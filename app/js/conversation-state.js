/**
 * conversation-state.js — 대화 세션 상태 관리
 * 직전 지역/업종/지표를 기억하여 후속 질문에서 맥락을 이어받음.
 * 페이지 리프레시 시 초기화 (in-memory only).
 */
export class ConversationState {
  constructor() {
    this.clear();
  }

  clear() {
    this.activeDistrict = null;   // { code, name, sgg }
    this.activeSgg = null;        // string — 구 단위 컨텍스트 (sggIndustry/rankDistricts/merge 후 유지)
    this.activeIndustry = null;   // string
    this.activeMetric = null;     // 'sales'|'upso'|'pop'|'trend'|'similar'|'overview'
    this.activeMonth = null;      // 'YYYYMM'
    this.comparisonDistricts = []; // [{ code, name, sgg }]
    this.lastView = null;         // 'overview'|'sales'|'compare'|...
    this.lastResult = null;       // 전체 response 객체
    this.lastQueryResult = null;  // raw queryEngine 결과
    this.lastIntent = null;       // 직전 intent
    this.turnCount = 0;
  }

  /**
   * 매 답변 후 상태 갱신.
   * @param {object} intent — IntentParser 결과
   * @param {object} queryResult — QueryEngine 결과
   * @param {object} response — ResponseBuilder 결과
   */
  update(intent, queryResult, response) {
    if (!intent) return;
    this.turnCount++;

    if (intent.district) {
      this.activeDistrict = {
        code: intent.district.code || '',
        name: intent.district.name || '',
        sgg: intent.district.sgg || '',
      };
      if (intent.district.sgg) this.activeSgg = intent.district.sgg;
    }

    // merge 결과: 법정동 소스명(둔산동)을 우선 저장 — 대표 행정동(둔산1동)이 아니라
    // 묶음 전체 이름을 기억해야 후속 비교('반석동과 비교')에서 둔산동 vs 반석동이 됨
    if (intent.mergeDistricts?.length > 0 && !intent.district) {
      const rep = intent.mergeDistricts[0];
      if (rep.name || intent.sourceLocation) {
        this.activeDistrict = {
          code: rep.code || '',
          name: intent.sourceLocation || rep.name || '',
          sgg: rep.sgg || '',
        };
        if (rep.sgg) this.activeSgg = rep.sgg;
      }
    }
    // 법정동/생활권 merge 소스명 별도 보관 (compare carry 등에서 사용)
    this.activeMergeSource = intent.sourceLocation || null;

    // sgg 단위 쿼리(sggIndustry, rankDistricts): sgg 저장, district는 클리어
    if (intent.sgg && !intent.district && !intent.mergeDistricts?.length) {
      this.activeSgg = intent.sgg;
      this.activeDistrict = null;
    }

    if (intent.industry) this.activeIndustry = intent.industry;
    if (intent.questionType) {
      this.activeMetric = intent.questionType;
      this.lastView = intent.questionType;
    }
    if (intent.month) this.activeMonth = intent.month;

    // 비교 모드 업데이트
    if (intent.questionType === 'compare' && intent.compareTarget) {
      this.comparisonDistricts = [
        this.activeDistrict,
        {
          code: intent.compareTarget.code || '',
          name: intent.compareTarget.name || '',
          sgg: intent.compareTarget.sgg || '',
        },
      ].filter(d => d && d.code);
    }

    this.lastResult = response || null;
    this.lastQueryResult = queryResult || null;
    this.lastIntent = intent;
  }

  /**
   * 새 질문의 빠진 슬롯을 직전 상태로 채움.
   * @param {object} intent — IntentParser 결과
   * @returns {object} enrichedIntent — 보강된 intent (원본 변경 없음)
   */
  resolve(intent) {
    if (!intent) return intent;
    const enriched = { ...intent };
    let carried = false;

    // 지역: 새 질문에 없으면 직전 지역 이어받기
    // 단, 법정동 다중 매핑(districtCandidates)이 있으면 carry 스킵 (merge 우선)
    if (!enriched.district && !enriched.sgg && this.activeDistrict
        && !(enriched.districtCandidates?.length > 1)) {
      enriched.district = { ...this.activeDistrict };
      enriched._carriedDistrict = true;
      carried = true;
    }

    // 구(sgg): district도 sgg도 없고, activeSgg만 있으면 이어받기
    if (!enriched.district && !enriched.sgg && !enriched._carriedDistrict && this.activeSgg) {
      enriched.sgg = this.activeSgg;
      enriched._carriedSgg = true;
      carried = true;
    }

    // 업종: 새 질문에 없으면 직전 업종 이어받기
    if (!enriched.industry && this.activeIndustry) {
      enriched.industry = this.activeIndustry;
      enriched._carriedIndustry = true;
      carried = true;
      // overview인데 맥락에서 업종이 carry되면 → 해당 업종 분석으로 전환
      if (enriched.questionType === 'overview') {
        enriched.questionType = 'sales';
      }
    }

    // 월: 새 질문에 없으면 직전 월 이어받기
    if (!enriched.month && this.activeMonth) {
      enriched.month = this.activeMonth;
      enriched._carriedMonth = true;
    }

    enriched._isFollowUp = carried;
    return enriched;
  }

  /** explain_last_answer 라우트용 */
  getLastResult() {
    return this.lastResult;
  }

  getLastQueryResult() {
    return this.lastQueryResult;
  }

  getLastIntent() {
    return this.lastIntent;
  }

  hasContext() {
    return this.turnCount > 0 && (this.activeDistrict || this.activeIndustry);
  }

  /**
   * Gemini 프롬프트용 요약.
   * @returns {string} 1-2줄 맥락 요약
   */
  toSummary() {
    const parts = [];
    if (this.activeDistrict?.name) parts.push(`지역: ${this.activeDistrict.name}`);
    else if (this.activeSgg) parts.push(`구: ${this.activeSgg}`);
    if (this.activeIndustry) parts.push(`업종: ${this.activeIndustry}`);
    if (this.activeMetric) parts.push(`지표: ${this.activeMetric}`);
    if (this.comparisonDistricts.length > 1) {
      parts.push(`비교: ${this.comparisonDistricts.map(d => d.name).join(' vs ')}`);
    }
    return parts.length ? `[직전 맥락] ${parts.join(', ')}` : '';
  }
}

export default ConversationState;
