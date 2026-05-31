/**
 * test-runner.js — 테스트 오케스트레이션 엔진
 *
 * main.js의 init + runQuery + responseBuilder.build 파이프라인을 재현하여
 * 프로덕션 모듈을 직접 호출한다. Gemini 없이 로컬 전용으로 동작.
 */

// 캐시 방지: 개발 시 항상 최신 코드 로드
const _v = '?v=' + Date.now();
const { generateTestCases } = await import('./test-suites.js' + _v);
const { TestReport } = await import('./test-report.js' + _v);

const BATCH_SIZE = 200;
const CASE_TIMEOUT_MS = 5000;  // 케이스당 최대 5초

export class TestRunner {
  constructor() {
    this.dataLoader = null;
    this.intentParser = null;
    this.queryEngine = null;
    this.responseBuilder = null;
    this.results = [];
    this.stats = { total: 0, pass: 0, fail: 0, error: 0, skip: 0 };
  }

  /** main.js init()과 동일한 순서로 프로덕션 모듈 초기화 */
  async init() {
    const { DataLoader } = await import('./data-loader.js' + _v);
    const { IntentParser } = await import('./intent-parser.js' + _v);
    const { QueryEngine } = await import('./query-engine.js' + _v);
    const { ResponseBuilder } = await import('./response-builder.js' + _v);
    const { ToolDispatcher } = await import('./tool-dispatcher.js' + _v);
    const { ResponseOrchestrator } = await import('./response-orchestrator.js' + _v);
    const { ConversationState } = await import('./conversation-state.js' + _v);
    const { AgentAnalyst } = await import('./agent-analyst.js' + _v);

    this.dataLoader = new DataLoader('./data/');
    await this.dataLoader.init();

    this.intentParser = new IntentParser(
      this.dataLoader.getDistrictList(),
      this.dataLoader.getIndustryList(),
      this.dataLoader.getIndustryAliases(),
      this.dataLoader.getMatchingDictionaries()
    );

    this.queryEngine = new QueryEngine(this.dataLoader);
    this.responseBuilder = new ResponseBuilder();

    // production 실행 경로 + 맥락(꼬리물기) 재현용 컴포넌트
    this.dispatcher = new ToolDispatcher(this.queryEngine, this.dataLoader);
    this._analyst = new AgentAnalyst(() => null);       // 키 없음 → 로컬 _fallbackToolPlan
    this._ConversationState = ConversationState;
    this._orch = new ResponseOrchestrator({
      dataLoader: this.dataLoader,
      intentParser: this.intentParser,
      agentAnalyst: this._analyst,
      toolDispatcher: this.dispatcher,
      responseBuilder: this.responseBuilder,
    });

    // 82개 행정동 데이터 미리 캐시 (merge 테스트 등에서 동시 fetch 방지)
    const districts = this.dataLoader.getDistrictList();
    await Promise.all(districts.map(d => this.dataLoader.loadDistrict(d.code)));
  }

  /** 회귀/지역전환 케이스에 넘길 컨텍스트 */
  _ctx() {
    return {
      dispatcher: this.dispatcher,
      intentParser: this.intentParser,
      queryEngine: this.queryEngine,
      responseBuilder: this.responseBuilder,
      dataLoader: this.dataLoader,
      build: (tr) => (tr && tr.error ? null : this.responseBuilder.build(tr?.intent || {}, tr)),
      month: this.dataLoader.getLatestMonth(),
    };
  }

  /** 지역전환 꼬리물기: chainSeq를 ConversationState+orchestrator carry로 순차 실행 */
  async _executeRegionSwitchChain(tc) {
    const errors = [];
    const cs = new this._ConversationState();
    const month = this.dataLoader.getLatestMonth();
    for (let i = 0; i < (tc.chainSeq || []).length; i++) {
      const q = tc.chainSeq[i];
      try {
        const localIntent = this.intentParser.parse(q);
        let plan = this._orch._localIntentToIntentPlan(localIntent, q);
        plan = this._orch._preferExplicitQuestionSlots(q, plan);
        plan = this._orch._enrichVagueCompareIntent(this._orch._fillFromConversation(plan, cs));
        const toolPlan = this._analyst._fallbackToolPlan(plan);
        if (!toolPlan.toolCalls?.length) {
          if (i > 0 && tc.expectCarryIndustry) errors.push({ phase: 'chain', message: `지역전환 "${q}": 분석 불가(clarify) — 업종 carry 실패` });
          if (i > 0 && tc.expectCompare) errors.push({ phase: 'chain', message: `법정동 비교 "${q}": 비교가 생성되지 않고 clarify로 빠짐` });
          continue;
        }
        const fc = this._orch._alignToolCallWithIntent(toolPlan.toolCalls[0], plan);
        const toolResult = await this.dispatcher.dispatch(fc);
        const intent = toolResult.intent || {};
        const response = toolResult.error ? null : this.responseBuilder.build(intent, toolResult);

        if (i > 0 && tc.expectCarryIndustry) {
          const got = intent.industry || plan.industry || (fc.args && fc.args.industry) || null;
          if (got !== tc.expectCarryIndustry) {
            errors.push({ phase: 'chain', message: `지역전환 "${q}": 업종 carry 실패 (기대="${tc.expectCarryIndustry}", 실제="${got}")` });
          }
        }
        if (i > 0 && tc.expectCompare) {
          if (fc.name !== 'compareDistricts') {
            errors.push({ phase: 'chain', message: `법정동 비교 "${q}": compareDistricts 미생성 (tool=${fc.name})` });
          } else if (toolResult.error) {
            errors.push({ phase: 'chain', message: `법정동 비교 "${q}": 비교 실행 에러 — ${toolResult.error}` });
          } else if (Array.isArray(tc.expectCompareDistricts)) {
            const c1 = intent.district?.codes?.length || 1;
            const c2 = intent.compareTarget?.codes?.length || 1;
            if (c1 < 2 || c2 < 2) errors.push({ phase: 'chain', message: `법정동 비교 "${q}": 한쪽이 merge 안 됨 (codes ${c1}/${c2})` });
          }
        }
        if (response) errors.push(...this._validateNoLeakJosa(response, `chain:${q}`));
        cs.update(intent, toolResult, response);
      } catch (err) {
        errors.push({ phase: 'chain', message: `지역전환 "${q}" 실행 에러: ${err.message}` });
      }
    }
    return errors;
  }

  /** 응답에서 누출/조사 오류 빠른 스캔 (지역전환 체인용) */
  _validateNoLeakJosa(response, where) {
    const errors = [];
    const s = JSON.stringify(response || {});
    const leak = (s.match(/NaN|Infinity|undefined|\[object Object\]/) || [])[0];
    if (leak) errors.push({ phase: 'chain', message: `${where} 값 누출: ${leak}` });
    const josa = (s.match(/(카페|피자|호프|헤어|유동인구|밀도)은[\s,."\\]/) || s.match(/유동인구이[\s,.]/) || s.match(/업소\s*수은[\s,.]/) || [])[0];
    if (josa) errors.push({ phase: 'chain', message: `${where} 조사 오류: ${josa.trim()}` });
    return errors;
  }

  /**
   * 테스트 실행
   * @param {number} level - 1, 2, or 3
   * @param {(progress: {completed:number, total:number}) => void} onProgress
   * @returns {Promise<Array>} results
   */
  async run(level, onProgress) {
    this.results = [];
    this.stats = { total: 0, pass: 0, fail: 0, error: 0, skip: 0 };

    const testCases = generateTestCases(level, this.dataLoader);
    this.stats.total = testCases.length;

    await this._runBatch(testCases, onProgress);

    // 다리(bridge): 실패를 관리자 페이지 오류신고 저장소(localStorage)에 기록
    this.lastExported = this.exportFailuresToErrorReports();

    return this.results;
  }

  /**
   * 다리: 실패/에러 케이스를 commercial_ai_error_reports(localStorage)에 기록.
   * admin-reports.html이 같은 origin에서 자동으로 읽어 "오류 신고"에 표시.
   * @returns {number} 새로 기록된 건수
   */
  exportFailuresToErrorReports() {
    if (typeof localStorage === 'undefined') return 0;
    const KEY = 'commercial_ai_error_reports';
    let existing = [];
    try { existing = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { existing = []; }
    const byId = {};
    existing.forEach((r) => { if (r && r.id) byId[r.id] = r; });
    const now = new Date().toISOString();
    const ver = (typeof document !== 'undefined' && document.documentElement?.dataset?.aiModuleVersion) || 'test-run';
    let added = 0;
    for (const r of this.results) {
      if (r.status === 'pass' || r.status === 'skip') continue;
      const id = `auto-${r.category || 'test'}-${String(r.id || Math.random().toString(36).slice(2))}`;
      byId[id] = {
        id,
        createdAt: now,
        question: r.question || `[${r.category}] ${r.id}`,
        source: '자동 테스트(test.html)',
        severity: r.status === 'error' ? 'high' : 'mid',
        category: `자동탐지 · ${r.category || 'test'}`,
        flags: [
          { level: r.status === 'error' ? 'error' : 'warn', label: r.status === 'error' ? '크래시/에러' : '검증 실패' },
          { level: 'info', label: r.category || 'test' },
        ],
        diagnostics: { moduleVersion: ver, level: r.level, elapsedMs: Math.round(r.elapsed || 0), detector: 'test-suites' },
        answerText: (r.errors || []).map((e) => `[${e.phase}] ${e.message}`).join('  /  ').slice(0, 800),
        status: 'open',
      };
      added++;
    }
    const merged = Object.values(byId)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 500);
    try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch { /* quota */ }
    return added;
  }

  // ── Batch Execution ──

  async _runBatch(testCases, onProgress) {
    for (let i = 0; i < testCases.length; i += BATCH_SIZE) {
      const batch = testCases.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(tc => this._withTimeout(this._executeTestCase(tc), tc))
      );

      for (const item of settled) {
        const result = item.status === 'fulfilled'
          ? item.value
          : { status: 'error', errors: [{ phase: 'crash', message: item.reason?.message || 'Unknown' }] };

        this.results.push(result);
        this.stats[result.status] = (this.stats[result.status] || 0) + 1;
      }

      if (onProgress) {
        onProgress({ completed: Math.min(i + batch.length, testCases.length), total: testCases.length });
      }

      // UI 스레드 양보 (MessageChannel — setTimeout 스로틀링 우회)
      await new Promise(r => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => r();
        ch.port2.postMessage(null);
      });
    }
  }

  /** 케이스별 타임아웃 래퍼 — hang 방지 */
  _withTimeout(promise, tc) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout ${CASE_TIMEOUT_MS}ms: ${tc.id}`)), CASE_TIMEOUT_MS)
      ),
    ]);
  }

  /**
   * Phase 5: follow-up 칩을 실제로 실행하여 체인 응답 검증
   * 각 follow-up 텍스트를 IntentParser에 넣고, 파이프라인을 재실행한다.
   */
  async _executeFollowUpChain(response, parentIntent) {
    const errors = [];
    const texts = this._extractFollowUpTexts(response);

    if (texts.length === 0) {
      errors.push({ phase: 'chain', message: 'follow-up 칩이 0개 (최소 1개 이상 기대)' });
      return errors;
    }

    const month = this.dataLoader.getLatestMonth();

    for (const chipText of texts) {
      try {
        // 1. follow-up 텍스트를 IntentParser로 파싱
        const intent2 = this.intentParser.parse(chipText);

        if (!intent2) {
          errors.push({ phase: 'chain', message: `follow-up 파싱 실패: "${chipText}"` });
          continue;
        }

        // merge 감지 재현
        if ((intent2.usedLegalDongAlias || intent2.usedLocationAlias)
            && intent2.districtCandidates?.length > 1
            && intent2.industry) {
          intent2.questionType = 'merge';
          intent2.mergeDistricts = intent2.districtCandidates;
          intent2.sourceLocation = intent2.question.match(/[가-힣]+동/)?.[0]
            || intent2.locationAlias || '';
          intent2.district = {
            ...intent2.districtCandidates[0],
            name: intent2.sourceLocation
              || intent2.districtCandidates.map(d => d.name).join(' + '),
          };
          intent2.sgg = intent2.districtCandidates[0]?.sgg || intent2.sgg;
          intent2.districtCandidates = [];
          intent2.ambiguities = [];
        }

        // SGG-only routing
        if (intent2.sgg && intent2.industry && !intent2.district) {
          const rankIntent = /(높|상위|1위|순위|랭킹|많|잘\s*되는)/.test(intent2.question || '')
            && !/(업종별|상위\s*업종|1위\s*업종|다른\s*업종)/.test(intent2.question || '');
          if (rankIntent) {
            intent2.questionType = 'rankDistricts';
            intent2.metric = /(업소|점포|가게)/.test(intent2.question || '') ? 'stores' : 'sales';
          } else {
            const metricMap = { sales: 'sales', upso: 'stores', pop: 'population', trend: 'trend' };
            intent2.metric = metricMap[intent2.questionType] || 'trend';
            intent2.questionType = 'sggIndustry';
          }
        }

        // 2. 쿼리 실행
        const code2 = intent2.district?.code || null;
        const qr2 = await this._runQuery(intent2, code2, month);

        // 3. 응답 빌드
        const resp2 = this.responseBuilder.build(intent2, qr2);

        if (!resp2) {
          errors.push({ phase: 'chain', message: `체인 응답 null: "${chipText}"` });
        }

        // 4. 내부 merge 라벨 패턴 검사
        const chainFollowUps = this._extractFollowUpTexts(resp2);
        const mergePattern = /[가-힣]+\d*동\s*\+\s*[가-힣]+\d*동/;
        for (const ft of chainFollowUps) {
          if (mergePattern.test(ft)) {
            errors.push({
              phase: 'chain',
              message: `체인 응답에서 merge 라벨 노출: "${ft}" (원문: "${chipText}")`,
            });
          }
        }

      } catch (err) {
        errors.push({
          phase: 'chain',
          message: `체인 실행 에러: "${chipText}" → ${err.message}`,
        });
      }
    }

    return errors;
  }

  /** response에서 follow-up 텍스트 배열 추출 (다양한 구조 대응) */
  _extractFollowUpTexts(response) {
    const followUps = response?.followUps;
    if (!followUps) return [];
    if (Array.isArray(followUps)) {
      return followUps.map(f => typeof f === 'string' ? f : f?.text || '').filter(Boolean);
    }
    if (followUps.groups) {
      return followUps.groups
        .flatMap(g => (g.chips || []).map(c => c?.text || ''))
        .filter(Boolean);
    }
    return [];
  }

  // ── Single Test Case ──

  async _executeTestCase(tc) {
    const start = performance.now();
    const result = {
      ...tc,
      status: 'pass',
      errors: [],
      elapsed: 0,
      // validators는 직렬화 불필요하므로 제거
    };
    delete result.validators;
    delete result.directTest;

    // 회귀 케이스: production 컴포넌트를 directTest로 직접 검사
    if (tc.directTest) {
      try {
        const errs = await tc.directTest(this._ctx());
        result.errors.push(...(errs || []));
      } catch (err) {
        result.errors.push({ phase: 'regression', message: `directTest 에러: ${err.message}` });
      }
      result.status = result.errors.length ? 'fail' : 'pass';
      result.elapsed = performance.now() - start;
      return result;
    }
    // 지역전환 꼬리물기: ConversationState+orchestrator carry로 순차 실행
    if (tc.regionSwitchTest) {
      try {
        result.errors.push(...(await this._executeRegionSwitchChain(tc)));
      } catch (err) {
        result.errors.push({ phase: 'chain', message: `지역전환 체인 에러: ${err.message}` });
      }
      result.status = result.errors.length ? 'fail' : 'pass';
      result.elapsed = performance.now() - start;
      return result;
    }

    try {
      // Phase 1: Intent Parsing
      const intent = this.intentParser.parse(tc.question);
      const intentErrors = tc.validators.intent(intent, tc);
      if (intentErrors.length) result.errors.push(...intentErrors);

      // ── main.js의 merge 감지 로직 재현 (lines 548-556) ──
      if ((intent.usedLegalDongAlias || intent.usedLocationAlias)
          && intent.districtCandidates?.length > 1
          && intent.industry) {
        intent.questionType = 'merge';
        intent.mergeDistricts = intent.districtCandidates;
        intent.sourceLocation = intent.question.match(/[가-힣]+동/)?.[0]
          || intent.locationAlias || '';
        intent.district = {
          ...intent.districtCandidates[0],
          name: intent.sourceLocation
            || intent.districtCandidates.map(d => d.name).join(' + '),
        };
        intent.sgg = intent.districtCandidates[0]?.sgg || intent.sgg;
        intent.districtCandidates = [];
        intent.ambiguities = [];
      }

      // ── SGG-only routing (main.js lines 580-590) ──
      if (intent.sgg && intent.industry && !intent.district) {
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
      }

      // Phase 2: Query
      const districtCode = intent.district?.code || null;
      const month = this.dataLoader.getLatestMonth();

      const queryResult = await this._runQuery(intent, districtCode, month);
      const record = queryResult.record || null;

      const queryErrors = tc.validators.query(record, intent, tc);
      if (queryErrors.length) result.errors.push(...queryErrors);

      // Phase 3: Response Build
      const response = this.responseBuilder.build(intent, queryResult);
      const responseErrors = tc.validators.response(response, intent, tc);
      if (responseErrors.length) result.errors.push(...responseErrors);

      // Phase 4: Follow-up Validation
      const followUpErrors = tc.validators.followUp(response, intent, tc);
      if (followUpErrors.length) result.errors.push(...followUpErrors);

      // Phase 5: Follow-up Chain (꼬리물기 테스트)
      if (tc.chainTest && response) {
        const chainErrors = await this._executeFollowUpChain(response, intent);
        if (chainErrors.length) result.errors.push(...chainErrors);
      }

      result.status = result.errors.length > 0 ? 'fail' : 'pass';

    } catch (err) {
      result.status = 'error';
      result.errors.push({
        phase: 'crash',
        message: `${err.message}\n${(err.stack || '').split('\n').slice(0, 3).join('\n')}`,
      });
    }

    result.elapsed = performance.now() - start;
    return result;
  }

  /**
   * main.js runQuery() 재현 — Gemini 없이 로컬 데이터만 사용
   */
  async _runQuery(intent, districtCode, month) {
    const queryResult = {};

    // merge
    if (intent.questionType === 'merge' && intent.mergeDistricts?.length >= 2) {
      const codes = intent.mergeDistricts.map(d => d.code);
      queryResult.mergeResult = await this.queryEngine.queryMergedDistricts(codes, intent.industry, month);
      if (queryResult.mergeResult) {
        if (intent.sourceLocation) queryResult.mergeResult.sourceLocation = intent.sourceLocation;
        queryResult.record = queryResult.mergeResult.merged;
      }
      return queryResult;
    }

    // rankDistricts
    if (intent.questionType === 'rankDistricts' && intent.sgg && intent.industry) {
      queryResult.ranking = await this.queryEngine.rankDistrictsByIndustry(
        intent.sgg, intent.industry, intent.metric || 'sales', month, 10
      );
      return queryResult;
    }

    // sggIndustry
    if (intent.questionType === 'sggIndustry' && intent.sgg && intent.industry) {
      queryResult.sggResult = await this.queryEngine.buildSggIndustry(
        intent.sgg, intent.industry, intent.metric || 'trend', month
      );
      return queryResult;
    }

    // overview
    if (intent.questionType === 'overview') {
      if (districtCode) {
        queryResult.overview = await this.queryEngine.buildOverview(districtCode, month);
      }
      return queryResult;
    }

    // pop (업종 없이)
    if (intent.questionType === 'pop' && districtCode && !intent.industry) {
      const popData = await this.queryEngine.getDistrictPopulation(districtCode, month);
      if (popData) {
        queryResult.record = {
          pop: popData.pop, peakDay: popData.peakDay,
          peakTime: popData.peakTime, dataStatus: 'direct',
        };
        queryResult.population = popData;
      }
      return queryResult;
    }

    // 일반 업종+동 조합
    if (intent.industry && districtCode) {
      queryResult.record = await this.queryEngine.queryRecord(districtCode, intent.industry, month);

      if (queryResult.record) {
        const rec = queryResult.record;

        if (intent.questionType === 'sales' || intent.questionType === 'upso') {
          queryResult.comparison = intent.questionType === 'sales'
            ? this.queryEngine.buildComparison(rec)
            : this.queryEngine.buildUpsoComparison(rec);
          const tierMetric = intent.questionType === 'upso' ? 'upso' : 'amt';
          queryResult.tierTrend = await this.queryEngine.buildTierTrend(
            districtCode, intent.industry, tierMetric
          );
        }

        if (intent.questionType === 'trend') {
          queryResult.trend = await this.queryEngine.buildTrend(districtCode, intent.industry);
          queryResult.tierTrend = await this.queryEngine.buildTierTrend(
            districtCode, intent.industry, 'amt'
          );
        }

        if (intent.questionType === 'similar') {
          queryResult.similar = this.queryEngine.getSimilar(rec);
        }

        if (intent.questionType === 'pop') {
          queryResult.population = this.queryEngine.getPopulationDetail(rec);
          queryResult.tierTrend = await this.queryEngine.buildTierTrend(
            districtCode, intent.industry, 'pop'
          );
        }
      }
    }

    return queryResult;
  }
}

// ────────────────────────────────────────
// UI 연결 (test.html에서 로드 시 자동 바인딩)
// ────────────────────────────────────────

function bindUI() {
  const runBtn = document.getElementById('runBtn');
  const exportBtn = document.getElementById('exportBtn');
  const levelSelect = document.getElementById('levelSelect');
  if (!runBtn || !exportBtn || !levelSelect) return;

  const runner = new TestRunner();
  const report = new TestReport(
    document.getElementById('results'),
    document.getElementById('progress'),
    document.getElementById('summary')
  );

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    exportBtn.disabled = true;
    document.getElementById('results').innerHTML = '';
    document.getElementById('summary').innerHTML = '';

    try {
      runBtn.textContent = '초기화 중…';
      await runner.init();

      const level = Number(levelSelect.value);
      runBtn.textContent = '테스트 실행 중…';
      report.startTimer();

      const results = await runner.run(level, (progress) => {
        report.updateProgress(progress);
      });

      report.render(results, runner.stats);
      exportBtn.disabled = false;
    } catch (err) {
      document.getElementById('results').innerHTML =
        `<div class="summary-alert">초기화 실패: ${err.message}</div>`;
      console.error('[TestRunner]', err);
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '테스트 실행';
    }
  });

  exportBtn.addEventListener('click', () => {
    if (!runner.results.length) return;
    const html = report.exportHTML(runner.results, runner.stats);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `test-report-${new Date().toISOString().slice(0, 10)}.html`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ES module은 defer되지만, 브라우저에 따라 DOM 접근 시점이 다를 수 있으므로 안전 장치
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindUI);
} else {
  bindUI();
}
