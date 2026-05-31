/**
 * agent-advisor.js — Agent 3: 어드바이저
 * 대화 맥락 관리 + 후속 질문 생성 + 맥락 요약.
 * API Key: gemini_api_key_advisor
 */

export class AgentAdvisor {
  /**
   * @param {() => string|null} apiKeyGetter
   */
  constructor(apiKeyGetter) {
    this._model = 'gemini-2.5-flash';
    this._getKey = apiKeyGetter;
    this._history = [];    // { role: 'user'|'data', text|summary }
    this._turnCount = 0;
    this._lastContextSummary = '';
  }

  isAvailable() {
    return Boolean(this._getKey());
  }

  async verifyAnswer({ question, intentPlan, toolPlan, toolResultSummary, responseSummary }) {
    const fallback = {
      decision: 'accept',
      issues: [],
      userMessage: '',
      suggestedToolCall: null,
      answerFocus: '',
      followUps: [],
      contextSummary: this.getContextSummary(),
    };

    const apiKey = this._getKey();
    if (!apiKey) return fallback;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this._model}:generateContent?key=${apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: this._verifierSystemPrompt() }] },
      contents: [{
        role: 'user',
        parts: [{ text: this._buildVerifierPrompt({ question, intentPlan, toolPlan, toolResultSummary, responseSummary }) }],
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 360,
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
      console.warn('[AgentAdvisor] verification fallback:', err.message);
      return fallback;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn('[AgentAdvisor] verification API error:', response.status);
      if (response.status === 429) throw new Error('API 429');
      return fallback;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const parsed = this._safeJson(text);
    const verified = this._normalizeVerification(parsed, fallback);
    if (verified.contextSummary) this._lastContextSummary = verified.contextSummary;
    return verified;
  }

  /**
   * 현재 결과 기반 후속 질문 칩 + 다음 턴 맥락 요약.
   * @param {object} params
   * @param {string} params.question — 사용자 질문
   * @param {string} params.toolName — 호출된 도구
   * @param {string} params.toolResultSummary — 데이터 요약 텍스트
   * @param {string} params.currentDistrict — 현재 행정동
   * @param {string} params.currentIndustry — 현재 업종
   * @returns {Promise<{ followUps: string[], contextSummary: string }>}
   */
  async generateFollowUps({ question, toolName, toolResultSummary, currentDistrict, currentIndustry }) {
    // 트림 먼저 (오래된 턴 제거 후 push)
    this._turnCount++;
    if (this._turnCount >= 10) this._trimHistory();

    // 히스토리 기록
    this._history.push({ role: 'user', text: question });
    this._history.push({ role: 'data', summary: toolResultSummary });

    const apiKey = this._getKey();
    if (!apiKey) {
      // API 없으면 기본 후속 질문 생성
      return this._fallbackFollowUps(currentDistrict, currentIndustry, toolName);
    }

    try {
      const result = await this._callGemini(question, toolName, toolResultSummary, currentDistrict, currentIndustry);

      // 맥락 요약 저장 (다음 턴 라우터에 전달)
      if (result.contextSummary) {
        this._lastContextSummary = result.contextSummary;
      }

      return result;
    } catch (err) {
      console.warn('[AgentAdvisor] 오류:', err.message);
      if (/429|quota/i.test(String(err?.message || ''))) throw err;
      return this._fallbackFollowUps(currentDistrict, currentIndustry, toolName);
    }
  }

  /**
   * 라우터에게 전달할 대화 맥락 요약.
   * Gemini가 생성한 요약이 있으면 사용, 없으면 최근 히스토리에서 구성.
   */
  getContextSummary() {
    if (this._lastContextSummary) return this._lastContextSummary;
    if (this._history.length === 0) return '';

    // 최근 5턴 요약
    const recent = this._history.slice(-10);
    return recent.map(h => {
      if (h.role === 'user') return `질문: ${h.text}`;
      return `결과: ${h.summary}`;
    }).join('\n');
  }

  clear() {
    this._history = [];
    this._turnCount = 0;
    this._lastContextSummary = '';
  }

  /* ── Gemini API ── */

  async _callGemini(question, toolName, toolResultSummary, district, industry) {
    const apiKey = this._getKey();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this._model}:generateContent?key=${apiKey}`;

    const historyText = this._history.slice(-10).map(h => {
      if (h.role === 'user') return `사용자: ${h.text}`;
      return `분석 결과: ${h.summary}`;
    }).join('\n');

    const toolLabel = {
      analyzeDistrictIndustry: '매출/업소/유동인구 분석',
      getDistrictOverview: '전체 상권 현황',
      compareDistricts: '지역 비교',
      findSimilarDistricts: '유사 상권 검색',
      mergeDistricts: '지역 합산',
      rankDistrictsByIndustry: '행정동 순위',
      analyzeSggIndustry: '구 단위 분석',
    }[toolName] || toolName;

    const userPrompt = [
      `현재 질문: ${question}`,
      `분석 유형: ${toolLabel}`,
      `현재 지역: ${district || '없음'}`,
      `현재 업종: ${industry || '없음'}`,
      `분석 결과 요약: ${toolResultSummary}`,
      historyText ? `\n대화 히스토리:\n${historyText}` : '',
      `\n주의: 3개 후속 질문은 모두 다른 관점이어야 합니다. 방금 "${question}"을 답했으므로 같은 내용을 다시 묻는 질문은 절대 포함하지 마세요.`,
    ].filter(Boolean).join('\n');

    const body = {
      system_instruction: { parts: [{ text: this._systemPrompt() }] },
      contents: [
        { role: 'user', parts: [{ text: userPrompt }] },
      ],
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 200,
        responseMimeType: 'application/json',
      },
    };

    // 3초 타임아웃
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
      throw err;
    }
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`API ${response.status}`);

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    try {
      const parsed = JSON.parse(text);
      return {
        followUps: Array.isArray(parsed.followUps) ? parsed.followUps.slice(0, 3) : [],
        contextSummary: parsed.contextSummary || '',
      };
    } catch {
      // JSON 파싱 실패 시 텍스트에서 추출 시도
      console.warn('[AgentAdvisor] JSON 파싱 실패, 폴백 사용');
      return this._fallbackFollowUps(district, industry, toolName);
    }
  }

  _systemPrompt() {
    return `당신은 대전 상권 AI의 대화 어드바이저입니다.
사용자의 현재 분석 결과를 보고, 자연스럽게 이어질 수 있는 후속 질문 3개를 제안하세요.

핵심 규칙:
1. 후속 질문은 사용자가 바로 클릭할 수 있는 자연어 문장이어야 합니다.
2. 3개 모두 다른 관점이어야 합니다. 같은 유형(예: 매출, 매출, 매출) 반복 금지.
3. 말투를 자연스럽고 다양하게 섞으세요:
   - "~어때?", "~는?", "~도 궁금해", "~랑 비교하면?", "~추세는 어떻지?", "~에서 뭐가 잘 되지?"
   - "X 확인", "Y 확인" 패턴을 연속 사용하지 마세요.
4. 분석 결과에서 눈에 띄는 수치(급등/급락, 평균 대비 높은/낮은 값)가 있으면 그것을 파고드는 질문을 우선하세요.
5. **중요**: 후속 질문에 반드시 구체적인 지역명과 업종명을 포함하세요. "다른 업종도 비교해볼까?" (X) → "둔산1동에서 치킨은 어때?" (O). 지역/업종이 빠진 모호한 질문은 금지합니다.

관점 풀 (도구 이름 기준, 최소 3가지 다른 관점에서 선택):
- 매출 깊이: "둔산1동 카페 업소당 월평균 업소당 월매출은?", "전년 대비 추세는?"
- 유동인구: "둔산1동 유동인구 패턴은?", "피크 시간대가 언제야?"
- 경쟁: "둔산1동 카페 비슷한 상권 있어?", "노은1동이랑 비교하면?"
- 업종 전환: "둔산1동에서 치킨은 어때?", "여기서 뭐가 잘 되지?"
- 밀도/효율: "둔산1동 카페 유동인구 대비 업소가 많은 편이야?", "매출 효율은?"
- 구/시 확장: "유성구 카페 전체로 보면?", "대전에서 카페 1위 동은?"
- 추세: "둔산1동 카페 최근 3개월 흐름이 어떻지?", "작년보다 나아졌어?"

5. contextSummary는 다음 턴에서 사용자의 생략된 맥락을 채울 단서입니다. 1-2줄로 핵심만.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "followUps": ["후속 질문1", "후속 질문2", "후속 질문3"],
  "contextSummary": "현재까지 대화 맥락 1-2줄 요약"
}`;
  }

  _verifierSystemPrompt() {
    return `You are the final suitability judge for a Korean commercial district AI.
Check whether the intent plan, selected tool, retrieved data, and prepared answer match the user's question.
Return only JSON.

Rules:
- Accept when the answer uses the right district, industry, metric, and tool.
- Clarify when a required district, industry, or comparison target is missing.
- Retry only when a different available tool call is clearly needed.
- Do not invent data. Keep any userMessage short and Korean.`;
  }

  _buildVerifierPrompt({ question, intentPlan, toolPlan, toolResultSummary, responseSummary }) {
    return `User question:
${question}

Intent plan:
${JSON.stringify(intentPlan || {}, null, 2)}

Tool plan:
${JSON.stringify(toolPlan || {}, null, 2)}

Retrieved data summary:
${toolResultSummary || '(none)'}

Prepared response summary:
${responseSummary || '(none)'}

Return JSON:
{
  "decision": "accept|clarify|retry",
  "issues": ["short issue"],
  "userMessage": "clarify message in Korean, only when needed",
  "suggestedToolCall": { "name": "toolName", "args": {} },
  "answerFocus": "one short Korean sentence for the analyst",
  "followUps": ["next question 1", "next question 2"],
  "contextSummary": "1-2 line context summary for the next turn"
}`;
  }

  _normalizeVerification(parsed, fallback) {
    if (!parsed || typeof parsed !== 'object') return fallback;
    const decision = ['accept', 'clarify', 'retry'].includes(parsed.decision)
      ? parsed.decision
      : 'accept';
    const allowed = new Set(['analyzeDistrictIndustry', 'getDistrictOverview', 'compareDistricts', 'findSimilarDistricts', 'mergeDistricts', 'rankDistrictsByIndustry', 'analyzeSggIndustry']);
    const suggestedToolCall = parsed.suggestedToolCall && allowed.has(parsed.suggestedToolCall.name)
      ? { name: parsed.suggestedToolCall.name, args: parsed.suggestedToolCall.args || {} }
      : null;

    return {
      decision,
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter(Boolean).slice(0, 5) : [],
      userMessage: parsed.userMessage || '',
      suggestedToolCall,
      answerFocus: parsed.answerFocus || '',
      followUps: Array.isArray(parsed.followUps) ? parsed.followUps.filter(Boolean).slice(0, 3) : [],
      contextSummary: parsed.contextSummary || fallback.contextSummary,
    };
  }

  _safeJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* continue */ }
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  /* ── Fallback ── */

  _fallbackFollowUps(district, industry, toolName) {
    const d = district || '';
    const ind = industry || '';
    const altIndustries = ['카페', '편의점', '치킨', '한식', '음식점', '미용실', '분식', '약국'];
    const alt = ind ? altIndustries.filter(i => i !== ind) : altIndustries;
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)] || arr[0];

    // 도구별 후보 풀: 최소 6개씩 → 랜덤 3개 추출
    const pools = {
      analyzeDistrictIndustry: [
        `${d} 유동인구 패턴은?`,
        `${d} ${ind} 최근 추세는 어떻지?`,
        `${d} ${ind} 비슷한 상권 있어?`,
        `${d}에서 ${pick(alt)}은 어때?`,
        `${d} ${ind} 업소당 월평균 업소당 월매출은?`,
        `${d} ${ind}랑 다른 동 비교하면?`,
      ],
      getDistrictOverview: [
        `${d}에서 뭐가 제일 잘 되지?`,
        `${d} ${pick(alt)} 매출은?`,
        `${d} 유동인구가 언제 많아?`,
        `${d} ${pick(alt.filter(i => i !== pick(alt)))} 어때?`,
        `${d} 최근 추세는?`,
        `${d} 근처 비슷한 동은?`,
      ],
      compareDistricts: [
        d ? `${d}에서 ${pick(alt)}은 어때?` : `${pick(alt)} 비교해볼까?`,
        d ? `${d} ${ind} 비슷한 상권 찾아줘` : '비슷한 상권 더 찾아줘',
        ind ? `${d} ${ind} 추세는 어떻지?` : '매출 추세 비교해줘',
        `유동인구 기준으로 다시 보면?`,
        ind ? `${d} ${ind} 밀도 분석해줘` : '업소 밀도는?',
      ],
      findSimilarDistricts: [
        `${d} ${ind} 매출 순위는?`,
        `${d} ${ind} 추세 보여줘`,
        `${d} 유동인구 기준으로 비교하면?`,
        `${d} ${pick(alt)} 유사 상권도 궁금해`,
        `${d} ${ind} 업소당 월평균 업소당 월매출은?`,
      ],
      mergeDistricts: [
        `개별 동별로 따로 보면?`,
        `합산 지역 유동인구는?`,
        ind ? `${ind} 추세는?` : '매출 추이는?',
        `이 지역에서 ${pick(alt)} 어때?`,
      ],
      rankDistrictsByIndustry: [
        d ? `${d} ${ind} 자세히 보면?` : `1위 동네 ${ind} 자세히 보면?`,
        `${ind} 유동인구 기준 순위는?`,
        `${pick(alt)} 순위도 궁금해`,
        `${ind} 업소 수 기준으로 보면 달라?`,
        `${ind} 추세 기준으로 순위가 바뀌나?`,
      ],
      analyzeSggIndustry: [
        d ? `${d} ${ind} 자세히 보면?` : `상위 행정동 ${ind} 자세히 보고 싶어`,
        `${pick(alt)} 현황도 보여줘`,
        `${ind} 유동인구 기준으로 보면?`,
        `${ind} 매출 추세가 오르고 있어?`,
        `${ind} 업소 밀도가 높은 동은?`,
      ],
    };

    const pool = pools[toolName] || pools.analyzeDistrictIndustry;
    // 셔플 후 상위 3개
    const shuffled = pool.filter(Boolean).sort(() => Math.random() - 0.5);
    const followUps = shuffled.slice(0, 3);

    const summary = [
      d ? `지역: ${d}` : '',
      ind ? `업종: ${ind}` : '',
      toolName ? `분석: ${toolName}` : '',
    ].filter(Boolean).join(', ');

    return {
      followUps,
      contextSummary: summary,
    };
  }

  _trimHistory() {
    // 가장 오래된 턴 제거 — 최대 5턴(10항목) 유지
    if (this._history.length > 14) {
      this._history = this._history.slice(-10);
    }
  }
}
