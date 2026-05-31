/**
 * agent-analyst.js — Agent 2: 분석가
 * 조회된 데이터 + 질문 → 자연어 해설 스트리밍.
 * API Key: gemini_api_key_analyst
 *
 * 기존 gemini-narrator.js의 SSE 스트리밍 로직과 프롬프트 체계를 계승.
 */

export class AgentAnalyst {
  /**
   * @param {() => string|null} apiKeyGetter
   */
  constructor(apiKeyGetter) {
    this._model = 'gemini-2.5-flash';
    this._getKey = apiKeyGetter;
    this._maxTokens = 700;
    this._temperature = 0.4;
  }

  isAvailable() {
    return Boolean(this._getKey());
  }

  async planTools({ question, intentPlan, contextSummary, availableTools = [] }) {
    const fallback = this._fallbackToolPlan(intentPlan);
    const apiKey = this._getKey();
    if (!apiKey) return fallback;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this._model}:generateContent?key=${apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: this._plannerSystemPrompt() }] },
      contents: [{
        role: 'user',
        parts: [{ text: this._buildPlannerPrompt({ question, intentPlan, contextSummary, availableTools }) }],
      }],
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 460,
        responseMimeType: 'application/json',
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn('[AgentAnalyst] tool planning fallback:', err.message);
      return fallback;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn('[AgentAnalyst] tool planning API error:', response.status);
      if (response.status === 429) throw new Error('API 429');
      return fallback;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const parsed = this._safeJson(text);
    const normalized = this._normalizeToolPlan(parsed);
    return normalized || fallback;
  }

  /**
   * 데이터 기반 해설 스트리밍.
   * @param {object} params
   * @param {string} params.question
   * @param {string} params.toolName — 호출된 도구 이름
   * @param {object} params.toolResult — 도구 조회 결과 요약 (geminiSummary)
   * @param {string} params.contextSummary — 대화 맥락 요약
   * @yields {string} text chunk
   */
  async *streamAnalysis({ question, toolName, toolResult, contextSummary }) {
    const apiKey = this._getKey();
    if (!apiKey) return;

    const systemPrompt = this._getSystemPrompt(toolName);
    const userPrompt = this._buildDataPrompt(question, toolResult, contextSummary);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this._model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const body = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [
        { role: 'user', parts: [{ text: userPrompt }] },
      ],
      generationConfig: {
        temperature: this._temperature,
        maxOutputTokens: this._maxTokens,
      },
    };

    // AbortController + 10초 타임아웃
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      console.warn('[AgentAnalyst] 10초 타임아웃 — 스트리밍 중단');
    }, 10000);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.warn('[AgentAnalyst] 요청 타임아웃');
      } else {
        console.warn('[AgentAnalyst] fetch error:', err.message);
      }
      return;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      console.warn('[AgentAnalyst] API error:', response.status);
      if (response.status === 429) throw new Error('API 429');
      return;
    }

    // SSE 스트리밍 파싱 (gemini-narrator.js 패턴)
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (!json || json === '[DONE]') continue;
          try {
            const parsed = JSON.parse(json);
            const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) yield text;
          } catch { /* skip malformed SSE frame */ }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      reader.cancel().catch(() => {});
    }
  }

  /* ── System Prompts ── */

  _getSystemPrompt(toolName) {
    switch (toolName) {
      case 'compareDistricts': return this._comparePrompt();
      case 'getDistrictOverview': return this._overviewPrompt();
      case 'findSimilarDistricts': return this._similarPrompt();
      default: return this._defaultPrompt();
    }
  }

  _plannerSystemPrompt() {
    return `당신은 대전 상권 AI의 Data & Tool Planner입니다.
Intent Router가 만든 의도 계획을 보고, 필요한 로컬 데이터 도구를 선택하세요.
직접 답변하지 말고 실행 계획만 JSON으로 반환합니다.

사용 가능한 도구:
- analyzeDistrictIndustry: 행정동+업종의 매출, 업소 수, 유동인구, 추세
- getDistrictOverview: 행정동 전체 상권 현황
- compareDistricts: 두 행정동의 같은 업종 비교
- findSimilarDistricts: 특정 행정동+업종과 유사한 상권
- mergeDistricts: 여러 행정동 합산 분석
- rankDistrictsByIndustry: 특정 구 안에서 특정 업종의 매출/업소 수/유동인구가 높은 행정동 순위
- analyzeSggIndustry: 특정 구 전체에서 특정 업종의 현황과 최근 추세

규칙:
- 질문에 필요한 최소 도구를 고르세요.
- follow-up 질문에서 지역/업종이 생략되면 의도 계획의 보완값을 사용하세요.
- "다른 업종 매출", "업종별 매출", "상위 업종"은 getDistrictOverview를 선택하세요.
- "구 안에서 어떤 행정동이 높은가"는 rankDistrictsByIndustry를 선택하세요.
- "구 단위 특정 업종 현황/추세"는 analyzeSggIndustry를 선택하세요.
- 질문한 지표를 중심으로 도구를 고르세요. "매출 추세" 질문이면 유동인구를 기본 근거로 끼워 넣지 말고 매출 월별 추세와 비교군을 우선합니다.
- goal=density: analyzeDistrictIndustry를 metric=all로 호출하세요.
- 사용자가 법정동/생활권 이름을 말하면 행정동 이름을 다시 요구하지 말고 가능한 도구에 그대로 넘겨 해소되게 하세요.
- 필요한 슬롯이 없으면 action을 clarify로 두고 clarifyMessage를 작성하세요.
- 반드시 JSON만 반환하세요.`;
  }

  _buildPlannerPrompt({ question, intentPlan, contextSummary, availableTools }) {
    return `사용자 질문:
${question}

이전 맥락:
${contextSummary || '(없음)'}

의도 계획:
${JSON.stringify(intentPlan || {}, null, 2)}

도구 선언 요약:
${JSON.stringify(availableTools.map(t => ({ name: t.name, required: t.parameters?.required || [] })), null, 2)}

반환 JSON 형식:
{
  "action": "execute|clarify|answer",
  "toolCalls": [
    { "name": "analyzeDistrictIndustry", "args": { "district": "중앙동", "industry": "카페", "metric": "sales" }, "reason": "선택 이유" }
  ],
  "clarifyMessage": "부족한 조건이 있을 때 사용자에게 물을 문장",
  "answerText": "도구 없이 답할 때만",
  "planRationale": "선택 근거 한 문장"
}`;
  }

  _normalizeToolPlan(plan) {
    if (!plan || typeof plan !== 'object') return null;
    const action = ['execute', 'clarify', 'answer'].includes(plan.action) ? plan.action : 'execute';
    const allowed = new Set(['analyzeDistrictIndustry', 'getDistrictOverview', 'compareDistricts', 'findSimilarDistricts', 'mergeDistricts', 'rankDistrictsByIndustry', 'analyzeSggIndustry']);
    const toolCalls = Array.isArray(plan.toolCalls)
      ? plan.toolCalls
        .filter(call => allowed.has(call?.name))
        .map(call => ({ name: call.name, args: call.args || {}, reason: call.reason || '' }))
        .slice(0, 3)
      : [];
    return {
      action: toolCalls.length ? 'execute' : action,
      toolCalls,
      clarifyMessage: plan.clarifyMessage || '',
      answerText: plan.answerText || '',
      planRationale: plan.planRationale || '',
    };
  }

  _fallbackToolPlan(intentPlan = {}) {
    if (intentPlan.responseType === 'smalltalk' && intentPlan.directAnswer) {
      return { action: 'answer', toolCalls: [], answerText: intentPlan.directAnswer, clarifyMessage: '', planRationale: 'smalltalk' };
    }
    const goal = intentPlan.goal || 'unknown';
    const district = intentPlan.district;
    const industry = intentPlan.industry;
    const metric = intentPlan.metric || (goal === 'stores' ? 'stores' : goal === 'population' ? 'population' : goal === 'trend' ? 'trend' : 'sales');

    if (goal === 'overview' && district) {
      return { action: 'execute', toolCalls: [{ name: 'getDistrictOverview', args: { district }, reason: '지역 전체 현황 조회' }], clarifyMessage: '', answerText: '', planRationale: 'fallback overview' };
    }
    if (goal === 'rankDistricts' && intentPlan.sgg && industry) {
      return {
        action: 'execute',
        toolCalls: [{ name: 'rankDistrictsByIndustry', args: { sgg: intentPlan.sgg, industry, metric }, reason: '구 내 행정동 순위 조회' }],
        clarifyMessage: '',
        answerText: '',
        planRationale: 'fallback district ranking',
      };
    }
    if (goal === 'sggIndustry' && intentPlan.sgg && industry) {
      return {
        action: 'execute',
        toolCalls: [{ name: 'analyzeSggIndustry', args: { sgg: intentPlan.sgg, industry, metric: metric || 'trend' }, reason: '구 단위 업종 현황/추세 조회' }],
        clarifyMessage: '',
        answerText: '',
        planRationale: 'fallback sgg industry',
      };
    }
    if (goal === 'sales' && district && !industry) {
      return { action: 'execute', toolCalls: [{ name: 'getDistrictOverview', args: { district }, reason: '업종별 매출 순위 조회' }], clarifyMessage: '', answerText: '', planRationale: 'fallback industry ranking' };
    }
    if (goal === 'compare' && industry && intentPlan.compareDistricts?.length >= 2) {
      const [district1, district2] = intentPlan.compareDistricts;
      const cmpMetric = intentPlan.metric || 'sales';
      return { action: 'execute', toolCalls: [{ name: 'compareDistricts', args: { district1, district2, industry, metric: cmpMetric }, reason: '두 지역 비교' }], clarifyMessage: '', answerText: '', planRationale: 'fallback compare' };
    }
    if (goal === 'compare' && !industry && intentPlan.compareDistricts?.length >= 2) {
      const [d1, d2] = intentPlan.compareDistricts;
      return { action: 'clarify', toolCalls: [], clarifyMessage: `${d1}과 ${d2}를 비교하려면 업종을 알려주세요. 예: "${d1} ${d2} 카페 비교해줘"`, answerText: '', planRationale: 'compare missing industry' };
    }
    if (goal === 'similar' && district && industry) {
      return { action: 'execute', toolCalls: [{ name: 'findSimilarDistricts', args: { district, industry }, reason: '유사 상권 조회' }], clarifyMessage: '', answerText: '', planRationale: 'fallback similar' };
    }
    if (goal === 'merge' && industry && intentPlan.mergeDistricts?.length >= 2) {
      // 법정동 merge에서 특정 metric 요청 시 → analyzeDistrictIndustry로 보강 (merge + metric 데이터 함께 반환)
      if (['trend', 'stores', 'population'].includes(metric) && intentPlan.sourceLocation) {
        return { action: 'execute', toolCalls: [{ name: 'analyzeDistrictIndustry', args: { district: intentPlan.sourceLocation, industry, metric }, reason: '법정동 합산 + 지표 분석' }], clarifyMessage: '', answerText: '', planRationale: 'fallback merge with metric' };
      }
      return { action: 'execute', toolCalls: [{ name: 'mergeDistricts', args: { districts: intentPlan.mergeDistricts, industry, sourceLocation: intentPlan.sourceLocation || '' }, reason: '복수 지역 합산' }], clarifyMessage: '', answerText: '', planRationale: 'fallback merge' };
    }
    if (goal === 'compareIndustry' && district && intentPlan.industries?.length >= 2) {
      return { action: 'execute', toolCalls: [{ name: 'compareIndustries', args: { district, industries: intentPlan.industries, metric: metric || 'sales' }, reason: '같은 지역 업종 간 비교' }], clarifyMessage: '', answerText: '', planRationale: 'fallback compare industries' };
    }
    if (goal === 'density' && district && industry) {
      return { action: 'execute', toolCalls: [{ name: 'analyzeDistrictIndustry', args: { district, industry, metric: 'all' }, reason: '복합 지표 교차 비교 조회' }], clarifyMessage: '', answerText: '', planRationale: 'fallback density cross-metric' };
    }
    if (district && industry) {
      return { action: 'execute', toolCalls: [{ name: 'analyzeDistrictIndustry', args: { district, industry, metric }, reason: '지역+업종 지표 조회' }], clarifyMessage: '', answerText: '', planRationale: 'fallback district industry' };
    }
    if (district) {
      return { action: 'execute', toolCalls: [{ name: 'getDistrictOverview', args: { district }, reason: '업종 없는 지역 현황 조회' }], clarifyMessage: '', answerText: '', planRationale: 'fallback district overview' };
    }
    return {
      action: 'clarify',
      toolCalls: [],
      clarifyMessage: '지역이나 업종이 부족합니다. 예: "중앙동 카페 매출 어때?"처럼 물어봐 주세요.',
      answerText: '',
      planRationale: 'missing required slots',
    };
  }

  _safeJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* continue */ }
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  _defaultPrompt() {
    return `당신은 대전광역시 상권을 함께 읽어 주는 대화형 데이터 분석가입니다.
사용자에게 제공된 상권 데이터 분석 결과를 친숙한 답변처럼 자연스럽고 통찰력 있게 설명합니다.

규칙:
1. 반드시 한국어로만 답하세요.
2. 제공된 숫자 데이터만 사용하세요. 추측하거나 없는 데이터를 만들지 마세요.
3. "추천합니다", "창업하기 좋습니다", "유망합니다" 등 주관적 평가를 절대 하지 마세요.
4. 첫 문장은 사용자의 질문에 바로 답하세요. "조회 결과입니다"처럼 기계적인 서두로 시작하지 마세요.
5. 4-6문장으로 쓰세요. 짧은 요약보다 깊은 해석을 우선합니다.
6. 옆에서 설명하듯 친숙하고 차분하게 말하세요.
7. 핵심 수치 2-4개를 반드시 인용하고, 단위(만원, 개, 명, %)를 포함하세요.
8. 데이터 간 비교, 추세, 엇갈리는 신호, 이상치를 중심으로 서술하세요.
9. 행정동 직접값, 시군구 대체값(sgg_sub)은 구분해서 말하세요.
10. 같은 뜻을 반복하지 말고 문장마다 판단, 근거, 해석, 주의 중 하나를 맡기세요.
11. 수치의 맥락을 해석하세요: "600만원"이 아니라 "시군구 평균(X만원) 대비 Y% 높은/낮은 수준"처럼 비교 프레임을 제공하세요.
12. 엇갈리는 신호가 있으면 반드시 짚어 주세요: 예) "매출은 오르는데 업소 수는 줄고 있어 업소당 월평균 업소당 월매출은 올라가는 구조"
13. 대화 맥락이 있으면 이전 질문과 연결하세요: "아까 본 X동보다 매출은 높지만 유동인구는 적은 편이에요."`;
  }

  _comparePrompt() {
    return `당신은 대전광역시 상권을 비교 분석하는 대화형 데이터 분석가입니다.
두 행정동의 상권 데이터를 비교하여 차이점을 설명합니다.

규칙:
1. 반드시 한국어로만 답하세요.
2. 두 지역의 핵심 차이를 먼저 한 문장으로 요약하세요.
3. 어느 쪽이 더 높고 낮은지 구체적 수치로 비교하세요. 어느 쪽이 유리한지 판단을 함께 제시하세요.
4. 단순 나열보다 차이의 의미를 해석하세요: "매출은 A동이 높지만 업소 수도 많아 업소당 월평균 업소당 월매출로 보면 B동이 더 효율적"처럼.
5. "추천합니다" 등 주관적 평가를 하지 마세요.
6. 4-5문장으로 쓰세요.
7. 숫자를 언급할 때는 단위(만원, 개, 명, %)를 반드시 포함하세요.
8. 추세 방향이 다르면 반드시 짚으세요: "A동은 오르는 반면 B동은 내리는 추세"`;
  }

  _overviewPrompt() {
    return `당신은 대전광역시 상권 현황을 설명하는 대화형 데이터 분석가입니다.
행정동의 전체 상권 현황을 자연스럽게 설명합니다.

규칙:
1. 전체 업종 수, 매출 규모, 유동인구 핵심 지표 위주로 설명하세요.
2. 매출 상위 업종을 자연스럽게 언급하고, 왜 그 업종이 강한지 맥락을 짧게 추론하세요.
3. 유동인구 패턴(피크 요일/시간대)이 있으면 상권 성격과 연결해서 설명하세요.
4. "추천합니다" 등 주관적 평가를 하지 마세요.
5. 4-6문장으로 쓰세요. 숫자 나열보다 이 동네 상권의 성격을 그려주세요.
6. 숫자를 언급할 때는 단위를 포함하세요.`;
  }

  _similarPrompt() {
    return `당신은 대전광역시 유사 상권을 설명하는 대화형 데이터 분석가입니다.
기준 상권과 유사한 행정동들을 비교하여 설명합니다.

규칙:
1. 기준 상권의 핵심 지표를 먼저 간단히 언급하세요.
2. 유사 상권 목록에서 눈에 띄는 특징을 설명하세요.
3. "추천합니다" 등 주관적 평가를 하지 마세요.
4. 3-5문장으로 간결하게 쓰세요.`;
  }

  /* ── User Prompt Builder ── */

  _buildDataPrompt(question, toolResult, contextSummary) {
    const p = [];
    if (question) p.push(`사용자 질문: ${question}`);
    if (contextSummary) p.push(`대화 맥락: ${contextSummary}`);

    if (toolResult) {
      const dataLines = [];
      const fin = (v) => Number.isFinite(v);
      if (toolResult.district) dataLines.push(`지역: ${toolResult.district}`);
      if (toolResult.industry) dataLines.push(`업종: ${toolResult.industry}`);
      if (toolResult.month) dataLines.push(`기준월: ${toolResult.month}`);
      if (fin(toolResult.amt)) dataLines.push(`업소당 월평균 업소당 월매출: ${toolResult.amt.toLocaleString()}만원`);
      if (fin(toolResult.amtSgg)) dataLines.push(`시군구 평균 업소당 월매출: ${toolResult.amtSgg.toLocaleString()}만원`);
      if (fin(toolResult.amtSido)) dataLines.push(`시도 평균 업소당 월매출: ${toolResult.amtSido.toLocaleString()}만원`);
      if (fin(toolResult.amtYoY)) dataLines.push(`매출 전년동월 대비: ${toolResult.amtYoY}%`);
      if (fin(toolResult.amtMoM)) dataLines.push(`매출 전월 대비: ${toolResult.amtMoM}%`);
      if (fin(toolResult.upso)) dataLines.push(`업소 수: ${toolResult.upso}개`);
      if (fin(toolResult.pop)) dataLines.push(`일평균 유동인구: ${toolResult.pop.toLocaleString()}명`);
      if (toolResult.peakDay) dataLines.push(`피크 요일: ${toolResult.peakDay}`);
      if (toolResult.peakTime) dataLines.push(`피크 시간대: ${toolResult.peakTime}`);
      if (toolResult.dataStatus === 'sgg_sub') dataLines.push('(행정동 직접값 없음, 시군구 대체값)');

      // overview 전용
      if (fin(toolResult.totalIndustries)) dataLines.push(`전체 업종 수: ${toolResult.totalIndustries}개`);
      if (fin(toolResult.totalUpso)) dataLines.push(`전체 업소 수: ${toolResult.totalUpso}개`);
      if (fin(toolResult.totalAmt)) dataLines.push(`합계 매출: ${toolResult.totalAmt.toLocaleString()}만원`);
      if (toolResult.top3) dataLines.push(`매출 상위 업종: ${toolResult.top3}`);

      // compare 전용
      if (toolResult.type === 'compare' && toolResult.metrics?.length) {
        dataLines.push('비교 지표:');
        toolResult.metrics.forEach(m => {
          dataLines.push(`  ${m.label}: ${m.value1?.toLocaleString() ?? '-'} vs ${m.value2?.toLocaleString() ?? '-'} (${m.unit})`);
        });
      }

      // similar 전용
      if (toolResult.type === 'similar') {
        dataLines.push(`유사 상권 수: ${toolResult.similarCount}곳`);
        if (toolResult.topSimilar) dataLines.push(`상위 유사 지역: ${toolResult.topSimilar}`);
        else dataLines.push('상위 유사 지역: 제공된 데이터 없음');
      }

      // rankDistricts 전용
      if (toolResult.type === 'rankDistricts') {
        if (toolResult.sgg) dataLines.push(`구: ${toolResult.sgg}`);
        if (toolResult.top3) dataLines.push(`상위 행정동: ${toolResult.top3}`);
        if (toolResult.topDistrict) dataLines.push(`1위: ${toolResult.topDistrict}`);
        if (toolResult.totalDistricts) dataLines.push(`분석 대상: ${toolResult.totalDistricts}개 행정동`);
      }

      // sggIndustry 전용
      if (toolResult.type === 'sggIndustry') {
        if (toolResult.sgg) dataLines.push(`구: ${toolResult.sgg}`);
        if (toolResult.topDistricts) dataLines.push(`상위 행정동: ${toolResult.topDistricts}`);
        if (toolResult.avgAmt) dataLines.push(`구 평균 업소당 월매출: ${toolResult.avgAmt.toLocaleString()}만원`);
        if (toolResult.trendDirection) dataLines.push(`추세 방향: ${toolResult.trendDirection}`);
      }

      if (dataLines.length) p.push(`데이터:\n${dataLines.join('\n')}`);
    }

    return p.join('\n\n');
  }
}
