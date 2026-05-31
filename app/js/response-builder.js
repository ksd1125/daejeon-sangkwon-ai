import { InsightEngine } from './insight-engine.js';
import { josa } from './josa.js';

export class ResponseBuilder {
  constructor() {
    this._insightEngine = new InsightEngine();
  }

  build(intent, queryResult = {}) {
    const result = queryResult || {};
    const record = result.record || result.current || (this._looksLikeRecord(result) ? result : null);
    const month = intent?.month || record?.month || result.month || null;
    const monthDisplay = this._formatMonth(month);
    const district = this._districtName(intent, record);
    const sgg = intent?.sgg || record?.sgg || intent?.district?.sgg || '';
    const industry = intent?.industry || record?.industry || '';
    const questionType = intent?.questionType || 'overview';

    const response = {
      header: {
        question: intent?.question || '',
        month,
        monthDisplay,
        district,
        sgg,
        industry,
      },
      summary: { text: '', bullets: [] },
      insights: [],
      followUps: [],  // populated after insights
      dataNotice: this._dataNotice(record?.dataStatus || result.dataStatus, record),
      disambiguation: this._disambiguation(intent),
    };

    if (!record && !['overview', 'rankDistricts', 'sggIndustry'].includes(questionType)) {
      // 원인별 에러 메시지 분류
      if (industry && district) {
        response.summary.text = `${district}에 ${industry} 데이터가 없습니다.`;
      } else if (industry) {
        response.summary.text = `해당 지역에 ${industry} 데이터가 없습니다.`;
      } else {
        response.summary.text = '현재 데이터 기준으로 보면 조건에 맞는 값을 확인할 수 없습니다.';
      }

      // 대안 제안 (alternatives가 있으면 followUp 칩 + 안내 bullets 생성)
      const alt = result?.alternatives;
      if (alt) {
        const bullets = [];
        if (alt.availableIndustries?.length) {
          bullets.push(`${district}에서 조회 가능한 업종: ${alt.availableIndustries.slice(0, 5).join(', ')}`);
        }
        if (alt.nearbyDistricts?.length) {
          const names = alt.nearbyDistricts.map(d => d.name).join(', ');
          bullets.push(`같은 구에서 ${industry} 데이터가 있는 동: ${names}`);
        }
        if (bullets.length) {
          response.summary.bullets = bullets;
          // 대안 followUp 칩 생성
          const chips = [];
          if (alt.availableIndustries?.[0]) {
            chips.push({ text: `${district} ${alt.availableIndustries[0]} 어때?` });
          }
          if (alt.nearbyDistricts?.[0]) {
            chips.push({ text: `${alt.nearbyDistricts[0].name} ${industry} 어때?` });
          }
          if (sgg && industry) {
            chips.push({ text: `${sgg} ${industry} 높은 동네` });
          }
          response.followUps = chips;
        }
      }
      return response;
    }

    const builders = {
      sales: () => this._buildSales(response, intent, result, record),
      upso: () => this._buildUpso(response, intent, result, record),
      pop: () => this._buildPop(response, intent, result, record),
      trend: () => this._buildTrend(response, intent, result, record),
      similar: () => this._buildSimilar(response, intent, result, record),
      compare: () => this._buildCompare(response, intent, result),
      compareIndustry: () => this._buildCompareIndustry(response, intent, result),
      density: () => this._buildDensity(response, intent, result, record),
      merge: () => this._buildMerge(response, intent, result, record),
      rankDistricts: () => this._buildRankDistricts(response, intent, result),
      sggIndustry: () => this._buildSggIndustry(response, intent, result),
      overview: () => this._buildOverview(response, intent, result, record),
      dataStatus: () => this._buildDataStatus(response, intent, result, record),
    };

    (builders[questionType] || builders.overview)();

    // 빈 추세 차트 정리: 대상(첫) 시리즈가 전부 null이면 그래프 생략 (#23)
    this._pruneEmptyTrend(response);

    // 응답 메타 (디자인: botMeta — ● 분석 완료 · 카페 업종 · 둔산1동)
    const displayDistrict = response.header.district || district;
    response.meta = { status: '분석 완료', category: industry, district: displayDistrict, month: monthDisplay };
    // 필터 칩 (디자인: filterRow — [지역: 둔산1동] [업종: 카페] ...)
    response.filters = this._buildFilters(questionType, displayDistrict, industry, monthDisplay, sgg, intent);
    // 업종 배지 (디자인: categoryBadge)
    response.badge = industry ? this._categoryBadge(industry) : null;
    // 참고 각주 (디자인: note)
    response.note = this._buildDataNote(questionType, record, result, intent);

    // 인라인 미니맵 카드 (디자인: MapCard)
    const baseCodes = Array.isArray(intent?.district?.codes) && intent.district.codes.length
      ? intent.district.codes
      : [intent?.district?.code || record?.districtCode || ''];
    const mergeCodes = Array.isArray(intent?.mergeDistricts)
      ? intent.mergeDistricts.map(d => d.code).filter(Boolean)
      : [];
    const compareCodes = Array.isArray(intent?.compareTarget?.codes) && intent.compareTarget.codes.length
      ? intent.compareTarget.codes
      : [intent?.compareTarget?.code || ''];
    const districtCodes = (questionType === 'merge' && mergeCodes.length ? mergeCodes : baseCodes).filter(Boolean);
    const compareTarget = intent?.compareTarget;
    const compareCodeList = compareCodes.filter(Boolean);
    if (districtCodes.length && !['trend'].includes(questionType)) {
      const districtName = questionType === 'merge'
        ? (intent?.sourceLocation || displayDistrict || district)
        : district;
      response.mapCard = {
        districtCode: districtCodes[0],
        districtCodes,
        districtName,
        sgg,
        industry,
        compareCode: compareCodeList[0] || null,
        compareCodes: compareCodeList,
        compareName: compareTarget?.name || null,
        title: compareTarget
          ? `${districtName} ↔ ${compareTarget.name}`
          : `${districtName}${industry ? ' · ' + industry : ''}`,
        subtitle: compareTarget ? '두 지역의 경계와 점포 분포' : '분석 지역 경계와 점포 분포',
      };
    }
    if (questionType === 'overview' && result.overview) {
      response.insights = this._insightEngine.generateOverviewInsights(result.overview);
    } else if (record) {
      response.insights = this._insightEngine.generateInsights(record, result.comparison);
    }

    // 스마트 후속 질문 (인사이트 + record 기반, 빌더에서 설정한 대안 칩 유지)
    // compare/compareIndustry에서 이미 groups 구조로 설정된 경우 병합하지 않음
    if (!response.followUps?.groups) {
      // merge 뷰에서는 빌더가 header.district를 sourceLocation("반석동")으로 갱신하므로,
      // follow-up 칩에도 갱신된 이름을 사용해야 "노은2동 + 노은3동" 대신 "반석동"이 표시됨
      const followUpDistrict = response.header.district || district;
      const altFollowUps = response.followUps?.length ? response.followUps : [];
      response.followUps = [
        ...altFollowUps,
        ...this._smartFollowUps(intent, record, response.insights, { district: followUpDistrict, sgg, industry }),
      ];
    }

    // Gemini 내러티브용 맥락
    response.narrativeContext = {
      question: intent?.question || '',
      district,
      sgg,
      industry,
      month: monthDisplay,
      questionType,
      route: intent?._route || questionType,
      record: record || null,
      insights: response.insights,
      comparison: result.comparison || null,
      comparisonRecord2: result.compareResult?.district2 || null,
      conversationSummary: intent?._conversationSummary || '',
    };

    return response;
  }

  _buildSales(response, intent, result, record) {
    const monthDisplay = response.header.monthDisplay;
    const district = response.header.district || '해당 행정동';
    const industry = response.header.industry || '해당 업종';
    if (!Number.isFinite(record?.amt)) {
      response.summary.text = `${monthDisplay} 기준으로 ${district} ${industry}의 매출 추정값은 현재 데이터에 제공되지 않습니다.`;
      const bullets = [
        Number.isFinite(record?.upso) && record.upso > 0 ? `업소 수는 ${this._formatNumber(record.upso)}개입니다.` : '',
        Number.isFinite(record?.pop) ? `일평균 유동인구는 ${this._formatNumber(record.pop)}명입니다.` : '',
        record?.dataStatus === 'sgg_sub' ? '행정동 직접 매출값이 부족해 일부 지표만 참고값으로 표시됩니다.' : '',
      ].filter(Boolean);
      // 대안 제안
      const alt = result?.alternatives;
      if (alt?.availableIndustries?.length) {
        bullets.push(`이 동에서 인기 업종: ${alt.availableIndustries.slice(0, 4).join(', ')}`);
      }
      if (alt?.nearbyDistricts?.length) {
        bullets.push(`같은 구 ${industry} 가능: ${alt.nearbyDistricts.map(d => d.name).join(', ')}`);
      }
      response.summary.bullets = bullets;
      response.statsCard = {
        title: '확인 가능한 지표',
        subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
        cells: [
          { label: '업소당 월평균 매출', value: '데이터 없음', unit: '', delta: null, deltaLabel: null },
          { label: '업소 수', value: this._formatNumber(record?.upso), unit: '개',
            delta: record?.upsoYoY, deltaLabel: '전년동월' },
          { label: '일평균 유동인구', value: this._formatNumber(record?.pop), unit: '명',
            delta: null, deltaLabel: null },
        ],
      };
      // 대안 followUp 칩
      if (alt) {
        const chips = [];
        if (alt.availableIndustries?.[0]) chips.push({ text: `${district} ${alt.availableIndustries[0]} 어때?` });
        if (alt.nearbyDistricts?.[0]) chips.push({ text: `${alt.nearbyDistricts[0].name} ${industry} 매출` });
        const sgg = response.header.sgg;
        if (sgg) chips.push({ text: `${sgg} ${industry} 높은 동네` });
        response.followUps = chips;
      }
      return;
    }
    response.summary.text = `${monthDisplay} 기준으로 ${district} ${industry}의 업소당 월평균 매출은 ${this._formatNumber(record?.amt)}만원입니다.`;
    const fin0 = (v) => Number.isFinite(v);
    response.summary.bullets = [
      fin0(record?.upso) ? `현재 ${industry} 업소 ${this._formatNumber(record.upso)}개 영업 중` : '',
      this._trendText(record?.amtYoY, record?.amtMoM, '매출'),
    ].filter(Boolean);
    // 3계층 비교 (행정동 / 시군구 / 대전시)
    const fin = (v) => Number.isFinite(v);
    const tierItems = [];
    // amt가 시군구 대체값이면 동 vs 시군구 비교 무의미 → 시도 비교만
    if (fin(record?.amt)) tierItems.push({ label: district, value: record.amt });
    if (fin(record?.amtSgg) && !record?._amtImputed) tierItems.push({ label: `${response.header.sgg || '시군구'} 평균`, value: record.amtSgg });
    if (fin(record?.amtSido)) tierItems.push({ label: '대전시 평균', value: record.amtSido });
    // StatsCard — 매출 전용 지표만 표시
    const amtLabel = record?._amtImputed ? '업소당 월평균 매출(참고)' : '업소당 월평균 매출';
    response.statsCard = {
      title: `${industry} 매출 현황`,
      subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
      cells: [
        { label: amtLabel, value: this._formatNumber(record?.amt), unit: '만원',
          delta: record?.amtYoY, deltaLabel: '전년동월' },
        { label: '전월 대비', value: Number.isFinite(record?.amtMoM) ? this._formatNumber(record.amtMoM) : '-', unit: '%', delta: null, deltaLabel: null },
        fin(record?.amtSgg) ? { label: `${response.header.sgg || '시군구'} 평균`, value: this._formatNumber(record.amtSgg), unit: '만원' } : null,
        fin(record?.amtSido) ? { label: '대전시 평균', value: this._formatNumber(record.amtSido), unit: '만원' } : null,
      ].filter(Boolean),
    };

    // CompareCard (디자인: 수평 bar 비교 — 동/구/시)
    if (tierItems.length >= 2) {
      response.compareCard = {
        title: '지역 비교',
        items: tierItems,
        unit: '만원',
      };
    }

    // TrendCard (디자인: 12개월 라인차트 — 동/구/시 3시리즈)
    if (result.tierTrend) {
      const tt = result.tierTrend;
      response.trendCard = {
        title: '12개월 매출 추세',
        subtitle: this._trendSubtitle(tt.dong),
        labels: tt.labels,
        series: [
          { label: district, data: tt.dong, color: '#2D4540' },
          { label: `${response.header.sgg || '시군구'} 평균`, data: tt.sgg, color: '#A29E94', dashed: true },
          { label: '대전시 평균', data: tt.sido, color: '#D6D1C5', dotted: true },
        ],
      };
    }

  }

  _buildUpso(response, intent, result, record) {
    const district = response.header.district || '해당 행정동';
    const industry = response.header.industry || '해당 업종';

    if (record?._upsoImputed) {
      // 업소 수 데이터 없는 경우 (sgg_sub 대체값이 총합으로 들어온 케이스)
      response.summary.text = `${district}에 ${industry} 업소 수 개별 데이터가 없습니다. 시군구 평균을 참고하세요.`;
      response.summary.bullets = [
        `업소당 월평균 매출은 ${this._formatNumber(record?.amt)}만원입니다(시군구 참고값).`,
      ].filter(Boolean);
    } else {
      response.summary.text = `${district} ${industry}의 업소 수는 ${this._formatNumber(record?.upso)}개입니다.`;
      response.summary.bullets = [
        `업소당 월평균 매출은 ${this._formatNumber(record?.amt)}만원입니다.`,
        this._trendText(record?.upsoYoY, record?.upsoMoM, '업소 수'),
      ].filter(Boolean);
    }

    // 3계층 비교 — 업소 수가 imputed면 동 값 제외
    const fin = (v) => Number.isFinite(v);
    const tierItems = [];
    if (fin(record?.upso)) tierItems.push({ label: district, value: record.upso });
    if (fin(record?.upsoSgg)) tierItems.push({ label: `${response.header.sgg || '시군구'} 평균`, value: record.upsoSgg });
    if (fin(record?.upsoSido)) tierItems.push({ label: '대전시 평균', value: record.upsoSido });
    // StatsCard — 업소 전용 지표만 표시
    const monthDisplay = response.header.monthDisplay;
    response.statsCard = {
      title: `${industry} 업소 현황`,
      subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
      cells: [
        { label: '업소 수', value: this._formatNumber(record?.upso), unit: '개',
          delta: record?.upsoYoY, deltaLabel: '전년동월' },
        { label: '전월 대비', value: Number.isFinite(record?.upsoMoM) ? this._formatNumber(record.upsoMoM) : '-', unit: '%', delta: null, deltaLabel: null },
        fin(record?.upsoSgg) ? { label: `${response.header.sgg || '시군구'} 평균`, value: this._formatNumber(record.upsoSgg), unit: '개' } : null,
        fin(record?.upsoSido) ? { label: '대전시 평균', value: this._formatNumber(record.upsoSido), unit: '개' } : null,
      ].filter(Boolean),
    };

    // CompareCard (디자인: 수평 bar 비교 — 동/구/시)
    if (tierItems.length >= 2) {
      response.compareCard = {
        title: '업소 수 지역 비교',
        items: tierItems,
        unit: '개',
      };
    }

    // TrendCard (디자인: 12개월 라인차트 — 동/구/시)
    if (result.tierTrend) {
      const tt = result.tierTrend;
      response.trendCard = {
        title: '12개월 업소 수 추세',
        subtitle: this._trendSubtitle(tt.dong),
        labels: tt.labels,
        series: [
          { label: district, data: tt.dong, color: '#2D4540' },
          { label: `${response.header.sgg || '시군구'} 평균`, data: tt.sgg, color: '#A29E94', dashed: true },
          { label: '대전시 평균', data: tt.sido, color: '#D6D1C5', dotted: true },
        ],
      };
    }
  }

  _buildPop(response, intent, result, record) {
    const popDetail = result.population || {};
    const district = response.header.district || '해당 행정동';
    const industry = response.header.industry || '';
    const monthDisplay = response.header.monthDisplay;
    const fin = (v) => Number.isFinite(v);

    const popVal = record?.pop ?? popDetail.pop ?? null;
    const weekday = popDetail.weekday ?? record?.popWeekday ?? null;
    const weekend = popDetail.weekend ?? record?.popWeekend ?? null;
    const byDay = popDetail.byDay || record?.byDay || [];
    const byTime = popDetail.byTime || record?.byTime || [];
    const peakDay = popDetail.peakDay || record?.peakDay || null;
    const peakTime = popDetail.peakTime || record?.peakTime || null;

    const industryLabel = industry ? ` ${industry}` : '';
    response.summary.text = `${district}${industryLabel}의 일평균 유동인구는 ${this._formatNumber(popVal)}명입니다.`;
    response.summary.bullets = [
      peakDay ? `유동인구가 가장 많은 요일은 ${peakDay}입니다.` : '',
      peakTime ? `피크 시간대는 ${peakTime}입니다.` : '',
      fin(weekday) && fin(weekend) ? `평일 ${weekday}% · 주말 ${weekend}% 비율입니다.` : '',
    ].filter(Boolean);

    // StatsCard — 핵심 유동인구 지표
    response.statsCard = {
      title: industry ? `${industry} 유동인구 현황` : '유동인구 현황',
      subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
      cells: [
        { label: '일평균 유동인구', value: this._formatNumber(popVal), unit: '명' },
        { label: '평일 비율', value: fin(weekday) ? weekday.toFixed(1) : '-', unit: '%' },
        { label: '피크 요일', value: peakDay || '-', unit: '' },
        { label: '피크 시간대', value: peakTime || '-', unit: '' },
      ],
    };

    // 1) CompareCard — 요일별 유동인구 (세로 바 차트)
    if (byDay.length > 0 && fin(popVal)) {
      response.compareCard = {
        title: '요일별 유동인구',
        vertical: true,
        items: byDay.map(d => ({
          label: d.label,
          value: Math.round(popVal * 7 * (d.value || 0) / 100),
        })),
        unit: '명',
      };
    }

    // 2) TrendCard — 시간대별 유동인구 (라인 차트)
    if (byTime.length > 0 && fin(popVal)) {
      response.trendCard = {
        title: '시간대별 유동인구',
        subtitle: peakTime ? `피크: ${peakTime}` : null,
        labels: byTime.map(t => t.label),
        series: [{
          label: '유동인구',
          data: byTime.map(t => Math.round(popVal * (t.value || 0) / 100)),
          color: '#2D4540',
        }],
      };
    }

    // 3) TrendCard2 — 월별 유동인구 추세 (12개월 라인 차트)
    if (result.tierTrend) {
      const tt = result.tierTrend;
      response.trendCard2 = {
        title: '월별 유동인구 추세',
        subtitle: this._trendSubtitle(tt.dong),
        labels: tt.labels,
        series: [
          { label: district, data: tt.dong, color: '#2D4540' },
        ],
      };
    }
  }

  _buildDensity(response, intent, result, record) {
    const district = response.header.district || '해당 행정동';
    const industry = response.header.industry || '해당 업종';
    const monthDisplay = response.header.monthDisplay;
    const fin = (v) => Number.isFinite(v);
    const metrics = intent?.crossMetrics || ['upso', 'pop'];

    const upso = record?.upso;
    const pop = record?.pop;
    const amt = record?.amt;
    const canUpso = fin(upso) && !record?._upsoImputed && upso > 0;
    const canAmt = fin(amt) && !record?._amtImputed;

    // 교차 지표 유형 판별
    const hasSales = metrics.includes('sales');
    const hasUpso = metrics.includes('upso');
    const hasPop = metrics.includes('pop');

    if (hasSales && hasPop && !hasUpso) {
      // ── 매출 대비 유동인구 ──
      const popPerAmt = canAmt && fin(pop) && amt > 0 ? Number((pop / amt).toFixed(1)) : null;
      const amtPerPop = canAmt && fin(pop) && pop > 0 ? Number((amt / pop * 1000).toFixed(1)) : null;

      response.summary.text = `${district} ${industry}의 매출 대비 유동인구 효율을 분석합니다.`;
      response.summary.bullets = [
        fin(popPerAmt) ? `매출 1만원당 유동인구는 ${this._formatNumber(popPerAmt)}명입니다.` : '',
        fin(amtPerPop) ? `유동인구 1,000명당 매출은 ${this._formatNumber(amtPerPop)}만원입니다.` : '',
      ].filter(Boolean);

      response.statsCard = {
        title: `${industry} 매출·유동인구 효율`,
        subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
        cells: [
          { label: canAmt ? '업소당 월평균 매출' : '업소당 월평균 매출(참고)', value: this._formatNumber(amt), unit: '만원',
            delta: record?.amtYoY, deltaLabel: '전년동월' },
          { label: '일평균 유동인구', value: this._formatNumber(pop), unit: '명' },
          { label: '매출 1만원당 인구', value: fin(popPerAmt) ? this._formatNumber(popPerAmt) : '-', unit: '명' },
          { label: '인구 1천명당 매출', value: fin(amtPerPop) ? this._formatNumber(amtPerPop) : '-', unit: '만원' },
        ],
      };

      // CompareCard — 매출 3계층 비교
      const tierItems = [];
      if (fin(amt)) tierItems.push({ label: district, value: amt });
      if (fin(record?.amtSgg) && !record?._amtImputed) tierItems.push({ label: `${response.header.sgg || '시군구'} 평균`, value: record.amtSgg });
      if (fin(record?.amtSido)) tierItems.push({ label: '대전시 평균', value: record.amtSido });
      if (tierItems.length >= 2) {
        response.compareCard = { title: '매출 지역 비교', items: tierItems, unit: '만원' };
      }

    } else if (hasSales && hasUpso && !hasPop) {
      // ── 매출 대비 업소 수 (효율) ──

      response.summary.text = `${district} ${industry}의 업소 수와 업소당 월평균 매출을 함께 봅니다.`;
      response.summary.bullets = [
        canAmt ? `업소당 월평균 매출은 ${this._formatNumber(amt)}만원입니다.` : '',
      ].filter(Boolean);

      response.statsCard = {
        title: `${industry} 매출 효율`,
        subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
        cells: [
          { label: canAmt ? '업소당 월평균 매출' : '업소당 월평균 매출(참고)', value: this._formatNumber(amt), unit: '만원',
            delta: record?.amtYoY, deltaLabel: '전년동월' },
          { label: '업소 수', value: this._formatNumber(upso), unit: '개',
            delta: record?.upsoYoY, deltaLabel: '전년동월' },
          { label: '업소당 월평균 매출', value: canAmt ? this._formatNumber(amt) : '-', unit: '만원' },
          { label: '일평균 유동인구', value: this._formatNumber(pop), unit: '명' },
        ],
      };

    } else {
      // ── 기본: 업소 수 대비 유동인구/매출 (3지표 이상 포함) ──
      const popPerUpso = canUpso && fin(pop) ? Math.round(pop / upso) : null;

      if (record?._upsoImputed || record?._amtImputed) {
        response.summary.text = `${district} ${industry}의 밀도 분석에 필요한 개별 데이터가 부족합니다. 시군구 참고값을 기준으로 표시합니다.`;
      } else {
        response.summary.text = `${district} ${industry}의 업소 수 대비 유동인구·매출 밀도를 분석합니다.`;
      }
      response.summary.bullets = [
        fin(popPerUpso) ? `업소당 유동인구는 ${this._formatNumber(popPerUpso)}명입니다.` : '',
        canAmt ? `업소당 월평균 매출은 ${this._formatNumber(amt)}만원입니다.` : '',
      ].filter(Boolean);

      response.statsCard = {
        title: `${industry} 밀도 분석`,
        subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
        cells: [
          { label: '업소 수', value: this._formatNumber(upso), unit: '개',
            delta: record?.upsoYoY, deltaLabel: '전년동월' },
          { label: '일평균 유동인구', value: this._formatNumber(pop), unit: '명' },
          { label: '업소당 유동인구', value: this._formatNumber(popPerUpso), unit: '명/업소' },
          { label: '업소당 월평균 매출', value: canAmt ? this._formatNumber(amt) : '-', unit: '만원' },
        ],
      };

      const densityItems = [];
      if (fin(popPerUpso)) densityItems.push({ label: district, value: popPerUpso });
      (record?.similar || [])
        .filter(item => fin(item?.pop) && fin(item?.upso) && item.upso > 0)
        .forEach(item => {
          const label = item.dong || item.district || item.name || '유사 상권';
          if (String(label).replace(/\s+/g, '') === String(district).replace(/\s+/g, '')) return;
          if (densityItems.length >= 5) return;
          densityItems.push({ label, value: Math.round(item.pop / item.upso) });
        });
      if (densityItems.length >= 2) {
        response.compareCard = {
          title: '업소당 유동인구 비교',
          items: densityItems,
          unit: '명/업소',
        };
      }
    }

    // CompareCard (기본 / upso 또는 pop 기준)
    if (!response.compareCard) {
      const tierItems = [];
      if (fin(upso)) tierItems.push({ label: district, value: upso });
      if (fin(record?.upsoSgg)) tierItems.push({ label: `${response.header.sgg || '시군구'} 평균`, value: record.upsoSgg });
      if (fin(record?.upsoSido)) tierItems.push({ label: '대전시 평균', value: record.upsoSido });
      if (tierItems.length >= 2) {
        response.compareCard = { title: '업소 수 지역 비교', items: tierItems, unit: '개' };
      }
    }
  }

  _buildTrend(response, intent, result, record) {
    const trend = result.trend || result;
    const district = response.header.district || '해당 행정동';
    const industry = response.header.industry || '해당 업종';
    const monthly = trend.monthly || [];
    const latest = monthly[monthly.length - 1];
    const prev = monthly[monthly.length - 2];
    const latestAmt = Number.isFinite(latest?.amt) ? latest.amt : record?.amt;
    const prevAmt = Number.isFinite(prev?.amt) ? prev.amt : null;
    const direction = Number.isFinite(latestAmt) && Number.isFinite(prevAmt)
      ? (latestAmt > prevAmt ? '증가' : latestAmt < prevAmt ? '감소' : '보합')
      : null;

    const fin = (v) => Number.isFinite(v);
    // 전년 대비 변화가 있으면 YoY 강조 요약
    if (fin(record?.amtYoY)) {
      const yoyDir = record.amtYoY > 0 ? '상승' : record.amtYoY < 0 ? '하락' : '보합';
      response.summary.text = `${district} ${industry}의 매출은 전년 동월 대비 ${this._formatPercent(record.amtYoY)} ${yoyDir}하여 현재 ${this._formatNumber(latestAmt)}만원입니다.`;
    } else {
      response.summary.text = fin(latestAmt)
        ? `${district} ${industry}의 최근 업소당 월평균 매출은 ${this._formatNumber(latestAmt)}만원입니다.`
        : `${district} ${industry}의 최근 추이를 확인합니다.`;
    }
    response.summary.bullets = [
      direction ? `직전월 대비 흐름은 ${direction}입니다.` : '',
      this._trendText(record?.amtYoY, record?.amtMoM, '매출'),
      this._trendText(record?.upsoYoY, record?.upsoMoM, '업소 수'),
    ].filter(Boolean);

    // StatsCard — 전년 동월 대비 핵심 지표
    const monthDisplay = response.header.monthDisplay;
    response.statsCard = {
      title: '전년 동월 대비',
      subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
      cells: [
        { label: '업소당 월평균 매출', value: this._formatNumber(record?.amt), unit: '만원',
          delta: record?.amtYoY, deltaLabel: '전년동월' },
        { label: '업소 수', value: this._formatNumber(record?.upso), unit: '개',
          delta: record?.upsoYoY, deltaLabel: '전년동월' },
        { label: '매출 전월 대비', value: fin(record?.amtMoM) ? this._formatNumber(record.amtMoM) : '-', unit: '%',
          delta: null, deltaLabel: null },
        { label: '일평균 유동인구', value: this._formatNumber(record?.pop), unit: '명',
          delta: null, deltaLabel: null },
      ],
    };

    if (result.tierTrend) {
      const tt = result.tierTrend;
      response.trendCard = {
        title: `최근 12개월 ${industry} 매출 추세`,
        subtitle: `${district} · 시군구 평균 · 대전 평균`,
        labels: tt.labels,
        series: [
          { label: district, data: tt.dong, color: '#2D4540' },
          { label: `${response.header.sgg || '시군구'} 평균`, data: tt.sgg, color: '#8AB3A0', dashed: true },
          { label: '대전 평균', data: tt.sido, color: '#D9A441', dotted: true },
        ],
      };
      return;
    }

    if (monthly.length) {
      response.trendCard = {
        title: `최근 12개월 ${industry} 매출 추세`,
        subtitle: district,
        labels: monthly.map(item => this._formatMonth(item.month)),
        series: [
          { label: district, data: monthly.map(item => item.amt), color: '#2D4540' },
        ],
      };
    }
  }

  _buildSimilar(response, intent, result, record) {
    const similar = result.similar || record?.similar || [];
    const district = response.header.district || '해당 행정동';
    const industry = response.header.industry || '해당 업종';
    const fin = (v) => Number.isFinite(v);

    if (!similar.length) {
      response.summary.text = `${district} ${industry}${josa(industry, '과/와')} 비교할 수 있는 유사 상권 데이터가 아직 없습니다.`;
      response.statsCard = {
        title: `${district} ${industry} 기준 현황`,
        subtitle: response.header.monthDisplay ? `${response.header.monthDisplay} 기준` : null,
        cells: [
          { label: '업소당 월평균 매출', value: this._formatNumber(record?.amt), unit: '만원' },
          { label: '업소 수', value: this._formatNumber(record?.upso), unit: '개' },
          { label: '일평균 유동인구', value: this._formatNumber(record?.pop), unit: '명' },
          { label: '유사 상권', value: '없음', unit: '' },
        ],
      };
      return;
    }

    const ranked = similar.slice(0, 5);
    response.summary.text = `${district} ${industry}${josa(industry, '과/와')} 비슷한 상권은 ${ranked.map(item => item.district || item.name).filter(Boolean).slice(0, 3).join(', ')} 등입니다.`;
    response.summary.bullets = ranked.slice(0, 3).map((item) => `${item.district || item.name}: ${this._formatNumber(item.amt)}만원`);

    response.statsCard = {
      title: `${district} ${industry} 기준 상권`,
      subtitle: response.header.monthDisplay ? `${response.header.monthDisplay} 기준` : null,
      cells: [
        { label: '업소당 월평균 매출', value: this._formatNumber(record?.amt), unit: '만원' },
        { label: '업소 수', value: this._formatNumber(record?.upso), unit: '개' },
        { label: '일평균 유동인구', value: this._formatNumber(record?.pop), unit: '명' },
        { label: '유사 상권 수', value: this._formatNumber(similar.length), unit: '곳' },
      ],
    };

    const items = [];
    if (fin(record?.amt)) items.push({ label: `${district} (기준)`, value: record.amt });
    const srcKey = String(district).replace(/\s+/g, '');
    ranked
      .filter(item => fin(item.amt))
      .filter(item => String(item.district || item.name || '').replace(/\s+/g, '') !== srcKey) // 기준 동 중복 제거 (#24)
      .forEach(item => items.push({ label: item.district || item.name || '유사 상권', value: item.amt }));

    if (items.length >= 2) {
      response.compareCard = {
        title: '유사 상권 매출 비교',
        items,
        unit: '만원',
      };
    }
  }

  _buildOverview(response, intent, result) {
    const overview = result.overview || result;
    const district = response.header.district || '해당 행정동';
    const total = overview.totalIndustries || 0;
    const direct = overview.directCount || 0;
    const popTotal = overview.pop?.total || 0;
    const totalUpso = overview.totalUpso || 0;
    const totalAmt = overview.totalAmt || 0;

    const top3 = overview.topIndustries?.slice(0, 3) || [];
    // 평균은 매출이 있는 업종 수로 나눈다 (전체 카탈로그 247로 나누면 디플레이션)
    const avgDenom = overview.amtIndustries || total;
    const avgAmt = (avgDenom > 0 && totalAmt > 0) ? Math.round(totalAmt / avgDenom) : 0;
    if (top3.length) {
      response.summary.text = `${district} 전체 상권 현황입니다. ${total}개 업종이 영업 중이며, 업종 평균 업소당 월매출은 ${this._formatNumber(avgAmt)}만원입니다.`;
    } else {
      response.summary.text = `${district}의 업종별 매출 데이터를 확인할 수 없습니다.`;
    }
    response.summary.bullets = [];

    // StatsCard (디자인: 2x2 핵심 지표)
    response.statsCard = {
      title: `${district} 상권 현황`,
      subtitle: response.header.monthDisplay ? `${response.header.monthDisplay} 기준` : null,
      cells: [
        { label: '전체 업소', value: this._formatNumber(totalUpso), unit: '개' },
        { label: '업종 수', value: this._formatNumber(total), unit: '개' },
        { label: '업종 평균 업소당 월매출', value: this._formatNumber(avgAmt), unit: '만원' },
        { label: '일평균 유동인구', value: this._formatNumber(popTotal), unit: '명' },
      ],
    };

    // CompareCard (매출 상위 업종)
    if (overview.topIndustries?.length) {
      response.compareCard = {
        title: '업소당 매출 상위 업종',
        items: overview.topIndustries.map(i => ({ label: i.name, value: i.amt })),
        unit: '만원',
      };
    }

    // TrendCard (요일별 유동인구 패턴)
    if (overview.pop?.byDay?.length) {
      response.trendCard = {
        title: '요일별 유동인구',
        subtitle: `피크: ${overview.pop.peakDay || '-'} ${overview.pop.peakTime || ''}`,
        labels: overview.pop.byDay.map(d => d.label),
        series: [{ label: '유동인구', data: overview.pop.byDay.map(d => d.value), color: '#2D4540' }],
      };
    }
  }

  _buildCompare(response, intent, result) {
    const cr = result.compareResult || {};
    const rec1 = cr.district1;
    const rec2 = cr.district2;
    const hComp = result.horizontalComparison || { metrics: [], summary: null };
    const name1 = rec1?.districtName || intent?.district?.name || '지역 A';
    const name2 = rec2?.districtName || intent?.compareTarget?.name || '지역 B';
    const industry = response.header.industry || '';
    const monthDisplay = response.header.monthDisplay || '';

    // summary — intent.metric에 따라 주요 지표 선택
    const requestedMetric = intent?.metric || 'sales';
    const metricLabelMap = { sales: '매출', population: '유동인구', stores: '업소 수', trend: '매출 추세' };
    const metricLabel = metricLabelMap[requestedMetric] || '매출';
    // 해당 지표의 winner 결정
    const metricFieldMap = { sales: 'amt', population: 'pop', stores: 'upso' };
    const mField = metricFieldMap[requestedMetric] || 'amt';
    const mVal1 = rec1?.[mField], mVal2 = rec2?.[mField];
    const metricWinner = (Number.isFinite(mVal1) && Number.isFinite(mVal2))
      ? (mVal1 >= mVal2 ? name1 : name2)
      : (hComp.summary?.amtWinner || name1);

    if (Number.isFinite(mVal1) && Number.isFinite(mVal2) && mVal1 === mVal2) {
      response.summary.text = `${monthDisplay} 기준, ${industry ? industry + ' ' : ''}${metricLabel}${josa(metricLabel, '은/는')} ${name1}${josa(name1, '과/와')} ${name2}${josa(name2, '이/가')} 비슷합니다.`;
    } else if (hComp.summary || (Number.isFinite(mVal1) && Number.isFinite(mVal2))) {
      response.summary.text = `${monthDisplay} 기준, ${industry ? industry + ' ' : ''}${metricLabel}${josa(metricLabel, '은/는')} ${metricWinner}${josa(metricWinner, '이/가')} 더 높습니다.`;
    } else {
      response.summary.text = `${name1}${josa(name1, '과/와')} ${name2}의 비교 결과입니다.`;
    }
    // 비교 대상을 사용자가 지정하지 않아 자동 선택한 경우 고지 (#15)
    if (intent?.autoCompareTarget) {
      response.summary.text += ` 비교 대상을 지정하지 않아 ${name2}${josa(name2, '을/를')} 자동 선택했습니다.`;
    }

    // bullets: 요청 지표를 첫 번째로 정렬
    const sortedMetrics = [...(hComp.metrics || [])].sort((a, b) => {
      const aMatch = a.label.includes(metricLabel) ? -1 : 0;
      const bMatch = b.label.includes(metricLabel) ? -1 : 0;
      return aMatch - bMatch;
    });
    response.summary.bullets = sortedMetrics.slice(0, 3).map((m) => {
      const v1 = m.value1 !== null ? this._formatNumber(m.value1) : '-';
      const v2 = m.value2 !== null ? this._formatNumber(m.value2) : '-';
      return `${m.label}: ${name1} ${v1}${m.unit} / ${name2} ${v2}${m.unit}`;
    });

    // StatsCard (비교 지표)
    response.statsCard = {
      title: `${name1} vs ${name2}`,
      subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
      cells: hComp.metrics.slice(0, 4).map(m => ({
        label: m.label,
        value: `${this._formatNumber(m.value1)} / ${this._formatNumber(m.value2)}`,
        unit: m.unit,
        delta: m.pctDiff, deltaLabel: `${name1} 기준`,
      })),
    };

    // TrendCard (추세 비교)
    if (result.trendComparison?.labels?.length > 1) {
      const tc = result.trendComparison;
      response.trendCard = {
        title: `${name1} vs ${name2} ${metricLabel} 추이`,
        labels: tc.labels,
        series: [
          { label: name1, data: tc.datasets?.[0]?.data || tc.data1 || [], color: '#2D4540' },
          { label: name2, data: tc.datasets?.[1]?.data || tc.data2 || [], color: '#D9A441' },
        ],
      };
    }

    // 후속 질문 (비교 모드: 지역명 유지 — 두 지역 구분 필요)
    const compareChips1 = [
      { text: industry ? `${name1} ${industry} 추세` : `${name1} 어때?` },
    ];
    const compareChips2 = [
      { text: industry ? `${name2} ${industry} 추세` : `${name2} 어때?`, switchRegion: true },
      { text: industry ? `${name1} ${industry} 유동인구` : `${name1} 유동인구` },
    ];
    const compareGroups = [
      { title: `${name1} 더 보기`, icon: '🔍', chips: compareChips1 },
      { title: `${name2} 더 보기`, icon: '↗', chips: compareChips2 },
    ];
    const compareFlat = compareGroups.flatMap(g => g.chips.map(c => c.text));
    response.followUps = { groups: compareGroups, length: compareFlat.length };
    response.followUps.map = (...args) => compareFlat.map(...args);
    response.followUps[Symbol.iterator] = function* () { yield* compareFlat; };
  }

  _buildCompareIndustry(response, intent, result) {
    const sides = result.industrySides || [];
    if (sides.length === 0) {
      response.summary.text = '업종 비교 데이터를 확인할 수 없습니다.';
      return;
    }
    const district = response.header.district || intent?.district?.name || '';
    const monthDisplay = response.header.monthDisplay || '';
    const metric = intent?.metric || 'sales';
    const metricLabel = { sales: '매출', stores: '업소 수', population: '유동인구' }[metric] || '매출';
    const metricField = { sales: 'amt', stores: 'upso', population: 'pop' }[metric] || 'amt';
    const metricUnit = { amt: '만원', upso: '개', pop: '명' }[metricField] || '';

    // winner 결정
    const sorted = [...sides].sort((a, b) => (b.record?.[metricField] || 0) - (a.record?.[metricField] || 0));
    const winner = sorted[0];
    const industryNames = sides.map(s => s.industry);

    response.summary.text = `${district}에서 ${industryNames.join(', ')} 중 ${metricLabel}${josa(metricLabel, '이/가')} 가장 높은 업종은 **${winner.industry}**(${this._formatNumber(winner.record?.[metricField])}${metricUnit})입니다.`;
    response.summary.bullets = sides.map(s =>
      `${s.industry}: ${metricLabel} ${this._formatNumber(s.record?.[metricField])}${metricUnit}, 업소 ${this._formatNumber(s.record?.upso)}개`
    );
    // 소표본 주의: 업소 수가 적은(≤2) 업종이 섞이면 업소당 지표 비교 신뢰도 낮음 (#22)
    const smallSide = sides.find(s => Number.isFinite(s.record?.upso) && s.record.upso <= 2);
    if (smallSide && metric === 'sales') {
      response.summary.bullets.push(`${smallSide.industry}${josa(smallSide.industry, '은/는')} 업소가 ${smallSide.record.upso}개로 적어 업소당 매출 비교는 참고용으로 보세요.`);
    }

    // StatsCard: 업종별 지표 비교
    response.statsCard = {
      title: `${district} 업종 비교`,
      subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
      cells: sides.map(s => ({
        label: s.industry,
        value: this._formatNumber(s.record?.[metricField]),
        unit: metricUnit,
      })),
    };

    // CompareCard: 가로 막대 차트용
    response.compareCard = {
      title: `업종별 ${metricLabel}`,
      items: sides.map(s => ({
        label: s.industry,
        value: s.record?.[metricField] || 0,
      })),
      unit: metricUnit,
    };

    // TrendCard는 없음 (업종 간 비교에서는 현재 시점 비교만)

    // 후속 질문 칩
    const chips = sides.map(s => ({ text: `${district} ${s.industry} 추세` }));
    chips.push({ text: `${district} 어때?` });
    const groups = [
      { title: '업종별 상세 분석', icon: '📊', chips },
    ];
    const flat = groups.flatMap(g => g.chips.map(c => c.text));
    response.followUps = { groups, length: flat.length };
    response.followUps.map = (...args) => flat.map(...args);
    response.followUps[Symbol.iterator] = function* () { yield* flat; };
  }

  _buildRankDistricts(response, intent, result) {
    const ranking = result.ranking || {};
    const items = ranking.items || [];
    const sgg = ranking.sgg || intent?.sgg || '';
    const industry = ranking.industry || intent?.industry || '';
    const metricLabel = {
      sales: '매출',
      stores: '업소 수',
      population: '유동인구',
    }[ranking.metric] || '매출';
    const unit = ranking.unit || '';
    const top = items[0];

    response.summary.text = top
      ? `${sgg}에서 ${industry} ${metricLabel}${josa(metricLabel, '이/가')} 가장 높은 행정동은 ${top.district}(${this._formatNumber(top.value)}${unit})입니다.`
      : `${sgg} ${industry} 행정동 순위 데이터를 확인할 수 없습니다.`;
    response.summary.bullets = items.slice(1, 4).map((item, index) => `${index + 2}위 ${item.district}: ${this._formatNumber(item.value)}${unit}`);

    response.statsCard = {
      title: `${sgg} ${industry} ${metricLabel} 순위`,
      subtitle: response.header.monthDisplay ? `${response.header.monthDisplay} 기준` : null,
      cells: [
        { label: '1위 행정동', value: top?.district || '-', unit: '' },
        { label: metricLabel, value: this._formatNumber(top?.value), unit },
        { label: '조회 행정동', value: this._formatNumber(ranking.matchedDistricts), unit: '개' },
        { label: '전체 행정동', value: this._formatNumber(ranking.totalDistricts), unit: '개' },
      ],
    };

    response.compareCard = {
      title: `행정동별 ${metricLabel}`,
      items: items.slice(0, 10).map(item => ({ label: item.district, value: item.value })),
      unit,
    };
  }

  _buildSggIndustry(response, intent, result) {
    const sggResult = result.sggResult || {};
    const sgg = sggResult.sgg || intent?.sgg || '';
    const industry = sggResult.industry || intent?.industry || '';
    const current = sggResult.current || {};
    const top = sggResult.topDistricts?.[0];
    const cohorts = sggResult.cohorts || {};
    const topCohort = cohorts.topDistricts?.[0];
    const bottomCohort = cohorts.bottomDistricts?.[0];
    const isSalesFocus = ['sales', 'trend'].includes(sggResult.metric);
    const metricLabel = { sales: '매출', stores: '업소 수', population: '유동인구', trend: '매출 추세', all: '종합' }[sggResult.metric] || '매출';

    response.summary.text = isSalesFocus
      ? `${sgg} ${industry}의 최근 매출 추세는 ${sggResult.matchedDistricts || 0}개 행정동 평균 기준 ${this._formatNumber(current.amt)}만원입니다.`
      : `${sgg} ${industry}${josa(industry, '은/는')} ${sggResult.matchedDistricts || 0}개 행정동에서 확인되며, ${metricLabel} 기준으로 정리했습니다.`;
    response.summary.bullets = [
      top ? `${metricLabel} 상위 행정동은 ${top.district}입니다.` : '',
      topCohort ? `상위 10% 비교군은 최근 12개월 평균 업소당 월매출 기준 ${topCohort.district}입니다.` : '',
      bottomCohort ? `하위 10% 비교군은 같은 기준으로 ${bottomCohort.district}입니다.` : '',
      !isSalesFocus && Number.isFinite(current.upso) ? `업소 수 합계는 ${this._formatNumber(current.upso)}개입니다.` : '',
      !isSalesFocus && Number.isFinite(current.pop) ? `일평균 유동인구 합계는 ${this._formatNumber(current.pop)}명입니다.` : '',
    ].filter(Boolean);

    response.statsCard = {
      title: `${sgg} ${industry} 현황`,
      subtitle: response.header.monthDisplay ? `${response.header.monthDisplay} 기준` : null,
      cells: isSalesFocus ? [
        { label: '행정동 평균 업소당 월매출', value: this._formatNumber(current.amt), unit: '만원' },
        { label: '상위 10% 연평균', value: this._formatNumber(topCohort?.annualAvgAmt), unit: '만원' },
        { label: '하위 10% 연평균', value: this._formatNumber(bottomCohort?.annualAvgAmt), unit: '만원' },
        { label: '조회 행정동', value: this._formatNumber(sggResult.matchedDistricts), unit: '개' },
      ] : [
        { label: '행정동 평균 업소당 월매출', value: this._formatNumber(current.amt), unit: '만원' },
        { label: '업소 수 합계', value: this._formatNumber(current.upso), unit: '개' },
        { label: '유동인구 합계', value: this._formatNumber(current.pop), unit: '명' },
        { label: '조회 행정동', value: this._formatNumber(sggResult.matchedDistricts), unit: '개' },
      ],
    };

    if (isSalesFocus && (cohorts.topDistricts?.length || cohorts.bottomDistricts?.length)) {
      response.compareCard = {
        title: '연평균 업소당 월매출 기준 상·하위 10%',
        items: [
          ...(cohorts.topDistricts || []).map(item => ({ label: `상위 ${item.district}`, value: item.annualAvgAmt })),
          ...(cohorts.bottomDistricts || []).map(item => ({ label: `하위 ${item.district}`, value: item.annualAvgAmt })),
        ],
        unit: '만원',
      };
    } else if (sggResult.topDistricts?.length) {
      response.compareCard = {
        title: `행정동별 ${metricLabel}`,
        items: sggResult.topDistricts.map(item => ({ label: item.district, value: item.value })),
        unit: sggResult.unit || '만원',
      };
    }

    if (sggResult.monthly?.length) {
      const trendSeries = [
        { label: `${sgg} 평균`, data: sggResult.monthly.map(item => item.amt), color: '#2D4540' },
      ];
      // 상위/하위 10% 밴드 (buildSggIndustry가 제공하는 경우)
      const hasTop10 = sggResult.monthly.some(item => Number.isFinite(item.top10Amt));
      const hasBottom10 = sggResult.monthly.some(item => Number.isFinite(item.bottom10Amt));
      if (hasTop10) {
        trendSeries.push({
          label: '상위 10%', data: sggResult.monthly.map(item => item.top10Amt ?? null), color: '#4F7A5E', dashed: true,
        });
      }
      if (hasBottom10) {
        trendSeries.push({
          label: '하위 10%', data: sggResult.monthly.map(item => item.bottom10Amt ?? null), color: '#A84B40', dotted: true,
        });
      }
      response.trendCard = {
        title: `최근 12개월 ${industry} 매출 추세`,
        subtitle: `${sgg} 행정동 평균${hasTop10 ? ' (상위·하위 10% 포함)' : ''}`,
        labels: sggResult.monthly.map(item => this._formatMonth(item.month)),
        series: trendSeries,
      };
    }
  }

  _buildMerge(response, intent, result, record) {
    const mergeResult = result.mergeResult;
    const merged = mergeResult?.merged || record;
    const names = mergeResult?.names || [];
    const industry = response.header.industry || '해당 업종';
    const monthDisplay = response.header.monthDisplay;
    const fin = (v) => Number.isFinite(v);
    const label = names.join(' + ') || '병합 지역';
    const sourceLocation = mergeResult?.sourceLocation || intent?.sourceLocation || '';
    const displayLabel = sourceLocation || label;

    response.header.district = displayLabel;
    const mergedUpsoText = (Number.isFinite(merged?.upso) && merged.upso > 0)
      ? `업소 규모는 ${this._formatNumber(merged.upso)}개로 집계했습니다.`
      : `다만 구성 행정동의 개별 업소 데이터가 없어 업소 규모는 집계되지 않았습니다.`;
    response.summary.text = sourceLocation
      ? `${sourceLocation} ${industry}${josa(industry, '은/는')} 여러 행정동을 묶어 본 결과입니다. 핵심은 평균 업소당 월매출 ${this._formatNumber(merged?.amt)}만원입니다. ${mergedUpsoText}`
      : `${label} ${industry}의 합산/평균 현황입니다.`;
    response.summary.bullets = [
      sourceLocation ? `행정동 기준 ${label}에 걸쳐 있어, 합산과 개별 현황을 함께 보여드립니다.` : '',
      `총 업소 수는 ${this._formatNumber(merged?.upso)}개(합산)입니다.`,
      `평균 업소당 월매출은 ${this._formatNumber(merged?.amt)}만원입니다.`,
      Number.isFinite(merged?.pop) ? '합산 유동인구는 인접 행정동을 오가는 인원이 중복 집계될 수 있습니다.' : '',
    ].filter(Boolean);

    response.statsCard = {
      title: `${displayLabel} 합산 현황`,
      subtitle: monthDisplay ? `${monthDisplay} 기준` : null,
      cells: [
        { label: '총 업소 수(합)', value: this._formatNumber(merged?.upso), unit: '개' },
        { label: '평균 업소당 월매출', value: this._formatNumber(merged?.amt), unit: '만원',
          delta: merged?.amtYoY, deltaLabel: '전년동월' },
        { label: '합산 유동인구', value: this._formatNumber(merged?.pop), unit: '명' },
        { label: '포함 행정동', value: this._formatNumber(merged?._mergedCount), unit: '개' },
      ],
    };

    // CompareCard: 요청된 metric 기준 (없으면 매출 우선, 없으면 업소수)
    const reqMetric = intent?.requestedMetric;
    const records = mergeResult?.records || [];
    if (records.length >= 2) {
      const useStores = reqMetric === 'stores';
      const hasAmt = records.some(r => fin(r?.amt));
      const hasUpso = records.some(r => fin(r?.upso));
      const showUpso = useStores ? hasUpso : (!hasAmt && hasUpso);
      const showAmt = !showUpso && hasAmt;
      if (showAmt || showUpso) {
        const items = records
          .filter(r => showUpso ? fin(r?.upso) : fin(r?.amt))
          .map(r => ({ label: r.districtName, value: showUpso ? r.upso : r.amt }));
        if (items.length >= 2) {
          response.compareCard = {
            title: showUpso ? '동별 업소 수' : '동별 매출',
            items,
            unit: showUpso ? '개' : '만원',
          };
        }
      }

      // DongDetailCard: 개별 행정동 핵심 지표 side-by-side
      response.dongDetailCard = {
        title: '행정동별 상세',
        dongs: records.map(r => ({
          name: r.districtName || '?',
          cells: [
            { label: '업소 수', value: this._formatNumber(r.upso), unit: '개',
              delta: r.upsoYoY, deltaLabel: '전년' },
            { label: '업소당 매출', value: this._formatNumber(r.amt), unit: '만원',
              delta: r.amtYoY, deltaLabel: '전년' },
            { label: '유동인구', value: this._formatNumber(r.pop), unit: '명' },
          ],
        })),
      };
    }

    // TrendCard: 법정동 merge + 추세 metric일 때 대표 동 기준 추세 차트
    if (result.tierTrend) {
      const tt = result.tierTrend;
      const repName = names[0] || displayLabel;
      response.trendCard = {
        title: `최근 12개월 ${industry} 매출 추세`,
        subtitle: `${displayLabel} 대표 동(${repName}) 기준`,
        labels: tt.labels,
        series: [
          { label: repName, data: tt.dong, color: '#2D4540' },
          { label: '시군구 평균', data: tt.sgg, color: '#8AB3A0', dashed: true },
          { label: '대전 평균', data: tt.sido, color: '#D9A441', dotted: true },
        ],
      };
    }
  }

  _buildDataStatus(response, intent, result, record) {
    response.summary.text = '현재 데이터 기준으로 보면 다음과 같습니다.';
    response.summary.bullets = [this._dataNotice(record?.dataStatus || result.dataStatus, record)].filter(Boolean);
  }

  /** 대상(첫) 시리즈가 전부 null인 추세 카드 제거 + 안내 (#23) */
  _pruneEmptyTrend(response) {
    const isEmpty = (card) => {
      const primary = card?.series?.[0]?.data || [];
      return primary.length > 0 && primary.every((v) => v == null);
    };
    let pruned = false;
    ['trendCard', 'trendCard2'].forEach((key) => {
      if (isEmpty(response[key])) { delete response[key]; pruned = true; }
    });
    if (pruned && response.summary) {
      response.summary.text = `${response.summary.text || ''} 다만 개별 추세 데이터가 없어 그래프는 생략했습니다.`.trim();
    }
  }

  _formatMonth(yyyymm) {
    const value = String(yyyymm || '');
    if (!/^\d{6}$/.test(value)) return value || '';
    return `${value.slice(0, 4)}년 ${Number(value.slice(4, 6))}월`;
  }

  _looksLikeRecord(value) {
    if (!value || typeof value !== 'object') return false;
    return ['amt', 'upso', 'pop', 'dataStatus', 'districtName', 'industry'].some((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  _formatNumber(n) {
    if (n === null || n === undefined || n === '' || Number.isNaN(Number(n))) return '-';
    return Number(n).toLocaleString('ko-KR');
  }

  _formatPercent(value) {
    if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) return '-';
    return `${Number(value).toLocaleString('ko-KR')}%`;
  }

  _dataNotice(status, record) {
    if (status === 'direct') {
      return '행정동 직접값 기준이므로 해당 행정동 비교 검토에 바로 참고할 수 있습니다.';
    }
    if (status === 'sgg_sub') {
      const parts = ['행정동 개별 데이터가 부족해 시군구 평균을 참고값으로 사용합니다.'];
      if (record?._amtImputed) parts.push('매출은 시군구 평균입니다.');
      if (record?._upsoImputed) parts.push('업소 수 개별 데이터가 없습니다.');
      return parts.join(' ');
    }
    return '';
  }

  _buildDataNote(questionType, record, result = {}, intent = {}) {
    const salesTypes = new Set(['sales', 'trend', 'similar', 'compare', 'density', 'merge', 'overview', 'sggIndustry', 'rankDistricts']);
    const hasSalesValue = Number.isFinite(record?.amt)
      || Number.isFinite(result?.overview?.totalAmt)
      || Number.isFinite(result?.sggResult?.current?.amt)
      || Number.isFinite(result?.ranking?.items?.[0]?.amt)
      || Number.isFinite(result?.compareResult?.district1?.amt)
      || Number.isFinite(result?.mergeResult?.merged?.amt);
    if (!salesTypes.has(questionType) || !hasSalesValue) return null;
    const notes = [];
    const rawIndustry = String(intent?.industryRaw || '').trim();
    const industry = String(intent?.industry || '').trim();
    // raw가 '업종명 + 조사'면(예: "한의원은", "약국은") 같은 업종이므로 해석 안내 생략 (QA-F5)
    const rawStripped = rawIndustry.replace(/(은|는|이|가|을|를|과|와|도|만|이나|나|의|에서|에|로|으로|까지|부터)$/, '');
    const sameWithParticle = rawStripped === industry;
    if (rawIndustry && industry && rawIndustry !== industry && !sameWithParticle && ['partial-token', 'partial'].includes(intent?.industryMatchType)) {
      notes.push(`"${rawIndustry}"${josa(rawIndustry, '은/는')} 업종 사전에 별도 분류가 없어 "${industry}"로 해석했습니다.`);
    } else if (rawIndustry && industry && rawIndustry !== industry && !sameWithParticle && ['brand', 'alias', 'group'].includes(intent?.industryMatchType)) {
      // 브랜드/별칭 치환 고지 (#10): 스타벅스→카페, 다이소→그 외 기타 종합 소매업 등
      notes.push(`"${rawIndustry}"${josa(rawIndustry, '은/는')} "${industry}" 분류로 분석했습니다.`);
    }
    notes.push('매출 지표는 카드매출 추정치 기준이며, 실제와 다를 수 있습니다.');
    return notes.join(' ');
  }

  _smartFollowUps(intent, record, insights = [], context = {}) {
    const region = context.district || intent?.district?.name || context.sgg || intent?.sgg || '';
    const sgg = context.sgg || intent?.sgg || intent?.district?.sgg || '';
    const type = intent?.questionType || 'overview';
    // overview는 특정 업종 없이 전체 현황을 보여주므로, record에서 leak된 industry를 무시
    const industry = type === 'overview' ? '' : (context.industry || intent?.industry || '');

    const candidates = [];
    const fin = (v) => Number.isFinite(v);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)] || arr[0];

    // 다양한 말투 템플릿 — 모든 칩에 지역/업종을 명시 (맥락 없이도 IntentParser가 파싱 가능하게)
    const phrases = {
      trend: [`${region} ${industry} 추세가 궁금해`, `${region} ${industry} 최근 흐름은?`, `${region} ${industry} 작년보다 나아졌어?`, `${region} ${industry} 월별 변화는?`],
      pop: [`${region} 유동인구는 언제 많아?`, `${region} 유동인구 패턴은?`, `${region} 사람들이 언제 다녀?`, `${region} 어느 요일에 붐벼?`],
      sales: [`${region} ${industry} 매출이 어느 정도야?`, `${region} ${industry} 장사가 잘 돼?`, `${region} ${industry} 월 매출은?`],
      upso: [`${region} ${industry} 가게가 많아?`, `${region} ${industry} 업소 수는?`, `${region}에 ${industry} 몇 개 있어?`],
      similar: [`${region} ${industry} 비슷한 동네는?`, `${region}이랑 비슷한 상권 찾아줘`, `${region} ${industry} 유사 지역은?`],
      density: [`${region} ${industry} 경쟁이 치열해?`, `${region} ${industry} 업소당 매출이 좋은 편이야?`, `${region} ${industry} 밀도 분석해줘`],
      altIndustry: (alt) => [`${region} ${alt}${josa(alt, '은/는')} 어때?`, `${region}에서 ${alt} 장사가 될까?`, `${region} ${alt} 매출은?`],
      compare: (other) => [`${region}이랑 ${other} ${industry} 비교해줘`, `${other} ${industry}${josa(industry, '은/는')} 어때?`, `${region} vs ${other} ${industry}`],
      rank: [`${sgg || '이 구'}에서 ${industry} 잘 되는 동네는?`, `${sgg || '이 구'} ${industry} 매출 순위`, `${industry} 1위 동네가 어딘지 궁금해`],
      overview: [`${region}에서 뭐가 제일 잘 돼?`, `${region} 전체 현황 알려줘`, `${region} 상권 요약해줘`],
    };

    // ── 인사이트/record 기반 동적 후속 질문 ──
    if (record) {
      // 전년 대비 큰 변동 → 추세 확인 유도
      if (fin(record.amtYoY) && Math.abs(record.amtYoY) > 30 && type !== 'trend') {
        const dir = record.amtYoY > 0 ? '급등' : '급락';
        candidates.push({ text: `${region} ${industry} 매출이 ${dir}했는데 추세는?`, priority: 0.95 });
      }
      // amt는 이미 업소당 월평균 매출이므로 업소 수로 다시 나누지 않습니다.
      if (fin(record.amt) && fin(record.amtSgg) && type !== 'density') {
        if (record.amt > record.amtSgg * 1.3) candidates.push({ text: `${region} ${industry} 업소당 매출이 높은 편이야?`, priority: 0.85 });
        if (record.amt < record.amtSgg * 0.7) candidates.push({ text: `${region} ${industry} 업소당 매출이 낮은 이유는?`, priority: 0.85 });
      }
      // 유동인구 피크 정보 있으면 유동인구 유도
      if (record.peakDay && type !== 'pop') {
        candidates.push({ text: pick(phrases.pop), priority: 0.7 });
      }
      // 참고값인 경우 종합 현황 유도
      if (record.dataStatus === 'sgg_sub' && type !== 'overview') {
        candidates.push({ text: pick(phrases.overview), priority: 0.5 });
      }
      // 유사 상권 비교 유도 (merge 뷰에서는 이미 하위 동 비교가 표시되므로 스킵)
      if (record.similar && record.similar.length > 0 && industry && type !== 'overview' && type !== 'similar' && type !== 'merge') {
        const currentRegion = String(region || '').replace(/\s+/g, '');
        // merge 하위 동 이름 집합 (merge 아닌 경우에도 안전)
        const mergedNames = new Set(
          (intent?.mergeDistricts || []).map(d => String(d?.name || d || '').replace(/\s+/g, ''))
        );
        const top = record.similar.find((item) => {
          const name = item?.dong || item?.district || item?.name || '';
          const compact = String(name).replace(/\s+/g, '');
          return compact && compact !== currentRegion && !mergedNames.has(compact);
        });
        const name = top?.dong || top?.district || top?.name || '';
        if (name) candidates.push({ text: pick(phrases.compare(name)), priority: 0.6, switchRegion: true });
      }
    }

    // ── 다른 관점 제안 (같은 지역, 다른 업종) ──
    const altIndustries = ['카페', '편의점', '치킨', '한식', '음식점', '미용실', '분식', '약국'];
    if (industry && region) {
      const others = altIndustries.filter(i => i !== industry);
      if (others.length > 0) {
        const alt = pick(others);
        candidates.push({ text: pick(phrases.altIndustry(alt)), priority: 0.45 });
      }
    }

    // ── 밀도/효율 제안 ──
    if (type !== 'density' && industry && region && record) {
      candidates.push({ text: pick(phrases.density), priority: 0.4 });
    }

    // ── 구/시 확장 제안 ──
    if (sgg && industry && type !== 'rankDistricts') {
      candidates.push({ text: pick(phrases.rank), priority: 0.35 });
    }

    // ── 아직 안 본 지표 (다양한 말투) — 이미 충분한 고우선 후보가 있으면 스킵 ──
    if (candidates.length < 7) {
      const hasPop = Boolean(record?.pop || record?.population || context._hasPop);
      const hasSimilar = Boolean(record?.similar?.length > 0);
      if (type !== 'sales' && record) candidates.push({ text: pick(phrases.sales), priority: 0.3 });
      if (type !== 'upso' && record) candidates.push({ text: pick(phrases.upso), priority: 0.25 });
      if (type !== 'pop' && hasPop) candidates.push({ text: pick(phrases.pop), priority: 0.2 });
      if (type !== 'trend' && record) candidates.push({ text: pick(phrases.trend), priority: 0.2 });
      if (type !== 'similar' && hasSimilar && industry) candidates.push({ text: pick(phrases.similar), priority: 0.15 });
    }

    // ── overview 전용 ──
    if (type === 'overview' && region && !industry) {
      const shuffledIndustries = altIndustries.sort(() => Math.random() - 0.5).slice(0, 3);
      shuffledIndustries.forEach((ind, i) => {
        const texts = [`${region} ${ind} 어때?`, `${region} ${ind} 매출은?`, `${region} ${ind} 장사가 잘 돼?`];
        candidates.push({ text: pick(texts), priority: 0.4 - i * 0.05 });
      });
    }

    // 현재 질문 유형과 동일한 유형의 칩 텍스트 필터링 (꼬리물기에서 동일 유형 반복 방지)
    const typeKeywords = {
      sales: /매출|장사|벌이|수익|실적/,
      upso: /업소|가게|점포|몇개|매장/,
      pop: /유동인구|사람|방문|통행|붐비/,
      trend: /추세|추이|흐름|변화|최근|요즘|나아졌|작년/,
      similar: /비슷|유사|닮은/,
      density: /밀도|업소당|경쟁|효율/,
      overview: /어때|현황|전체|종합/,
    };
    const currentTypePattern = typeKeywords[type];

    // 중복 제거 + 현재 유형 제외 + priority 정렬 + 상위 5개
    const seen = new Set();
    const sorted = candidates
      .sort((a, b) => b.priority - a.priority)
      .filter(c => {
        const key = c.text.replace(/\s+/g, '');
        if (seen.has(key)) return false;
        seen.add(key);
        // 현재 질문 유형과 동일한 키워드를 가진 칩은 제외
        if (currentTypePattern && currentTypePattern.test(c.text)) return false;
        return true;
      })
      .slice(0, 5);

    // 2그룹 분류: same = 같은 지역 탐색, other = 다른 지역/주제
    const same = sorted.filter(c => !c.switchRegion);
    const other = sorted.filter(c => c.switchRegion);

    // 그룹 구조로 반환 (하위호환: .flat 프로퍼티로 string[] 접근 가능)
    const groups = [];
    const guide = [];
    if (sgg && industry) {
      if (type !== 'rankDistricts' && type !== 'sales') guide.push({ text: `${sgg}에서 ${industry} 매출 높은 행정동은?` });
      if (type !== 'trend' && type !== 'sggIndustry') guide.push({ text: `${sgg} ${industry} 최근 추세는?` });
    } else if (region && industry) {
      if (type !== 'trend') guide.push({ text: `${region} ${industry} 최근 추세는?` });
      if (type !== 'density' && type !== 'pop') guide.push({ text: `${region} ${industry} 유동인구 대비 업소가 많아?` });
    }
    // guide도 현재 유형 키워드 필터 적용
    const filteredGuide = currentTypePattern
      ? guide.filter(g => !currentTypePattern.test(g.text))
      : guide;
    if (filteredGuide.length) {
      groups.push({
        title: '다음 분석 예시',
        icon: '?',
        chips: filteredGuide.slice(0, 2),
      });
    }
    if (same.length) {
      groups.push({
        title: '이 지역 더 보기',
        icon: '🔍',
        chips: same.slice(0, 3).map(c => ({ text: c.text })),
      });
    }
    if (other.length) {
      groups.push({
        title: '다른 지역·주제',
        icon: '↗',
        chips: other.slice(0, 2).map(c => ({ text: c.text, switchRegion: true })),
      });
    }
    // 그룹이 1개뿐이면 최대 4개까지 허용
    if (groups.length === 1) {
      groups[0].chips = groups[0].chips.slice(0, 4);
    }

    const result = { groups };
    // 하위호환: length, map 등 배열처럼 사용 가능
    const flat = groups.flatMap(g => g.chips.map(c => c.text));
    result.length = flat.length;
    result.map = (...args) => flat.map(...args);
    result[Symbol.iterator] = function* () { yield* flat; };
    return result;
  }

  _disambiguation(intent) {
    const candidates = intent?.districtCandidates || [];
    if (candidates.length <= 1) return null;
    return {
      message: '확인할 행정동을 선택하면 더 정확히 볼 수 있습니다.',
      candidates: candidates.map((candidate) => `${candidate.sgg ? `${candidate.sgg} ` : ''}${candidate.name}`),
    };
  }

  _districtName(intent, record) {
    if (intent?.district?.name) return intent.district.name;
    if (record?.districtName) return record.districtName;
    if (record?.district) return record.district;
    return '';
  }

  _statusLabel(status) {
    if (status === 'direct') return '행정동 직접값';
    if (status === 'sgg_sub') return '시군구 단위 참고값';
    return '확인 필요';
  }

  _trendText(yoy, mom, label) {
    if ((yoy === null || yoy === undefined) && (mom === null || mom === undefined)) return '';
    return `${label}${josa(label, '은/는')} 전년동월 대비 ${this._formatPercent(yoy)}, 전월 대비 ${this._formatPercent(mom)}입니다.`;
  }

  /** TrendCard 부제 — 최근 추세 방향 요약 */
  _trendSubtitle(data) {
    if (!data || data.length < 3) return '';
    const valid = data.filter(Number.isFinite);
    if (valid.length < 3) return '';
    const recent = valid.slice(-3);
    const earlier = valid.slice(-6, -3);
    if (!earlier.length) return '';
    const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const earlierAvg = earlier.reduce((s, v) => s + v, 0) / earlier.length;
    const pct = ((recentAvg - earlierAvg) / earlierAvg * 100).toFixed(1);
    if (pct > 3) return '최근 3개월 상승세';
    if (pct < -3) return '최근 3개월 하락세';
    return '최근 3개월 횡보';
  }

  _buildFilters(questionType, district, industry, monthDisplay, sgg, intent) {
    const filters = [];
    if (questionType === 'compare') {
      const name1 = district || intent?.district?.name || '';
      const name2 = intent?.compareTarget?.name || '';
      if (name1 && name2) filters.push({ key: '지역', value: `${name1} ↔ ${name2}` });
      else if (name1) filters.push({ key: '지역', value: name1 });
    } else {
      if (district) filters.push({ key: '지역', value: district });
      else if (sgg) filters.push({ key: '지역', value: sgg });
    }
    if (industry) filters.push({ key: '업종', value: industry });
    const intentMetric = intent?.metric || '';
    const compareMetricLabel = { population: '유동인구 비교', stores: '업소 수 비교', trend: '추세 비교' }[intentMetric] || '지역 비교';
    const metricLabel = { sales: '매출', upso: '업소 수', pop: '유동인구', trend: '추세', overview: '종합', similar: '유사 상권', compare: compareMetricLabel, density: '밀도 분석', merge: '지역 합산', dataStatus: '데이터' }[questionType];
    if (metricLabel) filters.push({ key: '지표', value: metricLabel });
    if (['sales', 'upso'].includes(questionType)) filters.push({ key: '비교', value: '대전시·전년' });
    return filters.length ? filters : null;
  }

  _categoryBadge(industry) {
    const palette = { '카페': '#D9663A', '편의점': '#4A8C5C', '음식점': '#C4883A', '치킨': '#B85C2A', '한식': '#8B6E3E', '미용실': '#7B5EA7', '약국': '#3A7D9C', '분식': '#C4663A', '중국집': '#9C4A3A', '피자': '#D98E3A' };
    // 팔레트에 없으면 업종명 해시 기반 HSL 색상 자동 생성
    const color = palette[industry] || this._hashColor(industry);
    return { label: industry, color };
  }

  _hashColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const h = Math.abs(hash) % 360;
    return `hsl(${h}, 45%, 40%)`;
  }
}

export default ResponseBuilder;
