/**
 * test-suites.js — 테스트 케이스 생성기 + 검증 함수
 *
 * 3단계 프로그레시브 테스트:
 *   Level 1 (Smoke):   37 merge × 3업종 + 13 questionType × 5동 + 82 district resolution ≈ 500
 *   Level 2 (Data):    82동 × 10 인기업종 = 820
 *   Level 3 (Full):    82동 × 247 업종 ≈ 20,254
 *
 * 테스트 데이터는 하드코딩 아님 — DataLoader에서 실제 데이터를 읽어 동적 생성.
 */

// ────────────────────────────────────────
// 메인 진입점
// ────────────────────────────────────────

/**
 * @param {number} level - 1, 2, or 3
 * @param {import('./data-loader.js').DataLoader} dataLoader
 * @returns {Array<TestCase>}
 */
export function generateTestCases(level, dataLoader) {
  const cases = [];

  // Level 1: Smoke
  cases.push(...generateMergeTests(dataLoader));
  cases.push(...generateQuestionTypeTests(dataLoader));
  cases.push(...generateDistrictResolutionTests(dataLoader));
  cases.push(...generateFollowUpChainTests(dataLoader));
  cases.push(...generateRegressionTests(dataLoader));       // 회귀: 과거 수정된 버그 재발 감지
  cases.push(...generateRegionSwitchChainTests(dataLoader)); // 지역전환 꼬리물기: A동→B동 carry
  cases.push(...generateLegalDongCompareTests(dataLoader));  // 법정동(복수 행정동 묶음) 비교

  if (level >= 2) {
    cases.push(...generateDataIntegrityTests(dataLoader));
  }

  if (level >= 3) {
    cases.push(...generateFullMatrixTests(dataLoader));
  }

  return cases;
}


// ────────────────────────────────────────
// Level 1: Suite A — 법정동 Merge 테스트
// ────────────────────────────────────────

function generateMergeTests(dataLoader) {
  const matchingDicts = dataLoader.getMatchingDictionaries();
  const legalDongMap = matchingDicts.legalDongToAdminDong || {};
  const multiMappings = Object.entries(legalDongMap)
    .filter(([, v]) => Array.isArray(v) && v.length >= 2);

  // "동"으로 끝나는 순수 법정동 vs 약어/위치별칭 분리
  // 약어: 키가 모든 타겟 행정동의 공통 접두사 (가양→가양1동,가양2동)
  // 위치별칭: 키가 타겟 행정동과 무관한 이름 (과학단지→전민동,신성동)
  const legalDongs = multiMappings.filter(([k]) => k.endsWith('동'));
  const nonDong = multiMappings.filter(([k]) => !k.endsWith('동'));
  const abbreviations = nonDong.filter(([k, targets]) =>
    targets.every(t => t.startsWith(k))
  );
  const locationAliases = nonDong.filter(([k, targets]) =>
    !targets.every(t => t.startsWith(k))
  );

  const industries = ['치킨', '카페', '편의점'];
  const cases = [];

  // Suite A-1: 순수 법정동 merge (반석동, 둔산동, 가양동 등)
  for (const [legalDong, adminDongs] of legalDongs) {
    for (const industry of industries) {
      cases.push({
        id: `merge-${legalDong}-${industry}`,
        category: 'merge',
        level: 1,
        question: `${legalDong} ${industry} 매출`,
        sourceLocation: legalDong,
        expectedMergeTargets: adminDongs,
        expectedIndustry: industry,
        validators: {
          intent: (intent) => validateMergeIntent(intent, legalDong, adminDongs),
          query: () => [],
          response: (resp) => validateMergeResponse(resp, legalDong),
          followUp: (resp, intent) => validateFollowUpNoInternalLabels(resp, legalDong, adminDongs, intent),
        },
      });
    }
  }

  // Suite A-2: 약어 merge (가양, 갈마, 관저 등 — "X동" 없이 입력)
  for (const [abbr, adminDongs] of abbreviations) {
    for (const industry of industries) {
      cases.push({
        id: `abbr-${abbr}-${industry}`,
        category: 'abbreviation',
        level: 1,
        question: `${abbr} ${industry} 매출`,
        sourceLocation: abbr,
        expectedMergeTargets: adminDongs,
        expectedIndustry: industry,
        validators: {
          intent: (intent) => validateAbbreviationIntent(intent, abbr, adminDongs),
          query: () => [],
          response: (resp) => validateNoCrash(resp),
          followUp: (resp) => validateFollowUpQuality(resp),
        },
      });
    }
  }

  // Suite A-3: 위치별칭 merge (과학단지, 성심당, 으능정이 등)
  for (const [alias, adminDongs] of locationAliases) {
    for (const industry of industries) {
      cases.push({
        id: `locAlias-${alias}-${industry}`,
        category: 'locationAlias',
        level: 1,
        question: `${alias} ${industry} 매출`,
        sourceLocation: alias,
        expectedMergeTargets: adminDongs,
        expectedIndustry: industry,
        validators: {
          intent: (intent) => validateLocationAliasIntent(intent, alias, adminDongs),
          query: () => [],
          response: (resp) => validateMergeResponse(resp, alias),
          followUp: (resp, intent) => validateFollowUpNoInternalLabels(resp, alias, adminDongs, intent),
        },
      });
    }
  }

  return cases;
}


// ────────────────────────────────────────
// Level 1: Suite B — 13 QuestionType 커버리지
// ────────────────────────────────────────

function generateQuestionTypeTests(dataLoader) {
  const districts = dataLoader.getDistrictList();
  // 5개 구에서 대표 동 1개씩 선택
  const sampleDistricts = pickRepresentativeDistricts(districts, 5);
  const cases = [];

  const templates = [
    { type: 'sales',    gen: (d, i) => `${d} ${i} 매출` },
    { type: 'upso',     gen: (d, i) => `${d} ${i} 업소 수` },
    { type: 'pop',      gen: (d, i) => `${d} ${i} 유동인구` },
    { type: 'trend',    gen: (d, i) => `${d} ${i} 추세` },
    { type: 'similar',  gen: (d, i) => `${d} ${i} 비슷한 상권` },
    { type: 'density',  gen: (d, i) => `${d} ${i} 업소 유동인구` },
    { type: 'overview', gen: (d)    => `${d} 어때` },
    { type: 'dataStatus', gen: (d, i) => `${d} ${i} 데이터` },
  ];

  for (const { type, gen } of templates) {
    for (const dist of sampleDistricts) {
      const industry = '카페';
      const question = gen(dist.name, industry);
      cases.push({
        id: `qtype-${type}-${dist.name}`,
        category: 'questionType',
        level: 1,
        question,
        districtCode: dist.code,
        districtName: dist.name,
        expectedQuestionType: type,
        expectedIndustry: type === 'overview' ? '' : industry,
        validators: {
          intent: (intent) => validateQuestionType(intent, type),
          query: (record) => [],
          response: (resp) => validateResponseStructure(resp),
          followUp: (resp) => validateFollowUpQuality(resp),
        },
      });
    }
  }

  // SGG-level question types (rankDistricts, sggIndustry)
  const sggs = [...new Set(districts.map(d => d.sgg))].filter(Boolean).slice(0, 3);
  for (const sgg of sggs) {
    cases.push({
      id: `qtype-rankDistricts-${sgg}`,
      category: 'questionType',
      level: 1,
      question: `${sgg} 카페 매출 높은 동네`,
      expectedQuestionType: 'rankDistricts',
      sgg,
      expectedIndustry: '카페',
      validators: {
        intent: (intent) => {
          const errors = [];
          if (!intent.sgg) errors.push({ phase: 'intent', message: `SGG not resolved for ${sgg}` });
          return errors;
        },
        query: () => [],
        response: (resp) => validateResponseStructure(resp),
        followUp: (resp) => validateFollowUpQuality(resp),
      },
    });

    cases.push({
      id: `qtype-sggIndustry-${sgg}`,
      category: 'questionType',
      level: 1,
      question: `${sgg} 카페 추세`,
      expectedQuestionType: 'sggIndustry',
      sgg,
      expectedIndustry: '카페',
      validators: {
        intent: (intent) => {
          const errors = [];
          if (!intent.sgg) errors.push({ phase: 'intent', message: `SGG not resolved for ${sgg}` });
          return errors;
        },
        query: () => [],
        response: (resp) => validateResponseStructure(resp),
        followUp: (resp) => validateFollowUpQuality(resp),
      },
    });
  }

  return cases;
}


// ────────────────────────────────────────
// Level 1: Suite C — 82개 행정동 이름 해석
// ────────────────────────────────────────

function generateDistrictResolutionTests(dataLoader) {
  const districts = dataLoader.getDistrictList();
  return districts.map(dist => ({
    id: `resolve-${dist.code}`,
    category: 'districtResolution',
    level: 1,
    question: `${dist.name} 어때`,
    districtCode: dist.code,
    districtName: dist.name,
    expectedQuestionType: 'overview',
    validators: {
      intent: (intent) => validateDistrictResolution(intent, dist),
      query: () => [],
      response: (resp) => validateResponseStructure(resp),
      followUp: (resp) => validateFollowUpQuality(resp),
    },
  }));
}


// ────────────────────────────────────────
// Level 1: Suite D — Follow-up 체인 테스트
// ────────────────────────────────────────

function generateFollowUpChainTests(dataLoader) {
  const districts = dataLoader.getDistrictList();
  const reps = pickRepresentativeDistricts(districts, 5);

  // 1차 질문 패턴: 다양한 questionType을 커버
  const patterns = [
    { suffix: '카페 매출', type: 'sales', industry: '카페' },
    { suffix: '편의점 업소 수', type: 'upso', industry: '편의점' },
    { suffix: '치킨 추세', type: 'trend', industry: '치킨' },
    { suffix: '어때', type: 'overview', industry: null },
    { suffix: '미용실 유동인구', type: 'pop', industry: '미용실' },
  ];

  const cases = [];

  for (const dist of reps) {
    for (const p of patterns) {
      cases.push({
        id: `chain-${dist.code}-${compact(p.suffix)}`,
        category: 'followUpChain',
        level: 1,
        question: `${dist.name} ${p.suffix}`,
        districtCode: dist.code,
        districtName: dist.name,
        expectedQuestionType: p.type,
        expectedIndustry: p.industry,
        chainTest: true,  // test-runner가 Phase 5 체인 실행
        validators: {
          intent: (intent) => validateBasicIntent(intent),
          query: () => [],
          response: (resp) => validateResponseStructure(resp),
          followUp: (resp) => validateFollowUpQuality(resp),
        },
      });
    }
  }

  // merge 케이스도 추가 (법정동 + 위치별칭)
  const matchingDicts = dataLoader.getMatchingDictionaries();
  const legalDongMap = matchingDicts.legalDongToAdminDong || {};
  const mergeKeys = Object.entries(legalDongMap)
    .filter(([, v]) => Array.isArray(v) && v.length >= 2)
    .slice(0, 3);  // 대표 3개만

  for (const [key] of mergeKeys) {
    cases.push({
      id: `chain-merge-${compact(key)}`,
      category: 'followUpChain',
      level: 1,
      question: `${key} 카페 매출`,
      expectedIndustry: '카페',
      chainTest: true,
      validators: {
        intent: (intent) => validateBasicIntent(intent),
        query: () => [],
        response: (resp) => validateNoCrash(resp),
        followUp: (resp) => validateNoInternalLabels(resp),
      },
    });
  }

  return cases;
}


// ────────────────────────────────────────
// Level 2: 82동 × 10 인기업종
// ────────────────────────────────────────

function generateDataIntegrityTests(dataLoader) {
  const districts = dataLoader.getDistrictList();
  const topIndustries = [
    '카페', '편의점', '치킨', '미용실', '약국',
    '기타 한식 음식점', '김밥/만두/분식', '부동산 중개/대리업',
    '돼지고기 구이/찜', '세탁소',
  ];
  const cases = [];

  for (const dist of districts) {
    for (const industry of topIndustries) {
      cases.push({
        id: `data-${dist.code}-${compact(industry)}`,
        category: 'dataIntegrity',
        level: 2,
        question: `${dist.name} ${industry} 매출`,
        districtCode: dist.code,
        districtName: dist.name,
        expectedIndustry: industry,
        validators: {
          intent: (intent) => validateDistrictResolution(intent, dist),
          query: (record) => validateRecordStructure(record, dist, industry),
          response: (resp) => validateResponseStructure(resp),
          followUp: (resp, intent) => validateFollowUpQuality(resp, intent),
        },
      });
    }
  }
  return cases;
}


// ────────────────────────────────────────
// Level 3: 82동 × 전체 247 업종
// ────────────────────────────────────────

function generateFullMatrixTests(dataLoader) {
  const districts = dataLoader.getDistrictList();
  const industries = dataLoader.getIndustryList();
  const cases = [];

  for (const dist of districts) {
    for (const industry of industries) {
      cases.push({
        id: `full-${dist.code}-${compact(industry)}`,
        category: 'fullMatrix',
        level: 3,
        question: `${dist.name} ${industry} 매출`,
        districtCode: dist.code,
        districtName: dist.name,
        expectedIndustry: industry,
        validators: {
          intent: (intent) => validateBasicIntent(intent),
          query: () => [],  // null 허용 (업종 미존재)
          response: (resp) => validateNoCrash(resp),
          followUp: (resp) => validateNoInternalLabels(resp),
        },
      });
    }
  }
  return cases;
}


// ────────────────────────────────────────
// 회귀(Regression) — 과거 수정된 버그가 재발하는지 단언
//   각 케이스는 directTest(ctx)로 production 컴포넌트를 직접 검사.
//   ctx = { dispatcher, intentParser, queryEngine, responseBuilder, dataLoader, build, month }
// ────────────────────────────────────────

function generateRegressionTests(dataLoader) {
  const districts = dataLoader.getDistrictList();
  const has = (n) => dataLoader.getIndustryList().includes(n);
  const cases = [];

  // QA-F4: 정확 업종명은 별칭으로 재매핑되면 안 됨 (약국→일반병원 오매칭)
  cases.push({
    id: 'reg-F4-exact-industry-no-realias', category: 'regression', level: 1,
    question: '유성구 약국 1위 동네',
    directTest: async (ctx) => {
      const errors = [];
      for (const ind of ['약국', '카페', '치킨', '편의점', '미용실']) {
        if (!has(ind)) continue;
        const r = ctx.dispatcher._resolveIndustry(ind);
        if (r !== ind) errors.push({ phase: 'regression', message: `정확 업종 재매핑(QA-F4 재발): _resolveIndustry("${ind}")="${r}"` });
      }
      const sgg = districts[0]?.sgg || '유성구';
      const tr = await ctx.dispatcher.dispatch({ name: 'rankDistrictsByIndustry', args: { sgg, industry: '약국', metric: 'sales' } });
      const got = tr?.geminiSummary?.industry || tr?.intent?.industry;
      if (got && got !== '약국') errors.push({ phase: 'regression', message: `rank 약국 결과 업종="${got}"(약국 아님)` });
      return errors;
    },
  });

  // (QA-F3 피크 요일/시간대 오라벨은 buildLocalNarrative(main.js 비공개)라 UI에서 검증 — 자동 제외)

  // QA-F5: '약국은?'/'한의원은?' 같이 raw가 업종+조사면 '별도 분류가 없어 해석' 안내 금지
  cases.push({
    id: 'reg-F5-josa-rawtoken-note', category: 'regression', level: 1,
    question: '둔산1동 한의원은',
    directTest: async (ctx) => {
      const errors = [];
      const d = districts.find(x => x.name === '둔산1동') || districts[0];
      for (const raw of ['약국은', '한의원은']) {
        const it = ctx.intentParser.parse(`${d.name} ${raw}`);
        if (!it.industry) continue;
        const tr = await ctx.dispatcher.dispatch({ name: 'analyzeDistrictIndustry', args: { district: d.name, industry: it.industry, metric: 'sales' } });
        const resp = ctx.build({ ...tr, intent: { ...tr.intent, industryRaw: it.industryRaw, industryMatchType: it.industryMatchType } });
        const note = resp?.note || '';
        if (/별도 분류가 없어/.test(note) && note.includes(raw)) errors.push({ phase: 'regression', message: `QA-F5 재발: '${raw}' 조사토큰 해석 안내 노출 — "${note.slice(0, 40)}"` });
      }
      return errors;
    },
  });

  // R4(#4/#45): overview 영업 업종 수가 전체 카탈로그(247)면 안 됨
  cases.push({
    id: 'reg-R4-operating-industries', category: 'regression', level: 1,
    question: '대청동 어때',
    directTest: async (ctx) => {
      const errors = [];
      const total = ctx.dataLoader.getIndustryList().length;
      for (const name of ['대청동', '기성동', '산내동']) {
        const d = districts.find(x => x.name === name); if (!d) continue;
        const tr = await ctx.dispatcher.dispatch({ name: 'getDistrictOverview', args: { district: name } });
        const resp = ctx.build(tr);
        const cell = (resp?.statsCard?.cells || []).find(c => /업종\s*수/.test(c.label));
        const v = Number(String(cell?.value || '').replace(/[,\s]/g, ''));
        if (Number.isFinite(v) && v >= total) errors.push({ phase: 'regression', message: `#4 재발: ${name} 업종 수=${v}(전체 카탈로그 ${total}와 동일)` });
      }
      return errors;
    },
  });

  // #5: 정형외과가 성형외과로 오매칭되면 안 됨
  cases.push({
    id: 'reg-5-jeonghyeong-no-seonghyeong', category: 'regression', level: 1,
    question: '중앙동 정형외과 매출',
    directTest: async (ctx) => {
      const errors = [];
      const it = ctx.intentParser.parse('중앙동 정형외과 매출');
      if (it.industry === '성형외과 의원') errors.push({ phase: 'regression', message: `#5 재발: 정형외과→성형외과 의원 오매칭` });
      return errors;
    },
  });

  return cases;
}


// ────────────────────────────────────────
// 지역전환 꼬리물기 — A동→B동→C동 전환 시 업종 carry 유지
//   chainSeq를 conversationState+orchestrator로 순차 실행 (test-runner가 처리)
// ────────────────────────────────────────

function generateRegionSwitchChainTests(dataLoader) {
  const districts = dataLoader.getDistrictList();
  const byName = (n) => districts.find(d => d.name === n);
  const cases = [];

  // 행정동 연속 전환 (업종 carry 유지)
  const adminChains = [
    { seq: ['효동 카페 매출', '용운동은?', '삼성동은?'], industry: '카페' },
    { seq: ['은행선화동 치킨 매출', '문창동은?', '부사동은?'], industry: '치킨' },
    { seq: ['송촌동 편의점 매출', '비래동은?', '오정동은?'], industry: '편의점' },
  ];
  for (const c of adminChains) {
    if (!c.seq.every(q => byName(q.split(' ')[0]) || /은\?$/.test(q))) { /* 첫 동만 확인 */ }
    cases.push({
      id: `regionswitch-admin-${compact(c.seq[0])}`,
      category: 'regionSwitchChain', level: 1,
      regionSwitchTest: true,
      chainSeq: c.seq,
      expectCarryIndustry: c.industry,
    });
  }

  // 법정동 전환 (전환 시 merge + 업종 carry)
  cases.push({
    id: 'regionswitch-legaldong-merge',
    category: 'regionSwitchChain', level: 1,
    regionSwitchTest: true,
    chainSeq: ['중앙동 한식 매출', '관저동은?', '둔산은?'],
    expectCarryIndustry: '기타 한식 음식점',
    expectMergeOnSwitch: true,
  });

  return cases;
}


// ────────────────────────────────────────
// 법정동 비교 — 복수 행정동 묶음(둔산동·반석동 등) 간 비교
//   directTest: 직접 compareDistricts가 양쪽을 merge하는지
//   regionSwitchTest+expectCompare: 다중턴('둔산동 카페'→'반석동과 비교')이 clarify로 빠지지 않는지
// ────────────────────────────────────────

function generateLegalDongCompareTests(dataLoader) {
  const cases = [];
  const legalMap = dataLoader.getMatchingDictionaries().legalDongToAdminDong || {};
  // 행정동 2개 이상으로 매핑되는 '법정동'(별칭/랜드마크 제외 — 동으로 끝나는 canonical만),
  // 같은 행정동 집합은 한 번만 (노은/노은동 별칭 중복 제거)
  const seenSet = new Set();
  const multi = [];
  for (const [k, v] of Object.entries(legalMap)) {
    if (!(Array.isArray(v) && v.length >= 2)) continue;
    if (!/동$/.test(k)) continue;                 // '노은','갈마' 같은 별칭 표기 스킵
    const sig = [...v].sort().join('|');
    if (seenSet.has(sig)) continue;               // 동일 행정동 집합 중복 스킵
    seenSet.add(sig);
    multi.push(k);
  }
  if (multi.length < 2) return cases;

  // 둔산동/반석동을 앞으로(대표 회귀 케이스), 나머지는 데이터 순서 유지
  multi.sort((a, b) => (b === '둔산동' || b === '반석동' ? 1 : 0) - (a === '둔산동' || a === '반석동' ? 1 : 0));

  // 인접 쌍으로 다수 꼬리물기 케이스 생성 (다른 동들도 골고루 커버), 최대 8쌍
  const pairs = [];
  for (let i = 0; i + 1 < multi.length && pairs.length < 8; i += 2) pairs.push([multi[i], multi[i + 1]]);
  const metrics = ['카페', '치킨', '편의점', '미용실'];

  pairs.forEach(([legalA, legalB], idx) => {
    const ind = metrics[idx % metrics.length];
    // 정방향 꼬리물기: 'A 업종 매출' → 'B과 비교해줘'
    cases.push({
      id: `legalcompare-chain-${compact(legalA)}-${compact(legalB)}`,
      category: 'legalDongCompare', level: 1,
      regionSwitchTest: true,
      chainSeq: [`${legalA} ${ind} 매출`, `${legalB}과 비교해줘`],
      expectCompare: true,
      expectCompareDistricts: [legalA, legalB],
    });
  });

  // 첫 쌍은 직접 비교 + 역방향 꼬리물기도 추가 (양방향·직접경로 동시 가드)
  const [a0, b0] = pairs[0];
  cases.push({
    id: `legalcompare-direct-${compact(a0)}-${compact(b0)}`,
    category: 'legalDongCompare', level: 1,
    question: `${a0} ${b0} 카페 비교`,
    directTest: async (ctx) => {
      const errors = [];
      const tr = await ctx.dispatcher.dispatch({ name: 'compareDistricts', args: { district1: a0, district2: b0, industry: '카페', metric: 'sales' } });
      if (tr.error) { errors.push({ phase: 'regression', message: `법정동 비교 에러(${a0} vs ${b0}): ${tr.error}` }); return errors; }
      const c1 = tr.intent?.district?.codes?.length || 0;
      const c2 = tr.intent?.compareTarget?.codes?.length || 0;
      const e1 = (legalMap[a0] || []).length;
      const e2 = (legalMap[b0] || []).length;
      if (c1 < e1) errors.push({ phase: 'regression', message: `${a0}(법정동)이 merge 안 됨 (codes=${c1}, 기대 ${e1})` });
      if (c2 < e2) errors.push({ phase: 'regression', message: `${b0}(법정동)이 merge 안 됨 (codes=${c2}, 기대 ${e2})` });
      return errors;
    },
  });
  cases.push({
    id: `legalcompare-chain-rev-${compact(b0)}-${compact(a0)}`,
    category: 'legalDongCompare', level: 1,
    regionSwitchTest: true,
    chainSeq: [`${b0} 카페 매출`, `${a0}과 비교해줘`],
    expectCompare: true,
    expectCompareDistricts: [b0, a0],
  });

  // 법정동 vs 행정동(단일) 혼합 꼬리물기
  const adminD = dataLoader.getDistrictList().find(d => !(legalMap[d.name]));
  if (adminD) {
    cases.push({
      id: `legalcompare-chain-mixed-${compact(a0)}`,
      category: 'legalDongCompare', level: 1,
      regionSwitchTest: true,
      chainSeq: [`${a0} 치킨 매출`, `${adminD.name}과 비교해줘`],
      expectCompare: true,
    });
  }

  return cases;
}


// ────────────────────────────────────────
// 누출/조사 디텍터 (전 케이스 공통 적용)
// ────────────────────────────────────────

function scanLeaks(obj) {
  const s = JSON.stringify(obj || {});
  const m = s.match(/NaN|Infinity|undefined|\[object Object\]/);
  return m ? m[0] : null;
}
function scanJosa(obj) {
  const s = JSON.stringify(obj || {});
  // 모음 종결 명사 + 은/과(오류), 자음 종결 명사 + 와(오류), 이/가 오류 — 정확한 표현은 제외.
  // 주의: 노래방(ㅇ)·네일(ㄹ)·효율(ㄹ)은 받침 있어 '은'이 정답이므로 제외, '업소 수'(수=모음)는 '와'가 정답이라 제외.
  const m = s.match(/(카페|피자|호프|헤어|유동인구|밀도)은[\s,."\\]/)
        || s.match(/(카페|피자|호프|헤어)과[\s,.]/)
        || s.match(/(치킨|편의점)와[\s,.]/)
        || s.match(/유동인구이[\s,.]/) || s.match(/업소\s*수은[\s,.]/);
  return m ? m[0].trim() : null;
}
function validateNoLeaksAndJosa(response) {
  const errors = [];
  const leak = scanLeaks(response);
  if (leak) errors.push({ phase: 'response', message: `값 누출: ${leak}` });
  const josa = scanJosa(response);
  if (josa) errors.push({ phase: 'response', message: `조사 오류: "${josa}"` });
  return errors;
}


// ────────────────────────────────────────
// Intent 검증 함수
// ────────────────────────────────────────

function validateMergeIntent(intent, legalDong, expectedAdminDongs) {
  const errors = [];

  // 법정동 별칭 인식 체크
  if (!intent.usedLegalDongAlias && !intent.usedLocationAlias) {
    // 인식 안 되면 districtCandidates에 해당 행정동들이라도 있어야 함
    const candidateNames = (intent.districtCandidates || []).map(d => d.name);
    const hasCandidates = expectedAdminDongs.some(n => candidateNames.includes(n));
    if (!hasCandidates && intent.questionType !== 'merge') {
      errors.push({
        phase: 'intent',
        message: `"${legalDong}"이 법정동 별칭/merge로 인식되지 않음 (questionType=${intent.questionType})`,
      });
    }
  }

  // districtCandidates 혹은 mergeDistricts에 기대 행정동이 포함되어야
  if (intent.districtCandidates?.length >= 2) {
    const names = intent.districtCandidates.map(d => d.name);
    for (const expected of expectedAdminDongs) {
      if (!names.includes(expected)) {
        errors.push({
          phase: 'intent',
          message: `districtCandidates에 "${expected}" 누락 (있는 것: ${names.join(', ')})`,
        });
      }
    }
  }

  return errors;
}

function validateAbbreviationIntent(intent, abbr, expectedAdminDongs) {
  const errors = [];
  // 약어(가양, 갈마 등)는 disambiguation 또는 merge 중 하나가 기대됨
  if (intent.districtCandidates?.length >= 2) {
    // OK: disambiguation으로 처리됨
    return errors;
  }
  if (intent.questionType === 'merge' && intent.mergeDistricts?.length >= 2) {
    // OK: merge로 처리됨
    return errors;
  }
  if (intent.district) {
    // OK: 하나의 동으로 해석됨 (약어가 하나만 매칭)
    return errors;
  }
  errors.push({
    phase: 'intent',
    message: `약어 "${abbr}"가 해석되지 않음 (candidates=${intent.districtCandidates?.length || 0}, qType=${intent.questionType})`,
  });
  return errors;
}

function validateLocationAliasIntent(intent, alias, expectedAdminDongs) {
  const errors = [];
  // 위치별칭(과학단지, 성심당 등)은 locationAlias 인식 + merge/disambiguation 기대
  if (!intent.usedLocationAlias && !intent.usedLegalDongAlias) {
    if (!intent.districtCandidates?.length) {
      errors.push({
        phase: 'intent',
        message: `위치별칭 "${alias}"가 인식되지 않음`,
      });
    }
  }
  return errors;
}

function validateQuestionType(intent, expectedType) {
  const errors = [];
  // overview와 sales는 키워드 유사성으로 혼동 가능 — 허용 범위 설정
  const acceptable = {
    overview: ['overview', 'sales'],
    density: ['density', 'pop', 'upso'],
    dataStatus: ['dataStatus', 'overview'],
  };
  const allowed = acceptable[expectedType] || [expectedType];
  if (!allowed.includes(intent.questionType)) {
    errors.push({
      phase: 'intent',
      message: `questionType 불일치: 기대 ${expectedType}, 실제 ${intent.questionType}`,
    });
  }
  return errors;
}

function validateDistrictResolution(intent, expectedDistrict) {
  const errors = [];
  if (!intent.district) {
    // districtCandidates에라도 있으면 OK (약어 모호성)
    if (!intent.districtCandidates?.length && !intent.sgg) {
      errors.push({
        phase: 'intent',
        message: `행정동 해석 실패: "${expectedDistrict.name}" (code=${expectedDistrict.code})`,
      });
    }
    return errors;
  }
  if (intent.district.code !== expectedDistrict.code) {
    errors.push({
      phase: 'intent',
      message: `기대 code ${expectedDistrict.code} (${expectedDistrict.name}), 실제 ${intent.district.code} (${intent.district.name})`,
    });
  }
  return errors;
}

function validateBasicIntent(intent) {
  const errors = [];
  if (!intent) {
    errors.push({ phase: 'intent', message: 'intent가 null' });
  }
  return errors;
}


// ────────────────────────────────────────
// Query 검증 함수
// ────────────────────────────────────────

function validateRecordStructure(record, district, industry) {
  const errors = [];
  if (!record) {
    // null은 허용 — 해당 동에 해당 업종이 없을 수 있음 (info level)
    return errors;
  }
  // amt: number | null (NaN이면 안 됨)
  if (record.amt !== null && record.amt !== undefined && !Number.isFinite(record.amt)) {
    errors.push({ phase: 'query', message: `amt가 ${record.amt} (number 또는 null이어야 함)` });
  }
  // upso: number | null
  if (record.upso !== null && record.upso !== undefined && !Number.isFinite(record.upso)) {
    errors.push({ phase: 'query', message: `upso가 ${record.upso} (number 또는 null이어야 함)` });
  }
  return errors;
}


// ────────────────────────────────────────
// Response 검증 함수
// ────────────────────────────────────────

function validateResponseStructure(response) {
  const errors = [];
  if (!response) {
    errors.push({ phase: 'response', message: 'response가 null' });
    return errors;
  }
  if (!response.summary?.text && response.summary?.text !== '') {
    errors.push({ phase: 'response', message: 'summary.text 누락' });
  }
  if (!response.header) {
    errors.push({ phase: 'response', message: 'header 누락' });
  }
  if (response.followUps === undefined) {
    errors.push({ phase: 'response', message: 'followUps 필드 누락' });
  }
  errors.push(...validateNoLeaksAndJosa(response));
  return errors;
}

function validateMergeResponse(response, sourceLocation) {
  const errors = validateResponseStructure(response);
  if (!response) return errors;

  // merge 응답의 header.district에 sourceLocation이 반영되어야
  if (sourceLocation && response.header?.district) {
    const headerDist = response.header.district;
    if (!headerDist.includes(sourceLocation)) {
      errors.push({
        phase: 'response',
        message: `header.district에 sourceLocation "${sourceLocation}" 미반영 (실제: "${headerDist}")`,
      });
    }
  }
  return errors;
}

function validateNoCrash(response) {
  const errors = [];
  if (!response) {
    errors.push({ phase: 'response', message: 'response가 null (크래시 가능성)' });
    return errors;
  }
  errors.push(...validateNoLeaksAndJosa(response));
  return errors;
}


// ────────────────────────────────────────
// Follow-up 검증 함수
// ────────────────────────────────────────

function validateFollowUpNoInternalLabels(response, sourceLocation, adminDongs, intent) {
  const errors = [];
  const texts = extractFollowUpTexts(response);

  // 내부 merge 라벨 "노은2동 + 노은3동" 같은 것이 노출되면 안 됨
  // 여러 순서 조합 체크
  for (let i = 0; i < adminDongs.length; i++) {
    for (let j = 0; j < adminDongs.length; j++) {
      if (i === j) continue;
      const label = `${adminDongs[i]} + ${adminDongs[j]}`;
      for (const text of texts) {
        if (text.includes(label)) {
          errors.push({
            phase: 'followUp',
            message: `내부 merge 라벨 노출: "${label}" in "${text}" (기대: "${sourceLocation}")`,
          });
        }
      }
    }
  }

  // 개별 행정동 이름이 sourceLocation 없이 단독으로 노출되면 경고
  if (sourceLocation) {
    for (const text of texts) {
      // sourceLocation이 이미 텍스트에 있으면 OK
      if (text.includes(sourceLocation)) continue;
      for (const dong of adminDongs) {
        if (text.includes(dong)) {
          errors.push({
            phase: 'followUp',
            message: `행정동 "${dong}" 단독 노출 (sourceLocation "${sourceLocation}" 미사용): "${text}"`,
          });
        }
      }
    }
  }

  return errors;
}

function validateFollowUpQuality(response, intent) {
  const errors = [];
  const texts = extractFollowUpTexts(response);
  const seen = new Set();

  for (const text of texts) {
    // 중복 체크
    const normalized = text.replace(/\s+/g, '');
    if (seen.has(normalized)) {
      errors.push({ phase: 'followUp', message: `중복 follow-up: "${text}"` });
    }
    seen.add(normalized);

    // 너무 짧은 followUp
    if (text.trim().length < 3) {
      errors.push({ phase: 'followUp', message: `빈/극소 follow-up: "${text}"` });
    }
  }

  return errors;
}

function validateNoInternalLabels(response) {
  const errors = [];
  const texts = extractFollowUpTexts(response);

  // 범용: "X동 + Y동" 형태의 내부 라벨 패턴 감지
  const mergePattern = /[가-힣]+\d*동\s*\+\s*[가-힣]+\d*동/;
  for (const text of texts) {
    if (mergePattern.test(text)) {
      errors.push({
        phase: 'followUp',
        message: `내부 merge 라벨 패턴 감지: "${text}"`,
      });
    }
  }

  return errors;
}


// ────────────────────────────────────────
// 유틸리티
// ────────────────────────────────────────

/**
 * response.followUps에서 텍스트 배열 추출.
 * followUps 구조: string[] | {text}[] | {groups: [{chips: [{text}]}]}
 */
export function extractFollowUpTexts(response) {
  const followUps = response?.followUps;
  if (!followUps) return [];

  if (Array.isArray(followUps)) {
    return followUps.map(f => typeof f === 'string' ? f : f?.text || '').filter(Boolean);
  }
  if (followUps.groups) {
    return followUps.groups
      .flatMap(g => (g.chips || []).map(c => c?.text || ''))
      .filter(Boolean);
  }
  return [];
}

function compact(str) {
  return String(str || '').replace(/[\s\/\-]/g, '');
}

function pickRepresentativeDistricts(districtList, count) {
  const sggs = [...new Set(districtList.map(d => d.sgg))].filter(Boolean);
  const result = [];
  for (const sgg of sggs) {
    if (result.length >= count) break;
    const first = districtList.find(d => d.sgg === sgg);
    if (first) result.push(first);
  }
  // 부족하면 나머지 채움
  for (const d of districtList) {
    if (result.length >= count) break;
    if (!result.some(r => r.code === d.code)) result.push(d);
  }
  return result;
}
