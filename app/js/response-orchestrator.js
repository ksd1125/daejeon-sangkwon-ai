import { TOOL_DECLARATIONS } from './tool-definitions.js';

/* ── Pipeline Context: 각 스테이지의 Gemini/Local 사용 추적 ── */

class PipelineContext {
  constructor(question) {
    this.question = question;
    this.stages = {};
    this.startTime = Date.now();
  }
  mark(stage, source) {
    this.stages[stage] = { source, time: Date.now() - this.startTime };
  }
  elapsed() { return Date.now() - this.startTime; }
  remaining(deadline) { return Math.max(0, deadline - Date.now()); }
  log() {
    const entries = Object.entries(this.stages);
    const geminiCount = entries.filter(([, s]) => s.source.startsWith('gemini')).length;
    if (typeof window !== 'undefined') {
      window.__commercialAiPipelineLast = {
        question: this.question,
        geminiCount,
        stageCount: entries.length,
        elapsedMs: this.elapsed(),
        stages: this.stages,
        updatedAt: new Date().toISOString(),
      };
      document.documentElement.dataset.aiLastQuestion = this.question;
      document.documentElement.dataset.aiGeminiCount = String(geminiCount);
      document.documentElement.dataset.aiStageCount = String(entries.length);
      document.documentElement.dataset.aiElapsedMs = String(this.elapsed());
    }
    console.log(`[Pipeline] ${geminiCount}/${entries.length} gemini, ${this.elapsed()}ms`, this.stages);
  }
}

/**
 * Coordinates the hybrid pipeline:
 * Each stage independently picks Gemini or Local fallback.
 *
 * Stage 1 Intent  → Stage 2 Plan   → Stage 3 Execute (local) →
 * Stage 4 Build   → Stage 5 Verify → Stage 6 Render  (local) →
 * Stage 7 Enrich  (narrative + followUps, parallel)
 */
export class ResponseOrchestrator {
  constructor(deps) {
    this._router = deps.agentRouter;
    this._analyst = deps.agentAnalyst;
    this._advisor = deps.agentAdvisor;
    this._dispatcher = deps.toolDispatcher;
    this._rb = deps.responseBuilder;
    this._ui = deps.uiController;
    this._chatUI = deps.chatUI;
    this._renderCharts = deps.renderCharts;
    this._ensureMapController = deps.ensureMapController;
    this._getMapController = deps.getMapController;
    this._dl = deps.dataLoader;
    this._lastMapSig = null;
    // 하이브리드 의존성
    this._intentParser = deps.intentParser || null;
    this._buildLocalNarrative = deps.buildLocalNarrative || null;
    // 에이전트별 429 쿨다운 (60초)
    this._cooldowns = {};  // { agentName: expiresAt }
  }

  /** 429 쿨다운 등록 — 해당 에이전트 60초간 Gemini 호출 스킵 */
  _setCooldown(agent) {
    this._cooldowns[agent] = Date.now() + 60000;
    console.warn(`[Orchestrator] ${agent} 429 쿨다운 60초 (${new Date(this._cooldowns[agent]).toLocaleTimeString()} 까지)`);
  }

  /** 쿨다운 중이면 true */
  _isCoolingDown(agent) {
    const expires = this._cooldowns[agent];
    if (!expires) return false;
    if (Date.now() >= expires) { delete this._cooldowns[agent]; return false; }
    return true;
  }

  /** 429 에러인지 판별 (비-Error/문자열 throw도 방어) */
  _is429(err) {
    return /429|quota/i.test(String(err?.message || err || ''));
  }

  /* ═══════════════════════════════════════════
     MAIN PIPELINE (스테이지별 하이브리드)
     ═══════════════════════════════════════════ */

  async handleQuestion(handle, question, conversationState) {
    const PIPELINE_TIMEOUT = 15000;
    const deadline = Date.now() + PIPELINE_TIMEOUT;
    const chatUI = this._chatUI;
    const ctx = new PipelineContext(question);

    // ── Stage 1: Intent ──
    const contextSummary = this._advisor?.isAvailable()
      ? this._advisor.getContextSummary()
      : conversationState.toSummary();

    const route = await this._resolveIntent(question, contextSummary, deadline, ctx);
    if (!route) return { fallbackToLocal: true, error: 'no intent resolver' };

    const explicitIntentPlan = this._preferExplicitQuestionSlots(question, route.intentPlan);
    const intentPlan = this._enrichVagueCompareIntent(
      this._fillFromConversation(explicitIntentPlan, conversationState),
    );

    if (intentPlan.responseType === 'smalltalk' && intentPlan.directAnswer) {
      this._showNarrative(handle, intentPlan.directAnswer);
      ctx.log();
      return { handled: true };
    }

    // 의도 에코
    const echoText = this._buildIntentEcho(intentPlan);
    if (echoText) chatUI.showIntentEcho(handle, echoText);

    // ── Stage 2: Tool Plan ──
    let toolPlan = await this._resolveToolPlan(question, intentPlan, contextSummary, route.legacyToolPlan, deadline, ctx);

    if (toolPlan.action === 'answer' && toolPlan.answerText) {
      this._showNarrative(handle, toolPlan.answerText);
      ctx.log();
      return { handled: true };
    }
    if (toolPlan.action === 'clarify' || !toolPlan.toolCalls?.length) {
      this._showNarrative(
        handle,
        toolPlan.clarifyMessage || '지역이나 업종 조건이 조금 더 필요해요. 예: "둔산1동 카페 매출 어때?"처럼 물어봐 주세요.',
      );
      ctx.log();
      return { handled: true };
    }

    let fc = this._alignToolCallWithIntent(toolPlan.toolCalls[0], intentPlan);

    // 도구 계획 에코
    const toolEcho = this._buildToolEcho(fc);
    if (toolEcho) chatUI.updateIntentEcho(handle, toolEcho);

    // ── Stage 3: Execute (항상 로컬) ──
    let toolResult = await this._dispatcher.dispatch(fc);
    ctx.mark('execute', 'local');

    if (toolResult.error && !toolResult.alternatives) {
      chatUI.removeThinking(handle);
      chatUI.showError(handle, toolResult.error);
      ctx.log();
      return { handled: true };
    }

    // 데이터 없음 + 대안 있음 → 빌더로 통과시켜 대안 카드 생성
    if (toolResult.error && toolResult.alternatives) {
      const d = toolResult.district || {};
      toolResult.intent = {
        question,
        district: { code: d.code, name: d.name, sgg: d.sgg },
        industry: intentPlan.industry || fc?.args?.industry,
        questionType: intentPlan.goal || 'sales',
        month: this._dl?.getLatestMonth?.() || '',
      };
      toolResult.record = null;
    }

    let intent = toolResult.intent;

    if (intent && intentPlan) {
      for (const key of ['industryRaw', 'industryMatchType', 'industryMatchRatio', 'typoCorrections']) {
        if (intentPlan[key] !== undefined && intent[key] === undefined) intent[key] = intentPlan[key];
      }
    }

    // density intent override
    if (intentPlan.goal === 'density' && intent) {
      intent.questionType = 'density';
      intent.crossMetrics = this._extractCrossMetrics(question);
    }

    // ── Stage 4: Build (항상 로컬) ──
    this._ui.updateOrbitFromIntent(intent, 'loading');
    let response = this._rb.build(intent, toolResult);
    ctx.mark('build', 'local');

    // 미인식 업종 안내 (#40): 업종을 못 찾아 전체 현황 등으로 폴백된 경우 note에 고지
    // (brand/alias 해석 고지와 같은 위치 — narrative와 중복 없이 항상 노출, QA-F1)
    if (intentPlan.unmatchedIndustry && !intent?.industry) {
      const region = intent?.district?.name || intent?.sgg || '해당 지역';
      const notice = `'${intentPlan.unmatchedIndustry}' 업종을 찾지 못해 ${region} 전체 현황을 보여드려요.`;
      response.note = response.note ? `${notice} ${response.note}` : notice;
    }

    // ── Stage 5: Verify ──
    let verification = await this._resolveVerification(question, intentPlan, toolPlan, toolResult, response, deadline, ctx);

    if (verification.decision === 'clarify' && verification.userMessage) {
      this._showNarrative(handle, verification.userMessage);
      this._ui.updateOrbitFromIntent(intent, 'complete');
      ctx.log();
      return { handled: true };
    }

    if (verification.decision === 'retry' && verification.suggestedToolCall) {
      const alignedRetryCall = this._alignToolCallWithIntent(verification.suggestedToolCall, intentPlan);
      const retryResult = await this._dispatcher.dispatch(alignedRetryCall);
      if (!retryResult.error) {
        fc = alignedRetryCall;
        toolPlan = { ...toolPlan, toolCalls: [fc], planRationale: `advisor retry: ${verification.issues.join(', ')}` };
        toolResult = retryResult;
        intent = toolResult.intent;
        if (intentPlan.goal === 'density' && intent) {
          intent.questionType = 'density';
          intent.crossMetrics = this._extractCrossMetrics(question);
        }
        response = this._rb.build(intent, toolResult);
        verification = await this._resolveVerification(question, intentPlan, toolPlan, toolResult, response, deadline, ctx);
      }
    }

    if (verification.decision === 'clarify' && verification.userMessage) {
      this._showNarrative(handle, verification.userMessage);
      this._ui.updateOrbitFromIntent(intent, 'complete');
      ctx.log();
      return { handled: true };
    }

    // ── Stage 6: Render (항상 로컬) ──
    chatUI.removeThinking(handle);
    chatUI.setMeta(handle, response.meta, response.badge);
    chatUI.setFilterRow(handle, response.filters);

    await this._renderMinimap(handle, response, intent);

    chatUI.setAnalysisContent(handle, this._ui.buildCardHTML(response));
    chatUI.initInteractions(handle);
    this._renderCharts(handle.card);
    ctx.mark('render', 'local');

    // ── Stage 7: Enrich (병렬 비차단) ──
    const analysisContext = [contextSummary, verification.answerFocus].filter(Boolean).join('\n');
    const [, followUps] = await Promise.all([
      this._resolveNarrative(handle, question, fc.name, toolResult, analysisContext, response, deadline, ctx),
      this._resolveFollowUps(question, fc.name, toolResult, intent, response, deadline, ctx),
    ]);

    chatUI.setFollowUpChips(handle, followUps);
    chatUI.setNote(handle, response.note);

    conversationState.update(intent, toolResult, response);
    this._ui.addHistoryItem(intent, question);
    this._ui.updateOrbitFromIntent(intent, 'complete');

    setTimeout(() => chatUI.scrollToTurn?.(handle), 300);
    ctx.log();
    return { handled: true };
  }

  clearAdvisor() {
    this._advisor?.clear();
    this._lastMapSig = null;
  }

  /* ═══════════════════════════════════════════
     Stage 1: _resolveIntent — Gemini → Local
     ═══════════════════════════════════════════ */

  async _resolveIntent(question, contextSummary, deadline, ctx) {
    // Gemini Router — routeIntent (JSON)
    if (this._router?.isAvailable() && !this._isCoolingDown('router') && ctx.remaining(deadline) > 4000) {
      let router429 = false;
      try {
        const intentPlan = await this._router.routeIntent(question, contextSummary);
        ctx.mark('intent', 'gemini');
        return { intentPlan };
      } catch (err) {
        console.warn('[Orchestrator] Gemini routeIntent 실패:', err.message);
        if (this._is429(err)) { this._setCooldown('router'); router429 = true; }
      }

      // Legacy route (function calling) — routeIntent 실패 시 (429면 스킵)
      if (!router429 && ctx.remaining(deadline) > 4000) {
        try {
          const legacy = await this._router.route(question, contextSummary);
          if (legacy.functionCalls.length === 0) {
            ctx.mark('intent', 'gemini-text');
            return {
              intentPlan: {
                responseType: 'smalltalk',
                goal: 'unknown',
                directAnswer: legacy.textResponse || '상권 데이터로 확인할 질문을 입력해 주세요.',
                originalQuestion: question,
              },
            };
          }
          const fc = legacy.functionCalls[0];
          ctx.mark('intent', 'gemini-legacy');
          return {
            intentPlan: this._intentPlanFromFunctionCall(fc, question),
            legacyToolPlan: {
              action: 'execute',
              toolCalls: [{ name: fc.name, args: fc.args || {}, reason: 'legacy router fallback' }],
              clarifyMessage: '',
              answerText: '',
              planRationale: 'legacy router fallback',
            },
          };
        } catch (err) {
          console.warn('[Orchestrator] Gemini legacy route 실패:', err.message);
          if (this._is429(err)) this._setCooldown('router');
        }
      }
    }

    // Local IntentParser fallback
    if (this._intentParser) {
      try {
        const localIntent = this._intentParser.parse(question);
        ctx.mark('intent', 'local');
        // 오타 보정이 일어났으면 보정된 질문으로 plan 생성 (지역 라벨이 보정값으로 표시되게)
        return { intentPlan: this._localIntentToIntentPlan(localIntent, localIntent.question || question) };
      } catch (err) {
        console.warn('[Orchestrator] local intent parse 실패:', err.message);
      }
    }

    return null; // caller → fallbackToLocal
  }

  /* ═══════════════════════════════════════════
     Stage 2: _resolveToolPlan — Gemini → Local
     ═══════════════════════════════════════════ */

  async _resolveToolPlan(question, intentPlan, contextSummary, legacyToolPlan, deadline, ctx) {
    // Gemini Analyst planner
    if (this._analyst?.planTools && !this._isCoolingDown('analyst') && ctx.remaining(deadline) > 3000) {
      try {
        const plan = await this._analyst.planTools({
          question,
          intentPlan,
          contextSummary,
          availableTools: TOOL_DECLARATIONS,
        });
        if (plan?.toolCalls?.length || plan?.action !== 'execute') {
          ctx.mark('plan', 'gemini');
          return plan;
        }
      } catch (err) {
        console.warn('[Orchestrator] Gemini analyst planner 실패:', err.message);
        if (this._is429(err)) this._setCooldown('analyst');
      }
    }

    // Legacy tool plan from router
    if (legacyToolPlan?.toolCalls?.length) {
      ctx.mark('plan', 'legacy');
      return legacyToolPlan;
    }

    // Local fallback (analyst _fallbackToolPlan)
    ctx.mark('plan', 'local');
    if (this._analyst?._fallbackToolPlan) {
      return this._analyst._fallbackToolPlan(intentPlan);
    }
    return { action: 'clarify', toolCalls: [], clarifyMessage: '질문을 분석할 수 없습니다.' };
  }

  /* ═══════════════════════════════════════════
     Stage 5: _resolveVerification — Gemini → Local
     ═══════════════════════════════════════════ */

  async _resolveVerification(question, intentPlan, toolPlan, toolResult, response, deadline, ctx) {
    const local = this._localVerification(intentPlan, toolPlan, toolResult, response);
    if (local.decision !== 'accept') {
      ctx.mark('verify', 'local');
      return local;
    }

    if (this._advisor?.verifyAnswer && !this._isCoolingDown('advisor') && this._needsRemoteVerification(intentPlan, toolPlan, toolResult) && ctx.remaining(deadline) > 3000) {
      try {
        const result = await this._advisor.verifyAnswer({
          question,
          intentPlan,
          toolPlan,
          toolResultSummary: this._buildSummaryText(toolResult),
          responseSummary: this._buildResponseSummary(response),
        });
        ctx.mark('verify', 'gemini');
        return result;
      } catch (err) {
        console.warn('[Orchestrator] Gemini advisor verification 실패:', err.message);
        if (this._is429(err)) this._setCooldown('advisor');
      }
    }

    ctx.mark('verify', 'local');
    return local;
  }

  /* ═══════════════════════════════════════════
     Stage 7a: _resolveNarrative — Gemini → Local
     ═══════════════════════════════════════════ */

  async _resolveNarrative(handle, question, toolName, toolResult, analysisContext, response, deadline, ctx) {
    const fallbackText = response?.summary?.text || '';

    // Try Gemini streaming
    if (this._analyst?.isAvailable() && !this._isCoolingDown('analyst') && ctx.remaining(deadline) > 3000) {
      const summary = toolResult.geminiSummary || {};
      this._chatUI.startStreaming(handle);
      let fullText = '';

      try {
        for await (const chunk of this._analyst.streamAnalysis({
          question,
          toolName,
          toolResult: summary,
          contextSummary: analysisContext,
        })) {
          fullText += chunk;
          this._chatUI.appendToStream(handle, chunk);
        }
      } catch (err) {
        console.warn('[AgentAnalyst] stream error:', err.message);
        if (this._is429(err)) this._setCooldown('analyst');
      }

      if (this._isBadNarrative(fullText) || this._isTruncated(fullText)) {
        const localText = this._buildLocalNarrative ? this._buildLocalNarrative(response) : fallbackText;
        handle.narrative.textContent = localText;
        this._chatUI.finishStream(handle, localText);
        ctx.mark('narrative', 'local-fallback');
        return;
      }

      const tail = this._streamTailPatch(fullText);
      if (tail) {
        fullText += tail;
        this._chatUI.appendToStream(handle, tail);
      }
      this._chatUI.finishStream(handle, fullText);
      ctx.mark('narrative', 'gemini');
      return;
    }

    // Local narrative fallback
    const localText = this._buildLocalNarrative ? this._buildLocalNarrative(response) : fallbackText;
    if (localText) {
      await this._chatUI.typeText(handle, localText);
    }
    ctx.mark('narrative', 'local');
  }

  /* ═══════════════════════════════════════════
     Stage 7b: _resolveFollowUps — Gemini → Local
     ═══════════════════════════════════════════ */

  async _resolveFollowUps(question, toolName, toolResult, intent, response, deadline, ctx) {
    if (this._advisor?.isAvailable() && !this._isCoolingDown('advisor') && ctx.remaining(deadline) > 3000) {
      try {
        const result = await this._advisor.generateFollowUps({
          question,
          toolName,
          toolResultSummary: this._buildSummaryText(toolResult),
          currentDistrict: intent.district?.name,
          currentIndustry: intent.industry,
        });
        if (result.followUps?.length) {
          ctx.mark('followUps', 'gemini');
          return this._filterDuplicateFollowUps(result.followUps, intent);
        }
      } catch (err) {
        console.warn('[AgentAdvisor] follow-up error:', err.message);
        if (this._is429(err)) this._setCooldown('advisor');
      }
    }

    ctx.mark('followUps', 'local');
    return response.followUps || [];
  }

  /** Gemini follow-up 중 현재 질문과 같은 유형을 제외 */
  _filterDuplicateFollowUps(followUps, intent) {
    const type = intent?.questionType;
    if (!type) return followUps;

    // questionType별 제외 키워드
    const excludePatterns = {
      trend:   /추세|흐름|작년.*나아|전년/,
      sales:   /매출[은이]?\s*(어|얼마|어느)|장사/,
      upso:    /업소[가수]?\s*(몇|어)|점포|가게\s*(몇|많)/,
      pop:     /유동인구.*(언제|패턴|많|때)/,
      similar: /비슷한\s*(상권|동네)|유사/,
      density: /밀도|업소당|효율/,
      overview:/현황|전체|어때$/,
      rankDistricts: /순위|1위|높은\s*(동|행정)/,
    };

    const pattern = excludePatterns[type];
    if (!pattern) return followUps;

    const getText = (f) => typeof f === 'string' ? f : f?.text || '';
    const filtered = followUps.filter(f => !pattern.test(getText(f)));
    // 전부 필터되면 원본 유지 (최소 1개 보장)
    return filtered.length > 0 ? filtered : followUps.slice(0, 2);
  }

  /* ═══════════════════════════════════════════
     _localIntentToIntentPlan — IntentParser → intentPlan 브릿지
     ═══════════════════════════════════════════ */

  _localIntentToIntentPlan(localIntent, question) {
    const qt = localIntent.questionType || 'overview';
    const goalMap = {
      sales: 'sales', upso: 'stores', pop: 'population', trend: 'trend',
      overview: 'overview', compare: 'compare', similar: 'similar',
      merge: 'merge', density: 'density',
      rankDistricts: 'rankDistricts', sggIndustry: 'sggIndustry',
      compareIndustry: 'compareIndustry',
    };
    const goal = goalMap[qt] || 'sales';

    // compare의 metric은 질문 키워드로 결정 (유동인구 비교 → population)
    const compareMetric = this._extractMetricFromQuestion(question);
    const metricMap = {
      sales: 'sales', upso: 'stores', pop: 'population', trend: 'trend',
      overview: null, compare: compareMetric, similar: 'sales', merge: 'sales',
      density: 'all', rankDistricts: 'sales', sggIndustry: 'trend',
      compareIndustry: compareMetric || 'sales',
    };

    let district = localIntent.district?.name || null;
    const industry = localIntent.industry || null;
    const sgg = localIntent.sgg || null;

    // 복수 행정동 후보 → merge 처리 (법정동 별칭: 관저동→[관저1동,관저2동], 위치 별칭: 둔산→[둔산1동,둔산2동,둔산3동])
    let resolvedGoal = goal;
    let mergeDistricts = Array.isArray(localIntent.mergeDistricts)
      ? localIntent.mergeDistricts.map(d => typeof d === 'string' ? d : d.name).filter(Boolean)
      : [];
    const hasMultiCandidates = localIntent.districtCandidates?.length > 1
      && (localIntent.usedLegalDongAlias || localIntent.usedLocationAlias);
    if (hasMultiCandidates && !['compare'].includes(goal)) {
      mergeDistricts = localIntent.districtCandidates.map(d => d.name || d).filter(Boolean);
      if (!district) district = mergeDistricts[0] || null;
      // industry가 있으면 즉시 merge, 없으면 goal 유지 (_fillFromConversation에서 carry 후 merge 전환)
      if (industry) {
        resolvedGoal = 'merge';
      }
    }

    // SGG-only + industry → sggIndustry or rankDistricts
    if (sgg && industry && !district && !['compare', 'merge'].includes(resolvedGoal)) {
      const rankIntent = /(높|상위|1위|순위|랭킹|많)/.test(question || '');
      resolvedGoal = rankIntent ? 'rankDistricts' : 'sggIndustry';
    }

    const missingSlots = [];
    if (!district && !sgg && ['sales', 'stores', 'population', 'trend', 'overview', 'similar'].includes(resolvedGoal)) {
      missingSlots.push('district');
    }

    return {
      responseType: localIntent.confidence < 0.3 ? 'clarify' : 'analysis',
      goal: resolvedGoal,
      sgg,
      district,
      industry,
      industryRaw: localIntent.industryRaw || null,
      industryMatchType: localIntent.industryMatchType || null,
      industryMatchRatio: localIntent.industryMatchRatio || null,
      industries: localIntent.compareIndustries || null,
      metric: metricMap[qt] || (resolvedGoal === 'sggIndustry' ? 'trend' : null),
      compareDistricts: this._extractExplicitCompareDistricts(question).length >= 2
        ? this._extractExplicitCompareDistricts(question).slice(0, 2)
        : (localIntent.compareTarget ? [district, localIntent.compareTarget.name].filter(Boolean) : []),
      mergeDistricts,
      sourceLocation: hasMultiCandidates
        ? (question?.match(/[가-힣]+동/)?.[0] || localIntent.locationAlias || '')
        : '',
      missingSlots,
      confidence: localIntent.confidence || 0.5,
      directAnswer: null,
      unmatchedIndustry: localIntent.unmatchedIndustry || null,
      typoCorrections: localIntent.typoCorrections || [],
      rationale: 'local intent parser',
      originalQuestion: question,
    };
  }

  /* ═══════════════════════════════════════════
     LOCAL VERIFICATION (unchanged)
     ═══════════════════════════════════════════ */

  _localVerification(intentPlan, toolPlan, toolResult, response) {
    const toolCall = toolPlan?.toolCalls?.[0] || {};
    const mergeWithMetric = ['trend', 'stores', 'population'].includes(intentPlan?.metric) && intentPlan?.sourceLocation;
    const expected = {
      overview: 'getDistrictOverview',
      compare: 'compareDistricts',
      similar: 'findSimilarDistricts',
      merge: mergeWithMetric ? 'analyzeDistrictIndustry' : 'mergeDistricts',
      sales: intentPlan?.industry ? 'analyzeDistrictIndustry' : 'getDistrictOverview',
      stores: 'analyzeDistrictIndustry',
      population: 'analyzeDistrictIndustry',
      trend: 'analyzeDistrictIndustry',
      density: 'analyzeDistrictIndustry',
      compareIndustry: 'compareIndustries',
      rankDistricts: 'rankDistrictsByIndustry',
      sggIndustry: 'analyzeSggIndustry',
    }[intentPlan?.goal];

    if (intentPlan?.missingSlots?.length) {
      return {
        decision: 'clarify',
        issues: ['missing slots'],
        userMessage: '지역이나 업종 조건이 조금 더 필요해요. 예: "둔산1동 카페 매출 어때?"처럼 물어봐 주세요.',
        suggestedToolCall: null,
        followUps: [],
        answerFocus: '',
        contextSummary: '',
      };
    }

    if (expected && toolCall.name && toolCall.name !== expected) {
      const suggestedToolCall = this._suggestToolCall(intentPlan, expected);
      if (!suggestedToolCall) {
        return {
          decision: 'clarify',
          issues: [`expected ${expected}, got ${toolCall.name}`],
          userMessage: '질문 의도에 맞춰 다시 보려면 지역과 업종을 함께 알려주세요.',
          suggestedToolCall: null,
          followUps: [],
          answerFocus: '',
          contextSummary: '',
        };
      }
      return {
        decision: 'retry',
        issues: [`expected ${expected}, got ${toolCall.name}`],
        userMessage: '',
        suggestedToolCall,
        followUps: [],
        answerFocus: '질문 의도에 맞는 도구로 다시 조회합니다.',
        contextSummary: '',
      };
    }

    return {
      decision: 'accept',
      issues: [],
      userMessage: '',
      suggestedToolCall: null,
      followUps: [],
      answerFocus: response?.summary?.text || '',
      contextSummary: '',
    };
  }

  _needsRemoteVerification(intentPlan, toolPlan, toolResult) {
    if (!this._advisor?.isAvailable()) return false;
    if ((intentPlan?.confidence ?? 1) < 0.7) return true;
    if (intentPlan?.goal === 'unknown') return true;
    if (toolPlan?.toolCalls?.length > 1) return true;
    if (toolResult?.geminiSummary?.dataStatus === 'sgg_sub') return true;
    return false;
  }

  _alignToolCallWithIntent(toolCall, intentPlan) {
    if (!toolCall?.args || !intentPlan) return toolCall;
    const args = { ...toolCall.args };
    const explicitIndustry = String(intentPlan.industry || '').trim();
    const plannedIndustry = String(args.industry || '').trim();
    if (explicitIndustry && plannedIndustry && explicitIndustry !== plannedIndustry) {
      args.industry = explicitIndustry;
    }
    return { ...toolCall, args };
  }
  _suggestToolCall(intentPlan, expected) {
    const district = intentPlan?.district;
    const industry = intentPlan?.industry;
    if (expected === 'getDistrictOverview' && district) return { name: expected, args: { district } };
    if (expected === 'findSimilarDistricts' && district && industry) return { name: expected, args: { district, industry } };
    if (expected === 'compareDistricts' && industry && intentPlan?.compareDistricts?.length >= 2) {
      const [district1, district2] = intentPlan.compareDistricts;
      return { name: expected, args: { district1, district2, industry } };
    }
    if (expected === 'mergeDistricts' && industry && intentPlan?.mergeDistricts?.length >= 2) {
      return { name: expected, args: { districts: intentPlan.mergeDistricts, industry, sourceLocation: intentPlan.sourceLocation || '' } };
    }
    if (expected === 'analyzeDistrictIndustry' && district && industry) {
      const metric = intentPlan?.goal === 'density' ? 'all' : (intentPlan?.metric || 'sales');
      return { name: expected, args: { district, industry, metric } };
    }
    if (expected === 'rankDistrictsByIndustry' && intentPlan?.sgg && industry) {
      return { name: expected, args: { sgg: intentPlan.sgg, industry, metric: intentPlan?.metric || 'sales' } };
    }
    if (expected === 'analyzeSggIndustry' && intentPlan?.sgg && industry) {
      return { name: expected, args: { sgg: intentPlan.sgg, industry, metric: intentPlan?.metric || 'trend' } };
    }
    if (expected === 'compareIndustries' && district && intentPlan?.industries?.length >= 2) {
      return { name: expected, args: { district, industries: intentPlan.industries, metric: intentPlan?.metric || 'sales' } };
    }
    return null;
  }

  _intentPlanFromFunctionCall(fc, question) {
    const args = fc.args || {};
    const base = {
      responseType: 'analysis',
      goal: 'unknown',
      district: null,
      industry: null,
      metric: args.metric || null,
      compareDistricts: [],
      mergeDistricts: [],
      missingSlots: [],
      confidence: 0.6,
      directAnswer: null,
      rationale: 'legacy function call route',
      originalQuestion: question,
    };

    switch (fc.name) {
      case 'analyzeDistrictIndustry':
        return { ...base, goal: this._metricToGoal(args.metric), district: args.district || null, industry: args.industry || null };
      case 'getDistrictOverview':
        return { ...base, goal: 'overview', district: args.district || null };
      case 'compareDistricts':
        return {
          ...base,
          goal: 'compare',
          district: args.district1 || null,
          industry: args.industry || null,
          compareDistricts: [args.district1, args.district2].filter(Boolean),
        };
      case 'findSimilarDistricts':
        return { ...base, goal: 'similar', district: args.district || null, industry: args.industry || null };
      case 'mergeDistricts':
        return {
          ...base,
          goal: 'merge',
          industry: args.industry || null,
          mergeDistricts: Array.isArray(args.districts) ? args.districts.filter(Boolean) : [],
          sourceLocation: args.sourceLocation || '',
        };
      case 'rankDistrictsByIndustry':
        return {
          ...base,
          goal: 'rankDistricts',
          sgg: args.sgg || null,
          industry: args.industry || null,
          metric: args.metric || 'sales',
        };
      case 'analyzeSggIndustry':
        return {
          ...base,
          goal: 'sggIndustry',
          sgg: args.sgg || null,
          industry: args.industry || null,
          metric: args.metric || 'trend',
        };
      default:
        return base;
    }
  }

  _metricToGoal(metric) {
    const map = { sales: 'sales', stores: 'stores', population: 'population', trend: 'trend', all: 'sales' };
    return map[metric] || 'sales';
  }

  /* ═══════════════════════════════════════════
     UI HELPERS
     ═══════════════════════════════════════════ */

  _showNarrative(handle, text) {
    this._chatUI.removeThinking(handle);
    handle.narrative.hidden = false;
    handle.narrative.textContent = text;
  }

  _streamTailPatch(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    if (/[.!?。]$/.test(t) || /[다요죠음임]$/.test(t)) return '';
    if (/(으로|로|이며|며|이고|고|인데|지만|때문에|따라|대비)$/.test(t)) {
      return ' 확인됩니다.';
    }
    return '.';
  }

  _isBadNarrative(text) {
    const t = String(text || '').trim();
    if (t.length < 8) return true;
    if (/[,，]\d{0,3}\.?$/.test(t)) return true;
    if (/\d+[,.]\d*$/.test(t) && t.length < 30) return true;
    return false;
  }

  /** 스트리밍이 중단되었을 때 텍스트가 문장 도중에 잘렸는지 확인 */
  _isTruncated(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    // 한국어 문장 종결 패턴으로 끝나면 잘리지 않은 것
    if (/[.!?。]$/.test(t)) return false;
    if (/[다요죠음임네까]$/.test(t)) return false;
    // 그 외(조사·어미 중간, 한글 자음/모음, 명사 등)에서 끝나면 잘린 것
    return true;
  }

  _buildSummaryText(toolResult) {
    const s = toolResult.geminiSummary || {};
    const parts = [];
    if (s.district) parts.push(`지역: ${s.district}`);
    if (s.industry) parts.push(`업종: ${s.industry}`);
    if (Number.isFinite(s.amt)) parts.push(`매출: ${s.amt.toLocaleString()}만원`);
    if (Number.isFinite(s.upso)) parts.push(`업소: ${s.upso}개`);
    if (Number.isFinite(s.pop)) parts.push(`유동인구: ${s.pop.toLocaleString()}명`);
    if (s.type === 'overview' && s.totalIndustries) parts.push(`업종 수: ${s.totalIndustries}`);
    if (s.type === 'compare') parts.push(`${s.district1} vs ${s.district2}`);
    if (s.type === 'similar') parts.push(`유사 상권: ${s.topSimilar || '없음'}`);
    if (s.type === 'merge') parts.push(`합산 지역: ${s.districts?.join(', ') || ''}`);
    if (s.type === 'rankDistricts') parts.push(`${s.sgg} ${s.industry} 상위 행정동: ${s.top3 || s.topDistrict}`);
    if (s.type === 'sggIndustry') parts.push(`${s.sgg} ${s.industry} 현황: 평균 업소당 월매출 ${s.amt?.toLocaleString?.() || s.amt}만원, 상위 행정동 ${s.topDistricts || '-'}`);
    return parts.join(', ');
  }

  _buildResponseSummary(response) {
    const parts = [];
    if (response.summary?.text) parts.push(response.summary.text);
    if (response.statsCard?.title) parts.push(`stats: ${response.statsCard.title}`);
    if (response.compareCard?.title) parts.push(`compare: ${response.compareCard.title}`);
    if (response.trendCard?.title) parts.push(`trend: ${response.trendCard.title}`);
    return parts.join('\n').slice(0, 1200);
  }

  /* ── 의도 에코 빌더 ── */

  _buildIntentEcho(intentPlan) {
    if (!intentPlan || intentPlan.responseType === 'smalltalk') return '';
    const d = intentPlan.district || '';
    const ind = intentPlan.industry || '';
    const sgg = intentPlan.sgg || '';
    const goal = intentPlan.goal || 'unknown';

    if (goal === 'compare' && intentPlan.compareDistricts?.length >= 2) {
      const [a, b] = intentPlan.compareDistricts;
      return `📋 ${a}과(와) ${b}을(를) 비교합니다`;
    }
    if (goal === 'similar' && d) return `📋 ${d}${ind ? ' ' + ind : ''}과(와) 비슷한 상권을 찾습니다`;
    if (goal === 'merge' && intentPlan.mergeDistricts?.length >= 2) return `📋 ${intentPlan.mergeDistricts.join(' + ')} 합산 분석합니다`;
    if (goal === 'rankDistricts' && sgg) return `📋 ${sgg}${ind ? ' ' + ind : ''} 상위 행정동을 조회합니다`;
    if (goal === 'sggIndustry' && sgg) return `📋 ${sgg}${ind ? ' ' + ind : ''} 현황과 추세를 확인합니다`;
    if (goal === 'overview' && d) return `📋 ${d} 전체 상권 현황을 살펴봅니다`;
    if (goal === 'density') return `📋 ${d || '해당 지역'}${ind ? ' ' + ind : ''} 복합 지표를 비교합니다`;

    const metricLabel = { sales: '매출', stores: '업소 수', population: '유동인구', trend: '최근 추세' }[intentPlan.metric] || '';
    if (d && ind) return `📋 ${d} ${ind}${metricLabel ? ' ' + metricLabel : ''}을(를) 확인합니다`;
    if (d) return `📋 ${d} 상권 정보를 확인합니다`;
    return '📋 질문을 분석하고 있습니다...';
  }

  _enrichVagueCompareIntent(intentPlan) {
    if (!intentPlan || intentPlan.goal !== 'compare') return intentPlan;
    const compareDistricts = Array.isArray(intentPlan.compareDistricts)
      ? intentPlan.compareDistricts.filter(Boolean)
      : [];
    if (compareDistricts.length >= 2 || !intentPlan.district || !intentPlan.industry) {
      return intentPlan;
    }

    const target = this._pickDefaultCompareDistrict(intentPlan.district);
    if (!target) return intentPlan;

    const missingSlots = (intentPlan.missingSlots || []).filter(slot => slot !== 'compareTarget');
    return {
      ...intentPlan,
      responseType: 'analysis',
      compareDistricts: [intentPlan.district, target.name],
      missingSlots,
      autoCompareTarget: true,
      rationale: `${intentPlan.rationale || ''} 비교 대상이 명시되지 않아 같은 권역의 ${target.name}을 비교군으로 자동 선택했습니다.`.trim(),
    };
  }

  _pickDefaultCompareDistrict(districtName) {
    const list = this._dl?.getDistrictList?.() || [];
    const baseName = String(districtName || '').trim();
    if (!baseName || !list.length) return null;
    const compact = (v) => String(v || '').replace(/\s+/g, '');
    const base = list.find(d => compact(d.name) === compact(baseName));
    if (!base) return null;

    const numbered = base.name.match(/^(.+?)(\d+)동$/);
    if (numbered) {
      const [, prefix, rawNo] = numbered;
      const currentNo = Number(rawNo);
      const sibling = list
        .filter(d => d.sgg === base.sgg && d.code !== base.code)
        .map(d => ({ district: d, match: d.name.match(new RegExp(`^${prefix}(\\d+)동$`)) }))
        .filter(item => item.match)
        .map(item => ({ ...item, no: Number(item.match[1]) }))
        .sort((a, b) => Math.abs(a.no - currentNo) - Math.abs(b.no - currentNo))[0];
      if (sibling?.district) return sibling.district;
    }

    return list.find(d => d.sgg === base.sgg && d.code !== base.code) || null;
  }

  /* ═══════════════════════════════════════════
     ConversationState → intentPlan 슬롯 보완
     ═══════════════════════════════════════════ */

  _fillFromConversation(intentPlan, conversationState) {
    if (!conversationState?.hasContext()) return intentPlan;
    if (intentPlan.responseType === 'smalltalk') return intentPlan;

    const filled = { ...intentPlan };
    let changed = false;

    // district 빈 슬롯 채우기
    if (!filled.district && !filled.sgg && conversationState.activeDistrict?.name) {
      filled.district = conversationState.activeDistrict.name;
      filled._carriedDistrict = true;
      changed = true;
    }

    // sgg 빈 슬롯 채우기 (district가 없고 activeSgg만 있을 때 — sgg/rank 후 follow-up)
    if (!filled.district && !filled.sgg && !filled._carriedDistrict && conversationState.activeSgg) {
      filled.sgg = conversationState.activeSgg;
      filled._carriedSgg = true;
      changed = true;
      // sgg + industry → 직전 goal 타입 유지 (rankDistricts) 또는 sggIndustry
      if (filled.industry && !['compare', 'merge', 'sggIndustry', 'rankDistricts'].includes(filled.goal)) {
        const lastQt = conversationState.lastIntent?.questionType;
        filled.goal = lastQt === 'rankDistricts' ? 'rankDistricts' : 'sggIndustry';
        filled.metric = filled.metric || 'trend';
      }
    }

    // industry 빈 슬롯 채우기
    // 단, 명시적 overview 키워드("어때/현황/전체")가 있는 개방형 질의만 직전 업종 미carry (#19).
    // "그럼 둔산1동은?"처럼 키워드 없는 후속 질문은 직전 업종을 이어받아야 함 (QA-F2 회귀 수정).
    const _q = String(filled.originalQuestion || '');
    const _explicitOverviewKw = /어때|어떤가|어떻|현황|전체|요약|개요|분위기/.test(_q);
    const explicitOpenOverview = filled.goal === 'overview' && _explicitOverviewKw
      && ((filled.district && !filled._carriedDistrict) || (filled.sgg && !filled._carriedSgg));
    if (!filled.industry && conversationState.activeIndustry && !explicitOpenOverview) {
      filled.industry = conversationState.activeIndustry;
      filled._carriedIndustry = true;
      changed = true;
      // 법정동 다중 매핑 + carry된 업종 → merge로 전환
      if (filled.mergeDistricts?.length > 1) {
        filled.goal = 'merge';
        filled.metric = filled.metric || 'sales';
      // sgg만 있고 district 없을 때 → sggIndustry로 전환 (서구 카페→유성구는?)
      } else if (filled.sgg && !filled.district && !['compare', 'merge', 'sggIndustry', 'rankDistricts'].includes(filled.goal)) {
        const lastQt = conversationState.lastIntent?.questionType;
        filled.goal = lastQt === 'rankDistricts' ? 'rankDistricts' : 'sggIndustry';
        filled.metric = filled.metric || 'trend';
      // overview인데 맥락에서 업종이 carry되면 → 해당 업종 분석으로 전환
      } else if (filled.goal === 'overview') {
        filled.goal = 'sales';
        filled.metric = filled.metric || 'sales';
      }
    }

    // compare 의도: 질문 지역 ≠ 맥락 지역이면 compareDistricts 자동 구성
    //   법정동(둔산동·반석동 등 복수 행정동 묶음)도 지원: district가 null이어도
    //   맥락은 merge 소스명(둔산동), 현재 질문은 sourceLocation(반석동)을 사용
    if (filled.goal === 'compare') {
      const cds = Array.isArray(filled.compareDistricts) ? filled.compareDistricts.filter(Boolean) : [];
      if (cds.length < 2) {
        const ctxRegion = conversationState.activeMergeSource || conversationState.activeDistrict?.name;
        const curRegion = filled.district || filled.sourceLocation || null;
        if (ctxRegion && curRegion && ctxRegion !== curRegion) {
          // "반석동과 비교해줘"(맥락 둔산동) → [둔산동, 반석동]
          filled.compareDistricts = [ctxRegion, curRegion];
          filled._carriedCompare = true;
          changed = true;
        }
      }
    }

    // missingSlots에서 채워진 슬롯 제거
    if (changed && Array.isArray(filled.missingSlots)) {
      filled.missingSlots = filled.missingSlots.filter(slot => {
        if (slot === 'district' && (filled.district || filled.sgg)) return false;
        if (slot === 'industry' && filled.industry) return false;
        return true;
      });
    }

    // confidence 보정 + 로그
    if (changed) {
      filled.confidence = Math.max(0.5, (filled.confidence || 0.7) - 0.1);
      filled.rationale = (filled.rationale || '') + ' [맥락에서 지역/업종 보완]';
      const logs = [];
      if (filled._carriedDistrict) logs.push(`district=${filled.district}`);
      if (filled._carriedIndustry) logs.push(`industry=${filled.industry}`);
      if (filled._carriedCompare) logs.push(`compare=${filled.compareDistricts.join('↔')}`);
    }

    return filled;
  }

  /** 질문에서 지표 키워드 추출 (compare용) */
  _preferExplicitQuestionSlots(question, intentPlan) {
    const explicitCompareDistricts = this._extractExplicitCompareDistricts(question);
    const hasCompareWord = /비교|대비|차이|vs|versus|보다/.test(String(question || ''));
    if (hasCompareWord && explicitCompareDistricts.length >= 2) {
      return {
        ...intentPlan,
        responseType: 'analysis',
        goal: 'compare',
        district: explicitCompareDistricts[0],
        compareDistricts: explicitCompareDistricts.slice(0, 2),
        missingSlots: (intentPlan?.missingSlots || []).filter(slot => !['district', 'compareTarget'].includes(slot)),
        confidence: Math.max(intentPlan?.confidence || 0, 0.86),
        rationale: `${intentPlan?.rationale || ''} [질문에 명시된 비교 지역 우선]`.trim(),
      };
    }
    return intentPlan;
  }

  _extractExplicitCompareDistricts(question) {
    const raw = String(question || '');
    const compactQuestion = raw.replace(/\s+/g, '');
    if (!compactQuestion) return [];
    const compact = (v) => String(v || '').replace(/\s+/g, '');
    const candidates = [];
    const push = (name, type) => {
      const key = compact(name);
      if (!key || key.length < 2) return;
      const idx = compactQuestion.indexOf(key);
      if (idx >= 0) candidates.push({ name, key, idx, type, len: key.length });
    };

    const legalMap = this._dl?.getMatchingDictionaries?.().legalDongToAdminDong || {};
    Object.keys(legalMap).forEach(name => push(name, 'legal'));
    (this._dl?.getDistrictList?.() || []).forEach(d => push(d.name, 'admin'));

    candidates.sort((a, b) => a.idx - b.idx || b.len - a.len || (a.type === 'legal' ? -1 : 1));
    const selected = [];
    const used = new Set();
    for (const item of candidates) {
      if ([...used].some(key => key.includes(item.key) || item.key.includes(key))) continue;
      selected.push(item.name);
      used.add(item.key);
      if (selected.length >= 3) break;
    }
    return selected;
  }
  _extractMetricFromQuestion(question) {
    const q = String(question || '');
    if (/유동|인구|사람|방문|통행/.test(q)) return 'population';
    if (/업소|점포|가게|업체/.test(q)) return 'stores';
    if (/추세|추이|변화|트렌드/.test(q)) return 'trend';
    return 'sales';
  }

  _extractCrossMetrics(question) {
    const q = String(question || '');
    const has = (pat) => pat.test(q);
    const metrics = [];
    if (has(/매출/)) metrics.push('sales');
    if (has(/업소|점포|업체/)) metrics.push('upso');
    if (has(/유동|인구/)) metrics.push('pop');
    if (metrics.length < 2) return ['upso', 'pop'];
    return metrics;
  }

  _buildToolEcho(fc) {
    if (!fc?.name) return '';
    const metric = fc.args?.metric || 'all';
    const map = {
      analyzeDistrictIndustry: {
        sales: '매출 데이터를 조회합니다...',
        stores: '업소 수 데이터를 조회합니다...',
        population: '유동인구 데이터를 조회합니다...',
        trend: '추세 데이터를 조회합니다...',
        all: '매출 + 업소 + 유동인구를 조합합니다...',
      },
      getDistrictOverview: '전체 업종 현황을 집계합니다...',
      compareDistricts: '두 지역 데이터를 나란히 비교합니다...',
      findSimilarDistricts: '유사 패턴 상권을 검색합니다...',
      mergeDistricts: '지역 합산 데이터를 계산합니다...',
      rankDistrictsByIndustry: '행정동별 순위를 집계합니다...',
      analyzeSggIndustry: '구 단위 추세를 계산합니다...',
    };
    const entry = map[fc.name];
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object') return entry[metric] || entry.all;
    return '데이터를 조회합니다...';
  }

  async _renderMinimap(handle, response, intent) {
    if (!response.mapCard) return;

    const districtCodes = response.mapCard.districtCodes?.length
      ? response.mapCard.districtCodes
      : (intent.district?.codes?.length ? intent.district.codes : [intent.district?.code]);
    const compareCodes = response.mapCard.compareCodes?.length
      ? response.mapCard.compareCodes
      : (intent.compareTarget?.codes?.length ? intent.compareTarget.codes : [intent.compareTarget?.code]);
    const allCodes = [...districtCodes, ...compareCodes].filter(Boolean);
    const mapSig = `${allCodes.join(',')}|${intent.industry || ''}`;

    if (!allCodes.length || mapSig === this._lastMapSig) return;

    if (this._ensureMapController) await this._ensureMapController();
    const mapController = this._getMapController?.();
    if (!mapController) { this._lastMapSig = mapSig; return; }

    const cmpList = compareCodes.filter(Boolean);
    const tgtList = districtCodes.filter(Boolean);
    const isCompare = cmpList.length > 0 && tgtList.length > 0;
    const sgg = response.mapCard.sgg || intent.district?.sgg || '';

    if (isCompare) {
      // 비교: 좌(대상)·우(비교) 두 지도, 각 동의 점포를 따로 로드
      const containers = this._chatUI.setMapCard(handle, response.mapCard, { dual: true });
      if (Array.isArray(containers) && containers[0] && containers[1]) {
        const [storesA, storesB] = await Promise.all([
          this._loadMapStoresForDistricts(tgtList),
          this._loadMapStoresForDistricts(cmpList),
        ]);
        mapController.createMiniMap(containers[0], {
          districtCode: tgtList[0], districtCodes: tgtList, sgg,
          industry: intent.industry, stores: storesA || [], tightFill: true,
        });
        mapController.createMiniMap(containers[1], {
          compareCode: cmpList[0], compareCodes: cmpList, sgg,
          industry: intent.industry, stores: storesB || [], tightFill: true,
        });
      }
    } else {
      const stores = await this._loadMapStoresForDistricts(allCodes);
      const mapContainer = this._chatUI.setMapCard(handle, response.mapCard);
      if (mapContainer) {
        mapController.createMiniMap(mapContainer, {
          districtCode: districtCodes[0], districtCodes, sgg,
          compareCode: compareCodes[0] || null, compareCodes,
          industry: intent.industry, stores: stores || [],
        });
      }
    }

    this._lastMapSig = mapSig;
  }
  async _loadMapStoresForDistricts(codes = []) {
    if (!this._dl) return [];
    const uniqueCodes = [...new Set(codes.filter(Boolean).map(code => String(code).trim()))];
    if (!uniqueCodes.length) return [];
    const loaded = await Promise.all(uniqueCodes.map(async (code) => {
      try { return await this._dl.loadStores(code); } catch { return []; }
    }));
    return loaded.flat().filter(Boolean);
  }
}
