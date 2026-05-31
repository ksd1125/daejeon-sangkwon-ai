/**
 * agent-router.js — Agent 1: 라우터
 * 사용자 질문 → Gemini function calling → 어떤 데이터를 조회할지 결정.
 * API Key: gemini_api_key_router
 */
import { TOOL_DECLARATIONS } from './tool-definitions.js';

export class AgentRouter {
  /**
   * @param {() => string|null} apiKeyGetter — API 키 반환 함수
   * @param {string} districtNames — 쉼표 구분 행정동 이름 목록
   */
  constructor(apiKeyGetter, districtNames) {
    this._model = 'gemini-2.5-flash';
    this._getKey = apiKeyGetter;
    this._districtNames = districtNames;
    // districtNames에서 구 이름 동적 추출 (예: "행정동: 중앙동,효동,...\n" → 구 매칭)
    const sggMatch = String(districtNames || '').match(/[가-힣]+구/g) || [];
    this._sggNames = [...new Set(sggMatch)];
    this._sggRegex = this._sggNames.length
      ? new RegExp(`(${this._sggNames.join('|')})`)
      : /(유성구|서구|중구|동구|대덕구)/;
  }

  isAvailable() {
    return Boolean(this._getKey());
  }

  /**
   * 질문 → functionCall(s) 또는 텍스트 응답 반환.
   * @param {string} question — 사용자 질문
   * @param {string} contextSummary — 어드바이저가 생성한 대화 맥락 요약
   * @returns {Promise<{ functionCalls: Array, textResponse: string|null }>}
   */
  async route(question, contextSummary = '') {
    const apiKey = this._getKey();
    if (!apiKey) throw new Error('라우터 API 키가 없습니다.');

    const userMessage = contextSummary
      ? `[대화 맥락]\n${contextSummary}\n\n[현재 질문]\n${question}`
      : question;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this._model}:generateContent?key=${apiKey}`;

    const body = {
      system_instruction: { parts: [{ text: this._systemPrompt() }] },
      contents: [
        { role: 'user', parts: [{ text: userMessage }] },
      ],
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 200,
      },
    };

    // AbortController + 4초 타임아웃
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      console.warn('[AgentRouter] 4초 타임아웃');
    }, 4000);

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
      if (err.name === 'AbortError') throw new Error('라우터 타임아웃 (4초)');
      throw err;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`라우터 API 오류 ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0]?.content;
    if (!candidate) {
      throw new Error('라우터 응답에 후보가 없습니다.');
    }

    const parts = candidate.parts || [];
    const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    const textParts = parts.filter(p => p.text).map(p => p.text);

    return {
      functionCalls,
      textResponse: textParts.join('') || null,
    };
  }

  async routeIntent(question, contextSummary = '') {
    const apiKey = this._getKey();
    if (!apiKey) throw new Error('라우터 API 키가 없습니다.');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this._model}:generateContent?key=${apiKey}`;
    const body = {
      system_instruction: { parts: [{ text: this._intentSystemPrompt() }] },
      contents: [
        { role: 'user', parts: [{ text: this._buildIntentPrompt(question, contextSummary) }] },
      ],
      generationConfig: {
        temperature: 0.15,
        maxOutputTokens: 360,
        responseMimeType: 'application/json',
      },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

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
      if (err.name === 'AbortError') throw new Error('라우터 의도 판단 타임아웃(4초)');
      throw err;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`라우터 의도 API 오류 ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    const parsed = this._safeJson(text);
    if (!parsed) throw new Error('라우터 의도 JSON 파싱 실패');

    return this._normalizeIntentPlan(parsed, question);
  }

  _systemPrompt() {
    return `당신은 대전광역시 82개 행정동 상권 분석 시스템의 라우터입니다.
사용자의 질문을 이해하고, 적절한 데이터 조회 도구를 호출하세요.

규칙:
1. 지역과 업종이 모두 있으면 analyzeDistrictIndustry를 호출하세요.
2. 지역만 있고 업종이 없으면 ("어때?", "현황") getDistrictOverview를 호출하세요.
3. 두 지역 비교는 compareDistricts를 호출하세요.
4. "비슷한 곳", "유사 상권"은 findSimilarDistricts를 호출하세요.
5. "합산", "합쳐서"는 mergeDistricts를 호출하세요.
6. 일상 대화(인사, 감사, 잡담)에는 도구 없이 짧게 텍스트로 답하세요.
7. 대화 맥락이 있으면 참고하여 생략된 지역/업종을 채우세요.
8. metric 파라미터: "매출" → sales, "업소"/"점포" → stores, "유동인구" → population, "추세" → trend, 불분명하면 all.
9. 반석동처럼 행정동 목록에 없지만 법정동/생활권 별칭에 있는 이름은 그대로 district로 넘기세요.
10. 상권 밖의 질문도 가능한 범위에서 짧게 답하고, 필요하면 상권 분석으로 이어질 질문을 제안하세요.

대전 행정동: ${this._districtNames}
주요 업종 예시: 카페, 편의점, 치킨, 한식, 중국음식, 미용실, 병원, 약국, 학원, 마트, 주점, 제과점, 분식`;
  }

  _intentSystemPrompt() {
    return `당신은 대전광역시 82개 행정동 상권 분석 시스템의 Intent Router입니다.
사용자 질문을 직접 도구로 실행하지 말고, 다음 Data & Tool Planner가 판단할 수 있는 의도 계획으로만 정리하세요.

규칙:
- 지역, 업종, 지표, 비교/합산/유사상권 여부를 분리하세요.
- 이전 맥락이 있으면 생략된 지역/업종을 보완하세요. 예: 맥락="지역: 둔산1동, 업종: 카페" + 질문="유동인구는?" → district="둔산1동", industry="카페", goal="population". 맥락 보완 시 confidence=0.7로 설정하세요.
- 사용자가 모를 법한 행정동명은 법정동/생활권 별칭을 그대로 district에 담아 다음 도구가 해소하게 하세요.
- "다른 업종", "업종별", "상위 업종", "나머지 업종 매출"은 이전 업종을 유지하지 말고 goal=overview, industry=null, metric=sales로 두세요.
- "비슷한 곳", "유사 상권", "같은 패턴", "다른 상권"은 goal=similar로 설정하세요.
- "유성구 카페 추세", "서구 편의점 현황"처럼 구 이름+업종+추세/현황/어때이면 goal=sggIndustry로 설정하세요.
- sggIndustry와 rankDistricts 구분: "높은 동", "1위 동", "순위"가 있으면 rankDistricts, "추세", "현황", "어때"이면 sggIndustry입니다.
- "유성구 내 카페 매출 높은 행정동", "서구 치킨 상위 동"처럼 구 범위에서 행정동 순위를 묻는 질문은 goal=rankDistricts, sgg에 구 이름을 넣으세요.
- "유동인구 대비 업소수", "매출 대비 인구", "밀도", "효율"처럼 두 가지 이상 지표를 교차 비교하는 질문은 goal=density, metric=all로 두세요.
- 상권 데이터 질문이면 responseType은 analysis입니다.
- 인사, 잡담, 앱 사용법, 데이터 해석 방법처럼 데이터 조회가 필요 없으면 responseType은 smalltalk이고 directAnswer를 채우세요. "상권 데이터만 답할 수 있다"처럼 차갑게 거절하지 말고, 아는 범위와 다음에 물어볼 수 있는 방향을 제안하세요.
- 반드시 JSON만 반환하세요.

사용 가능한 행정동: ${this._districtNames}
주요 업종 예시: 카페, 편의점, 치킨, 한식, 중식, 미용실, 병원, 약국, 학원, 마트, 주점, 분식`;
  }

  _buildIntentPrompt(question, contextSummary) {
    return `이전 맥락:
${contextSummary || '(없음)'}

현재 질문:
${question}

반환 JSON 형식:
{
  "responseType": "analysis|smalltalk|clarify",
  "goal": "sales|stores|population|trend|overview|compare|similar|merge|density|rankDistricts|sggIndustry|unknown",
  "sgg": "시군구 이름 또는 null",
  "district": "행정동 이름 또는 null",
  "industry": "업종 이름 또는 null",
  "metric": "sales|stores|population|trend|all|null",
  "compareDistricts": ["행정동1", "행정동2"],
  "mergeDistricts": ["행정동1", "행정동2"],
  "missingSlots": ["district", "industry", "compareTarget"],
  "confidence": 0.0,
  "directAnswer": "smalltalk일 때만 짧은 답변",
  "rationale": "의도 판단 근거 한 문장"
}`;
  }

  _fuzzyDistrict(name) {
    if (!name) return null;
    const n = String(name).trim();
    // 행정동 목록에서 직접 매칭
    const list = String(this._districtNames || '');
    if (list.includes(n)) return n;
    // "둔산1" → "둔산1동", "가양" → "가양동" 등 접미사 보정
    if (!n.endsWith('동') && list.includes(n + '동')) return n + '동';
    // "일동" → "1동" 등 한글 숫자 → 아라비아 숫자
    const numMap = { '일': '1', '이': '2', '삼': '3', '사': '4', '오': '5' };
    const numFixed = n.replace(/([가-힣]+)(일|이|삼|사|오)동?$/, (_, prefix, num) => {
      const candidate = prefix + numMap[num] + '동';
      return list.includes(candidate) ? candidate : _;
    });
    if (numFixed !== n && list.includes(numFixed)) return numFixed;
    // 접미사 없이 '동' 붙여보기
    if (!numFixed.endsWith('동') && list.includes(numFixed + '동')) return numFixed + '동';
    return n; // 원본 반환 (tool-dispatcher가 최종 해소)
  }

  _normalizeIntentPlan(plan, question) {
    const allowedGoals = new Set(['sales', 'stores', 'population', 'trend', 'overview', 'compare', 'similar', 'merge', 'density', 'rankDistricts', 'sggIndustry', 'unknown']);
    const responseType = ['analysis', 'smalltalk', 'clarify'].includes(plan.responseType) ? plan.responseType : 'analysis';
    const asksIndustryRanking = /다른\s*업종|업종별|상위\s*업종|나머지\s*업종|업종\s*매출|매출.*업종|1위\s*업종/.test(question || '');
    const sggPattern = this._sggRegex.source;
    const asksDistrictRanking = (
      new RegExp(`${sggPattern}.*(높은|상위|1위|순위|랭킹|많은|잘\\s*되는)`).test(question || '')
      || /행정동.*(높은|상위|1위|순위|랭킹|많은|잘\s*되는)/.test(question || '')
    ) && !asksIndustryRanking;
    const asksSimilar = /(비슷|유사|같은\s*(?:곳|상권|패턴|동네)|닮은|다른\s*(?:곳|상권))/.test(question || '');
    const sgg = plan.sgg || this._extractSgg(question);
    const asksSggIndustry = Boolean(sgg && (plan.industry || this._extractIndustryHint(question)) && !plan.district && !asksDistrictRanking && !asksSimilar);
    const goal = asksDistrictRanking ? 'rankDistricts'
      : asksIndustryRanking ? 'overview'
      : (asksSimilar && (plan.district || plan.goal === 'similar')) ? 'similar'
      : asksSggIndustry ? 'sggIndustry'
      : (allowedGoals.has(plan.goal) ? plan.goal : 'unknown');
    const metricMap = {
      sales: 'sales',
      stores: 'stores',
      upso: 'stores',
      population: 'population',
      pop: 'population',
      trend: 'trend',
      all: 'all',
    };
    const metric = metricMap[plan.metric] || (['sales', 'stores', 'population', 'trend'].includes(goal) ? metricMap[goal] : (goal === 'sggIndustry' ? (metricMap[plan.goal] || 'trend') : null));
    let missingSlots = Array.isArray(plan.missingSlots) ? plan.missingSlots.filter(Boolean) : [];
    if (['sggIndustry', 'rankDistricts'].includes(goal)) {
      missingSlots = missingSlots.filter(slot => !['district', 'compareTarget'].includes(slot));
    }
    if (goal === 'overview') {
      missingSlots = missingSlots.filter(slot => slot !== 'industry');
    }
    const fuzzyDistrict = this._fuzzyDistrict(plan.district);
    return {
      responseType,
      goal,
      sgg,
      district: fuzzyDistrict || null,
      industry: asksIndustryRanking ? null : (plan.industry || null),
      metric: asksIndustryRanking ? 'sales' : metric,
      compareDistricts: Array.isArray(plan.compareDistricts) ? plan.compareDistricts.filter(Boolean).slice(0, 2) : [],
      mergeDistricts: Array.isArray(plan.mergeDistricts) ? plan.mergeDistricts.filter(Boolean).slice(0, 5) : [],
      missingSlots,
      confidence: Number.isFinite(plan.confidence) ? Math.max(0, Math.min(1, plan.confidence)) : 0.5,
      directAnswer: plan.directAnswer || null,
      rationale: plan.rationale || '',
      originalQuestion: question,
    };
  }

  _safeJson(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch { /* continue */ }
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  _extractSgg(text) {
    const match = String(text || '').match(this._sggRegex);
    return match?.[1] || null;
  }

  /** 질문에서 업종 키워드 힌트 추출 (sggIndustry 감지 보조) */
  _extractIndustryHint(text) {
    const q = String(text || '');
    // 기본 인기 업종 + districtNames에서 추출된 업종 별칭이 있으면 활용
    const defaultHints = ['카페', '편의점', '치킨', '한식', '중식', '미용실', '병원', '약국', '학원', '마트', '주점', '분식', '제과점', '커피', '음식점', '약국', '헬스장', 'PC방', '빵', '피자'];
    return defaultHints.find(h => q.includes(h)) || null;
  }
}
