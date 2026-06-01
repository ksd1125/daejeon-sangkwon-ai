const QUESTION_KEYWORDS = {
  sales: [
    '매출', '매상', '수입', '수익', '얼마', '벌', '팔', '매출액', '돈', '잘되', '장사',
    '잘팔', '인기', '핫한', '뜨는', '대박', '번창', '잘나가', '핫플', '성업', '수입이', '돈벌',
    // 동의어/유사 표현 확장
    '월매출', '연매출', '평균매출', '매출평균', '점포당매출', '업소당매출', '건당매출',
    '매출규모', '매출현황', '매출이', '수익률', '매출좋', '매출높', '매출낮',
    '돈이', '돈을', '벌이', '소득', '이익', '영업실적', '실적', '잘벌',
    '장사잘', '장사가', '잘팔리', '매출순위', '매출비교',
  ],
  upso: [
    '업소', '가게', '점포', '업체', '몇개', '몇곳', '사업체', '몇군데',
    // 동의어/유사 표현 확장
    '점포수', '업소수', '가게수', '상점', '매장', '매장수', '개수', '영업중',
    '업체수', '사업장', '몇개나', '총몇개', '몇곳이나', '개업', '폐업',
    '신규', '늘었', '줄었', '생겼', '없어졌', '오픈', '창업', '개점', '폐점',
  ],
  pop: [
    '유동인구', '유동', '인구', '사람', '방문', '통행', '붐비', '몰리', '다니는', '왕래',
    // 동의어/유사 표현 확장
    '유동인구수', '보행자', '보행량', '통행량', '방문자', '방문객', '내방', '발길',
    '사람많', '사람이', '사람들', '얼마나다니', '사람수', '유입', '유출',
    '붐비는', '한적', '활성화', '상권활력', '생활인구', '배후인구', '거주인구',
    '주중', '주말', '평일', '요일별', '시간대', '피크', '언제많',
  ],
  trend: [
    '추세', '추이', '변화', '증가', '감소', '트렌드', '최근', '요즘', '늘', '줄', '흐름', '동향', '전망',
    // 동의어/유사 표현 확장
    '변동', '변해', '달라', '바뀌', '올라', '내려', '상승', '하락', '오름', '내림',
    '작년', '전년', '작년대비', '전년대비', '월별', '분기', '연간', '기간별',
    '나아졌', '악화', '개선', '호전', '침체', '회복', '성장', '위축',
  ],
  similar: ['비슷', '유사', '같은', '닮은', '다른곳', '비슷한곳', '비슷한동네', '유사상권', '유사한', '비슷한데'],
  compare: ['비교', '비교해', '대비', '차이', '어디가나은', '어디가좋', 'vs', 'VS'],
  merge: ['합쳐서', '합산', '합계', '합치면', '합해서', '합하면', '통합', '묶어서', '전체묶어', '생활권'],
  dataStatus: ['데이터', '직접값', '대체값', '정확', '신뢰'],
  overview: [
    '어때', '현황', '개요', '전체', '상권', '알려줘', '브리핑', '어떤', '어떻', '상황', '분위기', '괜찮', '어떤지', '좋은',
    // 동의어/유사 표현 확장
    '종합', '요약', '전반', '총평', '개괄', '한눈에', '정리해', '살펴봐', '전체적',
  ],
};

// 복수 행정동 약어 (둔산→둔산1/2/3동) + 단일 행정동 약어 (도안→도안동)
const ABBREVIATIONS = [
  // 복수 행정동
  '둔산', '갈마', '판암', '관저', '가양', '도마', '문화', '유천', '온천', '태평', '월평', '노은', '법',
  // 단일 행정동 (false positive 위험 낮은 2글자 이상)
  '도안', '탄방', '괴정', '가수원', '기성', '만년', '진잠', '학하', '전민', '구즉', '관평', '원신흥',
  '비래', '송촌', '중리', '신탄진', '석봉', '덕암', '목상', '용운', '자양', '용전', '홍도',
  '중촌', '대흥', '문창', '석교', '대사', '부사', '용두', '복수', '정림', '용문', '가장',
  '은행선화',
];

// 지역명 매칭 전 제거할 노이즈 단어
const LOCATION_NOISE = ['쪽', '근처', '주변', '부근', '인근', '동네', '사거리', '앞쪽', '뒤쪽', '옆', '일대', '권역', '지역'];

// "구" 없이도 매칭할 시군구 약어 (2글자 이상만, "동/중/서"는 너무 짧아 제외)
const SGG_SHORT = { '유성': '유성구', '대덕': '대덕구' };

export class IntentParser {
  constructor(districtList = [], industryList = [], industryAliases = {}, matchingDictionaries = {}) {
    this.districts = districtList.map((district) => ({
      code: String(district.code || district.admiCode || district.ADMI_CD || ''),
      name: String(district.name || district.admiName || district.ADMI_NM || ''),
      sgg: String(district.sgg || district.sggName || district.SGG_NM || ''),
      sggCode: String(district.sggCode || district.SGG_CD || ''),
    })).filter((district) => district.code && district.name);

    this.districtsByLength = [...this.districts].sort((a, b) => b.name.length - a.name.length);
    this.industries = [...industryList].map(String).filter(Boolean).sort((a, b) => b.length - a.length);
    this.industryAliases = this._normalizeAliases(industryAliases);
    this.legalDongAliases = this._buildLegalDongAliases(matchingDictionaries.legalDongToAdminDong || {});
    this.similarIndustryGroups = this._normalizeSimilarIndustryGroups(matchingDictionaries.similarIndustryGroups || {});
    this.ambiguousIndustryTerms = this._normalizeAmbiguousTerms(matchingDictionaries.ambiguousIndustryTerms || {});
    this.brandToIndustry = this._normalizeBrands(matchingDictionaries.brandToIndustry || {});
    this.locationAliases = this._normalizeLocationAliases(matchingDictionaries.locationAliases || {});
  }

  parse(question, _typoDepth = 0) {
    const text = String(question || '').trim();
    const compact = this._compact(text);
    let confidence = 1.0;
    const ambiguities = [];

    const districtResult = this._extractDistrict(text, compact);
    if (!districtResult.district && districtResult.candidates.length === 0) confidence -= 0.3;
    if (districtResult.usedAbbreviation) confidence -= 0.3;
    if (districtResult.candidates.length > 1) {
      ambiguities.push({
        type: 'district',
        message: '행정동 후보가 여러 개입니다.',
        candidates: districtResult.candidates,
      });
    }

    const industryResult = this._extractIndustry(text, compact, districtResult);
    const questionTypeResult = this._extractQuestionType(compact, Boolean(industryResult.industry));
    if (questionTypeResult.usedDefault) confidence -= 0.1;

    if (!industryResult.industry && this._industryIsImplied(questionTypeResult.questionType)) {
      confidence -= 0.3;
    }
    if (industryResult.matchType === 'partial') {
      confidence -= (1 - industryResult.matchRatio) * 0.4;
    }
    if (industryResult.matchType === 'ambiguous') {
      ambiguities.push({
        type: 'industry',
        message: `"${industryResult.raw}" 유형을 선택해 주세요.`,
        candidates: industryResult.candidates,
      });
    }

    const month = this._extractMonth(text);

    // 업종 간 비교 감지: "카페 vs 치킨", "카페랑 편의점 비교"
    let compareIndustries = null;
    const isCompare = questionTypeResult.questionType === 'compare';
    if (isCompare && districtResult.district && industryResult.industry) {
      const multiInd = this._extractMultiIndustries(text, compact);
      if (multiInd.length >= 2) {
        compareIndustries = multiInd.slice(0, 3);
        questionTypeResult.questionType = 'compareIndustry';
      }
    }

    // 비교 대상 행정동 추출 (compare 타입일 때, 업종 비교가 아닌 경우)
    const compareTarget = questionTypeResult.questionType === 'compare'
      ? this._extractCompareTarget(text, compact, districtResult.district)
      : null;

    // 병합(merge) 감지: merge 키워드 + 여러 동 패턴
    let mergeDistricts = null;
    const hasMergeKw = QUESTION_KEYWORDS.merge.some(kw => compact.includes(this._compact(kw)));
    if (hasMergeKw || this._hasNumericDongPattern(text)) {
      mergeDistricts = this._extractAllDistricts(text, compact);
      if (mergeDistricts.length >= 2) {
        questionTypeResult.questionType = 'merge';
        // 첫 번째를 대표 district로
        if (!districtResult.district) {
          districtResult.district = mergeDistricts[0];
          districtResult.sgg = mergeDistricts[0].sgg || null;
        }
      } else {
        mergeDistricts = null;
      }
    }

    // 오타 보정 폴백: 인식 실패한 부분(지역/업종/지표)을 가장 가까운 정답으로 보정 후 재파싱 (depth 0에서만)
    if (_typoDepth === 0) {
      const corr = this._detectTypoCorrections(text, districtResult, industryResult, questionTypeResult);
      if (corr.correctedText && corr.correctedText !== text) {
        const reparsed = this.parse(corr.correctedText, 1);
        reparsed.typoCorrections = corr.corrections;
        reparsed.originalQuestion = text;
        return reparsed;
      }
    }

    // 미인식 업종 감지: 업종이 필요한 질문인데 매칭 실패 시 잔여 토큰 추출 (#40)
    let unmatchedIndustry = null;
    if (!industryResult.industry && this._industryIsImplied(questionTypeResult.questionType)) {
      unmatchedIndustry = this._residualToken(compact, districtResult);
    }

    return {
      question: text,
      district: districtResult.district,
      sgg: districtResult.sgg,
      industry: industryResult.industry,
      industryRaw: industryResult.raw,
      unmatchedIndustry,
      industryMatchType: industryResult.matchType || null,
      industryMatchRatio: industryResult.matchRatio ?? null,
      questionType: questionTypeResult.questionType,
      crossMetrics: questionTypeResult.metrics || null, // density 분석용 교차 지표
      mergeDistricts, // merge 분석용 복수 행정동
      compareIndustries, // 업종 간 비교용 복수 업종 (최대 3)
      month,
      confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
      ambiguities,
      districtCandidates: districtResult.candidates,
      usedLegalDongAlias: Boolean(districtResult.usedLegalDongAlias),
      usedLocationAlias: Boolean(districtResult.usedLocationAlias),
      locationAliasMessage: districtResult.locationAliasMessage || null,
      locationAlias: districtResult.locationAlias || null,
      industryCandidates: industryResult.candidates || [],
      compareTarget,
      typoCorrections: [],
    };
  }

  _extractDistrict(text, compact) {
    // 노이즈 단어 제거 후 재생성 (지역명 매칭 정확도 향상)
    const cleanedText = LOCATION_NOISE.reduce((t, noise) => t.replace(new RegExp(noise, 'g'), ''), text);
    const cleanedCompact = this._compact(cleanedText);

    const sggNames = [...new Set(this.districts.map((district) => district.sgg).filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    let matchedSgg = sggNames.find((sgg) => cleanedCompact.includes(this._compact(sgg))) || null;
    // "유성"→"유성구", "대덕"→"대덕구" 등 "구" 없이도 매칭
    if (!matchedSgg) {
      const sggShortEntry = Object.entries(SGG_SHORT).find(([short]) => cleanedCompact.includes(short));
      if (sggShortEntry) matchedSgg = sggShortEntry[1];
    }

    if (matchedSgg) {
      const sggDistricts = this.districtsByLength.filter((district) => district.sgg === matchedSgg);
      const exactWithPrefix = sggDistricts.find((district) => {
        const pattern = new RegExp(`${this._escapeRegex(matchedSgg)}\\s*${this._escapeRegex(district.name)}`);
        return pattern.test(text);
      });
      if (exactWithPrefix) {
        return { district: exactWithPrefix, sgg: matchedSgg, candidates: [exactWithPrefix], usedAbbreviation: false };
      }
    }

    const exact = this._findDistrictsInText(cleanedCompact)[0] || this._findDistrictsInText(compact)[0];
    if (exact) {
      return { district: exact, sgg: exact.sgg || matchedSgg, candidates: [exact], usedAbbreviation: false };
    }

    // 상권 위치 별칭 검사 (발달상권, 원도심, 신도심 등)
    const locAlias = this._extractLocationAlias(cleanedCompact) || this._extractLocationAlias(compact);
    if (locAlias.candidates.length > 0) {
      // 복수 후보 시, 약어로 좁힐 수 있는지 시도 ("도안 신도시" → 도안동)
      if (locAlias.candidates.length > 1) {
        const abbr = ABBREVIATIONS.find(a => cleanedCompact.includes(this._compact(a)))
          || ABBREVIATIONS.find(a => compact.includes(this._compact(a)));
        if (abbr) {
          const narrowed = locAlias.candidates.filter(d => this._districtMatchesAbbreviation(d.name, abbr));
          if (narrowed.length === 1) {
            return {
              district: narrowed[0],
              sgg: matchedSgg || narrowed[0].sgg || null,
              candidates: narrowed,
              usedAbbreviation: true,
              usedLocationAlias: true,
              locationAliasMessage: locAlias.message,
              locationAlias: locAlias.alias || null,
            };
          }
        }
      }
      return {
        district: locAlias.candidates.length === 1 ? locAlias.candidates[0] : null,
        sgg: matchedSgg || (locAlias.candidates[0]?.sgg || null),
        candidates: locAlias.candidates,
        usedAbbreviation: false,
        usedLocationAlias: true,
        locationAliasMessage: locAlias.message,
        locationAlias: locAlias.alias || null,
      };
    }

    const legalAlias = this._extractLegalDongAlias(cleanedCompact, matchedSgg) || this._extractLegalDongAlias(compact, matchedSgg);
    if (legalAlias.candidates.length > 0) {
      return {
        district: legalAlias.candidates.length === 1 ? legalAlias.candidates[0] : null,
        sgg: matchedSgg || (legalAlias.candidates[0] ? legalAlias.candidates[0].sgg : null),
        candidates: legalAlias.candidates,
        usedAbbreviation: false,
        usedLegalDongAlias: true,
        // 매칭된 별칭 키 전달 — merge sourceLocation에 사용 (과학단지, 성심당 등)
        locationAlias: legalAlias.alias || null,
      };
    }

    const abbreviation = ABBREVIATIONS.find((abbr) => cleanedCompact.includes(this._compact(abbr)))
      || ABBREVIATIONS.find((abbr) => compact.includes(this._compact(abbr)));
    if (!abbreviation) {
      return { district: null, sgg: matchedSgg, candidates: [], usedAbbreviation: false };
    }

    let candidates = this.districts.filter((district) => this._districtMatchesAbbreviation(district.name, abbreviation));
    if (matchedSgg) candidates = candidates.filter((district) => district.sgg === matchedSgg);
    candidates.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

    return {
      district: candidates.length === 1 ? candidates[0] : null,
      sgg: matchedSgg || (candidates[0] ? candidates[0].sgg : null),
      candidates,
      usedAbbreviation: candidates.length > 0,
    };
  }

  _extractLegalDongAlias(compact, matchedSgg) {
    const aliasEntry = Object.entries(this.legalDongAliases)
      .filter(([alias]) => alias.length >= 2 && compact.includes(alias))
      .sort((a, b) => b[0].length - a[0].length)[0];

    if (!aliasEntry) return { alias: null, candidates: [] };

    const candidates = [];
    aliasEntry[1].forEach((adminDongName) => {
      const normalizedName = this._compact(adminDongName);
      this.districts.forEach((district) => {
        if (this._compact(district.name) === normalizedName) candidates.push(district);
      });
    });

    const filtered = matchedSgg
      ? candidates.filter((district) => district.sgg === matchedSgg)
      : candidates;

    return {
      alias: aliasEntry[0],
      candidates: this._uniqueDistricts(filtered).sort((a, b) => {
        const sggCompare = String(a.sgg || '').localeCompare(String(b.sgg || ''), 'ko');
        return sggCompare || a.name.localeCompare(b.name, 'ko');
      }),
    };
  }

  _extractIndustry(text, compact, districtResult = {}) {
    // 인식된 행정동 이름을 검색 텍스트에서 제거 — 브랜드/부분매칭이 동 이름 안의
    // 부분문자열에 잘못 걸리는 것 방지 (예: 브랜드 "정동"이 "오정동"에 매칭 — regionSwitch QA)
    const districtNames = [
      districtResult.district?.name,
      ...(districtResult.candidates || []).map((c) => c?.name),
    ].filter(Boolean);
    let searchCompact = compact;
    for (const n of districtNames) {
      const cn = this._compact(n);
      if (cn && cn.length >= 2) searchCompact = searchCompact.split(cn).join('');
    }

    const exactEarly = this.industries.find((industry) => compact.includes(this._compact(industry)));
    if (exactEarly) {
      const rawToken = this._findIndustryRawToken(text, exactEarly);
      if (rawToken && this._compact(rawToken) !== this._compact(exactEarly)) {
        return { industry: exactEarly, raw: rawToken, confidence: 0.85, matchType: 'partial-token', matchRatio: 0.85 };
      }
      return { industry: exactEarly, raw: exactEarly, confidence: 1.0, matchType: 'exact', matchRatio: 1 };
    }

    // 0. 브랜드 사전 매칭 (KFC → 치킨, 올리브영 → 화장품 소매업 등)
    //    행정동 이름 제거된 searchCompact 사용 (브랜드가 동 이름 안에 걸리는 것 방지)
    const brandSearchText = searchCompact.replace(/행정동|법정동/g, '');
    const brandEntry = Object.entries(this.brandToIndustry)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([brand]) => brand.length >= 2 && brandSearchText.includes(brand));
    if (brandEntry) {
      return { industry: brandEntry[1], raw: brandEntry[0], confidence: 0.95, matchType: 'brand', matchRatio: 1 };
    }

    // 0-b. 모호 업종 검사 (학원, 병원, 의원 → 기본 후보 자동 선택)
    const ambigEntry = Object.entries(this.ambiguousIndustryTerms)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([term]) => compact.includes(this._compact(term)));
    if (ambigEntry) {
      // "미술학원"처럼 구체적으로 적었으면 그냥 exact match로 넘김
      const specificMatch = this.industries.find((ind) => {
        const ci = this._compact(ind);
        return ci !== this._compact(ambigEntry[0]) && ci.endsWith(this._compact(ambigEntry[0])) && compact.includes(ci);
      });
      if (!specificMatch) {
        // 모호한 용어 → 첫 번째 후보를 기본값으로 선택 (null 반환 대신)
        const candidates = ambigEntry[1];
        const defaultIndustry = Array.isArray(candidates) ? candidates[0] : candidates;
        if (defaultIndustry && this.industries.includes(defaultIndustry)) {
          return { industry: defaultIndustry, raw: ambigEntry[0], confidence: 0.7, matchType: 'ambiguous-default', matchRatio: 0.7, candidates };
        }
        return { industry: null, raw: ambigEntry[0], confidence: 0.5, matchType: 'ambiguous', matchRatio: 0, candidates };
      }
    }

    const exact = this.industries.find((industry) => compact.includes(this._compact(industry)));
    if (exact) {
      return { industry: exact, raw: exact, confidence: 1.0, matchType: 'exact', matchRatio: 1 };
    }

    const aliasEntry = Object.entries(this.industryAliases).find(([alias]) => alias.length >= 2 && compact.includes(alias));
    if (aliasEntry) {
      return { industry: aliasEntry[1], raw: aliasEntry[0], confidence: 0.9, matchType: 'alias', matchRatio: 1 };
    }

    const groupEntry = Object.entries(this.similarIndustryGroups).find(([groupName, group]) => (
      compact.includes(groupName) || (group.aliases || []).some((alias) => alias.length >= 2 && compact.includes(alias))
    ));
    if (groupEntry) {
      const [groupName, group] = groupEntry;
      return { industry: group.primary, raw: groupName, confidence: 0.85, matchType: 'group', matchRatio: 1 };
    }

    let best = null;
    this.industries.forEach((industry) => {
      const cleanIndustry = this._compact(industry);
      const common = this._longestCommonSubstring(searchCompact, cleanIndustry);
      if (common.length < 3) return;
      // 앞글자가 다른 '중간 부분일치' 차단: 공통부분은 질문 또는 업종명의 접두여야 함
      // (예: 정형외과 vs 성형외과의원 → 공통 "형외과"가 어느 쪽 접두도 아님 → 거부) #5
      const isPrefixAligned = searchCompact.startsWith(common) || cleanIndustry.startsWith(common);
      if (!isPrefixAligned) return;
      const ratio = common.length / cleanIndustry.length;
      if (ratio < 0.35) return;
      const score = 0.6 + Math.min(0.2, ratio * 0.2);
      if (!best || score > best.confidence || (score === best.confidence && ratio > best.matchRatio)) {
        best = { industry, raw: common, confidence: score, matchType: 'partial', matchRatio: ratio };
      }
    });

    return best || { industry: null, raw: null, confidence: 0, matchType: 'none', matchRatio: 0 };
  }

  _extractQuestionType(compact, hasIndustry) {
    // 교차 지표: 두 가지 이상 지표 키워드가 함께 언급 → 밀도/효율 분석
    const metricTypes = ['sales', 'upso', 'pop'];
    const hits = metricTypes.filter(type =>
      QUESTION_KEYWORDS[type].some(kw => compact.includes(this._compact(kw)))
    );
    if (hits.length >= 2) {
      return { questionType: 'density', usedDefault: false, metrics: hits };
    }
    // "밀도/효율" 명시 키워드 단독으로도 density (#14)
    if (/밀도|효율/.test(compact)) {
      return { questionType: 'density', usedDefault: false, metrics: hits.length >= 1 ? hits.concat(['upso', 'pop']).filter((x, i, a) => a.indexOf(x) === i).slice(0, 2) : ['upso', 'pop'] };
    }

    if (QUESTION_KEYWORDS.compare.some((keyword) => compact.includes(this._compact(keyword)))) {
      return { questionType: 'compare', usedDefault: false };
    }

    // 전년 대비 패턴 → trend 우선 (sales/overview 키워드보다 먼저 매칭)
    if (/작년대비|전년대비|지난해대비|전년비/.test(compact)) {
      return { questionType: 'trend', usedDefault: false };
    }

    for (const [type, keywords] of Object.entries(QUESTION_KEYWORDS)) {
      if (type === 'compare') continue;
      if (keywords.some((keyword) => compact.includes(this._compact(keyword)))) {
        if (type === 'overview' && hasIndustry) {
          return { questionType: 'sales', usedDefault: false };
        }
        return { questionType: type, usedDefault: false };
      }
    }
    return { questionType: hasIndustry ? 'sales' : 'overview', usedDefault: true };
  }

  _extractMonth(text) {
    const explicit = text.match(/(20\d{2})\s*년\s*(1[0-2]|0?[1-9])\s*월/);
    if (explicit) return `${explicit[1]}${explicit[2].padStart(2, '0')}`;

    const compactYm = text.match(/\b(20\d{2})(0[1-9]|1[0-2])\b/);
    if (compactYm) return `${compactYm[1]}${compactYm[2]}`;

    const now = new Date();
    const monthOnly = text.match(/(1[0-2]|0?[1-9])\s*월/);
    if (/(작년|지난해)/.test(text)) {
      const year = now.getFullYear() - 1;
      const month = monthOnly ? Number(monthOnly[1]) : now.getMonth() + 1;
      return `${year}${String(month).padStart(2, '0')}`;
    }

    if (text.includes('지난달')) {
      const date = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    return null;
  }

  /**
   * 비교 대상 행정동 추출.
   * "{동}이랑 비교", "{동}하고 비교", "{동}보다", "{동} 대비" 패턴 인식.
   * @param {string} text — 원문
   * @param {string} compact — 공백 제거 텍스트
   * @param {object|null} primaryDistrict — 이미 추출된 주 행정동
   * @returns {object|null} { code, name, sgg } or null
   */
  /**
   * 복수 업종 추출 (최대 3개): "카페 vs 치킨", "카페랑 편의점이랑 치킨 비교"
   * 구분자: vs, VS, , 이랑, 랑, 하고, 와, 과 + 공백 구분도 지원
   */
  _extractMultiIndustries(text, compact) {
    // 지역명 제거한 텍스트에서 업종만 탐색
    const distNames = this.districtsByLength.map(d => d.name);
    let cleaned = text;
    for (const dn of distNames) { cleaned = cleaned.replace(dn, ''); }
    // 비교/추세 등 키워드도 제거
    cleaned = cleaned.replace(/비교해?줘?|차이|어때|어떻|어떤|vs|해줘/gi, '').trim();

    // 토큰 분리: "이랑", "랑", "하고", "와", "과", ","
    let tokens = cleaned.split(/\s*(?:이랑|랑|하고|와(?!래)|과|,|vs)\s*/i).map(t => t.trim()).filter(Boolean);

    // 구분자로 나눠지지 않으면 공백으로도 분리
    if (tokens.length <= 1 && cleaned.includes(' ')) {
      tokens = cleaned.split(/\s+/).filter(Boolean);
    }

    const found = [];
    const _match = (tc) => {
      let ind = this.industries.find(i => tc.includes(this._compact(i)));
      if (!ind) {
        const ae = Object.entries(this.industryAliases).find(([a]) => a.length >= 2 && tc.includes(a));
        if (ae) ind = ae[1];
      }
      return ind;
    };

    for (const token of tokens) {
      if (!token || token.length < 1) continue;
      const ind = _match(this._compact(token));
      if (ind && !found.includes(ind)) found.push(ind);
    }

    // 토큰 분리가 실패해도, 전체 텍스트에서 순차적으로 업종 매칭
    if (found.length < 2) {
      const cc = this._compact(cleaned);
      for (const ind of this.industries) {
        if (found.length >= 3) break;
        if (cc.includes(this._compact(ind)) && !found.includes(ind)) found.push(ind);
      }
    }
    return found;
  }

  _extractCompareTarget(text, compact, primaryDistrict) {
    // "~이랑", "~하고", "~보다", "~랑" 앞의 행정동 찾기
    const patterns = [
      /(.+?)(?:이랑|하고|랑|보다|대비|versus|vs)\s*(?:비교|차이|대비)/,
      /(?:비교|차이).*?(.+?)(?:이랑|하고|랑|보다)/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const fragment = this._compact(match[1]);
      const found = this.districtsByLength.find(
        (d) => fragment.includes(this._compact(d.name)) && d.code !== primaryDistrict?.code
      );
      if (found) return found;
    }

    // 직접 매칭: 질문에 2개 이상 행정동이 언급된 경우
    const allMatches = this._findDistrictsInText(compact);
    if (allMatches.length >= 2 && primaryDistrict) {
      const second = allMatches.find((d) => d.code !== primaryDistrict.code);
      if (second) return second;
    }

    return null;
  }

  _industryIsImplied(questionType) {
    return ['sales', 'upso', 'trend', 'similar', 'compare', 'compareIndustry', 'density', 'merge', 'dataStatus'].includes(questionType);
  }

  /** 지역·키워드·조사를 제거한 잔여 토큰 → 미인식 업종 추정 (#40) */
  _residualToken(compact, districtResult) {
    let s = String(compact || '');
    const removals = [];
    if (districtResult?.district?.name) removals.push(this._compact(districtResult.district.name));
    (districtResult?.candidates || []).forEach((c) => removals.push(this._compact(c?.name)));
    if (districtResult?.sgg) removals.push(this._compact(districtResult.sgg));
    Object.values(QUESTION_KEYWORDS).flat().forEach((k) => removals.push(this._compact(k)));
    const fillers = ['매출', '추세', '추이', '업소', '점포', '가게', '업체', '유동', '인구', '어때', '현황', '비교', '순위', '랭킹', '얼마', '정도', '데이터', '분석', '요일', '시간대', '지난달', '이번달', '작년', '올해', '전년', '대비', '알려줘', '보여줘', '궁금', '어디', '어느', '무엇', '얼마나', '좀', '은', '는', '이', '가', '을', '를', '와', '과', '의', '에', '에서', '로', '으로', '만원', '명', '몇', 'vs'];
    fillers.forEach((f) => removals.push(f));
    removals.filter(Boolean).sort((a, b) => b.length - a.length).forEach((r) => { s = s.split(r).join(''); });
    const residual = s.replace(/[^가-힣a-zA-Z]/g, '');
    return residual.length >= 2 ? residual : null;
  }

  /** "노은1동2동", "갈마1동2동" 패턴 감지 — 약어+번호 조합 */
  _hasNumericDongPattern(text) {
    for (const abbr of ABBREVIATIONS) {
      const re = new RegExp(`${abbr}\\d+동\\d+동`);
      if (re.test(text.replace(/\s+/g, ''))) return true;
    }
    return false;
  }

  /** 텍스트에서 모든 행정동 매칭 (merge 용) */
  _extractAllDistricts(text, compact) {
    const found = [];
    const usedCodes = new Set();

    // "노은1동2동" → "노은1동", "노은2동" 확장
    let expandedText = text;
    for (const abbr of ABBREVIATIONS) {
      const re = new RegExp(`(${abbr})(\\d+)동(\\d+)동`, 'g');
      expandedText = expandedText.replace(re, (_, a, n1, n2) => `${a}${n1}동 ${a}${n2}동`);
    }
    const expandedCompact = this._compact(expandedText);

    for (const d of this.districtsByLength) {
      const cName = this._compact(d.name);
      if (expandedCompact.includes(cName) && !usedCodes.has(d.code)) {
        found.push({ code: d.code, name: d.name, sgg: d.sgg });
        usedCodes.add(d.code);
      }
    }

    // 약어 매칭 (예: "노은" → 노은1동, 노은2동, 노은3동)
    if (found.length < 2) {
      for (const abbr of ABBREVIATIONS) {
        if (!compact.includes(abbr)) continue;
        const matches = this.districts.filter(d =>
          d.name.startsWith(abbr) && !usedCodes.has(d.code)
        );
        for (const m of matches) {
          if (!usedCodes.has(m.code)) {
            found.push({ code: m.code, name: m.name, sgg: m.sgg });
            usedCodes.add(m.code);
          }
        }
      }
    }

    return found;
  }

  _districtMatchesAbbreviation(name, abbreviation) {
    const compactName = this._compact(name);
    const compactAbbr = this._compact(abbreviation);
    return compactName === `${compactAbbr}동`
      || compactName.startsWith(compactAbbr)
      || compactName.replace(/\d+동$/, '').replace(/동$/, '') === compactAbbr;
  }

  _findDistrictsInText(compact) {
    const seen = new Set();
    return this.districtsByLength
      .map((district) => {
        const name = this._compact(district.name);
        return { district, name, index: compact.indexOf(name) };
      })
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index || b.name.length - a.name.length)
      .filter((item) => {
        if (seen.has(item.district.code)) return false;
        seen.add(item.district.code);
        return true;
      })
      .map((item) => item.district);
  }

  _normalizeAliases(aliases) {
    const normalized = {};
    Object.entries(aliases || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((alias) => {
          normalized[this._compact(alias)] = key;
        });
      } else {
        normalized[this._compact(key)] = String(value || '');
      }
    });
    return normalized;
  }

  _buildLegalDongAliases(source) {
    const aliases = {};
    const addAlias = (alias, adminDongs) => {
      const key = this._compact(alias);
      const values = (Array.isArray(adminDongs) ? adminDongs : [adminDongs])
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      if (!key || values.length === 0) return;
      aliases[key] = [...new Set([...(aliases[key] || []), ...values])];
    };

    this.districts.forEach((district) => {
      const baseName = district.name.replace(/\d+동$/, '동');
      if (baseName !== district.name) addAlias(baseName, district.name);
    });

    Object.entries(source || {}).forEach(([legalDong, adminDongs]) => {
      addAlias(legalDong, adminDongs);
    });

    return aliases;
  }

  _normalizeSimilarIndustryGroups(groups) {
    const normalized = {};
    Object.entries(groups || {}).forEach(([key, group]) => {
      const groupKey = this._compact(key);
      if (!groupKey) return;
      const value = typeof group === 'object' && group !== null
        ? {
          primary: String(group.primary || '').trim(),
          industries: (group.industries || []).map((item) => String(item || '').trim()).filter(Boolean),
          aliases: (group.aliases || []).map((item) => this._compact(item)).filter(Boolean),
        }
        : {
          primary: String(group || '').trim(),
          industries: [String(group || '').trim()].filter(Boolean),
          aliases: [],
        };
      if (!value.primary && value.industries.length > 0) value.primary = value.industries[0];
      if (value.primary) normalized[groupKey] = value;
    });
    return normalized;
  }

  _uniqueDistricts(districts) {
    const seen = new Set();
    return districts.filter((district) => {
      const key = district.code || `${district.sgg}:${district.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _compact(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }

  /* ══════════════ 오타 보정 (자모 편집거리) ══════════════ */

  _hangulToJamo(str) {
    const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
    const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
    const JONG = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
    let out = '';
    for (const ch of String(str || '')) {
      const code = ch.charCodeAt(0);
      if (code >= 0xAC00 && code <= 0xD7A3) {
        const s = code - 0xAC00;
        out += CHO[Math.floor(s / 588)] + JUNG[Math.floor((s % 588) / 28)] + JONG[s % 28];
      } else out += ch;
    }
    return out;
  }

  _editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      }
      prev = cur;
    }
    return prev[n];
  }

  _jamoDistance(a, b) {
    return this._editDistance(this._hangulToJamo(a), this._hangulToJamo(b));
  }

  /** 공백 제거 + 원본 인덱스 맵 */
  _compactMap(text) {
    const s = String(text || '');
    let compact = '';
    const map = [];
    for (let i = 0; i < s.length; i++) {
      if (/\s/.test(s[i])) continue;
      compact += s[i];
      map.push(i);
    }
    return { compact, map };
  }

  /** compact 안에서 후보와 가장 가까운(자모거리 1~maxDist) 구간을 찾음. 동률 2개면 모호 → null */
  _fuzzyFindBest(compact, map, candidates) {
    const matches = [];
    const clen = compact.length;
    for (const cand of candidates) {
      const L = cand.length;
      const maxDist = Math.min(2, Math.max(1, Math.floor(this._hangulToJamo(cand).length * 0.18)));
      let candBest = null;
      for (const w of [L, L - 1, L + 1]) {
        if (w < 2 || w > clen) continue;
        for (let i = 0; i + w <= clen; i++) {
          const d = this._jamoDistance(compact.slice(i, i + w), cand);
          if (d >= 1 && d <= maxDist && (!candBest || d < candBest.dist)) {
            candBest = { to: cand, dist: d, start: map[i], end: map[i + w - 1] + 1 };
          }
        }
      }
      if (candBest) matches.push(candBest);
    }
    if (!matches.length) return null;
    // 거리 오름 → 더 긴(구체적인) 후보 우선 → 앞선 위치
    matches.sort((a, b) => a.dist - b.dist || b.to.length - a.to.length || a.start - b.start);
    const top = matches[0];
    // 모호성: 같은 거리 + 같은 길이의 다른 후보가 있을 때만 보정 보류
    if (matches.some(m => m.to !== top.to && m.dist === top.dist && m.to.length === top.to.length)) return null;
    return top;
  }

  _regionFuzzyCandidates() {
    if (!this._regionCands) {
      this._regionCands = [...new Set([
        ...this.districts.map(d => d.name),
        ...Object.keys(this.legalDongAliases).filter(k => /(동|구)$/.test(k)),
        ...this.districts.map(d => d.sgg).filter(Boolean),
      ])].filter(n => n && n.length >= 2);
    }
    return this._regionCands;
  }

  /**
   * 오타 보정: 지역(번호동 포함)·업종·지표가 인식 실패했을 때만 가장 가까운 정답으로 보정.
   * @returns {{correctedText: string|null, corrections: Array<{type,from,to}>}}
   */
  _detectTypoCorrections(text, districtResult, industryResult, questionTypeResult) {
    const corrections = [];
    let t = String(text || '');

    // 1) 번호동 한글 표기 보정 ("둔산이동"→"둔산2동") — 실재 행정동이 될 때만이라 항상 안전
    const numMap = { 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 칠: '7', 팔: '8', 구: '9' };
    t = t.replace(/([가-힣]{2,})(일|이|삼|사|오|육|칠|팔|구)동/g, (m, pre, num) => {
      const canon = pre + numMap[num] + '동';
      if (this.districts.some(d => d.name === canon)) {
        corrections.push({ type: 'region', from: m, to: canon });
        return canon;
      }
      return m;
    });
    const regionFixed = corrections.some(c => c.type === 'region');

    // 자모 fuzzy 지역 보정은 '지역 신호가 전혀 없을 때만' (sgg도 없어야 — 구 단위 질의 오염 방지)
    const regionUnresolved = !districtResult.district && !districtResult.sgg
      && (districtResult.candidates?.length || 0) === 0
      && !['rankDistricts', 'sggIndustry'].includes(questionTypeResult.questionType);

    // 2) 자모거리 fuzzy — 실패한 부분만, 한 종류당 1건
    const ranges = [];
    const { compact, map } = this._compactMap(t);
    const addRange = (best, type) => {
      if (!best) return;
      if (ranges.some(r => best.start < r.end && best.end > r.start)) return; // 겹침 방지
      const from = t.slice(best.start, best.end);
      if (!from || from === best.to) return;
      ranges.push({ start: best.start, end: best.end, to: best.to });
      corrections.push({ type, from, to: best.to });
    };

    if (regionUnresolved && !regionFixed) {
      addRange(this._fuzzyFindBest(compact, map, this._regionFuzzyCandidates()), 'region');
    }
    const industryImplied = !industryResult.industry && this._industryIsImplied(questionTypeResult.questionType);
    if (industryImplied) {
      addRange(this._fuzzyFindBest(compact, map, this.industries.filter(n => n.length >= 2)), 'industry');
    }
    if (questionTypeResult.usedDefault) {
      addRange(this._fuzzyFindBest(compact, map, ['매출', '업소', '점포', '유동인구', '추세', '밀도', '순위', '현황', '종합', '비교']), 'metric');
    }

    // 범위를 오른쪽부터 적용 (인덱스 보존)
    ranges.sort((a, b) => b.start - a.start);
    for (const r of ranges) t = t.slice(0, r.start) + r.to + t.slice(r.end);

    return { correctedText: corrections.length ? t : null, corrections };
  }

  _escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _findIndustryRawToken(text, industry) {
    const industryKey = this._compact(industry);
    if (!industryKey) return null;
    const tokens = String(text || '')
      .split(/[^0-9A-Za-z가-힣/·]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    const suffixNoise = /(매출|추세|현황|업소수|업소|유동인구|사람|비교|어때|알려줘|보여줘|흐름|전망)+$/;
    for (const token of tokens) {
      const cleaned = token.replace(suffixNoise, '');
      const compactToken = this._compact(cleaned);
      if (!compactToken || !compactToken.includes(industryKey)) continue;
      if (compactToken === industryKey) return industry;
      const districtPrefix = this.districts.some((district) => compactToken === `${this._compact(district.name)}${industryKey}`);
      if (districtPrefix) return industry;
      return cleaned || token;
    }
    return industry;
  }
  _normalizeAmbiguousTerms(source) {
    const items = source?.items || source || {};
    const normalized = {};
    Object.entries(items).forEach(([term, candidates]) => {
      if (Array.isArray(candidates) && candidates.length > 0) {
        normalized[this._compact(term)] = candidates.map(c => String(c).trim()).filter(Boolean);
      }
    });
    return normalized;
  }

  _normalizeBrands(source) {
    const items = source?.items || source || {};
    const normalized = {};
    Object.entries(items).forEach(([brand, industry]) => {
      normalized[this._compact(brand)] = String(industry || '').trim();
    });
    return normalized;
  }

  _normalizeLocationAliases(source) {
    const items = source?.items || source || {};
    const normalized = {};
    Object.entries(items).forEach(([alias, config]) => {
      const key = this._compact(alias);
      if (!key) return;
      const candidates = (config?.candidates || []).map(c => String(c).trim()).filter(Boolean);
      if (candidates.length > 0) {
        normalized[key] = { message: config?.message || '', candidates };
      }
    });
    return normalized;
  }

  _extractLocationAlias(compact) {
    const entry = Object.entries(this.locationAliases)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([alias]) => compact.includes(alias));
    if (!entry) return { candidates: [], message: '' };

    const [aliasKey, config] = entry;
    // 위치 별칭의 후보 이름을 실제 district 객체로 매핑
    const matched = [];
    for (const candidateName of config.candidates) {
      const normalName = this._compact(candidateName);
      const found = this.districts.find(d => this._compact(d.name) === normalName);
      if (found) matched.push(found);
    }
    return { candidates: this._uniqueDistricts(matched), message: config.message, alias: aliasKey };
  }

  _longestCommonSubstring(a, b) {
    let best = '';
    for (let i = 0; i < a.length; i += 1) {
      for (let j = i + 2; j <= a.length; j += 1) {
        const part = a.slice(i, j);
        if (part.length > best.length && b.includes(part)) best = part;
      }
    }
    return best;
  }
}

export default IntentParser;
