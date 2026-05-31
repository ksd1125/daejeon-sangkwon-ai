import { DataLoader } from './data-loader.js';

const DAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];
const TIME_LABELS = ['05-09시', '09-12시', '12-14시', '14-18시', '18-23시', '23-05시'];

export class QueryEngine {
  constructor(dataLoader) {
    if (!(dataLoader instanceof DataLoader) && !dataLoader?.loadDistrict) {
      throw new Error('QueryEngine requires a DataLoader-compatible instance.');
    }
    this.dataLoader = dataLoader;
  }

  /**
   * 행정동 + 업종 + 월 기준 단일 레코드 조회.
   * district JSON 구조: { industries: { "업종명": { m: { "YYYYMM": { ... } } } } }
   */
  async queryRecord(districtCode, industry, month = null) {
    const code = typeof districtCode === 'object' ? districtCode?.code : String(districtCode || '');
    if (!code || !industry) return null;

    const data = await this.dataLoader.loadDistrict(code);
    if (!data?.industries) return null;

    const targetMonth = String(month || this.dataLoader.getLatestMonth?.() || '').trim();
    const targetIndustry = this._compact(industry);

    // 업종 이름 매칭 (정확 → 부분)
    const industryKey = this._findIndustryKey(data.industries, targetIndustry);
    if (!industryKey) return null;

    const entry = data.industries[industryKey];
    const months = entry?.m || {};

    // 월 매칭: 정확 → 최신
    let record = months[targetMonth] || null;
    if (!record) {
      const sortedMonths = Object.keys(months).sort();
      const latestKey = sortedMonths[sortedMonths.length - 1];
      if (latestKey) record = months[latestKey];
    }
    if (!record) return null;

    return this._enrichRecord(record, data, industryKey, entry, targetMonth || Object.keys(months).sort().pop());
  }

  /**
   * 데이터 없을 때 대안 추천.
   * @returns {{ availableIndustries: string[], nearbyDistricts: {name,code,sgg}[] }}
   */
  async suggestAlternatives(districtCode, industry, sgg) {
    const alternatives = { availableIndustries: [], nearbyDistricts: [] };
    const code = typeof districtCode === 'object' ? districtCode?.code : String(districtCode || '');

    // 1) 같은 동의 인기 업종 (업소 수 기준 상위 5개)
    if (code) {
      const data = await this.dataLoader.loadDistrict(code);
      if (data?.industries) {
        const month = this.dataLoader.getLatestMonth?.() || '';
        const scored = Object.entries(data.industries)
          .map(([name, ind]) => {
            const rec = ind?.m?.[month] || Object.values(ind?.m || {}).pop();
            return { name, upso: rec?.upso ?? 0 };
          })
          .filter(e => e.upso > 0)
          .sort((a, b) => b.upso - a.upso);
        alternatives.availableIndustries = scored.slice(0, 5).map(e => e.name);
      }
    }

    // 2) 같은 구에서 해당 업종 데이터가 있는 인근 동 (최대 3개)
    if (sgg && industry) {
      const districts = this.dataLoader.getDistrictsBySgg(sgg) || [];
      const month = this.dataLoader.getLatestMonth?.() || '';
      const targetIndustry = this._compact(industry);
      const found = [];
      for (const d of districts) {
        if (d.code === code) continue; // 자기 자신 제외
        if (found.length >= 3) break;
        const dData = await this.dataLoader.loadDistrict(d.code);
        if (!dData?.industries) continue;
        const key = this._findIndustryKey(dData.industries, targetIndustry);
        if (key) {
          const rec = dData.industries[key]?.m?.[month] || Object.values(dData.industries[key]?.m || {}).pop();
          if (rec?.upso > 0) found.push({ name: d.name, code: d.code, sgg: d.sgg });
        }
      }
      alternatives.nearbyDistricts = found;
    }

    return alternatives;
  }

  buildComparison(record) {
    if (!record) return { items: [], diffs: [], dataStatus: null };
    return this._buildMetricComparison(record, 'amt', '업소당 월평균 매출', '만원');
  }

  buildUpsoComparison(record) {
    if (!record) return { items: [], diffs: [], dataStatus: null };
    return this._buildMetricComparison(record, 'upso', '업소 수', '개');
  }

  async buildTrend(districtCode, industry) {
    const code = typeof districtCode === 'object' ? districtCode?.code : String(districtCode || '');
    if (!code || !industry) return { monthly: [], movingAvg: [], quarterly: [] };

    const data = await this.dataLoader.loadDistrict(code);
    if (!data?.industries) return { monthly: [], movingAvg: [], quarterly: [] };

    const targetIndustry = this._compact(industry);
    const industryKey = this._findIndustryKey(data.industries, targetIndustry);
    if (!industryKey) return { monthly: [], movingAvg: [], quarterly: [] };

    const months = data.industries[industryKey]?.m || {};
    const monthly = Object.entries(months)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, rec]) => ({ month, amt: rec.amt ?? null, upso: rec.upso ?? null }));

    const movingAvg = monthly.map((item, index) => {
      const window = monthly.slice(Math.max(0, index - 2), index + 1);
      const values = window.map((e) => e.amt).filter(Number.isFinite);
      const amt = values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null;
      return { month: item.month, amt };
    });

    const quarterMap = new Map();
    monthly.forEach((item) => {
      const quarter = this._toQuarter(item.month);
      if (!quarter || !Number.isFinite(item.amt)) return;
      if (!quarterMap.has(quarter)) quarterMap.set(quarter, []);
      quarterMap.get(quarter).push(item.amt);
    });
    const quarterly = [...quarterMap.entries()].map(([quarter, values]) => ({
      quarter,
      amt: Math.round(values.reduce((s, v) => s + v, 0) / values.length),
    }));

    return { monthly, movingAvg, quarterly };
  }

  /** 3계층(동/구/시) 12개월 시계열 — TrendCard용
   *  @param {string} metric - 'amt' (매출) 또는 'upso' (업소 수)
   */
  async buildTierTrend(districtCode, industry, metric = 'amt') {
    const code = typeof districtCode === 'object' ? districtCode?.code : String(districtCode || '');
    if (!code || !industry) return null;

    const data = await this.dataLoader.loadDistrict(code);
    if (!data?.industries) return null;

    const targetIndustry = this._compact(industry);
    const industryKey = this._findIndustryKey(data.industries, targetIndustry);
    if (!industryKey) return null;

    const months = data.industries[industryKey]?.m || {};
    const sorted = Object.entries(months).sort(([a], [b]) => (a > b ? 1 : a < b ? -1 : 0)).slice(-12);
    if (sorted.length < 2) return null;

    const labels = sorted.map(([m]) => {
      const y = m.slice(2, 4);
      const mo = parseInt(m.slice(4), 10);
      return `${y}.${mo}`;
    });

    const sggKey = metric + 'Sgg';
    const sidoKey = metric + 'Sido';
    let dongData = sorted.map(([, r]) => r[metric] ?? null);
    let sggData = sorted.map(([, r]) => r[sggKey] ?? null);
    let sidoData = sorted.map(([, r]) => r[sidoKey] ?? null);

    // upsoSgg/upsoSido는 합계값 → 행정동 수로 나눠 평균으로 변환
    if (metric === 'upso') {
      const sgg = String(data.sgg || '');
      const sggCount = Math.max(1, sgg ? this.dataLoader.getDistrictsBySgg(sgg).length : 1);
      const totalCount = this.dataLoader.getDistrictList().length || 82;
      sggData = sggData.map(v => Number.isFinite(v) ? Math.round(v / sggCount) : null);
      sidoData = sidoData.map(v => Number.isFinite(v) ? Math.round(v / totalCount) : null);
      // sgg_sub + upso===upsoSgg(raw) + upsoDong=0 → 가짜 값 null 처리
      dongData = sorted.map(([, r]) => {
        if (r.dataStatus === 'sgg_sub' && Number.isFinite(r.upso) && Number.isFinite(r.upsoSgg)
            && r.upso === r.upsoSgg && (!r.upsoDong || r.upsoDong === 0)) {
          return null;
        }
        return r[metric] ?? null;
      });
    }

    return { labels, dong: dongData, sgg: sggData, sido: sidoData };
  }

  async buildOverview(districtCode, month = null) {
    const code = typeof districtCode === 'object' ? districtCode?.code : String(districtCode || '');
    if (!code) return { topIndustries: [], totalIndustries: 0, directCount: 0, subCount: 0, pop: null };

    const data = await this.dataLoader.loadDistrict(code);
    if (!data?.industries) return { topIndustries: [], totalIndustries: 0, directCount: 0, subCount: 0, pop: null };

    const targetMonth = String(month || this.dataLoader.getLatestMonth?.() || '').trim();
    const records = [];

    for (const [name, entry] of Object.entries(data.industries)) {
      const months = entry?.m || {};
      const rec = months[targetMonth] || null;
      if (!rec) continue;
      records.push(this._enrichRecord(rec, data, name, entry, targetMonth));
    }

    const sorted = records
      .filter((r) => Number.isFinite(r.amt))
      .sort((a, b) => b.amt - a.amt);

    const topIndustries = sorted.slice(0, 10).map((r) => ({
      name: r.industry,
      amt: r.amt,
      upso: r.upso,
      dataStatus: r.dataStatus,
    }));

    // 실제 영업 중인 업종만 카운트: 로컬 업소가 실재(upso>0, 시군구 대체값 제외)
    // (데이터 파일은 247개 업종 행을 모두 포함하므로 records.length는 항상 247이고,
    //  sgg_sub 대체 amt만 있는 업종은 '영업 중'이 아님)
    const operating = records.filter((r) => Number.isFinite(r.upso) && r.upso > 0 && !r._upsoImputed);
    const directCount = operating.filter((r) => r.dataStatus === 'direct').length;
    const subCount = operating.filter((r) => r.dataStatus === 'sgg_sub').length;
    const amtIndustries = operating.filter((r) => Number.isFinite(r.amt) && !r._amtImputed).length;
    const popRecord = records.find((r) => Number.isFinite(r.pop)) || null;

    // 총합계 (업소 수, 매출) — imputed 값은 제외
    const totalUpso = records.reduce((s, r) => s + (Number.isFinite(r.upso) && !r._upsoImputed ? r.upso : 0), 0);
    const totalAmt = records.reduce((s, r) => s + (Number.isFinite(r.amt) && !r._amtImputed ? r.amt : 0), 0);

    // 업종 구성 비율 (상위 7개 + 기타)
    const topN = sorted.slice(0, 7);
    const otherAmt = totalAmt - topN.reduce((s, r) => s + r.amt, 0);
    const composition = topN.map(r => ({ label: r.industry, value: r.amt }));
    if (otherAmt > 0) composition.push({ label: '기타', value: otherAmt });

    return {
      topIndustries,
      totalIndustries: operating.length,
      amtIndustries,
      directCount,
      subCount,
      totalUpso,
      totalAmt,
      composition,
      pop: popRecord ? {
        total: popRecord.pop,
        peakDay: popRecord.peakDay,
        peakTime: popRecord.peakTime,
        byDay: popRecord.byDay || [],
        byTime: popRecord.byTime || [],
      } : null,
    };
  }

  async rankDistrictsByIndustry(sggName, industry, metric = 'sales', month = null, limit = 10) {
    const districts = this.dataLoader.getDistrictsBySgg(sggName);
    const targetMonth = String(month || this.dataLoader.getLatestMonth?.() || '').trim();
    const metricKey = { sales: 'amt', stores: 'upso', population: 'pop' }[metric] || 'amt';
    const unit = { sales: '만원', stores: '개', population: '명' }[metric] || '만원';

    const records = await Promise.all(
      districts.map(async (district) => {
        const record = await this.queryRecord(district.code, industry, targetMonth);
        if (!record || !Number.isFinite(record[metricKey])) return null;
        return {
          code: district.code,
          district: district.name,
          sgg: district.sgg,
          industry: record.industry || industry,
          month: record.month || targetMonth,
          value: record[metricKey],
          amt: record.amt,
          upso: record.upso,
          pop: record.pop,
          dataStatus: record.dataStatus,
        };
      }),
    );

    const ranked = records
      .filter(Boolean)
      .sort((a, b) => b.value - a.value)
      .slice(0, Math.max(1, Number(limit) || 10));

    return {
      sgg: sggName,
      industry,
      metric,
      metricKey,
      unit,
      month: targetMonth,
      items: ranked,
      totalDistricts: districts.length,
      matchedDistricts: records.filter(Boolean).length,
    };
  }

  async buildSggIndustry(sggName, industry, metric = 'trend', month = null) {
    const districts = this.dataLoader.getDistrictsBySgg(sggName);
    const targetMonth = String(month || this.dataLoader.getLatestMonth?.() || '').trim();
    const metricKey = { sales: 'amt', stores: 'upso', population: 'pop', trend: 'amt', all: 'amt' }[metric] || 'amt';
    const unit = { sales: '만원', stores: '개', population: '명', trend: '만원', all: '만원' }[metric] || '만원';

    const loaded = await Promise.all(districts.map(async (district) => {
      const data = await this.dataLoader.loadDistrict(district.code);
      const targetIndustry = this._compact(industry);
      const industryKey = data?.industries ? this._findIndustryKey(data.industries, targetIndustry) : null;
      if (!industryKey) return null;
      const entry = data.industries[industryKey];
      const months = entry?.m || {};
      const currentRaw = months[targetMonth] || null;
      const current = currentRaw ? this._enrichRecord(currentRaw, data, industryKey, entry, targetMonth) : null;
      return { district, data, industryKey, entry, current };
    }));

    const sources = loaded.filter(Boolean);
    const records = sources.map(s => s.current).filter(Boolean);
    const fin = (v) => Number.isFinite(v);
    const sum = (values) => values.reduce((s, v) => s + v, 0);
    const avg = (values) => values.length ? Math.round(sum(values) / values.length) : null;
    const aggregate = (key, rows) => {
      const values = rows.map(r => r?.[key]).filter(fin);
      if (!values.length) return null;
      return key === 'amt' ? avg(values) : sum(values);
    };

    const monthList = (this.dataLoader.months?.length ? this.dataLoader.months : Object.keys(sources[0]?.entry?.m || {}))
      .map(String)
      .sort()
      .slice(-12);
    const recordAt = (source, m) => {
      const raw = source.entry?.m?.[m];
      return raw ? this._enrichRecord(raw, source.data, source.industryKey, source.entry, m) : null;
    };
    const annualRows = sources
      .map((source) => {
        const values = monthList.map(m => recordAt(source, m)?.amt).filter(fin);
        if (!values.length) return null;
        return {
          district: source.district.name,
          annualAvgAmt: avg(values),
          source,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.annualAvgAmt - a.annualAvgAmt);
    const cohortSize = annualRows.length ? Math.max(1, Math.round(annualRows.length * 0.1)) : 0;
    const topCohort = cohortSize ? annualRows.slice(0, cohortSize) : [];
    const bottomCohort = cohortSize ? annualRows.slice(-cohortSize).reverse() : [];
    const cohortAvgAt = (cohort, m) => avg(cohort.map(item => recordAt(item.source, m)?.amt).filter(fin));
    const monthly = monthList.map((m) => {
      const rows = sources.map(source => recordAt(source, m)).filter(Boolean);
      return {
        month: m,
        amt: aggregate('amt', rows),
        upso: aggregate('upso', rows),
        pop: aggregate('pop', rows),
        top10Amt: cohortAvgAt(topCohort, m),
        bottom10Amt: cohortAvgAt(bottomCohort, m),
      };
    });

    const current = {
      amt: aggregate('amt', records),
      upso: aggregate('upso', records),
      pop: aggregate('pop', records),
    };
    const topDistricts = records
      .filter(r => fin(r[metricKey]))
      .sort((a, b) => b[metricKey] - a[metricKey])
      .slice(0, 5)
      .map(r => ({
        district: r.districtName,
        value: r[metricKey],
        amt: r.amt,
        upso: r.upso,
        pop: r.pop,
        dataStatus: r.dataStatus,
      }));

    return {
      sgg: sggName,
      industry,
      metric,
      metricKey,
      unit,
      month: targetMonth,
      current,
      monthly,
      cohorts: {
        basis: '최근 12개월 행정동별 평균 업소당 월매출',
        topPct: 10,
        bottomPct: 10,
        size: cohortSize,
        topDistricts: topCohort.map(({ district, annualAvgAmt }) => ({ district, annualAvgAmt })),
        bottomDistricts: bottomCohort.map(({ district, annualAvgAmt }) => ({ district, annualAvgAmt })),
      },
      topDistricts,
      totalDistricts: districts.length,
      matchedDistricts: records.length,
    };
  }

  /**
   * 행정동의 유동인구 상세 (업종 무관 — 첫 번째 유효 레코드에서 추출).
   */
  async getDistrictPopulation(districtCode, month = null) {
    const code = typeof districtCode === 'object' ? districtCode?.code : String(districtCode || '');
    if (!code) return null;

    const data = await this.dataLoader.loadDistrict(code);
    if (!data?.industries) return null;

    const targetMonth = String(month || this.dataLoader.getLatestMonth?.() || '').trim();

    for (const [name, entry] of Object.entries(data.industries)) {
      const rec = entry?.m?.[targetMonth];
      if (!rec || !Number.isFinite(rec.pop)) continue;
      const enriched = this._enrichRecord(rec, data, name, entry, targetMonth);
      return {
        pop: enriched.pop,
        weekday: enriched.popWeekday,
        weekend: enriched.popWeekend,
        byDay: enriched.byDay,
        byTime: enriched.byTime,
        peakDay: enriched.peakDay,
        peakTime: enriched.peakTime,
        _industry: name,
      };
    }
    return null;
  }

  getSimilar(record) {
    if (!record) return [];
    return (record.similar || []).map((item) => ({
      district: item.dong || item.district || item.name || '',
      amt: item.amt ?? null,
      pop: item.pop ?? null,
      upso: item.upso ?? null,
    }));
  }

  /**
   * 두 행정동을 같은 업종/월 기준으로 병렬 조회.
   * @returns {{ district1: enrichedRecord|null, district2: enrichedRecord|null }}
   */
  async queryCompareDistricts(code1, code2, industry, month = null) {
    const [rec1, rec2] = await Promise.all([
      this.queryRecord(code1, industry, month),
      this.queryRecord(code2, industry, month),
    ]);
    return { district1: rec1, district2: rec2 };
  }

  /**
   * 두 레코드를 수평 비교표로 구성.
   * @returns {{ metrics: Array<{ label, unit, value1, value2, diff, pctDiff }>, summary }}
   */
  buildHorizontalComparison(record1, record2) {
    if (!record1 && !record2) return { metrics: [], summary: null };

    const metrics = [];
    const fin = (v) => Number.isFinite(v);
    const add = (label, unit, v1, v2) => {
      if (!fin(v1) && !fin(v2)) return;
      const diff = fin(v1) && fin(v2) ? v1 - v2 : null;
      const pctDiff = fin(diff) && v2 !== 0 ? Number(((diff / v2) * 100).toFixed(1)) : null;
      metrics.push({ label, unit, value1: v1 ?? null, value2: v2 ?? null, diff, pctDiff });
    };

    add('업소당 월평균 매출', '만원', record1?.amt, record2?.amt);
    add('업소 수', '개', record1?.upso, record2?.upso);
    add('일평균 유동인구', '명', record1?.pop, record2?.pop);
    add('매출 전년동월 대비', '%', record1?.amtYoY, record2?.amtYoY);
    add('매출 전월 대비', '%', record1?.amtMoM, record2?.amtMoM);

    // 우세 지역 판단
    const amtMetric = metrics.find((m) => m.label === '업소당 월평균 매출');
    let summary = null;
    if (amtMetric && fin(amtMetric.diff)) {
      const winner = amtMetric.diff > 0 ? record1 : record2;
      const loser = amtMetric.diff > 0 ? record2 : record1;
      summary = {
        amtWinner: winner?.districtName || '',
        amtLoser: loser?.districtName || '',
        amtDiffPct: Math.abs(amtMetric.pctDiff ?? 0),
      };
    }

    return { metrics, summary };
  }

  /**
   * 같은 중분류 내 소분류 비교 — "카페 물으면 같은 중분류 안에서 비교".
   * @returns {{ midCategory, items: Array<{ name, amt, upso, pop }> }}
   */
  async getMidCategoryComparison(districtCode, industry, month = null) {
    const code = typeof districtCode === 'object' ? districtCode?.code : String(districtCode || '');
    if (!code || !industry) return { midCategory: null, items: [] };

    const data = await this.dataLoader.loadDistrict(code);
    if (!data?.industries) return { midCategory: null, items: [] };

    const targetIndustry = this._compact(industry);
    const industryKey = this._findIndustryKey(data.industries, targetIndustry);
    if (!industryKey) return { midCategory: null, items: [] };

    const targetCat = data.industries[industryKey]?.cat || [];
    const midCategory = targetCat[1] || null;
    if (!midCategory) return { midCategory: null, items: [] };

    const targetMonth = String(month || this.dataLoader.getLatestMonth?.() || '').trim();
    const items = [];

    for (const [name, entry] of Object.entries(data.industries)) {
      const cat = entry?.cat || [];
      if (cat[1] !== midCategory) continue;
      const rec = entry?.m?.[targetMonth];
      if (!rec) continue;
      items.push({
        name,
        amt: rec.amt ?? null,
        upso: rec.upso ?? null,
        pop: rec.pop ?? null,
        isCurrent: this._compact(name) === this._compact(industryKey),
      });
    }

    items.sort((a, b) => (b.amt ?? 0) - (a.amt ?? 0));
    return { midCategory, items };
  }

  /**
   * 두 행정동의 추세 데이터를 비교용으로 반환.
   * @returns {{ labels: string[], datasets: [{ label, data }] }}
   */
  async getTrendComparison(code1, code2, industry) {
    const [trend1, trend2] = await Promise.all([
      this.buildTrend(code1, industry),
      this.buildTrend(code2, industry),
    ]);

    // 공통 월 기준으로 정렬
    const allMonths = new Set([
      ...trend1.monthly.map(m => m.month),
      ...trend2.monthly.map(m => m.month),
    ]);
    const labels = [...allMonths].sort();

    const map1 = new Map(trend1.monthly.map(m => [m.month, m.amt]));
    const map2 = new Map(trend2.monthly.map(m => [m.month, m.amt]));

    return {
      labels: labels.map(m => this._formatMonthShort(m)),
      rawLabels: labels,
      datasets: [
        { data: labels.map(m => map1.get(m) ?? null) },
        { data: labels.map(m => map2.get(m) ?? null) },
      ],
    };
  }

  getPopulationDetail(record) {
    if (!record) {
      return { pop: null, weekday: null, weekend: null, byDay: [], byTime: [], peakDay: null, peakTime: null };
    }
    return {
      pop: record.pop,
      weekday: record.weekday ?? record.popWeekday ?? null,
      weekend: record.weekend ?? record.popWeekend ?? null,
      byDay: record.byDay || [],
      byTime: record.byTime || [],
      peakDay: record.peakDay || null,
      peakTime: record.peakTime || null,
    };
  }

  // ── private ──

  /**
   * raw JSON record를 응답 빌더가 기대하는 형태로 보강.
   */
  _enrichRecord(rec, districtData, industryKey, entry, month) {
    const byDayRaw = rec.popByDay || [];
    const byTimeRaw = rec.popByTime || [];

    // upsoSgg/upsoSido는 소속 행정동 합계 → 평균으로 변환
    const sgg = String(districtData.sgg || '');
    const sggCount = sgg ? this.dataLoader.getDistrictsBySgg(sgg).length : 1;
    const totalCount = this.dataLoader.getDistrictList().length || 82;
    const upsoSggAvg = Number.isFinite(rec.upsoSgg) ? Math.round(rec.upsoSgg / sggCount) : null;
    const upsoSidoAvg = Number.isFinite(rec.upsoSido) ? Math.round(rec.upsoSido / totalCount) : null;

    // sgg_sub 레코드 보정: 개별 데이터 없이 시군구 합계가 대입된 경우 감지
    const isSggSub = rec.dataStatus === 'sgg_sub';
    let adjustedUpso = rec.upso ?? null;
    let upsoImputed = false;
    let amtImputed = false;

    if (isSggSub) {
      // upso가 raw upsoSgg와 동일하고 upsoDong이 0/null → 가짜 값이므로 null 처리
      const fin = (v) => Number.isFinite(v);
      if (fin(rec.upso) && fin(rec.upsoSgg) && rec.upso === rec.upsoSgg) {
        if (!rec.upsoDong || rec.upsoDong === 0) {
          adjustedUpso = null;
          upsoImputed = true;
        }
      }
      // amt가 amtSgg와 동일 → 시군구 평균으로 대체된 값
      if (fin(rec.amt) && fin(rec.amtSgg) && rec.amt === rec.amtSgg) {
        amtImputed = true;
      }
    }

    return {
      ...rec,
      month: String(month || ''),
      districtCode: String(districtData.code || ''),
      districtName: String(districtData.district || districtData.name || ''),
      sgg: String(districtData.sgg || ''),
      industry: String(industryKey || ''),
      category: Array.isArray(entry?.cat) ? entry.cat.join(' > ') : '',
      amt: rec.amt ?? null,
      amtSgg: rec.amtSgg ?? null,
      amtSido: rec.amtSido ?? null,
      amtYoY: amtImputed ? null : (rec.amtYoY ?? null),
      amtMoM: amtImputed ? null : (rec.amtMoM ?? null),
      upso: adjustedUpso,
      upsoSgg: upsoSggAvg,
      upsoSido: upsoSidoAvg,
      upsoSggTotal: rec.upsoSgg ?? null,  // 구 전체 업소 수 (총합)
      upsoSidoTotal: rec.upsoSido ?? null, // 대전시 전체 업소 수 (총합)
      pop: rec.pop ?? null,
      popWeekday: rec.popWeekday ?? null,
      popWeekend: rec.popWeekend ?? null,
      upsoYoY: upsoImputed ? null : (rec.upsoYoY ?? null),
      upsoMoM: upsoImputed ? null : (rec.upsoMoM ?? null),
      byDay: byDayRaw.length === DAY_LABELS.length
        ? DAY_LABELS.map((label, i) => ({ label, value: byDayRaw[i] }))
        : [],
      byTime: byTimeRaw.length === TIME_LABELS.length
        ? TIME_LABELS.map((label, i) => ({ label, value: byTimeRaw[i] }))
        : [],
      peakDay: rec.peakDay || null,
      peakTime: rec.peakTime || null,
      dataStatus: rec.dataStatus || 'direct',
      similar: rec.similar || [],
      _amtImputed: amtImputed,
      _upsoImputed: upsoImputed,
    };
  }

  /**
   * industries 객체에서 업종명 매칭. 정확 → compact 비교 → 부분 포함.
   */
  _findIndustryKey(industries, targetCompact) {
    const keys = Object.keys(industries);

    // 1) compact 정확 매칭
    const exact = keys.find((k) => this._compact(k) === targetCompact);
    if (exact) return exact;

    // 2) 포함 매칭 (긴 이름 우선)
    const sorted = [...keys].sort((a, b) => b.length - a.length);
    const contains = sorted.find((k) => this._compact(k).includes(targetCompact) || targetCompact.includes(this._compact(k)));
    return contains || null;
  }

  _buildMetricComparison(record, metric, label, unit) {
    const districtValue = record[metric];
    const sggKey = metric === 'amt' ? 'amtSgg' : 'upsoSgg';
    const sidoKey = metric === 'amt' ? 'amtSido' : 'upsoSido';
    const sggValue = record[sggKey];
    const sidoValue = record[sidoKey];
    const isAmtImputed = metric === 'amt' && record._amtImputed;
    const isUpsoImputed = metric === 'upso' && record._upsoImputed;

    const items = [
      { label: `${record.districtName || '행정동'} ${label}`, value: districtValue, unit },
    ];
    // imputed면 동 = 시군구이므로 시군구 비교 생략
    if (!isAmtImputed && !isUpsoImputed) {
      items.push({ label: `${record.sgg || '시군구'} 평균`, value: sggValue, unit });
    }
    items.push({ label: '대전광역시 평균', value: sidoValue, unit });
    const filtered = items.filter((item) => Number.isFinite(item.value));

    const diffs = [];
    if (!isAmtImputed && !isUpsoImputed) {
      const d = this._diff('시군구 평균', districtValue, sggValue);
      if (d) diffs.push(d);
    }
    const sidoDiff = this._diff('시도 평균', districtValue, sidoValue);
    if (sidoDiff) diffs.push(sidoDiff);

    return { items: filtered, diffs, dataStatus: record.dataStatus };
  }

  /**
   * 여러 행정동의 데이터를 병합 (합산/평균).
   * upso, pop → 합산, amt → 평균.
   * @param {string[]} codes — 행정동 코드 배열
   * @param {string} industry
   * @param {string} month
   * @returns {{ merged, records, names }}
   */
  async queryMergedDistricts(codes, industry, month = null) {
    if (!codes?.length || !industry) return null;
    const records = await Promise.all(codes.map(c => this.queryRecord(c, industry, month)));
    const valid = records.filter(Boolean);
    if (valid.length === 0) return null;

    const fin = (v) => Number.isFinite(v);
    const sum = (key) => valid.reduce((s, r) => s + (fin(r[key]) ? r[key] : 0), 0);
    const avg = (key) => {
      const vals = valid.filter(r => fin(r[key])).map(r => r[key]);
      return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
    };
    // 업소 수 가중 평균 (업소당 매출 등 "업소당" 지표에 사용)
    const weightedAvgByUpso = (key) => {
      const pairs = valid.filter(r => fin(r[key]) && fin(r.upso) && r.upso > 0);
      if (!pairs.length) return avg(key);   // fallback: 업소 수 없으면 단순 평균
      const totalWeight = pairs.reduce((s, r) => s + r.upso, 0);
      return totalWeight > 0
        ? Math.round(pairs.reduce((s, r) => s + r[key] * r.upso, 0) / totalWeight)
        : avg(key);
    };
    const names = valid.map(r => r.districtName).filter(Boolean);

    const merged = {
      districtName: names.join(' + '),
      districtCode: codes[0],
      sgg: valid[0]?.sgg || '',
      industry: valid[0]?.industry || industry,
      month: valid[0]?.month || '',
      amt: weightedAvgByUpso('amt'),
      upso: sum('upso'),
      pop: sum('pop'),
      amtSgg: valid[0]?.amtSgg ?? null,
      amtSido: valid[0]?.amtSido ?? null,
      upsoSgg: valid[0]?.upsoSgg ?? null,
      upsoSido: valid[0]?.upsoSido ?? null,
      amtYoY: weightedAvgByUpso('amtYoY'),
      amtMoM: weightedAvgByUpso('amtMoM'),
      upsoYoY: null,
      upsoMoM: null,
      popWeekday: avg('popWeekday'),
      popWeekend: avg('popWeekend'),
      peakDay: valid[0]?.peakDay || null,
      peakTime: valid[0]?.peakTime || null,
      dataStatus: valid.every(r => r.dataStatus === 'direct') ? 'direct' : 'sgg_sub',
      similar: [],
      _amtImputed: false,
      _upsoImputed: false,
      _isMerged: true,
      _mergedCount: valid.length,
    };

    return { merged, records: valid, names };
  }

  _diff(vs, current, base) {
    if (!Number.isFinite(current) || !Number.isFinite(base)) return null;
    const diff = current - base;
    const pct = base === 0 ? null : Number(((diff / base) * 100).toFixed(1));
    return { vs, diff, pct };
  }

  _compact(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }

  _formatMonthShort(yyyymm) {
    const v = String(yyyymm || '');
    if (!/^\d{6}$/.test(v)) return v;
    return `${v.slice(2, 4)}.${v.slice(4, 6)}`;
  }

  _toQuarter(yyyymm) {
    const value = String(yyyymm || '');
    if (!/^\d{6}$/.test(value)) return null;
    const month = Number(value.slice(4, 6));
    return `${value.slice(0, 4)}Q${Math.ceil(month / 3)}`;
  }
}

export default QueryEngine;
