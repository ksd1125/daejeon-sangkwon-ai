const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { parse } = require('csv-parse');

const DEFAULT_DATA_DIR = path.resolve(__dirname, '../data');
const DEFAULT_OUT_DIR = path.join(DEFAULT_DATA_DIR, 'micro');
const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };

const STORE_FIELDS = {
  id: ['상가업소번호', '상가업소ID', 'bizesId', 'store_id', 'id'],
  name: ['상호명', 'bizesNm', 'store_name', 'name'],
  branch: ['지점명', 'brchNm', 'branch_name', 'branch'],
  sido: ['시도명', 'ctprvnNm', 'sido', 'SIDO_NM'],
  sidoCode: ['시도코드', 'ctprvnCd', 'sidoCode', 'sido_code', 'SIDO_CD'],
  sgg: ['시군구명', 'signguNm', 'sgg', 'SGG_NM'],
  sggCode: ['시군구코드', 'signguCd', 'sggCode', 'sgg_code', 'SGG_CD'],
  adminDong: ['행정동명', 'adstrdNm', 'adminDong', 'admin_dong', 'ADMI_NM'],
  adminCode: ['행정동코드', 'adstrdCd', 'adminCode', 'admin_code', 'ADMI_CD'],
  legalDong: ['법정동명', 'ldongNm', 'legalDong', 'legal_dong'],
  roadAddress: ['도로명주소', 'rdnmAdr', 'roadAddress', 'road_address'],
  parcelAddress: ['지번주소', 'lnoAdr', 'parcelAddress', 'parcel_address'],
  largeIndustry: ['상권업종대분류명', 'indsLclsNm', 'largeIndustry', 'large_industry'],
  midIndustry: ['상권업종중분류명', 'indsMclsNm', 'midIndustry', 'mid_industry'],
  smallIndustry: ['상권업종소분류명', 'indsSclsNm', 'smallIndustry', 'small_industry', 'industry'],
  lon: ['경도', 'lon', 'longitude', 'x'],
  lat: ['위도', 'lat', 'latitude', 'y'],
};

const BASIC_UNIT_ID_FIELDS = ['BAS_ID', 'bas_id', 'BASE_ID', 'base_id', 'basic_unit_id', 'gid', 'id'];
const BASIC_UNIT_DONG_FIELDS = ['ADMI_CD', 'ADM_CD', 'adm_cd', 'ADM_DR_CD', '행정동코드', 'admin_code'];

function usage() {
  console.log(`
Usage:
  node build/compile-microdata.js --stores <store-db.csv|store-api.json> [--basic-units <sgis-basic-units.geojson>]

Options:
  --data-dir <dir>       Existing app data directory. Default: app/data
  --out-dir <dir>        Output directory. Default: app/data/micro
  --months <list>        Comma-separated months. Default: latest app month
  --all-months          Generate synthetic sales and footfall for every app month
  --stores <file>        Public Data Portal store DB CSV or collect-store-api JSON
  --basic-units <json>   SGIS basic-unit GeoJSON in longitude/latitude coordinates

Outputs:
  stores-daejeon.synthetic.json
  basic-units-footfall.synthetic.geojson, when --basic-units is given
  microdata-manifest.json
`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--all-months') {
      args.allMonths = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function compact(value) {
  return cleanText(value).replace(/\s+/g, '');
}

function numberValue(value) {
  const normalized = cleanText(value).replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function pick(row, candidates) {
  for (const candidate of candidates) {
    if (row[candidate] !== undefined && cleanText(row[candidate])) return cleanText(row[candidate]);
  }
  return '';
}

function finite(value) {
  return Number.isFinite(value);
}

function writeJson(filePath, value) {
  return fsp.writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function random01(seedText) {
  let state = hashSeed(seedText) || 1;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return ((state >>> 0) + 1) / 4294967297;
}

function normal(seedText) {
  const left = Math.max(random01(`${seedText}:left`), Number.EPSILON);
  const right = random01(`${seedText}:right`);
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}

function logNormalWeight(seedText, sigma) {
  return Math.exp((sigma * normal(seedText)) - ((sigma * sigma) / 2));
}

function sigmaForIndustry(store) {
  const label = `${store.largeIndustry} ${store.midIndustry} ${store.industryRaw}`;
  if (/숙박|유흥|병원|자동차|주유/.test(label)) return 0.85;
  if (/음식|카페|소매|편의점|슈퍼/.test(label)) return 0.62;
  return 0.48;
}

function allocateRoundedTotal(items, total, weightFor) {
  const safeTotal = Math.max(0, Math.round(total));
  const weighted = items.map((item) => ({ item, weight: Math.max(weightFor(item), 1e-9) }));
  const weightSum = weighted.reduce((sum, item) => sum + item.weight, 0);
  const allocated = weighted.map((item) => {
    const raw = safeTotal * (item.weight / weightSum);
    return { item: item.item, value: Math.floor(raw), fraction: raw - Math.floor(raw) };
  });
  let remainder = safeTotal - allocated.reduce((sum, item) => sum + item.value, 0);
  allocated
    .sort((a, b) => b.fraction - a.fraction || String(a.item.id).localeCompare(String(b.item.id)))
    .forEach((item) => {
      if (remainder <= 0) return;
      item.value += 1;
      remainder -= 1;
    });
  return new Map(allocated.map((item) => [item.item, item.value]));
}

function ringContainsPoint(ring, point) {
  let inside = false;
  for (let left = 0, right = ring.length - 1; left < ring.length; right = left, left += 1) {
    const xi = ring[left][0];
    const yi = ring[left][1];
    const xj = ring[right][0];
    const yj = ring[right][1];
    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && (point[0] < (((xj - xi) * (point[1] - yi)) / ((yj - yi) || 1e-12)) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(coordinates, point) {
  if (!coordinates?.[0] || !ringContainsPoint(coordinates[0], point)) return false;
  return !coordinates.slice(1).some((hole) => ringContainsPoint(hole, point));
}

function geometryContainsPoint(geometry, point) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return polygonContainsPoint(geometry.coordinates, point);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((polygon) => polygonContainsPoint(polygon, point));
  return false;
}

function collectCoordinates(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates.flat(1);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  return [];
}

function geometryCentroid(geometry) {
  const coords = collectCoordinates(geometry);
  if (!coords.length) return null;
  const sum = coords.reduce((acc, coord) => [acc[0] + coord[0], acc[1] + coord[1]], [0, 0]);
  return [sum[0] / coords.length, sum[1] / coords.length];
}

function ringArea(ring) {
  if (!ring?.length) return 0;
  let twiceArea = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    twiceArea += (current[0] * next[1]) - (next[0] * current[1]);
  }
  return Math.abs(twiceArea / 2);
}

function polygonArea(coordinates) {
  if (!coordinates?.length) return 0;
  return Math.max(0, ringArea(coordinates[0]) - coordinates.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0));
}

function geometryArea(geometry) {
  if (!geometry) return 0;
  if (geometry.type === 'Polygon') return polygonArea(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
  return 0;
}

function districtCodeFromProperty(value, districtByCode) {
  const code = cleanText(value);
  if (!code) return '';
  if (districtByCode.has(code)) return code;
  const prefixMatch = [...districtByCode.keys()].find((districtCode) => code.startsWith(districtCode));
  return prefixMatch || '';
}

function buildDistrictIndexes(index, districtsGeoJson) {
  const districtByCode = new Map(index.districts.map((district) => [String(district.code), district]));
  const districtsByName = new Map();
  index.districts.forEach((district) => {
    const key = compact(district.name);
    if (!districtsByName.has(key)) districtsByName.set(key, []);
    districtsByName.get(key).push(district);
  });
  const districtFeatures = (districtsGeoJson.features || []).map((feature) => ({
    code: String(feature.properties?.code || feature.properties?.ADMI_CD || ''),
    geometry: feature.geometry,
  })).filter((feature) => districtByCode.has(feature.code));
  return { districtByCode, districtsByName, districtFeatures };
}

function matchDistrict(row, store, indexes) {
  const explicitCode = districtCodeFromProperty(pick(row, STORE_FIELDS.adminCode), indexes.districtByCode);
  if (explicitCode) return indexes.districtByCode.get(explicitCode);

  const nameMatches = indexes.districtsByName.get(compact(store.adminDong)) || [];
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    const narrowed = nameMatches.find((district) => compact(district.sgg) === compact(store.sgg));
    if (narrowed) return narrowed;
  }

  const feature = indexes.districtFeatures.find((districtFeature) => (
    geometryContainsPoint(districtFeature.geometry, [store.lon, store.lat])
  ));
  return feature ? indexes.districtByCode.get(feature.code) : null;
}

function isDaejeon(row) {
  const sido = pick(row, STORE_FIELDS.sido);
  const sidoCode = pick(row, STORE_FIELDS.sidoCode);
  return compact(sido).startsWith('대전') || sidoCode.startsWith('30');
}

function industryLookup(industriesJson) {
  const names = industriesJson.list || industriesJson.industries || [];
  const targetByCompact = new Map(names.map((name) => [compact(name), name]));
  Object.entries(industriesJson.aliases || {}).forEach(([alias, target]) => {
    if (targetByCompact.has(compact(target))) targetByCompact.set(compact(alias), targetByCompact.get(compact(target)));
  });
  return targetByCompact;
}

function buildStore(row, position) {
  return {
    id: pick(row, STORE_FIELDS.id) || `public-store-${position}`,
    name: pick(row, STORE_FIELDS.name),
    branch: pick(row, STORE_FIELDS.branch),
    sido: pick(row, STORE_FIELDS.sido),
    sgg: pick(row, STORE_FIELDS.sgg),
    sggCode: pick(row, STORE_FIELDS.sggCode),
    adminDong: pick(row, STORE_FIELDS.adminDong),
    legalDong: pick(row, STORE_FIELDS.legalDong),
    roadAddress: pick(row, STORE_FIELDS.roadAddress),
    parcelAddress: pick(row, STORE_FIELDS.parcelAddress),
    largeIndustry: pick(row, STORE_FIELDS.largeIndustry),
    midIndustry: pick(row, STORE_FIELDS.midIndustry),
    industryRaw: pick(row, STORE_FIELDS.smallIndustry),
    lon: numberValue(pick(row, STORE_FIELDS.lon)),
    lat: numberValue(pick(row, STORE_FIELDS.lat)),
    syntheticSales: {},
  };
}

async function loadStores(csvPath, indexes, industries) {
  const stats = {
    sourceRows: 0,
    daejeonRows: 0,
    validCoordinateRows: 0,
    matchedDistrictRows: 0,
    matchedIndustryRows: 0,
  };
  const stores = [];
  const addRow = (row) => {
    stats.sourceRows += 1;
    if (!isDaejeon(row)) return;
    stats.daejeonRows += 1;
    const store = buildStore(row, stats.sourceRows);
    if (!finite(store.lon) || !finite(store.lat)) return;
    stats.validCoordinateRows += 1;
    const district = matchDistrict(row, store, indexes);
    if (!district) return;
    stats.matchedDistrictRows += 1;
    store.districtCode = String(district.code);
    store.districtName = district.name;
    store.districtSgg = district.sgg;
    store.industry = industries.get(compact(store.industryRaw)) || '';
    if (store.industry) stats.matchedIndustryRows += 1;
    stores.push(store);
  };

  if (path.extname(csvPath).toLowerCase() === '.json') {
    const payload = await readJson(csvPath);
    const rows = Array.isArray(payload) ? payload : (payload.stores || payload.items || []);
    if (!Array.isArray(rows)) throw new Error('Store JSON must be an array or contain a stores array.');
    rows.forEach(addRow);
  } else {
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath)
        .pipe(parse({ bom: true, columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true }))
        .on('data', addRow)
        .on('error', reject)
        .on('end', resolve);
    });
  }
  return { stores, stats };
}

async function loadAggregateTargets(dataDir, index, months) {
  const salesTargets = new Map();
  const populationTargets = new Map();

  await Promise.all(index.districts.map(async (district) => {
    const districtPath = path.join(dataDir, 'districts', `${district.code}.json`);
    const districtJson = await readJson(districtPath);
    const populationMonthsDone = new Set();
    Object.entries(districtJson.industries || {}).forEach(([industry, entry]) => {
      months.forEach((month) => {
        const record = entry?.m?.[month];
        if (!record) return;
        if (finite(record.amt)) {
          salesTargets.set(`${district.code}|${industry}|${month}`, {
            districtCode: String(district.code),
            districtName: district.name,
            sgg: district.sgg,
            industry,
            month,
            aggregateMeanSalesManwon: record.amt,
            aggregateStoreCount: finite(record.upso) ? record.upso : null,
            dataStatus: record.dataStatus || null,
          });
        }
        if (!populationMonthsDone.has(month) && finite(record.pop)) {
          populationTargets.set(`${district.code}|${month}`, {
            districtCode: String(district.code),
            districtName: district.name,
            sgg: district.sgg,
            month,
            districtFootfall: record.pop,
          });
          populationMonthsDone.add(month);
        }
      });
    });
  }));

  return { salesTargets, populationTargets };
}

function assignSyntheticSales(stores, salesTargets, months) {
  const groups = new Map();
  stores.filter((store) => store.industry).forEach((store) => {
    months.forEach((month) => {
      const key = `${store.districtCode}|${store.industry}|${month}`;
      if (!salesTargets.has(key)) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(store);
    });
  });

  const diagnostics = [];
  groups.forEach((groupStores, key) => {
    const target = salesTargets.get(key);
    const total = target.aggregateMeanSalesManwon * groupStores.length;
    const allocated = allocateRoundedTotal(groupStores, total, (store) => (
      logNormalWeight(`${store.id}|${target.month}|${target.industry}`, sigmaForIndustry(store))
    ));
    groupStores.forEach((store) => {
      store.syntheticSales[target.month] = allocated.get(store);
    });
    const syntheticTotal = [...allocated.values()].reduce((sum, value) => sum + value, 0);
    diagnostics.push({
      districtCode: target.districtCode,
      districtName: target.districtName,
      industry: target.industry,
      month: target.month,
      storeRows: groupStores.length,
      aggregateStoreCount: target.aggregateStoreCount,
      aggregateMeanSalesManwon: target.aggregateMeanSalesManwon,
      syntheticMeanSalesManwon: Number((syntheticTotal / groupStores.length).toFixed(6)),
    });
  });
  return diagnostics.sort((a, b) => (
    a.month.localeCompare(b.month)
    || a.districtCode.localeCompare(b.districtCode)
    || a.industry.localeCompare(b.industry, 'ko')
  ));
}

function basicUnitId(feature, index) {
  for (const field of BASIC_UNIT_ID_FIELDS) {
    if (cleanText(feature.properties?.[field])) return cleanText(feature.properties[field]);
  }
  return `basic-unit-${index + 1}`;
}

function basicUnitDistrict(feature, centroid, indexes) {
  for (const field of BASIC_UNIT_DONG_FIELDS) {
    const code = districtCodeFromProperty(feature.properties?.[field], indexes.districtByCode);
    if (code) return indexes.districtByCode.get(code);
  }
  const districtFeature = indexes.districtFeatures.find((candidate) => geometryContainsPoint(candidate.geometry, centroid));
  return districtFeature ? indexes.districtByCode.get(districtFeature.code) : null;
}

async function buildFootfallGeoJson(filePath, indexes, populationTargets, months) {
  const input = await readJson(filePath);
  if (input.type !== 'FeatureCollection') throw new Error('Basic-unit input must be a GeoJSON FeatureCollection.');
  const units = [];
  (input.features || []).forEach((feature, index) => {
    const centroid = geometryCentroid(feature.geometry);
    if (!centroid) return;
    const district = basicUnitDistrict(feature, centroid, indexes);
    if (!district) return;
    units.push({
      id: basicUnitId(feature, index),
      district,
      feature,
      area: Math.max(geometryArea(feature.geometry), 1e-12),
      syntheticFootfall: {},
    });
  });

  const diagnostics = [];
  months.forEach((month) => {
    const unitsByDistrict = new Map();
    units.forEach((unit) => {
      const key = `${unit.district.code}|${month}`;
      if (!populationTargets.has(key)) return;
      if (!unitsByDistrict.has(key)) unitsByDistrict.set(key, []);
      unitsByDistrict.get(key).push(unit);
    });
    unitsByDistrict.forEach((districtUnits, key) => {
      const target = populationTargets.get(key);
      const allocated = allocateRoundedTotal(districtUnits, target.districtFootfall, (unit) => (
        unit.area * logNormalWeight(`${unit.id}|${target.month}|footfall`, 0.35)
      ));
      districtUnits.forEach((unit) => {
        unit.syntheticFootfall[target.month] = allocated.get(unit);
      });
      const syntheticTotal = [...allocated.values()].reduce((sum, value) => sum + value, 0);
      diagnostics.push({
        districtCode: target.districtCode,
        districtName: target.districtName,
        month: target.month,
        basicUnitRows: districtUnits.length,
        aggregateDistrictFootfall: target.districtFootfall,
        syntheticBasicUnitFootfall: syntheticTotal,
      });
    });
  });

  return {
    geojson: {
      type: 'FeatureCollection',
      features: units.map((unit) => ({
        type: 'Feature',
        geometry: unit.feature.geometry,
        properties: {
          basicUnitId: unit.id,
          districtCode: String(unit.district.code),
          districtName: unit.district.name,
          sgg: unit.district.sgg,
          syntheticFootfall: unit.syntheticFootfall,
          allocationMethod: 'area_weighted_lognormal_rescaled_to_district_total',
        },
      })),
    },
    diagnostics,
    inputFeatureCount: (input.features || []).length,
    outputFeatureCount: units.length,
  };
}

function slimStore(store) {
  return {
    id: store.id,
    name: store.name,
    branch: store.branch,
    districtCode: store.districtCode,
    districtName: store.districtName,
    sgg: store.districtSgg,
    adminDong: store.adminDong,
    legalDong: store.legalDong,
    roadAddress: store.roadAddress,
    parcelAddress: store.parcelAddress,
    industry: store.industry || store.industryRaw,
    industryMatchedToAggregate: Boolean(store.industry),
    industryRaw: store.industryRaw,
    largeIndustry: store.largeIndustry,
    midIndustry: store.midIndustry,
    coordinates: [store.lon, store.lat],
    syntheticSalesManwon: store.syntheticSales,
  };
}

function selectedMonths(args, index) {
  if (args.allMonths) return [...index.months].map(String).sort();
  if (args.months) return args.months.split(',').map((month) => month.trim()).filter(Boolean);
  return [String(index.latestMonth)];
}

async function compile() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.stores) throw new Error('Missing --stores <store-db.csv>.');

  const dataDir = path.resolve(args['data-dir'] || DEFAULT_DATA_DIR);
  const outDir = path.resolve(args['out-dir'] || DEFAULT_OUT_DIR);
  await fsp.mkdir(outDir, { recursive: true });

  const [index, industriesJson, districtsGeoJson] = await Promise.all([
    readJson(path.join(dataDir, 'index.json')),
    readJson(path.join(dataDir, 'industries.json')),
    readJson(path.join(dataDir, 'daejeon-districts.geojson')),
  ]);
  const months = selectedMonths(args, index);
  const indexes = buildDistrictIndexes(index, districtsGeoJson);
  const industries = industryLookup(industriesJson);
  const targets = await loadAggregateTargets(dataDir, index, months);
  const storeResult = await loadStores(path.resolve(args.stores), indexes, industries);
  const salesDiagnostics = assignSyntheticSales(storeResult.stores, targets.salesTargets, months);

  const storesOutput = {
    metadata: {
      source: 'Public Data Portal store DB filtered to Daejeon rows with coordinates',
      salesMethod: 'deterministic_lognormal_weights_rescaled_to_preserve_district_industry_month_mean',
      salesUnit: 'manwon',
      months,
    },
    stores: storeResult.stores.map(slimStore),
  };
  await writeJson(path.join(outDir, 'stores-daejeon.synthetic.json'), storesOutput);

  let footfall = {
    geojson: EMPTY_GEOJSON,
    diagnostics: [],
    inputFeatureCount: 0,
    outputFeatureCount: 0,
    skipped: true,
  };
  if (args['basic-units']) {
    footfall = await buildFootfallGeoJson(path.resolve(args['basic-units']), indexes, targets.populationTargets, months);
    await writeJson(path.join(outDir, 'basic-units-footfall.synthetic.geojson'), footfall.geojson);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    months,
    inputs: {
      storeCsv: path.resolve(args.stores),
      basicUnitsGeoJson: args['basic-units'] ? path.resolve(args['basic-units']) : null,
      appDataDir: dataDir,
    },
    outputs: {
      stores: path.join(outDir, 'stores-daejeon.synthetic.json'),
      basicUnitsFootfall: args['basic-units'] ? path.join(outDir, 'basic-units-footfall.synthetic.geojson') : null,
    },
    cautions: [
      'Store coordinates and names come from the public store DB input.',
      'Store-level sales are synthetic and preserve each matched district-industry-month aggregate mean over observed store rows.',
      'Basic-unit footfall is synthetic and preserves each matched district-month total over assigned SGIS basic-unit features.',
      'A mismatch between public store rows and aggregate upso counts is kept in diagnostics instead of silently fabricating stores.',
    ],
    storeExtraction: storeResult.stats,
    salesGroups: {
      generated: salesDiagnostics.length,
      diagnostics: salesDiagnostics,
    },
    basicUnitFootfall: {
      generated: !footfall.skipped,
      inputFeatureCount: footfall.inputFeatureCount,
      outputFeatureCount: footfall.outputFeatureCount,
      diagnostics: footfall.diagnostics,
    },
  };
  await writeJson(path.join(outDir, 'microdata-manifest.json'), manifest);

  console.log(JSON.stringify({
    months,
    stores: storeResult.stores.length,
    salesGroups: salesDiagnostics.length,
    basicUnits: footfall.outputFeatureCount,
    outDir,
  }, null, 2));
}

compile().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
