export class DataLoader {
  constructor(basePath = './data/') {
    this.basePath = basePath.endsWith('/') ? basePath : `${basePath}/`;
    this.districtCache = new Map();
    this.storesCache = new Map();
    this.codebook = null;
    this.industryCodeToName = new Map();
    this.industryNameToCode = new Map();
    this.districtCodeToLabel = new Map();
    this.districtLabelToCode = new Map();
    this.districts = [];
    this.industries = [];
    this.industryAliases = {};
    this.industryCategories = new Map();
    this.matchingDictionaries = {
      legalDongToAdminDong: {},
      industryAliasOverrides: {},
      similarIndustryGroups: {},
    };
    this.latestMonth = null;
    this.months = [];
  }

  async init() {
    const [index, industryData, matchingData, codebookData] = await Promise.all([
      this._fetchJson('index.json'),
      this._fetchJson('industries.json'),
      this._fetchOptionalJson('matching-dictionaries.json', {}),
      this._fetchOptionalJson('codebook.json', null),
    ]);

    this.districts = this._normalizeDistricts(index.districts || index.items || []);
    this.months = (index.months || index.availableMonths || []).map(String).sort();
    this.latestMonth = String(index.latestMonth || index.latest || this.months[this.months.length - 1] || '');

    const normalizedIndustries = this._normalizeIndustries(industryData);
    this.matchingDictionaries = this._normalizeMatchingDictionaries(matchingData);
    this.industries = normalizedIndustries.names;
    this.industryAliases = {
      ...normalizedIndustries.aliases,
      ...this.matchingDictionaries.industryAliasOverrides,
    };
    this.industryCategories = normalizedIndustries.categories;
    this._applyCodebook(codebookData);

    // 데이터 불일치 감지 (GeoJSON ↔ districts 교차 검증)
    this._validateConsistency();

    return {
      districts: this.districts,
      industries: this.industries,
      latestMonth: this.latestMonth,
      months: this.months,
    };
  }

  async _validateConsistency() {
    try {
      const geojson = await this._fetchOptionalJson('daejeon-districts.geojson', null);
      if (!geojson?.features) return;
      const geoCodes = new Set(geojson.features.map(f => String(f.properties?.code || '')).filter(Boolean));
      const dataCodes = new Set(this.districts.map(d => d.code));
      const missingGeo = [...dataCodes].filter(c => !geoCodes.has(c));
      const missingData = [...geoCodes].filter(c => !dataCodes.has(c));
      if (missingGeo.length || missingData.length) {
        console.warn('[DataLoader] 데이터 불일치:', {
          'index에만 있는 코드(GeoJSON 누락)': missingGeo,
          'GeoJSON에만 있는 코드(index 누락)': missingData,
        });
      }
    } catch { /* 검증 실패해도 앱은 계속 동작 */ }
  }

  async loadDistrict(code) {
    const key = String(code || '').trim();
    if (!key) return null;
    if (this.districtCache.has(key)) return this.districtCache.get(key);

    const data = await this._fetchJson(`districts/${encodeURIComponent(key)}.json`);
    this.districtCache.set(key, data);
    return data;
  }

  async loadStores(code) {
    const key = String(code || '').trim();
    if (!key) return null;
    if (this.storesCache.has(key)) return this.storesCache.get(key);
    const data = await this._fetchOptionalJson(`micro/stores/${encodeURIComponent(key)}.json`, []);
    this.storesCache.set(key, data);
    return data;
  }

  getDistrictList() {
    return [...this.districts];
  }

  getDistrictByName(name) {
    const target = this._normalizeText(name);
    if (!target) return null;
    return this.districts.find((district) => this._normalizeText(district.name) === target) || null;
  }

  getDistrictsBySgg(sggName) {
    const target = this._normalizeText(sggName);
    if (!target) return [];
    return this.districts.filter((district) => this._normalizeText(district.sgg) === target);
  }

  getIndustryList() {
    return [...this.industries];
  }

  getCodebook() {
    if (!this.codebook) return null;
    return {
      ...this.codebook,
      sgg: [...(this.codebook.sgg || [])],
      districts: [...(this.codebook.districts || [])],
      categories: [...(this.codebook.categories || [])],
      industries: [...(this.codebook.industries || [])],
      industryAliases: [...(this.codebook.industryAliases || [])],
    };
  }

  getDistrictCode(nameOrCode) {
    const raw = String(nameOrCode || '').trim();
    if (!raw) return '';
    if (this.districtCodeToLabel.has(raw)) return raw;
    return this.districtLabelToCode.get(this._normalizeText(raw)) || '';
  }

  getDistrictLabelByCode(code) {
    return this.districtCodeToLabel.get(String(code || '').trim()) || '';
  }

  getIndustryCode(nameOrCode) {
    const raw = String(nameOrCode || '').trim();
    if (!raw) return '';
    if (this.industryCodeToName.has(raw)) return raw;
    const normalized = this._normalizeText(raw);
    const aliasTarget = this.industryAliases[normalized] || this.industryAliases[raw];
    const canonical = aliasTarget || raw;
    return this.industryNameToCode.get(this._normalizeText(canonical)) || '';
  }

  getIndustryNameByCode(code) {
    return this.industryCodeToName.get(String(code || '').trim()) || '';
  }

  resolveIndustryInput(value) {
    const raw = String(value || '').trim();
    return this.getIndustryNameByCode(raw) || raw;
  }

  getIndustryAliases() {
    return { ...this.industryAliases };
  }

  getIndustryCategories() {
    return this.industryCategories || {};
  }

  getMatchingDictionaries() {
    return {
      legalDongToAdminDong: { ...this.matchingDictionaries.legalDongToAdminDong },
      industryAliasOverrides: { ...this.matchingDictionaries.industryAliasOverrides },
      similarIndustryGroups: { ...this.matchingDictionaries.similarIndustryGroups },
      ambiguousIndustryTerms: { ...this.matchingDictionaries.ambiguousIndustryTerms },
      brandToIndustry: { ...this.matchingDictionaries.brandToIndustry },
      locationAliases: { ...this.matchingDictionaries.locationAliases },
    };
  }

  getIndustryCategory(industryName) {
    const normalized = this._normalizeText(industryName);
    return this.industryCategories.get(normalized) || null;
  }

  getLatestMonth() {
    return this.latestMonth;
  }

  async _fetchJson(path) {
    const response = await fetch(`${this.basePath}${path}`, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Failed to load ${path}: ${response.status}`);
    }
    return response.json();
  }

  async _fetchOptionalJson(path, fallback = null) {
    try {
      const response = await fetch(`${this.basePath}${path}`, { cache: 'no-cache' });
      if (!response.ok) return fallback;
      return response.json();
    } catch {
      return fallback;
    }
  }

  _normalizeDistricts(districts) {
    return districts.map((district) => ({
      code: String(district.code || district.admiCode || district.ADMI_CD || district.id || ''),
      name: String(district.name || district.admiName || district.ADMI_NM || ''),
      sgg: String(district.sgg || district.sggName || district.SGG_NM || ''),
      sggCode: String(district.sggCode || district.SGG_CD || ''),
    })).filter((district) => district.code && district.name);
  }

  _normalizeIndustries(data) {
    const source = Array.isArray(data) ? { industries: data } : (data || {});
    const names = [];
    const aliases = {};
    const categories = new Map();

    const addIndustry = (name, category = null) => {
      const cleanName = String(name || '').trim();
      if (!cleanName || names.includes(cleanName)) return;
      names.push(cleanName);
      if (category) categories.set(this._normalizeText(cleanName), String(category).trim());
    };

    (source.industries || source.list || source.items || []).forEach((item) => {
      if (typeof item === 'string') {
        addIndustry(item);
        return;
      }
      const name = item.name || item.industry || item.TPBIZ_CLSCD_NM;
      const category = item.category || item.middleCategory || item.TPBIZ_MCLCD_NM || item.largeCategory || item.TPBIZ_LCLCD_NM;
      addIndustry(name, category);
      (item.aliases || []).forEach((alias) => {
        aliases[this._normalizeText(alias)] = String(name || '').trim();
      });
    });

    Object.entries(source.aliases || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) {
        addIndustry(key);
        value.forEach((alias) => {
          aliases[this._normalizeText(alias)] = key;
        });
      } else {
        aliases[this._normalizeText(key)] = String(value || '').trim();
        addIndustry(value);
      }
    });

    Object.entries(source.categories || {}).forEach(([key, value]) => {
      const cat = typeof value === 'object' && value !== null
        ? (value.mid || value.large || JSON.stringify(value))
        : String(value || '');
      categories.set(this._normalizeText(key), cat.trim());
      addIndustry(key, cat);
    });

    const addDefaultAlias = (alias, target) => {
      if (!names.includes(target)) return;
      aliases[this._normalizeText(alias)] = target;
    };
    addDefaultAlias('한식', '기타 한식 음식점');
    addDefaultAlias('한식집', '기타 한식 음식점');
    addDefaultAlias('일식', '기타 일식 음식점');
    addDefaultAlias('일식집', '기타 일식 음식점');
    addDefaultAlias('중식', '중국집');
    addDefaultAlias('중식당', '중국집');
    addDefaultAlias('중국음식', '중국집');
    addDefaultAlias('양식', '기타 서양식 음식점');
    addDefaultAlias('양식집', '기타 서양식 음식점');
    addDefaultAlias('고깃집', '돼지고기 구이/찜');
    addDefaultAlias('고기집', '돼지고기 구이/찜');
    addDefaultAlias('술집', '요리 주점');
    // 모호한 일반 용어 → 대표 업종 매핑
    addDefaultAlias('병원', '일반병원');
    addDefaultAlias('의원', '기타 의원');
    addDefaultAlias('학원', '입시·교과학원');
    addDefaultAlias('약국', '약국');
    addDefaultAlias('마트', '슈퍼마켓');
    addDefaultAlias('슈퍼', '슈퍼마켓');
    addDefaultAlias('빵집', '빵/도넛');
    addDefaultAlias('커피', '카페');
    addDefaultAlias('커피숍', '카페');
    addDefaultAlias('노래방', '노래방');
    addDefaultAlias('헬스', '헬스장');
    addDefaultAlias('세탁', '세탁소');
    addDefaultAlias('부동산', '부동산 중개/대리업');
    addDefaultAlias('이발소', '미용실');
    addDefaultAlias('미장원', '미용실');
    // 의료 전문과목 (데이터셋 전용 분류가 있는 것만 정확 매핑)
    addDefaultAlias('안과', '안과 의원');
    addDefaultAlias('피부과', '피부/비뇨기과 의원');
    addDefaultAlias('비뇨기과', '피부/비뇨기과 의원');
    addDefaultAlias('이비인후과', '이비인후과 의원');
    addDefaultAlias('산부인과', '산부인과 의원');
    addDefaultAlias('소아과', '내과/소아과 의원');
    addDefaultAlias('내과', '내과/소아과 의원');
    addDefaultAlias('정신과', '신경/정신과 의원');
    addDefaultAlias('신경과', '신경/정신과 의원');
    addDefaultAlias('정신건강의학과', '신경/정신과 의원');
    addDefaultAlias('치과', '치과의원');
    addDefaultAlias('성형외과', '성형외과 의원');
    addDefaultAlias('한방', '한방병원');
    addDefaultAlias('요양원', '요양병원');
    addDefaultAlias('요양병원', '요양병원');
    // 전용 분류가 없는 전문과 → 일반 의원으로 안내 (정형외과→성형외과 오매칭 방지 겸)
    ['정형외과', '신경외과', '흉부외과', '구강외과', '재활의학과', '가정의학과', '영상의학과', '마취통증의학과', '마취과'].forEach((s) => addDefaultAlias(s, '기타 의원'));
    // 음식/주점
    addDefaultAlias('곱창', '곱창 전골/구이');
    addDefaultAlias('막창', '곱창 전골/구이');
    addDefaultAlias('대창', '곱창 전골/구이');
    addDefaultAlias('포장마차', '요리 주점');
    addDefaultAlias('포차', '요리 주점');
    addDefaultAlias('이자카야', '요리 주점');
    addDefaultAlias('와인바', '요리 주점');
    addDefaultAlias('초밥', '일식 회/초밥');
    addDefaultAlias('스시', '일식 회/초밥');
    // 레저/생활
    addDefaultAlias('스크린골프', '골프 연습장');
    addDefaultAlias('코노', '노래방');
    addDefaultAlias('찜질방', '목욕탕/사우나');
    addDefaultAlias('사우나', '목욕탕/사우나');
    addDefaultAlias('필라테스', '요가/필라테스 학원');
    addDefaultAlias('요가', '요가/필라테스 학원');

    return {
      names: names.sort((a, b) => a.localeCompare(b, 'ko')),
      aliases,
      categories,
    };
  }

  _applyCodebook(data) {
    this.codebook = data && typeof data === 'object' ? data : null;
    this.industryCodeToName = new Map();
    this.industryNameToCode = new Map();
    this.districtCodeToLabel = new Map();
    this.districtLabelToCode = new Map();

    const districtRows = this.codebook?.districts?.length ? this.codebook.districts : this.districts.map((district) => ({
      code: district.code,
      labelKo: district.name,
      sggCode: district.sggCode,
      sggLabelKo: district.sgg,
    }));
    districtRows.forEach((district) => {
      const code = String(district.code || '').trim();
      const label = String(district.labelKo || district.name || '').trim();
      if (!code || !label) return;
      this.districtCodeToLabel.set(code, label);
      this.districtLabelToCode.set(this._normalizeText(label), code);
    });

    const industryRows = this.codebook?.industries?.length ? this.codebook.industries : [];
    industryRows.forEach((industry) => {
      const code = String(industry.code || '').trim();
      const label = String(industry.labelKo || industry.name || '').trim();
      if (!code || !label) return;
      this.industryCodeToName.set(code, label);
      this.industryNameToCode.set(this._normalizeText(label), code);
    });

    (this.codebook?.industryAliases || []).forEach((alias) => {
      const aliasKo = String(alias.aliasKo || '').trim();
      const industryName = this.getIndustryNameByCode(alias.industryCode);
      if (aliasKo && industryName) this.industryAliases[this._normalizeText(aliasKo)] = industryName;
    });
  }

  _normalizeMatchingDictionaries(data) {
    const source = data || {};
    const legalSource = source.legalDongToAdminDong?.items || source.legalDongToAdminDong || {};
    const aliasSource = source.industryAliasOverrides?.items || source.industryAliasOverrides || {};
    const groupSource = source.similarIndustryGroups?.items || source.similarIndustryGroups || {};

    const legalDongToAdminDong = {};
    Object.entries(legalSource).forEach(([legalDong, adminDongs]) => {
      const key = this._normalizeText(legalDong);
      const values = (Array.isArray(adminDongs) ? adminDongs : [adminDongs])
        .map((value) => String(value || '').trim())
        .filter(Boolean);
      if (key && values.length > 0) legalDongToAdminDong[key] = values;
    });

    const industryAliasOverrides = {};
    const addAlias = (alias, industry) => {
      const key = this._normalizeText(alias);
      const value = String(industry || '').trim();
      if (key && value) industryAliasOverrides[key] = value;
    };

    Object.entries(aliasSource).forEach(([alias, industry]) => {
      addAlias(alias, industry);
    });

    const similarIndustryGroups = {};
    Object.entries(groupSource).forEach(([groupName, group]) => {
      const groupKey = this._normalizeText(groupName);
      if (!groupKey) return;
      const normalizedGroup = typeof group === 'object' && group !== null
        ? {
          primary: String(group.primary || '').trim(),
          industries: (group.industries || []).map((value) => String(value || '').trim()).filter(Boolean),
          aliases: (group.aliases || []).map((value) => String(value || '').trim()).filter(Boolean),
        }
        : {
          primary: String(group || '').trim(),
          industries: [String(group || '').trim()].filter(Boolean),
          aliases: [],
        };
      if (!normalizedGroup.primary && normalizedGroup.industries.length > 0) {
        normalizedGroup.primary = normalizedGroup.industries[0];
      }
      if (!normalizedGroup.primary) return;
      similarIndustryGroups[groupKey] = normalizedGroup;
      addAlias(groupName, normalizedGroup.primary);
      normalizedGroup.aliases.forEach((alias) => addAlias(alias, normalizedGroup.primary));
    });

    // 모호 업종 / 브랜드 / 위치별칭은 IntentParser가 직접 처리 — 그대로 전달
    const ambiguousSource = source.ambiguousIndustryTerms?.items || source.ambiguousIndustryTerms || {};
    const brandSource = source.brandToIndustry?.items || source.brandToIndustry || {};
    const locationSource = source.locationAliases?.items || source.locationAliases || {};

    return {
      legalDongToAdminDong,
      industryAliasOverrides,
      similarIndustryGroups,
      ambiguousIndustryTerms: ambiguousSource,
      brandToIndustry: brandSource,
      locationAliases: locationSource,
    };
  }

  _normalizeText(value) {
    return String(value || '').replace(/\s+/g, '').trim();
  }
}

export default DataLoader;
