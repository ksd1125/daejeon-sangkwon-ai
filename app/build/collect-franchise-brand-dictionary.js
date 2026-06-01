const fs = require('fs/promises');
const path = require('path');
require('./load-env'); // 저장소 루트 .env → process.env

const APP_ROOT = path.resolve(__dirname, '..');
const DEFAULT_KEY_FILE = path.resolve(__dirname, 'secrets/fairtrade-franchise-api-key.txt');
const DEFAULT_ENV_FILE = path.resolve(__dirname, 'secrets/fairtrade-franchise.env');
const FALLBACK_KEY_FILE = path.resolve(__dirname, 'secrets/public-data-store-api-key.txt');
const DEFAULT_INDUSTRIES = path.resolve(APP_ROOT, 'data/industries.json');
const DEFAULT_DICT = path.resolve(APP_ROOT, 'data/matching-dictionaries.json');
const DEFAULT_OUT = path.resolve(APP_ROOT, 'data/generated/franchise-brand-dictionary.json');
const DEFAULT_REVIEW = path.resolve(APP_ROOT, 'data/generated/franchise-brand-review.json');
const DEFAULT_RAW = path.resolve(APP_ROOT, 'raw/fairtrade-franchise-brand.json');

const FIELD_CANDIDATES = {
  brand: ['brdNm', 'brandNm', 'brandName', 'brand', '브랜드명'],
  company: ['corpNm', 'bzmnNm', 'conmNm', 'companyNm', '상호명', '법인명'],
  large: ['indutyLclasNm', 'indutyLclsNm', 'indsLclsNm', '업종대분류명', '업종 대분류명'],
  mid: ['indutyMlsfcNm', 'indutyMclsNm', 'indsMclsNm', '업종중분류명', '업종 중분류명'],
  product: ['majrGdsNm', 'majorGoodsNm', 'mainGoodsNm', '주요상품명', '주요 상품명'],
  registerNo: ['jngBizInfoRgstNo', 'regNo', 'rgsNo', '등록번호', '가맹정보공개서등록번호'],
};

const CATEGORY_RULES = [
  { pattern: /스터디\s*카페|독서실/, industry: '독서실/스터디 카페', confidence: 0.96 },
  { pattern: /피자/, industry: '피자', confidence: 0.96 },
  { pattern: /찜닭|닭갈비|닭\s*\/\s*오리/, industry: '닭/오리고기 구이/찜', confidence: 0.9 },
  { pattern: /치킨|닭강정/, industry: '치킨', confidence: 0.96 },
  { pattern: /커피|카페|음료|차 전문점/, industry: '카페', confidence: 0.9, large: /외식/ },
  { pattern: /제과|제빵|베이커리|도넛|빵/, industry: '빵/도넛', confidence: 0.92 },
  { pattern: /버거|햄버거|패스트푸드/, industry: '버거', confidence: 0.92 },
  { pattern: /도시락/, industry: '백반/한정식', confidence: 0.9 },
  { pattern: /분식|김밥|떡볶이|만두/, industry: '김밥/만두/분식', confidence: 0.9 },
  { pattern: /샌드위치|토스트|샐러드/, industry: '토스트/샌드위치/샐러드', confidence: 0.9 },
  { pattern: /아이스크림|빙수/, industry: '아이스크림/빙수', confidence: 0.9 },
  { pattern: /중식|중국/, industry: '중국집', confidence: 0.86 },
  { pattern: /초밥|스시|회|참치/, industry: '일식 회/초밥', confidence: 0.9 },
  { pattern: /돈가스|돈까스|카레|덮밥/, industry: '일식 카레/돈가스/덮밥', confidence: 0.88 },
  { pattern: /일식|일본/, industry: '기타 일식 음식점', confidence: 0.82 },
  { pattern: /마라|훠궈/, industry: '마라탕/훠궈', confidence: 0.92 },
  { pattern: /족발|보쌈/, industry: '족발/보쌈', confidence: 0.92 },
  { pattern: /고기|삼겹|갈비|육류/, industry: '돼지고기 구이/찜', confidence: 0.76 },
  { pattern: /한식|국밥|탕|찌개|백반/, industry: '기타 한식 음식점', confidence: 0.72 },
  { pattern: /편의점/, industry: '편의점', confidence: 0.98 },
  { pattern: /슈퍼|마트/, industry: '슈퍼마켓', confidence: 0.82 },
  { pattern: /화장품|뷰티상품|드럭스토어/, industry: '화장품 소매업', confidence: 0.88 },
  { pattern: /미용|헤어/, industry: '미용실', confidence: 0.82 },
  { pattern: /네일/, industry: '네일숍', confidence: 0.9 },
  { pattern: /피부|에스테틱/, industry: '피부 관리실', confidence: 0.82 },
  { pattern: /영상|비디오|DVD/, industry: '영상방', confidence: 0.86 },
  { pattern: /헬스|피트니스|요가|필라테스/, industry: '헬스장', confidence: 0.72 },
  { pattern: /PC방|피시방/, industry: 'PC방', confidence: 0.9 },
  { pattern: /노래/, industry: '노래방', confidence: 0.88 },
  { pattern: /학원|교육/, industry: '그 외 기타 교육기관', confidence: 0.62 },
  { pattern: /주점|호프|맥주|술/, industry: '요리 주점', confidence: 0.76 },
  { pattern: /숙박|호텔|모텔/, industry: '여관/모텔', confidence: 0.7 },
];

function usage() {
  console.log(`
Usage:
  node build/collect-franchise-brand-dictionary.js [options]

Options:
  --url <url>             Full API request URL from Swagger. serviceKey/page params are added if absent.
  --base-url <url>        API service URL, used with --endpoint.
  --endpoint <name>       API operation name, used with --base-url.
  --year <yyyy>           기준연도. Default: current year - 1.
  --year-param <name>     Year parameter name. Default: yr.
  --key-file <file>       Service key file. Default: build/secrets/fairtrade-franchise-api-key.txt
  --env-file <file>       Env file containing FAIRTRADE_FRANCHISE_API_KEY.
  --service-key <key>     Service key for this run.
  --raw <file>            Use an existing API JSON file instead of calling the network.
  --out <file>            Generated dictionary output.
  --review <file>         Low-confidence review output.
  --dict <file>           Matching dictionary to merge into.
  --page-size <n>         Default: 1000.
  --max-pages <n>         Optional cap for smoke tests.
  --merge                 Merge high-confidence mappings into data/matching-dictionaries.json.
  --dry-run               Print plan without network writes.

Tip:
  The best source for this task is usually "공정거래위원회_가맹정보_브랜드 목록 정보 제공 서비스"
  because it includes brand name plus industry large/mid categories and major goods.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--merge') args.merge = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function clean(value) {
  return String(value ?? '').trim();
}

function compact(value) {
  return clean(value).replace(/\s+/g, '').replace(/[(){}\[\].,·"'`]/g, '').trim();
}

function first(item, keys) {
  for (const key of keys) {
    if (item[key] !== undefined && clean(item[key])) return clean(item[key]);
  }
  return '';
}

function numberValue(value) {
  const parsed = Number(clean(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function loadServiceKey(args) {
  if (args['service-key']) return clean(args['service-key']);
  if (process.env.FAIRTRADE_FRANCHISE_API_KEY) return clean(process.env.FAIRTRADE_FRANCHISE_API_KEY);

  const explicit = path.resolve(args['key-file'] || DEFAULT_KEY_FILE);
  for (const keyPath of [explicit]) {
    try {
      const text = await fs.readFile(keyPath, 'utf8');
      const key = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
      if (key) return key;
    } catch {
      // Try env file next.
    }
  }

  try {
    const envPath = path.resolve(args['env-file'] || DEFAULT_ENV_FILE);
    const text = await fs.readFile(envPath, 'utf8');
    const line = text.split(/\r?\n/).find((item) => item.trim().startsWith('FAIRTRADE_FRANCHISE_API_KEY='));
    const key = clean(line?.split('=').slice(1).join('='));
    if (key) return key;
  } catch {
    // Try fallback key file next.
  }

  for (const keyPath of [FALLBACK_KEY_FILE]) {
    try {
      const text = await fs.readFile(keyPath, 'utf8');
      const key = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#'));
      if (key) return key;
    } catch {
      // No key here.
    }
  }

  throw new Error(`No service key found. Put it in ${explicit} or ${DEFAULT_ENV_FILE}`);
}

function redact(value) {
  const text = clean(value);
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function normalizeItems(payload) {
  const candidates = [
    payload?.response?.body?.items,
    payload?.body?.items,
    payload?.items,
    payload?.data,
    payload?.result,
  ];
  const root = candidates.find((item) => item !== undefined && item !== null);
  if (Array.isArray(root)) return root;
  if (Array.isArray(root?.item)) return root.item;
  if (root?.item) return [root.item];
  return [];
}

function totalCount(payload, fallback) {
  return [
    payload?.response?.body?.totalCount,
    payload?.body?.totalCount,
    payload?.totalCount,
    payload?.matchCount,
  ].map(numberValue).find(Number.isFinite) ?? fallback;
}

function pageUrl(args, serviceKey, pageNo, pageSize) {
  const year = args.year || String(new Date().getFullYear() - 1);
  const yearParam = args['year-param'] || 'yr';
  const params = {
    serviceKey,
    pageNo,
    numOfRows: pageSize,
    resultType: 'json',
  };
  params[yearParam] = year;

  const base = args.url
    ? new URL(args.url)
    : new URL(`${clean(args['base-url']).replace(/\/$/, '')}/${clean(args.endpoint)}`);

  Object.entries(params).forEach(([key, value]) => {
    if (!base.searchParams.has(key)) base.searchParams.set(key, value);
  });
  return base;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json, text/json, */*' } });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API did not return JSON (${response.status}): ${text.slice(0, 240)}`);
  }
}

async function collectFromApi(args) {
  if (!args.url && (!args['base-url'] || !args.endpoint)) {
    throw new Error('Missing API URL. Pass --url from Swagger, or --base-url and --endpoint.');
  }

  const serviceKey = await loadServiceKey(args);
  const pageSize = Number(args['page-size'] || 1000);
  const maxPages = args['max-pages'] ? Number(args['max-pages']) : 200;
  const pages = [];
  let total = null;

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const url = pageUrl(args, serviceKey, pageNo, pageSize);
    if (pageNo === 1) {
      console.log(`[franchise] request ${url.origin}${url.pathname} serviceKey=${redact(serviceKey)}`);
    }
    const payload = await fetchJson(url);
    const items = normalizeItems(payload);
    pages.push({ pageNo, itemCount: items.length, payload });
    total = totalCount(payload, items.length);
    const hasReliableTotal = Number.isFinite(total) && total > 0;
    if (items.length === 0) break;
    if (hasReliableTotal && pageNo * pageSize >= total) break;
    if (!hasReliableTotal && items.length < pageSize) break;
  }

  const combined = {
    collectedAt: new Date().toISOString(),
    source: args.url || `${args['base-url']}/${args.endpoint}`,
    year: args.year || String(new Date().getFullYear() - 1),
    totalCount: total,
    pageCount: pages.length,
    items: pages.flatMap((page) => normalizeItems(page.payload)),
  };
  await writeJson(DEFAULT_RAW, combined);
  return combined.items;
}

function normalizeBrandRecord(item) {
  return {
    brand: first(item, FIELD_CANDIDATES.brand),
    company: first(item, FIELD_CANDIDATES.company),
    large: first(item, FIELD_CANDIDATES.large),
    mid: first(item, FIELD_CANDIDATES.mid),
    product: first(item, FIELD_CANDIDATES.product),
    registerNo: first(item, FIELD_CANDIDATES.registerNo),
    raw: item,
  };
}

function loadIndustryNames(industriesData) {
  if (Array.isArray(industriesData)) return new Set(industriesData.map(clean).filter(Boolean));
  if (Array.isArray(industriesData.list)) return new Set(industriesData.list.map(clean).filter(Boolean));
  return new Set(Object.keys(industriesData.categories || {}).map(clean).filter(Boolean));
}

function inferIndustry(record, industryNames) {
  const haystack = `${record.mid} ${record.large} ${record.product} ${record.brand}`.trim();
  for (const rule of CATEGORY_RULES) {
    if (rule.large && !rule.large.test(record.large)) continue;
    if (rule.pattern.test(haystack) && industryNames.has(rule.industry)) {
      return { industry: rule.industry, confidence: rule.confidence, rule: String(rule.pattern) };
    }
  }
  return { industry: '', confidence: 0, rule: '' };
}

function shouldKeepBrandName(name) {
  const value = clean(name);
  if (value.length < 2) return false;
  if (/^\d+$/.test(value)) return false;
  if (/점$/.test(value) && value.length < 4) return false;
  return true;
}

function buildDictionary(items, industriesData, existingDict) {
  const industryNames = loadIndustryNames(industriesData);
  const existing = existingDict?.brandToIndustry?.items || {};
  const exactExisting = new Map(Object.entries(existing).map(([brand, industry]) => [compact(brand), { brand, industry }]));
  const generated = {};
  const review = [];
  const seen = new Map();

  for (const item of items) {
    const record = normalizeBrandRecord(item);
    if (!shouldKeepBrandName(record.brand)) continue;
    const key = compact(record.brand);
    if (!key || seen.has(key)) continue;
    seen.set(key, record);

    const existingMatch = exactExisting.get(key);
    if (existingMatch) {
      generated[existingMatch.brand] = {
        industry: existingMatch.industry,
        confidence: 1,
        source: 'existing',
        large: record.large,
        mid: record.mid,
        product: record.product,
      };
      continue;
    }

    const inferred = inferIndustry(record, industryNames);
    const entry = {
      brand: record.brand,
      company: record.company,
      large: record.large,
      mid: record.mid,
      product: record.product,
      registerNo: record.registerNo,
      suggestedIndustry: inferred.industry,
      confidence: inferred.confidence,
      rule: inferred.rule,
    };

    if (inferred.industry && inferred.confidence >= 0.82) {
      generated[record.brand] = {
        industry: inferred.industry,
        confidence: inferred.confidence,
        source: 'fairtrade-api',
        large: record.large,
        mid: record.mid,
        product: record.product,
      };
    } else {
      review.push(entry);
    }
  }

  return { generated, review };
}

async function mergeIntoMatchingDictionary(generated, dictPath) {
  const dict = await readJson(dictPath);
  dict.brandToIndustry = dict.brandToIndustry || { description: '브랜드/프랜차이즈 이름을 업종으로 연결합니다.', items: {} };
  dict.brandToIndustry.items = dict.brandToIndustry.items || {};

  let added = 0;
  for (const [brand, meta] of Object.entries(generated)) {
    if (dict.brandToIndustry.items[brand]) continue;
    dict.brandToIndustry.items[brand] = meta.industry;
    added += 1;
  }
  await writeJson(dictPath, dict);
  return added;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const reviewPath = path.resolve(args.review || DEFAULT_REVIEW);
  const dictPath = path.resolve(args.dict || DEFAULT_DICT);
  const industriesPath = path.resolve(args.industries || DEFAULT_INDUSTRIES);

  if (args.dryRun) {
    console.log({ outPath, reviewPath, dictPath, industriesPath, source: args.raw || args.url || args['base-url'] });
    return;
  }

  const [industries, existingDict] = await Promise.all([
    readJson(industriesPath),
    readJson(dictPath),
  ]);
  const items = args.raw
    ? normalizeItems(await readJson(path.resolve(args.raw)))
    : await collectFromApi(args);

  const { generated, review } = buildDictionary(items, industries, existingDict);
  const output = {
    generatedAt: new Date().toISOString(),
    source: args.raw ? path.resolve(args.raw) : (args.url || `${args['base-url']}/${args.endpoint}`),
    inputRows: items.length,
    generatedCount: Object.keys(generated).length,
    reviewCount: review.length,
    items: generated,
  };
  await writeJson(outPath, output);
  await writeJson(reviewPath, {
    generatedAt: output.generatedAt,
    inputRows: items.length,
    reviewCount: review.length,
    items: review,
  });

  let merged = 0;
  if (args.merge) merged = await mergeIntoMatchingDictionary(generated, dictPath);

  console.log(JSON.stringify({
    inputRows: items.length,
    generated: output.generatedCount,
    review: review.length,
    merged,
    out: outPath,
    reviewOut: reviewPath,
  }, null, 2));
}

main().catch((err) => {
  console.error(`[franchise] ${err.message}`);
  process.exit(1);
});
