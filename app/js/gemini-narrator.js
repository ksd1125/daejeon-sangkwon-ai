/**
 * gemini-narrator.js — Gemini 스트리밍 내러티브 생성
 * ResponseBuilder가 준비한 데이터(record, insights, comparison)를 Gemini에게 전달
 * → 자연어 분석 코멘터리 생성 (SSE 스트리밍)
 */
export class GeminiNarrator {
  constructor() {
    this._model = 'gemini-2.5-flash';
    this._maxTokens = 420;
    this._temperature = 0.45;
    this._cooldownUntil = 0;
  }

  /** API 키 유무 확인 */
  isAvailable() {
    return Boolean(this._getApiKey()) && !this._isCoolingDown();
  }

  _setCooldown(ms = 60000) {
    this._cooldownUntil = Date.now() + ms;
    console.warn('[GeminiNarrator] 429 cooldown ' + Math.ceil(ms / 1000) + 's');
  }

  _isCoolingDown() {
    if (!this._cooldownUntil) return false;
    if (Date.now() >= this._cooldownUntil) {
      this._cooldownUntil = 0;
      return false;
    }
    return true;
  }

  /**
   * SSE 스트리밍 AsyncGenerator
   * @param {object} context — narrativeContext from ResponseBuilder
   * @yields {string} text chunk
   */
  async *streamNarrative(context) {
    const apiKey = this._getApiKey();
    if (!apiKey) return;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this._model}:streamGenerateContent?alt=sse&key=${apiKey}`;

    const route = context.route || '';
    const body = {
      system_instruction: { parts: [{ text: this._systemPrompt(route) }] },
      contents: [
        ...this._historyToContents(context.conversationHistory || []),
        { role: 'user', parts: [{ text: this._userPrompt(context) }] },
      ],
      generationConfig: {
        temperature: this._temperature,
        maxOutputTokens: this._maxTokens,
      },
    };

    // AbortController + 15초 타임아웃
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      console.warn('[GeminiNarrator] 15초 타임아웃 — 스트리밍 중단');
    }, 15000);

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
        console.warn('[GeminiNarrator] 요청 타임아웃');
      } else {
        console.warn('[GeminiNarrator] fetch error:', err.message);
      }
      return;
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      console.warn('[GeminiNarrator] API error:', response.status);
      if (response.status === 429) this._setCooldown();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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

    clearTimeout(timeoutId);
  }

  /* ── prompts ── */

  _systemPrompt(route) {
    if (route === 'explain_last_answer') return this._explainSystemPrompt();
    if (route === 'run_comparison') return this._compareSystemPrompt();
    return this._defaultSystemPrompt();
  }

  _explainSystemPrompt() {
    return `당신은 대전광역시 상권 데이터 분석가입니다.
사용자가 직전 답변의 이유나 근거를 물었습니다.
직전 답변에서 사용된 데이터와 논리를 사용자 눈높이로 풀어 설명하세요.

규칙:
1. 새로운 분석을 하지 마세요. 이미 제공된 데이터만 다시 설명하세요.
2. "추천합니다" 등 주관적 평가를 하지 마세요.
3. 3-4문장으로 짧게 설명하세요.
4. 숫자를 언급할 때는 단위를 포함하세요.
5. 사용자의 질문에 자연스럽게 답하듯 말하세요.`;
  }

  _compareSystemPrompt() {
    return `당신은 대전광역시 상권을 비교 분석하는 대화형 데이터 분석가입니다.
두 행정동의 상권 데이터를 비교하여 차이점을 설명합니다.

규칙:
1. 두 지역의 핵심 차이를 먼저 말하세요.
2. 어느 쪽이 더 높고 낮은지 구체적 수치로 비교하세요.
3. 단순 나열보다 차이의 의미를 해석하세요.
4. "추천합니다" 등 주관적 평가를 하지 마세요.
5. 3-5문장으로 간결하게 쓰세요.
6. 숫자를 언급할 때는 단위(만원, 개, 명, %)를 반드시 포함하세요.`;
  }

  _defaultSystemPrompt() {  // 기존 _systemPrompt()에서 이름 변경
    return `당신은 대전광역시 상권을 함께 읽어 주는 대화형 데이터 분석가입니다.
사용자에게 제공된 상권 데이터 분석 결과를 친숙한 답변서처럼 자연스럽고 통찰력 있게 설명합니다.

규칙:
1. 제공된 숫자 데이터만 사용하세요. 추측하거나 없는 데이터를 만들지 마세요.
2. "추천합니다", "창업하기 좋습니다", "유망합니다" 등 주관적 평가를 절대 하지 마세요.
3. 첫 문장은 사용자의 질문에 바로 답하세요. "조회 결과입니다"처럼 기계적인 서두로 시작하지 마세요.
4. 보통 3-5문장만 쓰세요. 넓은 현황 질문만 한 문단과 짧은 근거 목록을 허용하세요.
5. 공공기관 보고서처럼 딱딱한 문장으로 쓰지 마세요. 사용자의 질문을 받아 옆에서 설명하듯 친숙하고 차분하게 말하세요.
6. 숫자를 나열하지 말고 중요한 수치 1-3개를 골라 수준, 변화, 비교, 시간대, 공간 맥락 중 의미 있는 축으로 해석하세요.
7. 데이터 간 비교, 추세, 엇갈리는 신호, 이상치를 중심으로 서술하세요. 숫자 뒤에는 왜 눈여겨볼 만한지 한 문장으로 설명하세요.
8. 제공된 데이터로 답할 수 있으면 분석 방법을 설명하지 마세요. "살펴볼 필요가 있습니다", "확인해 보겠습니다", "읽는 편이 좋습니다" 같은 완충 문구를 피하세요.
9. 데이터가 부족하거나 값이 엇갈리면 확신을 과장하지 말고 부족한 범위를 한 문장으로 말하세요.
10. 이전 대화 맥락이 있으면 자연스럽게 이어서 설명하세요.
11. 숫자를 언급할 때는 단위(만원, 개, 명, %)를 반드시 포함하세요.
12. 행정동 직접값, 시군구 대체값, 합성 배분값은 구분해서 말하세요.
13. 같은 뜻을 반복하지 말고 문장마다 판단, 근거, 해석, 주의 중 하나를 맡기세요.`;
  }

  _userPrompt(ctx) {
    const p = [];
    if (ctx.question) p.push(`사용자 질문: ${ctx.question}`);
    if (ctx.district) p.push(`지역: ${ctx.district}`);
    if (ctx.industry) p.push(`업종: ${ctx.industry}`);
    if (ctx.month) p.push(`기준월: ${ctx.month}`);

    if (ctx.record) {
      const r = ctx.record;
      const m = [];
      const fin = (v) => Number.isFinite(v);
      if (fin(r.amt)) m.push(`업소당 월평균 매출 ${r.amt.toLocaleString()}만원`);
      if (fin(r.upso)) m.push(`업소 수 ${r.upso}개`);
      if (fin(r.pop)) m.push(`일평균 유동인구 ${r.pop.toLocaleString()}명`);
      if (fin(r.amtYoY)) m.push(`매출 전년동월 대비 ${r.amtYoY}%`);
      if (fin(r.amtMoM)) m.push(`매출 전월 대비 ${r.amtMoM}%`);
      if (fin(r.amtSgg)) m.push(`시군구 평균 업소당 월매출 ${r.amtSgg.toLocaleString()}만원`);
      if (fin(r.amtSido)) m.push(`시도 평균 업소당 월매출 ${r.amtSido.toLocaleString()}만원`);
      if (r.peakDay) m.push(`피크 요일: ${r.peakDay}`);
      if (r.peakTime) m.push(`피크 시간대: ${r.peakTime}`);
      if (r.dataStatus === 'sgg_sub') m.push('(행정동 직접값 없음, 시군구 대체값)');
      if (m.length) p.push(`데이터: ${m.join(', ')}`);
    }

    if (ctx.insights?.length) {
      p.push(`핵심 발견: ${ctx.insights.map(i => typeof i === 'string' ? i : i.text || '').join('; ')}`);
    }

    if (ctx.comparison?.diffs?.length) {
      const diffs = ctx.comparison.diffs.map(d =>
        `${d.vs} 대비 ${d.diff > 0 ? '+' : ''}${d.diff}${d.pct !== null ? ` (${d.pct}%)` : ''}`
      );
      p.push(`비교: ${diffs.join(', ')}`);
    }

    // 비교 데이터 (compare 라우트)
    if (ctx.comparisonRecord2) {
      const r2 = ctx.comparisonRecord2;
      const m2 = [];
      const fin = (v) => Number.isFinite(v);
      if (r2.districtName) m2.push(`비교 지역: ${r2.districtName}`);
      if (fin(r2.amt)) m2.push(`매출 ${r2.amt.toLocaleString()}만원`);
      if (fin(r2.upso)) m2.push(`업소 수 ${r2.upso}개`);
      if (fin(r2.pop)) m2.push(`유동인구 ${r2.pop.toLocaleString()}명`);
      if (fin(r2.amtYoY)) m2.push(`매출 전년동월 대비 ${r2.amtYoY}%`);
      if (m2.length) p.push(`비교 지역 데이터: ${m2.join(', ')}`);
    }

    // 대화 맥락 요약
    if (ctx.conversationSummary) p.push(ctx.conversationSummary);

    const typeNames = { sales: '매출 분석', upso: '업소 수 분석', pop: '유동인구', trend: '추세', similar: '유사 상권', compare: '2지역 비교', overview: '종합 브리핑' };
    if (ctx.questionType) p.push(`질문 유형: ${typeNames[ctx.questionType] || ctx.questionType}`);

    return p.join('\n');
  }

  _historyToContents(history) {
    if (!history.length) return [];
    return history.slice(-6).map(h => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.text }],
    }));
  }

  _getApiKey() {
    return localStorage.getItem('gemini_api_key_analyst')
      || localStorage.getItem('gemini_api_key_router')
      || localStorage.getItem('gemini_api_key')
      || '';
  }
}

export default GeminiNarrator;
