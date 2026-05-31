import { UIController } from './ui-controller.js?v=20260531-qa-g';
import { ChatUI } from './chat-ui.js?v=20260531-qa-g';
import { ConversationState } from './conversation-state.js?v=20260531-qa-g';
import { LocalRouter } from './local-router.js?v=20260531-qa-g';
import { ReportExporter } from './report-exporter.js?v=20260531-qa-g';
import { josa } from './josa.js?v=20260531-qa-g';

const ui = new UIController();
const chatUI = new ChatUI(
  document.getElementById('chatMessages'),
  document.getElementById('chatWelcome')
);
const conversationState = new ConversationState();
const localRouter = new LocalRouter();
const MODULE_VERSION = '20260531-qa-g';
const reportExporter = new ReportExporter({ moduleVersion: MODULE_VERSION, maintainer: 'Codex' });

let dataLoader = null;
let intentParser = null;
let queryEngine = null;
let responseBuilder = null;
let geminiNarrator = null;
let mapController = null;
let _lastMapSig = null; // 같은 지역+업종 반복 질문 시 미니맵 중복 방지
let responseOrchestrator = null; // Gemini 3-agent 오케스트레이터

function refreshDiagnostics(extra = {}) {
  if (typeof window === 'undefined') return;
  const has = (key) => Boolean(localStorage.getItem(key));
  window.__commercialAiDiagnostics = {
    moduleVersion: MODULE_VERSION,
    mode: has('gemini_api_key_router') || has('gemini_api_key') ? 'Gemini Agent' : 'Local Only',
    orchestrator: Boolean(responseOrchestrator),
    agents: {
      router: has('gemini_api_key_router') || has('gemini_api_key'),
      analyst: has('gemini_api_key_analyst') || has('gemini_api_key'),
      advisor: has('gemini_api_key_advisor') || has('gemini_api_key'),
    },
    data: {
      latestMonth: dataLoader?.getLatestMonth?.() || null,
      districts: dataLoader?.getDistrictList?.().length || 0,
      industries: dataLoader?.getIndustryList?.().length || 0,
    },
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  document.documentElement.dataset.aiMode = window.__commercialAiDiagnostics.mode;
  document.documentElement.dataset.aiModuleVersion = MODULE_VERSION;
  document.documentElement.dataset.aiOrchestrator = String(Boolean(responseOrchestrator));
  document.documentElement.dataset.aiRouter = String(window.__commercialAiDiagnostics.agents.router);
  document.documentElement.dataset.aiAnalyst = String(window.__commercialAiDiagnostics.agents.analyst);
  document.documentElement.dataset.aiAdvisor = String(window.__commercialAiDiagnostics.agents.advisor);
  window.__commercialAiRefreshDiagnostics = refreshDiagnostics;
}

/* ═══════════════
   INIT
   ═══════════════ */

async function init() {
  try {
    const { DataLoader } = await import(`./data-loader.js?v=${MODULE_VERSION}`);
    const { IntentParser } = await import(`./intent-parser.js?v=${MODULE_VERSION}`);
    const { QueryEngine } = await import(`./query-engine.js?v=${MODULE_VERSION}`);
    const { ResponseBuilder } = await import(`./response-builder.js?v=${MODULE_VERSION}`);

    dataLoader = new DataLoader('./data/');
    await dataLoader.init();

    intentParser = new IntentParser(
      dataLoader.getDistrictList(),
      dataLoader.getIndustryList(),
      dataLoader.getIndustryAliases(),
      dataLoader.getMatchingDictionaries()
    );

    queryEngine = new QueryEngine(dataLoader);
    responseBuilder = new ResponseBuilder();

    // 자동완성 초기화
    try {
      const { Autocomplete } = await import(`./autocomplete.js?v=${MODULE_VERSION}`);
      const searchInput = document.getElementById('searchInput');
      if (searchInput) {
        // 동적 인기 업종 추출: categories의 음식/소매/수리·개인/보건의료 대분류에서 짧은 이름 우선
        const categories = dataLoader.getIndustryCategories?.() || {};
        const popularLargeCategories = new Set(['음식', '소매', '수리·개인', '보건의료', '예술·스포츠']);
        const topIndustries = dataLoader.getIndustryList()
          .filter(i => {
            const cat = categories[i];
            return cat && popularLargeCategories.has(cat.large) && i.length <= 12;
          })
          .slice(0, 40);
        new Autocomplete(searchInput, {
          districts: dataLoader.getDistrictList().map(d => ({ name: d.name, sgg: d.sgg })),
          industries: topIndustries.length ? topIndustries : dataLoader.getIndustryList().slice(0, 30),
          aliases: dataLoader.getIndustryAliases() || {},
        }, (q) => handleQuestion(q));
      }
    } catch (err) { console.warn('[상권AI] 자동완성 초기화 실패:', err.message); }

    // 웰컴 예시 질문 동적 생성
    try { refreshWelcomeChips(dataLoader); } catch (err) { console.warn('[상권AI] 웰컴 칩 실패:', err.message); }

    try {
      const { GeminiNarrator } = await import(`./gemini-narrator.js?v=${MODULE_VERSION}`);
      geminiNarrator = new GeminiNarrator();
    } catch { /* narrator optional */ }

  } catch (err) {
    console.warn('[상권AI] 엔진 모듈 로드 실패, 데모 모드로 동작합니다:', err.message);
  }

  // 기존 단일 API 키 → 3키 마이그레이션
  const envKeys = window.__COMMERCIAL_AI_ENV || {};
  const envCommonKey = envKeys.GEMINI_API_KEY || '';
  if (envCommonKey && !localStorage.getItem('gemini_api_key')) {
    localStorage.setItem('gemini_api_key', envCommonKey);
  }
  ['ROUTER', 'ANALYST', 'ADVISOR'].forEach((role) => {
    const envKey = envKeys[`GEMINI_API_KEY_${role}`] || envCommonKey;
    const storageKey = `gemini_api_key_${role.toLowerCase()}`;
    if (envKey && !localStorage.getItem(storageKey)) localStorage.setItem(storageKey, envKey);
  });

  // 기존 단일 API 키 → 3키 마이그레이션 (개별 키가 없을 때만)
  const legacyKey = localStorage.getItem('gemini_api_key');
  if (legacyKey) {
    ['router', 'analyst', 'advisor'].forEach(role => {
      if (!localStorage.getItem(`gemini_api_key_${role}`)) {
        localStorage.setItem(`gemini_api_key_${role}`, legacyKey);
      }
    });
  }
  const routerKey = localStorage.getItem('gemini_api_key_router');
  if (routerKey && !localStorage.getItem('gemini_api_key')) {
    localStorage.setItem('gemini_api_key', routerKey);
  }
  // 키 상태 로그
  const keyStatus = ['router', 'analyst', 'advisor'].map(r => {
    const k = localStorage.getItem(`gemini_api_key_${r}`);
    return `${r}: ${k ? k.slice(-6) : '없음'}`;
  });

  // Gemini 3-Agent 오케스트레이터 초기화
  if (queryEngine && dataLoader && responseBuilder) {
    try {
      const { ToolDispatcher } = await import(`./tool-dispatcher.js?v=${MODULE_VERSION}`);
      const { AgentRouter } = await import(`./agent-router.js?v=${MODULE_VERSION}`);
      const { AgentAnalyst } = await import(`./agent-analyst.js?v=${MODULE_VERSION}`);
      const { AgentAdvisor } = await import(`./agent-advisor.js?v=${MODULE_VERSION}`);
      const { ResponseOrchestrator } = await import(`./response-orchestrator.js?v=${MODULE_VERSION}`);

      const adminNames = dataLoader.getDistrictList().map(d => d.name);
      const legalNames = Object.keys(dataLoader.getMatchingDictionaries?.().legalDongToAdminDong || {});
      const districtNames = [
        `행정동: ${adminNames.join(',')}`,
        legalNames.length ? `법정동/생활권 별칭: ${legalNames.join(',')}` : '',
      ].filter(Boolean).join('\n');

      responseOrchestrator = new ResponseOrchestrator({
        agentRouter: new AgentRouter(
          () => localStorage.getItem('gemini_api_key_router') || localStorage.getItem('gemini_api_key'),
          districtNames,
        ),
        agentAnalyst: new AgentAnalyst(
          () => localStorage.getItem('gemini_api_key_analyst') || localStorage.getItem('gemini_api_key'),
        ),
        agentAdvisor: new AgentAdvisor(
          () => localStorage.getItem('gemini_api_key_advisor') || localStorage.getItem('gemini_api_key'),
        ),
        toolDispatcher: new ToolDispatcher(queryEngine, dataLoader),
        responseBuilder,
        uiController: ui,
        chatUI,
        renderCharts: renderChartsInContainer,
        ensureMapController,
        getMapController: () => mapController,
        dataLoader,
        // 하이브리드 파이프라인 의존성
        intentParser,
        buildLocalNarrative,
      });

      const hasKey = Boolean(routerKey);
      refreshDiagnostics();
    } catch (err) {
      console.warn('[상권AI] Gemini 모듈 로드 실패, 로컬 모드로 동작:', err.message);
      refreshDiagnostics({ error: err.message });
    }
  }

  refreshDiagnostics();
}

/* ═══════════════
   MAP (lazy init — minimap only)
   ═══════════════ */

async function ensureMapController() {
  if (mapController) return;
  try {
    const { MapController } = await import(`./map-controller.js?v=${MODULE_VERSION}`);
    mapController = new MapController();
  } catch { /* map optional */ }
}

async function loadMapStoresForDistricts(codes = []) {
  if (!dataLoader) return [];
  const uniqueCodes = [...new Set(codes.filter(Boolean).map(code => String(code).trim()))];
  if (!uniqueCodes.length) return [];
  const loaded = await Promise.all(uniqueCodes.map(async (code) => {
    try { return await dataLoader.loadStores(code); } catch { return []; }
  }));
  return loaded.flat().filter(Boolean);
}

/* ═══════════════════════════════
   QUESTION HANDLER (chat flow)
   ═══════════════════════════════ */

// 파이프라인 진행 중 중복 질문/칩클릭 차단 (공유 conversationState·_lastMapSig 경쟁 방지)
let inFlight = false;

async function handleQuestion(question) {
  if (!question) return;
  if (inFlight) return;
  inFlight = true;

  // 1) 사용자 메시지 표시
  chatUI.addUserMessage(question);
  ui.setQuestion('');

  // 2) AI 턴 생성 + 로딩
  const handle = chatUI.createAssistantTurn();
  chatUI.showThinking(handle);

  try {
    // 하이브리드 파이프라인: orchestrator가 Gemini/Local을 스테이지별로 자동 선택
    if (responseOrchestrator) {
      const result = await responseOrchestrator.handleQuestion(handle, question, conversationState);
      if (!result.fallbackToLocal) {
        setTimeout(() => chatUI.scrollToTurn?.(handle), 300);
        return;
      }
      // fallbackToLocal: orchestrator 자체가 로컬 파서도 실패한 경우에만 도달
      console.warn('[상권AI] 하이브리드 파이프라인 실패, 레거시 로컬 경로:', result.error);
      handle.narrative.hidden = false;
      handle.narrative.innerHTML = '<span class="intent-echo" style="color:var(--warn)">⚠ 분석 전환 중</span>';
      await new Promise(r => setTimeout(r, 500));
      chatUI.showThinking(handle);
    }

    if (!intentParser || !queryEngine || !responseBuilder) {
      chatUI.removeThinking(handle);
      const demo = buildDemoResponse(question);
      chatUI.setAnalysisContent(handle, ui.buildCardHTML(demo));
      chatUI.setFollowUpChips(handle, demo.followUps);
      chatUI.initInteractions(handle);
      return;
    }

    // 3) 라우팅: 질문 유형 분류 (로컬 폴백)
    const routeResult = localRouter.route(question, conversationState);

    // 4) 라우트별 분기
    switch (routeResult.route) {
      case 'explain_last_answer':
        await handleExplainRoute(handle, question);
        return;

      case 'refine_same_analysis':
        await handleRefineRoute(handle, question);
        return;

      case 'run_comparison':
        await handleCompareRoute(handle, question, routeResult);
        return;

      case 'clarify_scope':
        handleClarifyRoute(handle, question, routeResult);
        return;

      case 'run_new_analysis':
      default:
        await handleNewAnalysisRoute(handle, question, routeResult);
        return;
    }

  } catch (err) {
    console.error('[상권AI] 오류:', err);
    chatUI.removeThinking(handle);
    chatUI.showError(handle, '데이터를 조회하는 중 오류가 발생했습니다: ' + err.message);
  } finally {
    inFlight = false;
  }
}

/* ═══════════════════
   ROUTE HANDLERS
   ═══════════════════ */

/** explain_last_answer: 직전 답 근거 재설명 (쿼리 없음) */
async function handleExplainRoute(handle, question) {
  const lastResult = conversationState.getLastResult();
  if (!lastResult) {
    chatUI.removeThinking(handle);
    chatUI.showError(handle, '설명할 직전 답변이 없습니다. 먼저 질문을 해 주세요.');
    return;
  }

  chatUI.removeThinking(handle);
  chatUI.setMeta(handle, lastResult.meta, lastResult.badge);

  // Gemini에 "설명" 모드로 스트리밍
  if (geminiNarrator?.isAvailable() && lastResult.narrativeContext) {
    const ctx = {
      ...lastResult.narrativeContext,
      question,
      route: 'explain_last_answer',
      conversationHistory: chatUI.getConversationHistory(),
      conversationSummary: conversationState.toSummary(),
    };
    chatUI.startStreaming(handle);
    let fullText = '';
    try {
      for await (const chunk of geminiNarrator.streamNarrative(ctx)) {
        fullText += chunk;
        chatUI.appendToStream(handle, chunk);
      }
    } catch (err) { console.warn('[GeminiNarrator] explain error:', err.message); }
    chatUI.finishStream(handle, fullText);
  }

  // 직전 분석 카드 다시 표시
  chatUI.setFilterRow(handle, lastResult.filters);

  // 인라인 미니맵 — explain은 같은 지역이므로 중복 시 생략
  // (mapSig는 직전 분석과 동일하므로 보통 생략됨)

  chatUI.setAnalysisContent(handle, ui.buildCardHTML(lastResult));
  chatUI.initInteractions(handle);
  renderChartsInContainer(handle.card);
  chatUI.setNote(handle, lastResult.note);
  chatUI.setFollowUpChips(handle, lastResult.followUps);
}

/** refine_same_analysis: 직전 결과를 다른 형태로 재렌더링 */
async function handleRefineRoute(handle, question) {
  const lastResult = conversationState.getLastResult();
  if (!lastResult) {
    chatUI.removeThinking(handle);
    chatUI.showError(handle, '재표현할 직전 답변이 없습니다.');
    return;
  }

  chatUI.removeThinking(handle);
  chatUI.setMeta(handle, lastResult.meta, lastResult.badge);

  // 짧은 내러티브
  if (geminiNarrator?.isAvailable() && lastResult.narrativeContext) {
    const ctx = {
      ...lastResult.narrativeContext,
      question,
      route: 'refine_same_analysis',
      conversationHistory: chatUI.getConversationHistory(),
      conversationSummary: conversationState.toSummary(),
    };
    chatUI.startStreaming(handle);
    let fullText = '';
    try {
      for await (const chunk of geminiNarrator.streamNarrative(ctx)) {
        fullText += chunk;
        chatUI.appendToStream(handle, chunk);
      }
    } catch (err) { console.warn('[GeminiNarrator] refine error:', err.message); }
    chatUI.finishStream(handle, fullText);
  }

  chatUI.setFilterRow(handle, lastResult.filters);

  // 인라인 미니맵 — refine은 같은 지역이므로 중복 시 생략

  chatUI.setAnalysisContent(handle, ui.buildCardHTML(lastResult));
  chatUI.initInteractions(handle);
  renderChartsInContainer(handle.card);
  chatUI.setNote(handle, lastResult.note);
  chatUI.setFollowUpChips(handle, lastResult.followUps);
}

/** run_comparison: 2지역 비교 */
async function handleCompareRoute(handle, question, routeResult) {
  // Intent 파싱
  let intent = intentParser.parse(question);
  intent._route = 'run_comparison';
  intent._conversationSummary = conversationState.toSummary();

  // 맥락 복원: 비교 대상이 하나만 있으면 직전 지역을 base로
  const enriched = conversationState.resolve(intent);
  if (enriched._carriedDistrict) intent = enriched;

  const baseDistrict = intent.district;
  const compareTarget = intent.compareTarget;
  const industry = intent.industry || conversationState.activeIndustry;

  // 비교 대상이 없으면 폴백
  if (!baseDistrict && !compareTarget) {
    await handleNewAnalysisRoute(handle, question, routeResult);
    return;
  }

  // 비교 대상이 하나만 있으면 그게 compareTarget, base는 직전 지역
  let code1 = baseDistrict?.code;
  let code2 = compareTarget?.code;
  if (!code1 && code2 && conversationState.activeDistrict) {
    code1 = conversationState.activeDistrict.code;
    intent.district = conversationState.activeDistrict;
  }
  if (!code2 && code1 && conversationState.activeDistrict && code1 !== conversationState.activeDistrict.code) {
    code2 = conversationState.activeDistrict.code;
    intent.compareTarget = conversationState.activeDistrict;
  }
  if (!code2 && code1 && industry) {
    const autoTarget = await pickDefaultCompareTarget(intent.district, industry, intent.month || dataLoader.getLatestMonth());
    if (autoTarget) {
      code2 = autoTarget.code;
      intent.compareTarget = autoTarget;
      intent.autoCompareTarget = true;
    }
  }

  if (!code1 || !code2 || !industry) {
    // 비교 조건 불충분 → 일반 분석으로 폴백
    await handleNewAnalysisRoute(handle, question, routeResult);
    return;
  }

  ui.updateOrbitFromIntent(intent, 'loading');
  const month = intent.month || dataLoader.getLatestMonth();

  // 2지역 쿼리 + 추세 비교 병렬 실행
  const [compareResult, trendComparison] = await Promise.all([
    queryEngine.queryCompareDistricts(code1, code2, industry, month),
    queryEngine.getTrendComparison(code1, code2, industry),
  ]);
  const horizontalComparison = queryEngine.buildHorizontalComparison(compareResult.district1, compareResult.district2);

  // 비교 응답 생성
  intent.questionType = 'compare';
  const response = responseBuilder.build(intent, {
    record: compareResult.district1,
    compareResult,
    horizontalComparison,
    trendComparison,
  });

  chatUI.removeThinking(handle);
  chatUI.setMeta(handle, response.meta, response.badge);

  // Gemini 내러티브
  if (geminiNarrator?.isAvailable() && response.narrativeContext) {
    await streamNarrative(handle, response);
  }

  chatUI.setFilterRow(handle, response.filters);

  // 인라인 미니맵 카드 (비교 모드) — 같은 비교 조합이면 중복 표시하지 않음
  const cmpDistrictCodes = response.mapCard?.districtCodes || [code1];
  const cmpCompareCodes = response.mapCard?.compareCodes || [code2];
  const cmpMapCodes = [...cmpDistrictCodes, ...cmpCompareCodes].filter(Boolean);
  const cmpMapSig = `${code1}|${code2}|${intent.industry || ''}`;
  if (response.mapCard && cmpMapSig !== _lastMapSig) {
    await ensureMapController();
    if (mapController) {
      const mapContainer = chatUI.setMapCard(handle, response.mapCard);
      if (mapContainer) {
        const mapStores = await loadMapStoresForDistricts(cmpMapCodes);
        mapController.createMiniMap(mapContainer, {
          districtCode: cmpDistrictCodes[0],
          districtCodes: cmpDistrictCodes,
          sgg: intent.district?.sgg || '',
          compareCode: cmpCompareCodes[0] || null,
          compareCodes: cmpCompareCodes,
          industry: intent.industry,
          stores: mapStores,
        });
      }
    }
    _lastMapSig = cmpMapSig;
  }

  chatUI.setAnalysisContent(handle, ui.buildCardHTML(response));
  chatUI.initInteractions(handle);
  renderChartsInContainer(handle.card);
  chatUI.setNote(handle, response.note);
  chatUI.setFollowUpChips(handle, response.followUps);

  conversationState.update(intent, { compareResult, horizontalComparison }, response);
  ui.addHistoryItem(intent, question);
  ui.updateOrbitFromIntent(intent, 'complete');

  // 모든 카드 삽입 완료 후 최종 스크롤 보정
  setTimeout(() => chatUI.scrollToTurn?.(handle), 300);
}

/** clarify_scope: 모호성 확인 */
function handleClarifyRoute(handle, question, routeResult) {
  chatUI.removeThinking(handle);
  const missingSlots = routeResult.missingSlots || [];
  let message = '어느 지역을 비교할지 선택해 주세요.';
  if (missingSlots.includes('compareTarget')) {
    message = '비교할 행정동을 선택해 주세요.';
  }

  const candidates = [];
  if (conversationState.activeDistrict) {
    candidates.push(`${conversationState.activeDistrict.name} ${conversationState.activeIndustry || ''} 어때?`.trim());
  }

  const clarifyResponse = {
    header: { question, monthDisplay: null, district: null, sgg: null, industry: null },
    summary: { text: message, bullets: [] },
    details: [],
    insights: [],
    followUps: candidates,
    dataNotice: null,
    disambiguation: candidates.length > 0 ? { message, candidates } : null,
  };

  chatUI.setAnalysisContent(handle, ui.buildCardHTML(clarifyResponse));
  chatUI.initInteractions(handle);
}

/** run_new_analysis: 기존 분석 파이프라인 (기본 라우트) */
async function handleNewAnalysisRoute(handle, question, routeResult) {
  // Intent 파싱
  let intent = intentParser.parse(question);
  intent._route = 'run_new_analysis';
  intent._conversationSummary = conversationState.toSummary();

  // 모호성 처리 — 업종 (학원, 병원, 의원 등): resolve() 전에 검사해야 carry 방지
  if (intent.industryCandidates && intent.industryCandidates.length > 1 && !intent.industry) {
    // 지역은 carry해도 됨 (행정동 맥락 유지)
    if (!intent.district && conversationState.activeDistrict) {
      intent.district = { ...conversationState.activeDistrict };
    }
    chatUI.removeThinking(handle);
    const disambigResponse = buildIndustryDisambiguationResponse(intent);
    chatUI.setAnalysisContent(handle, ui.buildCardHTML(disambigResponse));
    chatUI.initInteractions(handle);
    ui.updateOrbitFromIntent(intent, 'complete');
    return;
  }

  // 맥락 복원: 짧은 후속 질문이면 직전 지역/업종 이어받기
  // carry 플래그가 있거나, 지역/업종이 빠졌는데 직전 맥락이 있으면 복원
  if (routeResult.carry?.district || routeResult.carry?.industry ||
      (conversationState.hasContext() && ((!intent.district && !intent.sgg) || !intent.industry))) {
    intent = conversationState.resolve(intent);
  }

  // compare 의도이지만 비교 대상이 없으면 sales로 전환
  if (intent.questionType === 'compare' && !intent.compareTarget) {
    intent.questionType = 'sales';
  }

  if ((intent.usedLegalDongAlias || intent.usedLocationAlias) && intent.districtCandidates?.length > 1 && intent.industry) {
    intent.questionType = 'merge';
    intent.mergeDistricts = intent.districtCandidates;
    intent.sourceLocation = intent.question.match(/[가-힣]+동/)?.[0] || intent.locationAlias || '';
    intent.district = { ...intent.districtCandidates[0], name: intent.sourceLocation || intent.districtCandidates.map(d => d.name).join(' + ') };
    intent.sgg = intent.districtCandidates[0]?.sgg || intent.sgg;
    intent.districtCandidates = [];
    intent.ambiguities = [];
  }

  ui.updateOrbitFromIntent(intent, 'loading');

  // 모호성 처리 — 행정동
  if (intent.districtCandidates && intent.districtCandidates.length > 1 && !intent.district) {
    chatUI.removeThinking(handle);
    const disambigResponse = buildDisambiguationResponse(intent);
    chatUI.setAnalysisContent(handle, ui.buildCardHTML(disambigResponse));
    chatUI.initInteractions(handle);
    ui.updateOrbitFromIntent(intent, 'complete');
    return;
  }

  if (intent.confidence < 0.5 && !intent.district && !intent.sgg && !intent._isFollowUp) {
    chatUI.removeThinking(handle);
    chatUI.showError(handle, '질문에서 지역이나 업종을 찾지 못했습니다. "중앙동 편의점 매출 어때?" 같은 형태로 물어보세요.');
    return;
  }

  // 시군구만 지정 → disambiguation
  let districtCode = null;
  if (intent.district) {
    districtCode = intent.district.code || null;
  } else if (intent.sgg && intent.industry && !intent.district) {
    const rankIntent = /(높|상위|1위|순위|랭킹|많|잘\s*되는)/.test(intent.question || '')
      && !/(업종별|상위\s*업종|1위\s*업종|다른\s*업종)/.test(intent.question || '');
    if (rankIntent) {
      intent.questionType = 'rankDistricts';
      intent.metric = /(업소|점포|가게)/.test(intent.question || '') ? 'stores' : 'sales';
    } else {
      const metricMap = { sales: 'sales', upso: 'stores', pop: 'population', trend: 'trend' };
      intent.metric = metricMap[intent.questionType] || 'trend';
      intent.questionType = 'sggIndustry';
    }
  } else if (intent.sgg && !intent.district) {
    const sggDistricts = dataLoader.getDistrictsBySgg(intent.sgg);
    if (sggDistricts.length > 0) {
      chatUI.removeThinking(handle);
      const sggResponse = buildSggDisambiguationResponse(intent, sggDistricts);
      chatUI.setAnalysisContent(handle, ui.buildCardHTML(sggResponse));
      chatUI.initInteractions(handle);
      return;
    }
  }

  if (!districtCode && intent.question && !intent.sgg && !intent._isFollowUp) {
    chatUI.removeThinking(handle);
    chatUI.showError(handle, `"${intent.question}"에서 유효한 행정동을 찾지 못했습니다. 대전 82개 행정동 이름으로 질문해 주세요.`);
    return;
  }

  // 데이터 조회
  const month = intent.month || dataLoader.getLatestMonth();
  const queryResult = await runQuery(intent, districtCode, month);

  // 응답 생성
  const response = responseBuilder.build(intent, queryResult);

  chatUI.removeThinking(handle);
  chatUI.setMeta(handle, response.meta, response.badge);

  // Gemini 내러티브
  if (geminiNarrator?.isAvailable() && response.narrativeContext) {
    await streamNarrative(handle, response);
  } else if (!geminiNarrator?.isAvailable()) {
    // API 키가 없어도 로컬 요약 답변은 반드시 보여준다.
    handle.narrative.style.color = '';
    handle.narrative.style.fontSize = '';
    await chatUI.typeText(handle, buildLocalNarrative(response));
  }

  chatUI.setFilterRow(handle, response.filters);

  // 인라인 미니맵 카드 — 같은 지역+업종이면 중복 표시하지 않음
  const mapSig = `${districtCode}|${intent.industry || ''}`;
  if (response.mapCard && mapSig !== _lastMapSig) {
    let stores = null;
    if (districtCode && intent.industry && dataLoader) {
      try { stores = await dataLoader.loadStores(districtCode); } catch { /* optional */ }
    }
    await ensureMapController();
    if (mapController) {
      const mapContainer = chatUI.setMapCard(handle, response.mapCard);
      const mapCodes = response.mapCard?.districtCodes || [districtCode];
      if (mapContainer) {
        mapController.createMiniMap(mapContainer, {
          districtCode: mapCodes[0] || districtCode,
          districtCodes: mapCodes,
          sgg: response.mapCard.sgg,
          industry: intent.industry,
          stores: stores || [],
        });
      }
    }
    _lastMapSig = mapSig;
  }

  chatUI.setAnalysisContent(handle, ui.buildCardHTML(response));
  chatUI.initInteractions(handle);
  renderChartsInContainer(handle.card);
  chatUI.setNote(handle, response.note);
  chatUI.setFollowUpChips(handle, response.followUps);

  // 상태 업데이트
  conversationState.update(intent, queryResult, response);
  ui.addHistoryItem(intent, question);
  ui.updateOrbitFromIntent(intent, 'complete');

  // 모든 카드 삽입 완료 후 최종 스크롤 보정
  setTimeout(() => chatUI.scrollToTurn?.(handle), 300);
}

/* ═══════════════
   HELPERS
   ═══════════════ */

async function runQuery(intent, districtCode, month) {
  const queryResult = {};

  if (intent.questionType === 'merge' && intent.mergeDistricts?.length >= 2) {
    const codes = intent.mergeDistricts.map(d => d.code);
    queryResult.mergeResult = await queryEngine.queryMergedDistricts(codes, intent.industry, month);
    if (queryResult.mergeResult) {
      if (intent.sourceLocation) queryResult.mergeResult.sourceLocation = intent.sourceLocation;
      queryResult.record = queryResult.mergeResult.merged;
    }
    return queryResult;
  }

  if (intent.questionType === 'rankDistricts' && intent.sgg && intent.industry) {
    queryResult.ranking = await queryEngine.rankDistrictsByIndustry(intent.sgg, intent.industry, intent.metric || 'sales', month, 10);
    return queryResult;
  }

  if (intent.questionType === 'sggIndustry' && intent.sgg && intent.industry) {
    queryResult.sggResult = await queryEngine.buildSggIndustry(intent.sgg, intent.industry, intent.metric || 'trend', month);
    return queryResult;
  }

  if (intent.questionType === 'overview') {
    if (districtCode) queryResult.overview = await queryEngine.buildOverview(districtCode, month);
  } else if (intent.questionType === 'pop' && districtCode && !intent.industry) {
    const popData = await queryEngine.getDistrictPopulation(districtCode, month);
    if (popData) {
      queryResult.record = { pop: popData.pop, peakDay: popData.peakDay, peakTime: popData.peakTime, dataStatus: 'direct' };
      queryResult.population = popData;
      // pop은 업종 무관 동일값 → 아무 업종으로 월별 추세 빌드
      if (popData._industry) {
        queryResult.tierTrend = await queryEngine.buildTierTrend(districtCode, popData._industry, 'pop');
      }
    }
  } else if (intent.industry && districtCode) {
    queryResult.record = await queryEngine.queryRecord(districtCode, intent.industry, month);
    if (queryResult.record) {
      if (intent.questionType === 'sales' || intent.questionType === 'upso') {
        queryResult.comparison = intent.questionType === 'sales'
          ? queryEngine.buildComparison(queryResult.record)
          : queryEngine.buildUpsoComparison(queryResult.record);
        // 중분류 비교 (같은 중분류 내 소분류끼리)
        if (intent.questionType === 'sales') {
          queryResult.midCategoryComparison = await queryEngine.getMidCategoryComparison(districtCode, intent.industry, month);
        }
        // 3계층 12개월 시계열 (TrendCard) — 업소 수 질문이면 upso 지표 사용
        const tierMetric = intent.questionType === 'upso' ? 'upso' : 'amt';
        queryResult.tierTrend = await queryEngine.buildTierTrend(districtCode, intent.industry, tierMetric);
      }
      if (intent.questionType === 'trend') {
        queryResult.trend = await queryEngine.buildTrend(districtCode, intent.industry);
        queryResult.tierTrend = await queryEngine.buildTierTrend(districtCode, intent.industry, 'amt');
      }
      if (intent.questionType === 'similar') queryResult.similar = queryEngine.getSimilar(queryResult.record);
      if (intent.questionType === 'pop') {
        queryResult.population = queryEngine.getPopulationDetail(queryResult.record);
        queryResult.tierTrend = await queryEngine.buildTierTrend(districtCode, intent.industry, 'pop');
      }
    }
  }

  return queryResult;
}

async function pickDefaultCompareTarget(baseDistrict, industry, month) {
  if (!baseDistrict?.code || !dataLoader) return null;
  const compact = (v) => String(v || '').replace(/\s+/g, '');
  const toDistrict = (name) => dataLoader.getDistrictByName?.(name);

  try {
    const record = await queryEngine.queryRecord(baseDistrict.code, industry, month);
    const similar = queryEngine.getSimilar(record);
    for (const item of similar) {
      const candidate = toDistrict(item.district);
      if (candidate && candidate.code !== baseDistrict.code) {
        return { code: candidate.code, name: candidate.name, sgg: candidate.sgg, autoReason: '유사 상권' };
      }
    }
  } catch { /* optional */ }

  const list = dataLoader.getDistrictList?.() || [];
  const numbered = String(baseDistrict.name || '').match(/^(.+?)(\d+)동$/);
  if (numbered) {
    const [, prefix, rawNo] = numbered;
    const currentNo = Number(rawNo);
    const sibling = list
      .filter(d => d.sgg === baseDistrict.sgg && d.code !== baseDistrict.code)
      .map(d => ({ district: d, match: d.name.match(new RegExp(`^${prefix}(\\d+)동$`)) }))
      .filter(item => item.match)
      .map(item => ({ ...item, no: Number(item.match[1]) }))
      .sort((a, b) => Math.abs(a.no - currentNo) - Math.abs(b.no - currentNo))[0];
    if (sibling?.district) {
      return { code: sibling.district.code, name: sibling.district.name, sgg: sibling.district.sgg, autoReason: '같은 생활권' };
    }
  }

  const fallback = list.find(d => d.sgg === baseDistrict.sgg && d.code !== baseDistrict.code && compact(d.name) !== compact(baseDistrict.name));
  return fallback ? { code: fallback.code, name: fallback.name, sgg: fallback.sgg, autoReason: '같은 구 비교군' } : null;
}

async function streamNarrative(handle, response) {
  const ctx = {
    ...response.narrativeContext,
    conversationHistory: chatUI.getConversationHistory(),
  };

  chatUI.startStreaming(handle);
  let fullText = '';
  let streamAborted = false;

  try {
    for await (const chunk of geminiNarrator.streamNarrative(ctx)) {
      fullText += chunk;
      chatUI.appendToStream(handle, chunk);
    }
  } catch (err) {
    streamAborted = true;
    console.warn('[GeminiNarrator] streaming error:', err.message);
  }

  // Gemini 문장 미완성 → 로컬 내러티브로 교체 (정상 완료 포함)
  const trimmed = fullText.trim();
  if (!trimmed) {
    const localText = buildLocalNarrative(response);
    handle.narrative.textContent = localText;
    chatUI.finishStream(handle, localText);
    return;
  }
  const isComplete = /[.!?。]$/.test(trimmed) || /[다요죠음임네까]$/.test(trimmed);
  if (trimmed.length > 0 && !isComplete) {
    const localText = buildLocalNarrative(response);
    handle.narrative.textContent = localText;
    chatUI.finishStream(handle, localText);
    return;
  }

  chatUI.finishStream(handle, fullText);
}

function buildLocalNarrative(response) {
  const type = response?.narrativeContext?.questionType || '';
  const district = response?.header?.district || response?.narrativeContext?.district || '';
  const sgg = response?.header?.sgg || response?.narrativeContext?.sgg || '';
  const region = district || sgg || '해당 지역';
  const industry = response?.header?.industry || response?.narrativeContext?.industry || '해당 업종';
  const cells = response?.statsCard?.cells || [];
  const summary = response?.summary?.text || '';
  const bullets = response?.summary?.bullets || [];

  const findCell = (label) => cells.find(c => String(c.label || '').includes(label));
  const value = (label) => {
    const c = findCell(label);
    if (!c) return '';
    return `${c.value}${c.unit || ''}`;
  };

  if (type === 'density') {
    const popPerStore = value('업소당 유동인구');
    const salesPerStore = value('업소당 월평균 매출');
    const stores = value('업소 수');
    const pop = value('유동인구');
    return [
      `${region} ${industry}${josa(industry, '은/는')} **업소당 유동인구 ${popPerStore || '-'}**가 핵심입니다.`,
      stores && pop ? `현재 ${stores} 업소가 ${pop} 유동인구를 나눠 갖는 구조입니다.` : summary,
      salesPerStore ? `매출까지 보면 **업소당 월평균 매출 ${salesPerStore}** 수준입니다.` : '',
      response?.compareCard?.title ? `${response.compareCard.title} 그래프에서 주변 기준과 밀도를 비교해 보세요.` : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'sggIndustry') {
    const avg = value('행정동 평균 업소당 월매출');
    const top = value('상위 10%');
    const bottom = value('하위 10%');
    const topText = bullets.find(b => String(b).includes('상위 10%')) || '';
    const bottomText = bullets.find(b => String(b).includes('하위 10%')) || '';
    return [
      `${sgg || region} ${industry}${josa(industry, '은/는')} 최근 기준 **행정동 평균 업소당 월매출 ${avg || '-'}**입니다.`,
      top || bottom ? `비교군은 **상위 10% ${top || '-'}**, **하위 10% ${bottom || '-'}**로 잡았습니다.` : '',
      response?.trendCard?.title ? `${response.trendCard.title}에서 평균선과 상·하위 비교군의 흐름을 함께 확인할 수 있습니다.` : '',
      topText || bottomText ? [topText, bottomText].filter(Boolean).join(' ') : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'trend') {
    const latest = value('업소당 월평균 매출') || value('행정동 평균 업소당 월매출');
    return [
      latest ? `${region} ${industry}의 현재 핵심값은 **${latest}**입니다.` : summary,
      response?.trendCard?.title ? `${response.trendCard.title}에서 최근 흐름을 확인하세요.` : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'merge') {
    const sales = value('평균 업소당 월매출');
    const stores = value('총 업소');
    return [
      `${region} ${industry}${josa(industry, '은/는')} 여러 행정동을 묶어 본 결과입니다.`,
      sales ? `핵심은 **평균 업소당 월매출 ${sales}**입니다.` : summary,
      stores ? `업소 규모는 **${stores}**로 집계했습니다.` : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'sales') {
    const amt = value('업소당 월평균 매출') || value('매출');
    const yoy = value('전년동월');
    // 데이터 없음 + 대안 bullets 있으면 대안 안내 포함
    if (amt === '데이터 없음' || !amt) {
      const altBullets = bullets.filter(b => b.includes('인기 업종') || b.includes('가능'));
      return [
        summary,
        ...altBullets,
        altBullets.length ? '아래 추천 질문을 눌러보세요.' : '다른 업종이나 인근 행정동으로 조회해 보세요.',
      ].filter(Boolean).join(' ');
    }
    return [
      amt ? `${region} ${industry}의 **업소당 월평균 매출은 ${amt}**입니다.` : summary,
      yoy ? `전년동월 대비 ${yoy} 변동했습니다.` : '',
      response?.trendCard?.title ? `${response.trendCard.title}에서 흐름을 확인하세요.` : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'upso') {
    const stores = value('업소 수') || value('업소');
    return [
      stores ? `${region} ${industry}${josa(industry, '은/는')} 현재 **${stores}** 영업 중입니다.` : summary,
      response?.trendCard?.title ? `${response.trendCard.title}에서 변동 추이를 확인하세요.` : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'pop') {
    const pop = value('유동인구') || value('일평균 유동인구');
    const peakDay = value('피크 요일');
    const peakTime = value('피크 시간대');
    const peakParts = [peakDay, peakTime].filter(Boolean).join(' ');
    return [
      pop ? `${region}${industry ? ' ' + industry + ' 주변' : ''} **일평균 유동인구는 ${pop}**입니다.` : summary,
      peakParts ? `주로 **${peakParts}**에 붐빕니다.` : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'similar') {
    return [
      summary || `${region} ${industry}${josa(industry, '과/와')} 비슷한 상권을 찾았습니다.`,
      response?.compareCard?.title ? `${response.compareCard.title} 그래프에서 유사도를 비교해 보세요.` : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'compare') {
    return [
      summary || `두 지역의 ${industry} 데이터를 비교했습니다.`,
      response?.compareCard?.title ? `${response.compareCard.title} 그래프에서 차이를 확인하세요.` : '',
      response?.trendCard?.title ? `추세 비교도 함께 보세요.` : '',
    ].filter(Boolean).join(' ');
  }

  if (type === 'overview') {
    const totalInd = value('업종 수') || value('전체 업종');
    const totalAmt = value('합계 매출') || value('총 매출');
    const avgAmt = value('업종 평균 업소당 월매출') || value('평균 업소당 월매출');
    return [
      `${region} 전체 상권 현황입니다.`,
      totalInd ? `**${totalInd}** 업종이 영업 중${totalAmt || avgAmt ? '이고' : '입니다.'}` : '',
      totalAmt ? `합계 매출은 **${totalAmt}**입니다.` : '',
      !totalAmt && avgAmt ? `업종 평균 업소당 월매출은 **${avgAmt}**입니다.` : '',
      summary && !totalInd ? summary : '',
    ].filter(Boolean).join(' ');
  }

  const highlights = cells.slice(0, 2)
    .map(c => `**${c.label} ${c.value}${c.unit || ''}**`)
    .join(', ');
  const chart = response?.trendCard?.title
    ? `${response.trendCard.title}도 함께 확인하세요.`
    : response?.compareCard?.title
      ? `${response.compareCard.title} 그래프를 함께 보세요.`
      : '';
  return [summary || `${region} ${industry} 데이터를 확인했습니다.`, highlights, chart]
    .filter(Boolean)
    .join(' ');
}

async function renderChartsInContainer(container) {
  try {
    const { ChartRenderer } = await import('./chart-renderer.js');
    window._chartRenderer = window._chartRenderer || new ChartRenderer();
    const canvases = ui.getChartCanvases(container);
    for (const canvas of canvases) {
      try {
        const chartData = JSON.parse(canvas.dataset.chart);
        window._chartRenderer.render(canvas, chartData);
      } catch { /* skip */ }
    }
  } catch { /* charts optional */ }
}

function buildDemoResponse(question) {
  return {
    header: { question, monthDisplay: '2026년 2월', district: null, sgg: null, industry: null },
    summary: { text: '데모 모드', bullets: ['엔진 모듈이 아직 로드되지 않았습니다.', 'data/ 폴더에 JSON 데이터를 빌드한 뒤 다시 시도해 주세요.'] },
    details: [],
    insights: [],
    followUps: ['중앙동 어때?', '둔산1동 카페 매출', '유성구 편의점 추세'],
    dataNotice: '현재 데모 모드입니다.',
    disambiguation: null,
  };
}

function buildDisambiguationResponse(intent) {
  const districtAmbiguity = intent.ambiguities?.find(a => a.type === 'district');
  return {
    header: { question: intent.question, monthDisplay: null, district: null, sgg: intent.sgg, industry: intent.industry },
    summary: { text: '어느 지역을 확인할까요?', bullets: [] },
    details: [],
    insights: [],
    followUps: [],
    dataNotice: null,
    disambiguation: {
      message: districtAmbiguity?.message || '해당하는 지역이 여러 곳입니다. 아래에서 선택해 주세요.',
      candidates: intent.districtCandidates.map(d => {
        const name = d.sgg ? `${d.sgg} ${d.name}` : d.name;
        const parts = [name];
        if (intent.industry) parts.push(intent.industry);
        parts.push(intent.questionType === 'overview' ? '어때?' : '매출 어때?');
        return parts.join(' ');
      }),
    },
  };
}

function buildIndustryDisambiguationResponse(intent) {
  const industryAmbiguity = intent.ambiguities?.find(a => a.type === 'industry');
  const districtName = intent.district?.name || '';
  return {
    header: { question: intent.question, monthDisplay: null, district: districtName, sgg: intent.sgg, industry: null },
    summary: { text: industryAmbiguity?.message || '어떤 유형을 확인할까요?', bullets: [] },
    details: [],
    insights: [],
    followUps: [],
    dataNotice: null,
    disambiguation: {
      message: industryAmbiguity?.message || '업종 유형을 선택해 주세요.',
      candidates: (intent.industryCandidates || []).map(ind => {
        const parts = [];
        if (districtName) parts.push(districtName);
        parts.push(ind);
        parts.push('매출 어때?');
        return parts.join(' ');
      }),
    },
  };
}

function buildSggDisambiguationResponse(intent, sggDistricts) {
  return {
    header: { question: intent.question, monthDisplay: null, district: null, sgg: intent.sgg, industry: intent.industry },
    summary: { text: `${intent.sgg}에 ${sggDistricts.length}개 행정동이 있습니다. 행정동을 선택해 주세요.`, bullets: [] },
    details: [],
    insights: [],
    followUps: [],
    dataNotice: null,
    disambiguation: {
      message: '확인할 행정동을 선택하면 더 정확히 볼 수 있습니다.',
      candidates: sggDistricts.slice(0, 10).map(d => {
        const parts = [d.name];
        if (intent.industry) parts.push(intent.industry);
        parts.push(intent.questionType === 'overview' ? '어때?' : '매출 어때?');
        return parts.join(' ');
      }),
    },
  };
}

/* ═══════════════
   WELCOME CHIPS (동적 생성)
   ═══════════════ */

function refreshWelcomeChips(dl) {
  const container = document.getElementById('welcomeChips');
  if (!container) return;

  const districts = dl.getDistrictList();
  const sggs = [...new Set(districts.map(d => d.sgg))];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const popularInds = ['카페', '편의점', '치킨', '한식', '미용실', '분식', '약국'];
  const validInds = popularInds.filter(i => dl.getIndustryList().some(a => a.includes(i)));

  // 3가지 유형: 행정동+업종, 행정동 종합, 구+업종
  const d1 = pick(districts);
  const ind1 = pick(validInds) || '카페';
  const d2 = pick(districts.filter(d => d.sgg !== d1.sgg));
  const sgg = pick(sggs);
  const ind2 = pick(validInds.filter(i => i !== ind1)) || '편의점';

  const suggestions = [
    { q: `${d1.name} ${ind1} 매출 어때?`, label: `${d1.name} ${ind1} 매출` },
    { q: `${d2.name} 어때?`, label: `${d2.name} 종합 현황` },
    { q: `${sgg} ${ind2} 최근 추세는?`, label: `${sgg} ${ind2} 추세` },
  ];

  container.innerHTML = suggestions.map(s =>
    `<button type="button" class="suggest-btn" data-q="${s.q}">${s.label}<span class="suggest-arrow">&rarr;</span></button>`
  ).join('');
}

/* ═══════════════
   EVENT BINDING
   ═══════════════ */

ui.onSubmit(handleQuestion);
ui.onChipClick(handleQuestion);
chatUI.onReportAction((event) => reportExporter.handleAction(event));
ui.onHistoryClick((q) => {
  ui.setQuestion(q);
  handleQuestion(q);
});

// 새 대화 버튼
ui.onNewChat(() => {
  chatUI.resetConversation();
  conversationState.clear();
  responseOrchestrator?.clearAdvisor();
  ui.clearHistory();
  ui.setQuestion('');
  _lastMapSig = null;
});

init();
