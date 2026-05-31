/**
 * tool-dispatcher.js — Gemini functionCall → QueryEngine 로컬 실행
 * Gemini가 반환한 도구 호출을 받아 실제 데이터를 조회하고,
 * ResponseBuilder가 소비할 수 있는 구조체 + Gemini에게 돌려줄 요약을 반환.
 */

export class ToolDispatcher {
  /**
   * @param {import('./query-engine.js').QueryEngine} queryEngine
   * @param {import('./data-loader.js').DataLoader} dataLoader
   */
  constructor(queryEngine, dataLoader) {
    this._qe = queryEngine;
    this._dl = dataLoader;
    this._districtList = dataLoader.getDistrictList(); // [{ code, name, sgg }]
  }

  /**
   * functionCall → 데이터 조회 결과
   * @param {{ name: string, args: object }} functionCall
   * @returns {Promise<{ intent, record, ..., geminiSummary }>}
   */
  async dispatch(functionCall) {
    const { name, args } = functionCall;
    const handlers = {
      analyzeDistrictIndustry: (a) => this._analyze(a),
      getDistrictOverview: (a) => this._overview(a),
      compareDistricts: (a) => this._compare(a),
      compareIndustries: (a) => this._compareIndustries(a),
      findSimilarDistricts: (a) => this._similar(a),
      mergeDistricts: (a) => this._merge(a),
      rankDistrictsByIndustry: (a) => this._rankDistricts(a),
      analyzeSggIndustry: (a) => this._sggIndustry(a),
    };
    const handler = handlers[name];
    if (!handler) return { error: `알 수 없는 도구: ${name}` };

    // 업종 별칭 해소 (모든 핸들러 공통)
    const resolvedArgs = { ...args };
    if (resolvedArgs.industry) resolvedArgs.industry = this._resolveIndustry(resolvedArgs.industry);

    try {
      return await handler(resolvedArgs);
    } catch (err) {
      console.error(`[ToolDispatcher] ${name} 오류:`, err);
      return { error: `도구 실행 오류: ${err.message}` };
    }
  }

  /* ═══════════════
     TOOL HANDLERS
     ═══════════════ */

  async _analyze({ district, industry, metric = 'all' }) {
    const legalDistricts = this._resolveLegalDistricts(district);
    if (legalDistricts.length > 1) {
      const result = await this._merge({ districts: legalDistricts, industry, sourceLocation: district, metric });
      if (!result.error) {
        // 법정동 merge에서도 요청된 metric 데이터를 보강 (추세/업소/유동인구)
        const firstResolved = this._resolveDistrict(legalDistricts[0]);
        if (firstResolved && (metric === 'trend' || metric === 'all')) {
          result.trend = await this._qe.buildTrend(firstResolved.code, industry);
          result.tierTrend = await this._qe.buildTierTrend(firstResolved.code, industry, 'amt');
        }
        if (firstResolved && metric === 'stores') {
          result.tierTrend = await this._qe.buildTierTrend(firstResolved.code, industry, 'upso');
        }
      }
      return result;
    }
    const resolved = this._resolveDistrict(legalDistricts[0] || district);
    if (!resolved) return { error: `"${district}" 행정동을 찾을 수 없습니다. 대전 82개 행정동 이름으로 다시 시도해 주세요.` };

    const { code, name: districtName, sgg } = resolved;
    const month = this._dl.getLatestMonth();
    const record = await this._qe.queryRecord(code, industry, month);

    if (!record) {
      const alternatives = await this._qe.suggestAlternatives(code, industry, sgg);
      return { error: `${districtName}에 "${industry}" 데이터가 없습니다.`, alternatives, district: { code, name: districtName, sgg } };
    }

    const qType = this._metricToQuestionType(metric);
    const intent = {
      question: `${districtName} ${industry}`,
      district: { code, name: districtName, sgg },
      industry: record.industry || industry,
      questionType: qType,
      month,
    };

    const result = { record, intent };

    // 데이터 부족 시 대안 추천 (amt 없거나 업소 0)
    if (!Number.isFinite(record.amt) || record.upso === 0) {
      result.alternatives = await this._qe.suggestAlternatives(code, industry, sgg);
    }

    // metric에 따라 추가 데이터 조회
    if (metric === 'sales' || metric === 'all') {
      result.comparison = this._qe.buildComparison(record);
      result.tierTrend = await this._qe.buildTierTrend(code, record.industry || industry, 'amt');
      result.midCategoryComparison = await this._qe.getMidCategoryComparison(code, record.industry || industry, month);
    }
    if (metric === 'stores' || metric === 'all') {
      result.upsoComparison = this._qe.buildUpsoComparison(record);
      if (metric === 'stores') {
        result.tierTrend = await this._qe.buildTierTrend(code, record.industry || industry, 'upso');
        intent.questionType = 'upso';
      }
    }
    if (metric === 'population' || metric === 'all') {
      result.population = this._qe.getPopulationDetail(record);
      if (metric === 'population') {
        result.tierTrend = await this._qe.buildTierTrend(code, record.industry || industry, 'pop');
        intent.questionType = 'pop';
      }
    }
    if (metric === 'trend') {
      result.trend = await this._qe.buildTrend(code, record.industry || industry);
      result.tierTrend = await this._qe.buildTierTrend(code, record.industry || industry, 'amt');
      intent.questionType = 'trend';
    }

    result.geminiSummary = this._buildGeminiSummary(record, result);
    return result;
  }

  async _overview({ district }) {
    const { resolved, multiMatch, districts: legalDistricts } = this._resolveDistrictWithLegal(district);
    if (multiMatch && legalDistricts?.length) {
      // 법정동 → 여러 행정동: 후보 안내
      return {
        error: `"${district}"은(는) 여러 행정동에 걸쳐 있습니다: ${legalDistricts.join(', ')}. 행정동을 선택해 주세요.`,
        disambiguation: legalDistricts,
      };
    }
    if (!resolved) return { error: `"${district}" 행정동을 찾을 수 없습니다.` };

    const { code, name: districtName, sgg } = resolved;
    const month = this._dl.getLatestMonth();
    const overview = await this._qe.buildOverview(code, month);

    const intent = {
      question: `${districtName} 상권 현황`,
      district: { code, name: districtName, sgg },
      industry: '',
      questionType: 'overview',
      month,
    };

    const result = { overview, record: null, intent };

    result.geminiSummary = {
      district: districtName,
      type: 'overview',
      totalIndustries: overview.totalIndustries,
      totalUpso: overview.totalUpso,
      totalAmt: overview.totalAmt,
      top3: overview.topIndustries?.slice(0, 3).map(i => `${i.name}(${i.amt?.toLocaleString()}만원)`).join(', '),
      pop: overview.pop?.total,
      peakDay: overview.pop?.peakDay,
      peakTime: overview.pop?.peakTime,
    };

    return result;
  }

  async _compare({ district1, district2, industry, metric = 'sales', autoCompareTarget = false }) {
    const res1 = this._resolveDistrictWithLegal(district1);
    const r1 = res1.resolved || (res1.multiMatch ? this._resolveDistrict(res1.districts?.[0]) : null);
    const vagueTarget = !district2 || /^(다른\s*동|다른곳|비슷한\s*동|비교군|주변\s*동|주변)$/i.test(String(district2).trim());
    if (r1 && vagueTarget) {
      const picked = await this._pickDefaultCompareDistrict(r1, industry);
      if (picked) {
        district2 = picked.name;
        autoCompareTarget = true;
      }
    }

    // 동일 동 자기비교 차단 (#34)
    const _norm = (s) => String(s || '').replace(/\s+/g, '');
    if (!autoCompareTarget && district2 && _norm(district1) === _norm(district2)) {
      return { error: `${district1} 한 곳만으로는 비교할 수 없어요. 비교할 다른 지역을 함께 알려주세요.` };
    }

    const res2 = this._resolveDistrictWithLegal(district2);
    if (!r1 && !res1.multiMatch) return { error: `"${district1}" 행정동을 찾을 수 없습니다.` };
    if (!res2.resolved && !res2.multiMatch) return { error: `"${district2}" 행정동을 찾을 수 없습니다.` };

    const month = this._dl.getLatestMonth();
    const [side1, side2] = await Promise.all([
      this._buildCompareSide(res1, district1, industry, month),
      this._buildCompareSide(res2, district2, industry, month),
    ]);
    if (!side1?.record) return { error: `"${district1}" ${industry} 데이터를 찾을 수 없습니다.` };
    if (!side2?.record) return { error: `"${district2}" ${industry} 데이터를 찾을 수 없습니다.` };

    const compareResult = { district1: side1.record, district2: side2.record };
    const trendComparison = side1.codes.length === 1 && side2.codes.length === 1
      ? await this._qe.getTrendComparison(side1.codes[0], side2.codes[0], industry)
      : null;
    const horizontalComparison = this._qe.buildHorizontalComparison(
      compareResult.district1, compareResult.district2,
    );

    const intent = {
      question: `${side1.label} vs ${side2.label} ${industry}`,
      district: { code: side1.codes[0], codes: side1.codes, name: side1.label, sgg: side1.sgg },
      compareTarget: { code: side2.codes[0], codes: side2.codes, name: side2.label, sgg: side2.sgg },
      compareGroups: { leftCodes: side1.codes, rightCodes: side2.codes },
      industry,
      metric,
      questionType: 'compare',
      month,
      autoCompareTarget,
    };

    const result = {
      record: compareResult.district1,
      compareResult,
      horizontalComparison,
      trendComparison,
      intent,
    };

    const rec1 = compareResult.district1;
    const rec2 = compareResult.district2;
    result.geminiSummary = {
      type: 'compare',
      district1: side1.label, district2: side2.label, industry,
      amt1: rec1?.amt, amt2: rec2?.amt,
      upso1: rec1?.upso, upso2: rec2?.upso,
      pop1: rec1?.pop, pop2: rec2?.pop,
      metrics: horizontalComparison.metrics?.slice(0, 5),
    };

    return result;
  }

  async _compareIndustries({ district, industries, metric = 'sales' }) {
    // 동일 업종 중복 제거 ("카페, 카페 중 …" 비문 방지, #36)
    const uniqueIndustries = [...new Set((industries || []).map(i => this._resolveIndustry(i)))];
    if (uniqueIndustries.length < 2) {
      return { error: '서로 다른 2개 이상의 업종이 필요합니다.' };
    }
    const resolved = this._resolveDistrict(district);
    if (!resolved) return { error: `"${district}" 행정동을 찾을 수 없습니다.` };

    const { code, name: districtName, sgg } = resolved;
    const month = this._dl.getLatestMonth();

    // 각 업종별 데이터 병렬 조회
    const resolvedIndustries = uniqueIndustries;
    const records = await Promise.all(
      resolvedIndustries.map(ind => this._qe.queryRecord(code, ind, month))
    );

    const sides = resolvedIndustries.map((ind, i) => ({
      industry: records[i]?.industry || ind,
      record: records[i],
    })).filter(s => s.record);

    if (sides.length < 2) {
      const missing = resolvedIndustries.filter((ind, i) => !records[i]).join(', ');
      return { error: `${districtName}에서 ${missing} 데이터를 찾을 수 없습니다. 다른 업종으로 시도해 보세요.` };
    }

    const intent = {
      question: `${districtName} ${sides.map(s => s.industry).join(' vs ')}`,
      district: { code, name: districtName, sgg },
      industries: sides.map(s => s.industry),
      questionType: 'compareIndustry',
      metric,
      month,
    };

    const result = {
      record: sides[0].record,
      industrySides: sides,
      intent,
      geminiSummary: {
        type: 'compareIndustry',
        district: districtName,
        industries: sides.map(s => s.industry),
        metric,
        values: sides.map(s => ({
          industry: s.industry,
          amt: s.record?.amt,
          upso: s.record?.upso,
          pop: s.record?.pop,
        })),
      },
    };
    return result;
  }

  async _buildCompareSide(resolution, originalName, industry, month) {
    if (resolution?.multiMatch && resolution.districts?.length) {
      const resolved = resolution.districts.map(name => this._resolveDistrict(name)).filter(Boolean);
      const codes = resolved.map(r => r.code);
      const mergeResult = await this._qe.queryMergedDistricts(codes, industry, month);
      if (!mergeResult?.merged) return null;
      const label = String(originalName || '').trim() || mergeResult.names.join(' + ');
      return {
        label,
        codes,
        sgg: resolved[0]?.sgg || '',
        record: {
          ...mergeResult.merged,
          districtName: label,
          districtCode: codes[0],
          _sourceDistricts: resolved.map(r => r.name),
        },
      };
    }

    const r = resolution?.resolved;
    if (!r?.code) return null;
    const record = await this._qe.queryRecord(r.code, industry, month);
    return record ? {
      label: r.name,
      codes: [r.code],
      sgg: r.sgg,
      record,
    } : null;
  }
  async _pickDefaultCompareDistrict(baseDistrict, industry) {
    if (!baseDistrict?.code || !industry) return null;
    const month = this._dl.getLatestMonth();
    try {
      const record = await this._qe.queryRecord(baseDistrict.code, industry, month);
      const similar = this._qe.getSimilar(record);
      for (const item of similar) {
        const candidate = this._resolveDistrict(item.district);
        if (candidate && candidate.code !== baseDistrict.code) return candidate;
      }
    } catch { /* optional */ }

    const numbered = String(baseDistrict.name || '').match(/^(.+?)(\d+)동$/);
    if (numbered) {
      const [, prefix, rawNo] = numbered;
      const currentNo = Number(rawNo);
      const sibling = this._districtList
        .filter(d => d.sgg === baseDistrict.sgg && d.code !== baseDistrict.code)
        .map(d => ({ district: d, match: d.name.match(new RegExp(`^${prefix}(\\d+)동$`)) }))
        .filter(item => item.match)
        .map(item => ({ ...item, no: Number(item.match[1]) }))
        .sort((a, b) => Math.abs(a.no - currentNo) - Math.abs(b.no - currentNo))[0];
      if (sibling?.district) return sibling.district;
    }

    return this._districtList.find(d => d.sgg === baseDistrict.sgg && d.code !== baseDistrict.code) || null;
  }

  async _similar({ district, industry }) {
    const { resolved, multiMatch, districts: legalDistricts } = this._resolveDistrictWithLegal(district);
    if (multiMatch) return { error: `"${district}"은(는) 여러 행정동에 걸쳐 있습니다: ${legalDistricts.join(', ')}. 행정동을 선택해 주세요.` };
    if (!resolved) return { error: `"${district}" 행정동을 찾을 수 없습니다.` };

    const { code, name: districtName, sgg } = resolved;
    const month = this._dl.getLatestMonth();
    const record = await this._qe.queryRecord(code, industry, month);
    if (!record) return { error: `${districtName}에 "${industry}" 데이터가 없습니다.` };

    const similar = this._qe.getSimilar(record);
    const intent = {
      question: `${districtName} ${industry} 유사 상권`,
      district: { code, name: districtName, sgg },
      industry: record.industry || industry,
      questionType: 'similar',
      month,
    };

    const result = { record, similar, intent };
    result.geminiSummary = {
      type: 'similar',
      district: districtName, industry: record.industry || industry,
      amt: record.amt, upso: record.upso,
      similarCount: similar.length,
      topSimilar: similar.slice(0, 3).map(s => s.district).join(', '),
    };

    return result;
  }

  async _merge({ districts, industry, sourceLocation = '', metric = 'all' }) {
    if (!districts?.length || districts.length < 2) {
      return { error: '합산하려면 2개 이상의 행정동이 필요합니다.' };
    }

    const resolvedList = districts.map(d => {
      const r = this._resolveDistrictWithLegal(d);
      return r.resolved;
    });
    const failed = districts.filter((d, i) => !resolvedList[i]);
    if (failed.length) return { error: `다음 행정동을 찾을 수 없습니다: ${failed.join(', ')}` };

    const codes = resolvedList.map(r => r.code);
    const month = this._dl.getLatestMonth();
    const mergeResult = await this._qe.queryMergedDistricts(codes, industry, month);

    if (!mergeResult?.merged) {
      return { error: `${districts.join('+')}에 "${industry}" 합산 데이터가 없습니다.` };
    }

    const intent = {
      question: `${sourceLocation || districts.join('+')} ${industry} 합산`,
      mergeDistricts: resolvedList.map(r => ({ code: r.code, name: r.name, sgg: r.sgg })),
      sourceLocation,
      industry,
      questionType: 'merge',
      requestedMetric: metric,
      month,
    };

    if (sourceLocation) {
      mergeResult.sourceLocation = sourceLocation;
    }

    const result = { record: mergeResult.merged, mergeResult, intent };
    result.geminiSummary = {
      type: 'merge',
      sourceLocation,
      districts: resolvedList.map(r => r.name),
      industry,
      mergedAmt: mergeResult.merged?.amt,
      mergedUpso: mergeResult.merged?.upso,
    };

    return result;
  }

  async _rankDistricts({ sgg, industry, metric = 'sales', limit = 10 }) {
    const resolvedSgg = this._resolveSgg(sgg);
    if (!resolvedSgg) return { error: `"${sgg}" 구를 찾을 수 없습니다. 예: 유성구, 서구, 중구처럼 물어봐 주세요.` };

    const month = this._dl.getLatestMonth();
    const ranking = await this._qe.rankDistrictsByIndustry(resolvedSgg, industry, metric, month, limit);
    if (!ranking.items?.length) {
      return { error: `${resolvedSgg}에서 "${industry}" 순위 데이터를 찾을 수 없습니다.` };
    }

    const top = ranking.items[0];
    const intent = {
      question: `${resolvedSgg} ${industry} 행정동 순위`,
      sgg: resolvedSgg,
      industry: top.industry || industry,
      questionType: 'rankDistricts',
      month,
    };

    return {
      ranking,
      intent,
      geminiSummary: {
        type: 'rankDistricts',
        sgg: resolvedSgg,
        industry: top.industry || industry,
        metric,
        unit: ranking.unit,
        topDistrict: top.district,
        topValue: top.value,
        top3: ranking.items.slice(0, 3).map(i => `${i.district}(${i.value?.toLocaleString()}${ranking.unit})`).join(', '),
        matchedDistricts: ranking.matchedDistricts,
        totalDistricts: ranking.totalDistricts,
      },
    };
  }

  async _sggIndustry({ sgg, industry, metric = 'trend' }) {
    const resolvedSgg = this._resolveSgg(sgg);
    if (!resolvedSgg) return { error: `"${sgg}" 구를 찾을 수 없습니다. 예: 유성구, 서구, 중구처럼 물어봐 주세요.` };

    const month = this._dl.getLatestMonth();
    const sggResult = await this._qe.buildSggIndustry(resolvedSgg, industry, metric, month);
    if (!sggResult.matchedDistricts) {
      return { error: `${resolvedSgg}에서 "${industry}" 데이터를 찾을 수 없습니다.` };
    }

    const intent = {
      question: `${resolvedSgg} ${industry} ${metric === 'trend' ? '추세' : '현황'}`,
      sgg: resolvedSgg,
      industry: sggResult.industry || industry,
      questionType: 'sggIndustry',
      month,
    };

    return {
      sggResult,
      intent,
      geminiSummary: {
        type: 'sggIndustry',
        sgg: resolvedSgg,
        industry: sggResult.industry || industry,
        metric,
        month,
        amt: sggResult.current.amt,
        upso: sggResult.current.upso,
        pop: sggResult.current.pop,
        topDistricts: sggResult.topDistricts.slice(0, 3).map(i => `${i.district}(${i.value?.toLocaleString()}${sggResult.unit})`).join(', '),
        matchedDistricts: sggResult.matchedDistricts,
        totalDistricts: sggResult.totalDistricts,
      },
    };
  }

  /* ═══════════════
     HELPERS
     ═══════════════ */

  /**
   * 법정동까지 고려한 행정동 해소.
   * 1) 법정동 매핑 시도 → 결과 1개면 _resolveDistrict 재귀
   * 2) 결과 2개+ → merge용 다중 반환
   * 3) 0이면 _resolveDistrict 폴스루
   * @returns {{ resolved: object|null, multiMatch?: boolean, districts?: string[] }}
   */
  _resolveDistrictWithLegal(name) {
    if (!name) return { resolved: null };
    const legal = this._resolveLegalDistricts(name);
    if (legal.length === 1) return { resolved: this._resolveDistrict(legal[0]) };
    if (legal.length > 1) return { multiMatch: true, districts: legal };
    return { resolved: this._resolveDistrict(name) };
  }

  /**
   * 행정동 이름 → { code, name, sgg } 해소
   * 정확 매칭 → 포함 매칭 → null
   */
  _resolveDistrict(name) {
    if (!name) return null;
    const n = name.trim();

    // 정확 매칭
    let found = this._districtList.find(d => d.name === n);
    if (found) return found;

    // 숫자 없는 축약 매칭 (예: "둔산" → "둔산1동")
    found = this._districtList.find(d => d.name.startsWith(n) || d.name.includes(n));
    if (found) return found;

    // 역방향 포함 (예: "둔산1" → "둔산1동")
    found = this._districtList.find(d => n.includes(d.name) || d.name.replace('동', '') === n.replace('동', ''));
    if (found) return found;

    return null;
  }

  _resolveSgg(name) {
    if (!name) return null;
    const n = String(name).trim();
    const sggNames = [...new Set(this._districtList.map(d => d.sgg).filter(Boolean))];
    return sggNames.find(sgg => sgg === n)
      || sggNames.find(sgg => sgg.includes(n) || n.includes(sgg))
      || null;
  }

  _resolveLegalDistricts(name) {
    if (!name) return [];
    const normalized = this._compact(name);
    const legalMap = this._dl.getMatchingDictionaries?.().legalDongToAdminDong || {};
    const matched = Object.entries(legalMap).find(([legalDong]) => this._compact(legalDong) === normalized);
    return Array.isArray(matched?.[1]) ? matched[1].filter(Boolean) : [];
  }

  _compact(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }

  /**
   * 업종 별칭 해소 ("코피" → "카페", "편의" → "편의점" 등)
   */
  _resolveIndustry(name) {
    if (!name) return name;
    // 이미 정확한 업종명이면 별칭을 적용하지 않음 (약국→일반병원 같은 잘못된 override 방지, QA-F4)
    const exact = String(name).trim();
    if ((this._dl.getIndustryList?.() || []).includes(exact)) return exact;
    const aliases = this._dl.getIndustryAliases?.() || {};
    const resolvedInput = this._dl.resolveIndustryInput?.(name) || name;
    const normalized = String(resolvedInput).trim();
    const compact = this._compact(normalized);
    // 내부 코드(ind_0001 등)와 별칭 사전에서 직접 매칭
    if (aliases[compact]) return aliases[compact];
    if (aliases[normalized]) return aliases[normalized];
    // 부분 매칭 시도
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (compact.includes(alias) || alias.includes(compact) || normalized.includes(alias)) return canonical;
    }
    return normalized;
  }

  _metricToQuestionType(metric) {
    const map = { sales: 'sales', stores: 'upso', population: 'pop', trend: 'trend', all: 'sales' };
    return map[metric] || 'sales';
  }

  /**
   * Gemini에게 돌려줄 핵심 숫자 요약 (~500자 이내)
   */
  _buildGeminiSummary(record, result) {
    const fin = (v) => Number.isFinite(v);
    const summary = {
      district: record.districtName,
      industry: record.industry,
      month: record.month,
      dataStatus: record.dataStatus,
    };

    if (fin(record.amt)) summary.amt = record.amt;
    if (fin(record.amtSgg)) summary.amtSgg = record.amtSgg;
    if (fin(record.amtSido)) summary.amtSido = record.amtSido;
    if (fin(record.amtYoY)) summary.amtYoY = record.amtYoY;
    if (fin(record.amtMoM)) summary.amtMoM = record.amtMoM;
    if (fin(record.upso)) summary.upso = record.upso;
    if (fin(record.pop)) summary.pop = record.pop;
    if (record.peakDay) summary.peakDay = record.peakDay;
    if (record.peakTime) summary.peakTime = record.peakTime;

    // 누락 필드 마커 — Gemini가 데이터 한계를 인식할 수 있도록
    const missing = [];
    if (!fin(record.amt)) missing.push('amt');
    if (!fin(record.upso)) missing.push('upso');
    if (!fin(record.pop)) missing.push('pop');
    if (record._amtImputed) missing.push('amt_imputed');
    if (record._upsoImputed) missing.push('upso_imputed');
    if (missing.length) summary.missingFields = missing;

    return summary;
  }
}
