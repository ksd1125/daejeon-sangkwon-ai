/**
 * InsightEngine — 레코드에서 자동으로 분석 인사이트를 추출.
 * 8개 감지기가 독립 실행, severity 순으로 상위 4개 반환.
 */
export class InsightEngine {
  constructor() {
    this._detectors = [
      (r) => this._detectRevenueVsSgg(r),
      (r) => this._detectYoYExtreme(r),
      // _detectRevenuePerBusiness 제거: amt가 이미 '업소당 월평균 매출'이라 amt/upso는 오산이며
      // 카드 본문 및 _detectRevenueVsSgg와 중복 (#27)
      (r) => this._detectWeekdayWeekend(r),
      (r) => this._detectPeakConcentration(r),
      (r) => this._detectRevenueVsSido(r),
      (r) => this._detectMoMTrend(r),
      (r) => this._detectBusinessCountAnomaly(r),
    ];
  }

  /**
   * @param {object} record — enriched record from QueryEngine
   * @param {object} [comparison] — comparison result (optional)
   * @returns {InsightItem[]} 최대 4개, severity 내림차순
   */
  generateInsights(record, comparison = null) {
    if (!record) return [];
    const all = [];
    for (const detect of this._detectors) {
      const item = detect(record);
      if (item) all.push(item);
    }
    return all.sort((a, b) => b.severity - a.severity).slice(0, 4);
  }

  /**
   * overview 데이터용 인사이트.
   */
  generateOverviewInsights(overview) {
    if (!overview) return [];
    const items = [];
    const total = overview.totalIndustries || 0;
    const direct = overview.directCount || 0;
    const sub = overview.subCount || 0;
    const directRatio = total > 0 ? Math.round((direct / total) * 100) : 0;

    if (directRatio > 0) {
      items.push({
        type: directRatio >= 50 ? 'highlight' : 'warning',
        icon: directRatio >= 50 ? '✅' : '⚠️',
        text: `전체 ${this._fmt(total)}개 업종 중 <strong>${directRatio}%</strong>가 행정동 직접값입니다`,
        value: `${directRatio}%`,
        detail: `직접값 ${this._fmt(direct)}건, 시군구 대체값 ${this._fmt(sub)}건`,
        severity: 0.5,
      });
    }

    if (overview.pop?.total) {
      items.push({
        type: 'comparison',
        icon: '👥',
        text: `일평균 유동인구 <strong>${this._fmt(overview.pop.total)}명</strong>`,
        value: `${this._fmt(overview.pop.total)}명`,
        detail: overview.pop.peakDay ? `${overview.pop.peakDay} ${overview.pop.peakTime || ''}에 가장 붐빕니다` : null,
        severity: 0.6,
      });
    }

    const top = overview.topIndustries?.[0];
    if (top) {
      items.push({
        type: 'highlight',
        icon: '🏆',
        text: `업소당 매출 1위 업종은 <strong>${top.name}</strong> (${this._fmt(top.amt)}만원)`,
        value: top.name,
        detail: `업소 수 ${this._fmt(top.upso)}개`,
        severity: 0.7,
      });
    }

    return items.sort((a, b) => b.severity - a.severity).slice(0, 4);
  }

  // ── 감지기 ──

  _detectRevenueVsSgg(r) {
    // sgg_sub일 때 amt===amtSgg → 의미 없는 비교이므로 건너뜀
    if (r.dataStatus === 'sgg_sub') return null;
    if (!fin(r.amt) || !fin(r.amtSgg) || r.amtSgg <= 0) return null;
    const ratio = r.amt / r.amtSgg;
    const sgg = r.sgg || '시군구';
    if (ratio > 3) {
      return {
        type: 'highlight', icon: '📈',
        text: `${sgg} 평균보다 <strong>${ratio.toFixed(1)}배</strong> 높은 매출`,
        value: `${ratio.toFixed(1)}배`,
        detail: `행정동 매출 ${this._fmt(r.amt)}만원 vs ${sgg} 평균 ${this._fmt(r.amtSgg)}만원`,
        severity: Math.min(0.95, 0.7 + ratio / 50),
      };
    }
    if (ratio < 0.3) {
      return {
        type: 'warning', icon: '📉',
        text: `${sgg} 평균의 <strong>${Math.round(ratio * 100)}%</strong> 수준 매출`,
        value: `${Math.round(ratio * 100)}%`,
        detail: `행정동 매출 ${this._fmt(r.amt)}만원 vs ${sgg} 평균 ${this._fmt(r.amtSgg)}만원`,
        severity: 0.8,
      };
    }
    if (ratio >= 1.5) {
      return {
        type: 'comparison', icon: '↗️',
        text: `${sgg} 평균보다 <strong>${ratio.toFixed(1)}배</strong> 높은 매출`,
        value: `${ratio.toFixed(1)}배`,
        detail: `행정동 ${this._fmt(r.amt)}만원 vs ${sgg} ${this._fmt(r.amtSgg)}만원`,
        severity: 0.55,
      };
    }
    return null;
  }

  _detectYoYExtreme(r) {
    if (!fin(r.amtYoY) || Math.abs(r.amtYoY) <= 30) return null;
    const abs = Math.abs(r.amtYoY);
    if (r.amtYoY > 0) {
      return {
        type: 'trend', icon: '🚀',
        text: `전년 대비 <strong>${this._fmt(r.amtYoY)}% 성장</strong>${abs > 100 ? ' — 이례적 수준' : ''}`,
        value: `+${this._fmt(r.amtYoY)}%`,
        detail: abs > 100 ? '전년 동월 대비 2배 이상 증가한 이례적인 성장입니다' : '전년 동월 대비 뚜렷한 성장세입니다',
        severity: Math.min(0.95, 0.6 + abs / 500),
      };
    }
    return {
      type: 'warning', icon: '⚠️',
      text: `전년 대비 <strong>${this._fmt(abs)}% 하락</strong> — 주의 필요`,
      value: `-${this._fmt(abs)}%`,
      detail: '전년 동월 대비 큰 폭의 매출 감소가 확인됩니다',
      severity: Math.min(0.9, 0.6 + abs / 500),
    };
  }

  _detectWeekdayWeekend(r) {
    const wd = r.popWeekday ?? r.weekday;
    const we = r.popWeekend ?? r.weekend;
    if (!fin(wd) || !fin(we) || we <= 0) return null;
    // wd/we는 주중 5일·주말 2일의 합산 비중(%) → 일평균으로 정규화해야 공정 (#33)
    const ratio = (wd / 5) / (we / 2);
    if (ratio < 1.5 && ratio > 0.7) return null; // 일평균 차이 작으면 건너뜀
    const heavier = ratio >= 1 ? '주중' : '주말';
    const mult = ratio >= 1 ? ratio : 1 / ratio;
    return {
      type: 'comparison', icon: '📅',
      text: `일평균 방문이 <strong>${heavier}에 ${mult.toFixed(1)}배</strong> 집중`,
      value: `${mult.toFixed(1)}:1`,
      detail: `주중 5일 ${wd.toFixed(1)}% vs 주말 2일 ${we.toFixed(1)}% (일평균 환산)`,
      severity: mult > 3 ? 0.65 : 0.4,
    };
  }

  _detectPeakConcentration(r) {
    if (!r.peakDay || !r.peakTime) return null;

    // popByTime에서 최대 비율 확인 (byTime은 [{label, value}] 형태)
    const byTime = r.byTime || [];
    let maxTimePct = 0;
    if (Array.isArray(byTime) && byTime.length > 0) {
      maxTimePct = Math.max(...byTime.map(t => (typeof t === 'object' ? t.value : t) || 0));
    }

    return {
      type: 'highlight', icon: '⏰',
      text: `유동인구 피크 <strong>${r.peakDay} ${r.peakTime}</strong>${maxTimePct > 25 ? ` (${maxTimePct.toFixed(1)}%)` : ''}`,
      value: `${r.peakDay} ${r.peakTime}`,
      detail: maxTimePct > 0 ? `해당 시간대에 전체 유동인구의 ${maxTimePct.toFixed(1)}%가 집중됩니다` : null,
      severity: maxTimePct > 25 ? 0.6 : 0.35,
    };
  }

  _detectRevenueVsSido(r) {
    // sgg_sub면 amt가 시군구 대체값이라 행정동 성과로 오인 → 건너뜀 (#31)
    if (r.dataStatus === 'sgg_sub') return null;
    if (!fin(r.amt) || !fin(r.amtSido) || r.amtSido <= 0) return null;
    const ratio = r.amt / r.amtSido;
    if (ratio < 2 && ratio > 0.5) return null; // 평범하면 건너뜀
    if (ratio >= 2) {
      return {
        type: 'comparison', icon: '🏙️',
        text: `대전 평균의 <strong>${ratio.toFixed(1)}배</strong> 매출`,
        value: `${ratio.toFixed(1)}배`,
        detail: `행정동 ${this._fmt(r.amt)}만원 vs 대전 평균 ${this._fmt(r.amtSido)}만원`,
        severity: Math.min(0.7, 0.4 + ratio / 30),
      };
    }
    return {
      type: 'warning', icon: '🏙️',
      text: `대전 평균의 <strong>${Math.round(ratio * 100)}%</strong> 수준`,
      value: `${Math.round(ratio * 100)}%`,
      detail: `행정동 ${this._fmt(r.amt)}만원 vs 대전 평균 ${this._fmt(r.amtSido)}만원`,
      severity: 0.45,
    };
  }

  _detectMoMTrend(r) {
    if (!fin(r.amtMoM) || Math.abs(r.amtMoM) <= 10) return null;
    const abs = Math.abs(r.amtMoM);
    if (r.amtMoM > 0) {
      return {
        type: 'trend', icon: '📊',
        text: `전월 대비 <strong>+${this._fmt(r.amtMoM)}%</strong> 상승`,
        value: `+${this._fmt(r.amtMoM)}%`,
        detail: '직전 월 대비 매출 상승세입니다',
        severity: Math.min(0.6, 0.35 + abs / 200),
      };
    }
    return {
      type: 'warning', icon: '📊',
      text: `전월 대비 <strong>${this._fmt(r.amtMoM)}%</strong> 하락`,
      value: `${this._fmt(r.amtMoM)}%`,
      detail: '직전 월 대비 매출 하락세입니다',
      severity: Math.min(0.6, 0.35 + abs / 200),
    };
  }

  _detectBusinessCountAnomaly(r) {
    if (r.dataStatus === 'sgg_sub') return null;
    if (!fin(r.upso) || !fin(r.upsoSgg) || r.upsoSgg <= 0) return null;
    const ratio = r.upso / r.upsoSgg;
    if (ratio < 2 && ratio > 0.3) return null;
    const sgg = r.sgg || '구';
    if (ratio >= 2) {
      return {
        type: 'comparison', icon: '🏪',
        text: `${sgg} 평균보다 업소가 <strong>${ratio.toFixed(1)}배</strong> 많음`,
        value: `${ratio.toFixed(1)}배`,
        detail: `행정동 ${this._fmt(r.upso)}개 vs ${sgg} 평균 ${this._fmt(r.upsoSgg)}개`,
        severity: 0.45,
      };
    }
    return {
      type: 'warning', icon: '🏪',
      text: `${sgg} 평균의 <strong>${Math.round(ratio * 100)}%</strong> 수준 업소 수`,
      value: `${Math.round(ratio * 100)}%`,
      detail: `행정동 ${this._fmt(r.upso)}개 vs ${sgg} 평균 ${this._fmt(r.upsoSgg)}개`,
      severity: 0.4,
    };
  }

  // ── helpers ──

  _fmt(n) {
    if (!fin(n)) return '-';
    return Number(n).toLocaleString('ko-KR');
  }
}

function fin(v) {
  return Number.isFinite(v);
}

export default InsightEngine;
