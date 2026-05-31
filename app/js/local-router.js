/**
 * local-router.js — 질문 라우팅 (Gemini 호출 없이 키워드 규칙 기반)
 *
 * 6가지 라우트:
 *   explain_last_answer — 직전 답 근거 설명
 *   refine_same_analysis — 같은 결과를 다른 형태로 재표현
 *   run_new_analysis — 새 지표/업종/지역 조회
 *   run_comparison — 2지역 비교
 *   open_spatial_view — 점포/밀집 지도 (Phase 3 스텁)
 *   clarify_scope — 모호성 확인
 */
export class LocalRouter {
  constructor() {
    this._explainKeywords = ['왜', '이유', '근거', '무슨뜻', '쉽게', '다시설명', '왜그래', '왜그렇'];
    this._refineKeywords = ['그래프로', '표로', '핵심만', '요약', '다시보여', '차트로', '정리해'];
    this._compareKeywords = ['비교', '비교해'];
    this._compareConnectors = ['이랑', '하고', '랑', '보다', '대비', 'vs', '차이'];
    this._spatialKeywords = ['어디', '위치', '몰려', '점포', '지도'];
    this._ambiguousPronouns = ['거기', '그쪽', '그동', '그지역', '아까'];
  }

  /**
   * @param {string} question — 사용자 원문 질문
   * @param {ConversationState} state — 대화 상태
   * @returns {{ route, confidence, reuseLastResult, carry, slots, missingSlots }}
   */
  route(question, state) {
    const text = String(question || '').trim();
    const compact = text.replace(/\s+/g, '');
    const hasContext = state?.hasContext?.();
    const hasLastResult = Boolean(state?.getLastResult?.());

    // 1. explain_last_answer: 직전 답 해석 요청
    if (hasLastResult && this._matchesAny(compact, this._explainKeywords)) {
      return this._result('explain_last_answer', 0.85, true);
    }

    // 2. refine_same_analysis: 같은 결과 재표현
    if (hasLastResult && this._matchesAny(compact, this._refineKeywords)) {
      return this._result('refine_same_analysis', 0.80, true);
    }

    // 3. clarify_scope: 모호한 대명사 + 비교 의도
    if (this._matchesAny(compact, this._ambiguousPronouns) && this._matchesAny(compact, this._compareKeywords)) {
      if (!hasContext) {
        return this._result('clarify_scope', 0.70, false, { missingSlots: ['compareTarget'] });
      }
    }

    // 4. run_comparison: 비교 키워드 감지
    if (this._isComparisonQuestion(compact, text)) {
      return this._result('run_comparison', 0.85, false, {
        carry: { district: true, industry: true, month: true },
      });
    }

    // 5. open_spatial_view: 점포/위치 질문 (Phase 3 스텁)
    if (hasContext && this._matchesAny(compact, this._spatialKeywords)) {
      // Phase 3 전까지 run_new_analysis로 폴백
      return this._result('run_new_analysis', 0.60, false, {
        carry: { district: true, industry: true, month: true },
        _spatialIntent: true,
      });
    }

    // 6. run_new_analysis: 기본 (새 분석 또는 후속 지표 전환)
    const carry = { district: false, industry: false, month: false };
    if (hasContext) {
      // 짧은 후속 질문인지 판단: 지역/업종 명시 없이 지표만 바꾸는 경우
      const isShortFollowUp = text.length < 20 && !this._hasDistrictMention(compact);
      if (isShortFollowUp) {
        carry.district = true;
        carry.industry = true;
        carry.month = true;
      }
    }

    return this._result('run_new_analysis', 0.50, false, { carry });
  }

  /* ── helpers ── */

  _isComparisonQuestion(compact, text) {
    // "비교"/"비교해" 키워드 → 명시적 비교 의도
    if (this._matchesAny(compact, this._compareKeywords)) return true;
    // 커넥터(이랑/하고/대비/vs/차이 등) + 두 지역 언급 → 지역 비교
    if (this._compareConnectors.some((c) => compact.includes(c)) && this._hasTwoDistricts(text)) {
      return true;
    }
    return false;
  }

  /** 원문(공백 포함)에서 두 개 이상의 행정동/구가 언급되었는지 판별 */
  _hasTwoDistricts(text) {
    const NON_DISTRICT = /유동인구|인구|활동|이동|행동|변동|운동|연동|탐구|연구|도구/g;
    const cleaned = text.replace(NON_DISTRICT, '');
    // 공백 + 커넥터로 분리하여 토큰 단위로 "X동"/"X구" 매칭
    const tokens = cleaned.split(/[\s,]+|이랑|하고|보다|vs/g).filter(Boolean);
    const districts = tokens.filter(t => /[가-힣0-9]+동$/.test(t) || /[가-힣]+구$/.test(t));
    return districts.length >= 2;
  }

  _hasDistrictMention(compact) {
    const NON_DISTRICT = /유동인구|인구|활동|이동|행동|변동|운동|연동|탐구|연구|도구/g;
    const cleaned = compact.replace(NON_DISTRICT, '');
    if (!cleaned) return false;
    return /[가-힣]+동/.test(cleaned) || /[가-힣]+구/.test(cleaned);
  }

  _matchesAny(compact, keywords) {
    return keywords.some((kw) => compact.includes(kw));
  }

  _result(route, confidence, reuseLastResult, extra = {}) {
    return {
      route,
      confidence,
      reuseLastResult,
      carry: extra.carry || { district: false, industry: false, month: false },
      slots: extra.slots || {},
      missingSlots: extra.missingSlots || [],
      _spatialIntent: extra._spatialIntent || false,
    };
  }
}

export default LocalRouter;
