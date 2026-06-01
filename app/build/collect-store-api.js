const fs = require('fs/promises');
const path = require('path');
require('./load-env'); // 저장소 루트 .env → process.env

const DEFAULT_DATA_DIR = path.resolve(__dirname, '../data');
const DEFAULT_RAW_DIR = path.resolve(__dirname, '../raw/store-api');
const DEFAULT_OUT_PATH = path.resolve(__dirname, '../data/micro/public-store-api-daejeon.json');
const DEFAULT_KEY_FILE = path.resolve(__dirname, './secrets/public-data-store-api-key.txt');
const DEFAULT_BASE_URL = 'https://apis.data.go.kr/B553077/api/open/sdsc2';
const DEFAULT_ENDPOINTS = [
  'storeListInDong',
  'storeListInDongV2',
];

const DAEJEON_SGG = [
  { code: '30110', name: '동구' },
  { code: '30140', name: '중구' },
  { code: '30170', name: '서구' },
  { code: '30200', name: '유성구' },
  { code: '30230', name: '대덕구' },
];

function usage() {
  console.log(`
Usage:
  node build/collect-store-api.js [options]

Options:
  --key-file <file>       Text file containing one Public Data Portal service key.
                          Default: build/secrets/public-data-store-api-key.txt
  --service-key <key>     Service key passed directly for an ephemeral run.
  --base-url <url>        API root. Default: ${DEFAULT_BASE_URL}
  --endpoint <name>       Endpoint name. Default tries: ${DEFAULT_ENDPOINTS.join(', ')}
  --sgg-codes <list>      Comma-separated Daejeon sigungu codes. Default: 30110,30140,30170,30200,30230
  --page-size <number>    Rows per API page. Default: 1000
  --max-pages <number>    Optional page cap per sigungu for a smoke test.
  --response-type <type>  API response type. Default: json
  --out <file>            Normalized JSON output.
  --raw-dir <dir>         Save page responses and collection manifest here.
  --dry-run               Print the collection plan without calling the API.

The collector uses sigungu-level queries first so a Daejeon collection does not
spend the API quota on a nationwide pull.
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function clean(value) {
  return String(value ?? '').trim();
}

function compact(value) {
  return clean(value).replace(/\s+/g, '');
}

function numberValue(value) {
  const parsed = Number(clean(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function omitEmpty(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => clean(value)));
}

function first(item, keys) {
  for (const key of keys) {
    if (item[key] !== undefined && clean(item[key])) return clean(item[key]);
  }
  return '';
}

async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeJson(filePath, data) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(data)}\n`, 'utf8');
}

function redactKey(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.length <= 8) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function loadServiceKey(args) {
  if (args['service-key']) return clean(args['service-key']);
  if (process.env.PUBLIC_DATA_STORE_API_KEY) return clean(process.env.PUBLIC_DATA_STORE_API_KEY);
  const keyPath = path.resolve(args['key-file'] || DEFAULT_KEY_FILE);
  let contents;
  try {
    contents = await fs.readFile(keyPath, 'utf8');
  } catch {
    throw new Error('service key가 없습니다. .env에 PUBLIC_DATA_STORE_API_KEY를 넣거나 --service-key/--key-file 로 전달하세요.');
  }
  const key = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('붙여'));
  if (!key) throw new Error(`No service key found in ${keyPath}`);
  return key;
}

function parseCodes(args) {
  if (!args['sgg-codes']) return DAEJEON_SGG;
  const lookup = new Map(DAEJEON_SGG.map((item) => [item.code, item]));
  return args['sgg-codes']
    .split(',')
    .map((code) => clean(code))
    .filter(Boolean)
    .map((code) => lookup.get(code) || ({ code, name: code }));
}

function safeUrl(baseUrl, endpoint, params) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/${endpoint}`);
  Object.entries(omitEmpty(params)).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  return url;
}

function normalizeItems(payload) {
  const candidates = [
    payload?.body?.items,
    payload?.response?.body?.items,
    payload?.items,
    payload?.data,
  ];
  const itemRoot = candidates.find((candidate) => candidate !== undefined && candidate !== null);
  if (Array.isArray(itemRoot)) return itemRoot;
  if (Array.isArray(itemRoot?.item)) return itemRoot.item;
  if (itemRoot?.item) return [itemRoot.item];
  return [];
}

function findTotalCount(payload, itemCount) {
  const candidates = [
    payload?.body?.totalCount,
    payload?.response?.body?.totalCount,
    payload?.totalCount,
    payload?.matchCount,
  ].map(numberValue).filter(Number.isFinite);
  return candidates[0] ?? itemCount;
}

function findResultCode(payload) {
  return clean(
    payload?.header?.resultCode
      || payload?.response?.header?.resultCode
      || payload?.resultCode
      || payload?.resultMsg,
  );
}

function normalizeStore(item) {
  const lon = numberValue(first(item, ['lon', 'longitude', '경도']));
  const lat = numberValue(first(item, ['lat', 'latitude', '위도']));
  return {
    id: first(item, ['bizesId', 'bizesIden', '상가업소번호', 'id']),
    name: first(item, ['bizesNm', '상호명', 'name']),
    branch: first(item, ['brchNm', '지점명', 'branch']),
    sidoCode: first(item, ['ctprvnCd', '시도코드']),
    sido: first(item, ['ctprvnNm', '시도명']),
    sggCode: first(item, ['signguCd', '시군구코드']),
    sgg: first(item, ['signguNm', '시군구명']),
    adminCode: first(item, ['adstrdCd', '행정동코드']),
    adminDong: first(item, ['adstrdNm', '행정동명']),
    legalCode: first(item, ['ldongCd', '법정동코드']),
    legalDong: first(item, ['ldongNm', '법정동명']),
    roadAddress: first(item, ['rdnmAdr', '도로명주소']),
    parcelAddress: first(item, ['lnoAdr', '지번주소']),
    largeIndustryCode: first(item, ['indsLclsCd', '상권업종대분류코드']),
    largeIndustry: first(item, ['indsLclsNm', '상권업종대분류명']),
    midIndustryCode: first(item, ['indsMclsCd', '상권업종중분류코드']),
    midIndustry: first(item, ['indsMclsNm', '상권업종중분류명']),
    smallIndustryCode: first(item, ['indsSclsCd', '상권업종소분류코드']),
    smallIndustry: first(item, ['indsSclsNm', '상권업종소분류명']),
    standardIndustryCode: first(item, ['ksicCd', '표준산업분류코드']),
    standardIndustry: first(item, ['ksicNm', '표준산업분류명']),
    lon,
    lat,
  };
}

function isDaejeonStore(store) {
  return store.sidoCode.startsWith('30') || compact(store.sido).startsWith('대전');
}

function coordinateStore(store) {
  return Number.isFinite(store.lon) && Number.isFinite(store.lat);
}

function buildParams(serviceKey, sggCode, pageNo, pageSize, responseType) {
  return {
    serviceKey,
    divId: 'signguCd',
    key: sggCode,
    pageNo,
    numOfRows: pageSize,
    type: responseType,
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url.pathname}; got ${text.slice(0, 200)}`);
  }
}

async function probeEndpoint(baseUrl, endpoints, serviceKey, sgg, pageSize, responseType) {
  const errors = [];
  for (const endpoint of endpoints) {
    const url = safeUrl(baseUrl, endpoint, buildParams(serviceKey, sgg.code, 1, pageSize, responseType));
    try {
      const payload = await fetchJson(url);
      const items = normalizeItems(payload);
      if (items.length || findTotalCount(payload, 0) === 0) return { endpoint, payload };
      errors.push(`${endpoint}: no recognizable items`);
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }
  throw new Error(`No store API endpoint succeeded. ${errors.join(' | ')}`);
}

function pageFile(rawDir, sggCode, pageNo) {
  return path.join(rawDir, `stores-${sggCode}-page-${String(pageNo).padStart(4, '0')}.json`);
}

async function collectSgg({ baseUrl, endpoint, serviceKey, sgg, pageSize, maxPages, responseType, rawDir, firstPayload }) {
  const stores = [];
  let totalCount = null;
  let pageNo = 1;
  while (true) {
    const payload = pageNo === 1 && firstPayload
      ? firstPayload
      : await fetchJson(safeUrl(baseUrl, endpoint, buildParams(serviceKey, sgg.code, pageNo, pageSize, responseType)));
    await writeJson(pageFile(rawDir, sgg.code, pageNo), payload);
    const items = normalizeItems(payload);
    totalCount = totalCount ?? findTotalCount(payload, items.length);
    stores.push(...items.map(normalizeStore).filter((store) => isDaejeonStore(store) && coordinateStore(store)));
    const finishedByCount = totalCount !== null && (pageNo * pageSize) >= totalCount;
    const finishedByItems = items.length < pageSize;
    const finishedByCap = maxPages && pageNo >= maxPages;
    if (finishedByCount || finishedByItems || finishedByCap) {
      return {
        sgg,
        totalCount,
        pages: pageNo,
        keptStores: stores.length,
        resultCode: findResultCode(payload),
        stores,
      };
    }
    pageNo += 1;
  }
}

function dedupeStores(stores) {
  const seen = new Set();
  return stores.filter((store) => {
    const key = store.id || `${store.name}|${store.roadAddress}|${store.lon}|${store.lat}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function collect(args) {
  const baseUrl = args['base-url'] || DEFAULT_BASE_URL;
  const endpoints = args.endpoint ? [args.endpoint] : DEFAULT_ENDPOINTS;
  const rawDir = path.resolve(args['raw-dir'] || DEFAULT_RAW_DIR);
  const outPath = path.resolve(args.out || DEFAULT_OUT_PATH);
  const pageSize = Math.max(1, Number(args['page-size'] || 1000));
  const maxPages = args['max-pages'] ? Math.max(1, Number(args['max-pages'])) : null;
  const responseType = args['response-type'] || 'json';
  const sggs = parseCodes(args);
  const serviceKey = await loadServiceKey(args);

  await fs.mkdir(rawDir, { recursive: true });
  const probe = await probeEndpoint(baseUrl, endpoints, serviceKey, sggs[0], pageSize, responseType);
  const results = [];
  for (const sgg of sggs) {
    results.push(await collectSgg({
      baseUrl,
      endpoint: probe.endpoint,
      serviceKey,
      sgg,
      pageSize,
      maxPages,
      responseType,
      rawDir,
      firstPayload: sgg.code === sggs[0].code ? probe.payload : null,
    }));
  }
  const stores = dedupeStores(results.flatMap((result) => result.stores));
  const output = {
    metadata: {
      source: 'Public Data Portal 소상공인시장진흥공단 상가(상권)정보 API',
      collectedAt: new Date().toISOString(),
      endpoint: `${baseUrl.replace(/\/$/, '')}/${probe.endpoint}`,
      scope: 'Daejeon sigungu queries',
      sigungu: sggs,
      storeCount: stores.length,
    },
    stores,
  };
  const manifest = {
    collectedAt: output.metadata.collectedAt,
    endpoint: output.metadata.endpoint,
    serviceKey: redactKey(serviceKey),
    requestShape: {
      divId: 'signguCd',
      key: '<sigungu code>',
      pageNo: '<page>',
      numOfRows: pageSize,
      type: responseType,
    },
    sigunguResults: results.map(({ stores: ignored, ...result }) => result),
    output: outPath,
  };
  await Promise.all([
    writeJson(outPath, output),
    writeJson(path.join(rawDir, 'collection-manifest.json'), manifest),
  ]);
  console.log(JSON.stringify({
    endpoint: output.metadata.endpoint,
    stores: stores.length,
    rawDir,
    out: outPath,
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.dryRun) {
    console.log(JSON.stringify({
      baseUrl: args['base-url'] || DEFAULT_BASE_URL,
      endpoints: args.endpoint ? [args.endpoint] : DEFAULT_ENDPOINTS,
      keyFile: path.resolve(args['key-file'] || DEFAULT_KEY_FILE),
      sigungu: parseCodes(args),
      output: path.resolve(args.out || DEFAULT_OUT_PATH),
      rawDir: path.resolve(args['raw-dir'] || DEFAULT_RAW_DIR),
      pageSize: Number(args['page-size'] || 1000),
    }, null, 2));
    return;
  }
  await collect(args);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
