const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const iconv = require('iconv-lite');
const { parse } = require('csv-parse');

const CSV_PATH = path.resolve(__dirname, '../../20260515_AI 제공데이터(대전)/220260515_AI 제공데이터(대전).csv');
const OUT_DIR = path.resolve(__dirname, '../data');
const DISTRICTS_DIR = path.join(OUT_DIR, 'districts');

const DEFAULT_ALIASES = {
  '치킨집': '치킨',
  '커피숍': '카페',
  '삼겹살': '돼지고기 구이/찜',
  '과일가게': '채소/과일 소매업',
  '피시방': 'PC방',
  '미장원': '미용실',
  '해장국': '국/탕/찌개류',
  '빵집': '베이커리',
  '떡볶이': '분식',
  '횟집': '횟집',
  '초밥': '일식/회/초밥',
  '중국집': '중국집',
  '마라탕': '마라탕/훠궈',
  '족발': '족발/보쌈',
  '보쌈': '족발/보쌈',
};

const DAY_FIELDS = [
  'POP_MON',
  'POP_TUS',
  'POP_WED',
  'POP_THU',
  'POP_FRI',
  'POP_SAT',
  'POP_SUN',
];

const TIME_FIELDS = [
  'POP_TIME_05_09',
  'POP_TIME_09_12',
  'POP_TIME_12_14',
  'POP_TIME_14_18',
  'POP_TIME_18_23',
  'POP_TIME_23_05',
];

const BAEMIN_FIELDS = [
  'BAEMIN_MONTH_AVG_CNT',
  'BAEMIN_WEEKDAY',
  'BAEMIN_WEEKEND',
  'BAEMIN_MON',
  'BAEMIN_TUS',
  'BAEMIN_WED',
  'BAEMIN_THU',
  'BAEMIN_FRI',
  'BAEMIN_SAT',
  'BAEMIN_SUN',
  'BAEMIN_TIME_05_09',
  'BAEMIN_TIME_09_12',
  'BAEMIN_TIME_12_14',
  'BAEMIN_TIME_14_18',
  'BAEMIN_TIME_18_23',
  'BAEMIN_TIME_23_05',
  'BAEMIN_AGE_10',
  'BAEMIN_AGE_20',
  'BAEMIN_AGE_30',
  'BAEMIN_AGE_40',
  'BAEMIN_AGE_50',
  'BAEMIN_AGE_60',
  'BAEMIN_M',
  'BAEMIN_W',
];

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;

  const text = String(value).trim();
  if (!text || text === '-') return null;

  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function isNumericValue(value) {
  return parseNumber(value) !== null;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = parseNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function compact(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function sortKo(a, b) {
  return String(a).localeCompare(String(b), 'ko');
}

function setNestedMetric(target, areaName, month, industry, metric) {
  if (!areaName || !month || !industry) return;
  target[areaName] ??= {};
  target[areaName][month] ??= {};
  target[areaName][month][industry] = metric;
}

function ensureIndustry(industryMap, row) {
  const name = String(row.TPBIZ_CLSCD_NM || '').trim();
  if (!name) return null;

  if (!industryMap.has(name)) {
    industryMap.set(name, {
      large: String(row.TPBIZ_LCLCD_NM || '').trim(),
      mid: String(row.TPBIZ_MCLCD_NM || '').trim(),
    });
  }

  return name;
}

function ensureDistrict(districtMap, row) {
  const code = String(row.ADMI_CD || '').trim();
  if (!code) return null;

  if (!districtMap.has(code)) {
    districtMap.set(code, {
      code,
      name: String(row.ADMI_NM || '').trim(),
      sgg: String(row.SGG_NM || '').trim(),
      sggCode: String(row.SGG_CD || '').trim(),
      industries: {},
    });
  }

  return districtMap.get(code);
}

function splitSangwonLocation(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { dong: '', sgg: '' };

  return {
    dong: parts[parts.length - 1] || '',
    sgg: parts[parts.length - 2] || '',
  };
}

function buildSimilar(row) {
  const similar = [];

  for (let index = 1; index <= 5; index += 1) {
    const rawDong = row[`SANGWON${index}_DONG`];
    if (!String(rawDong || '').trim()) continue;

    const { dong, sgg } = splitSangwonLocation(rawDong);
    similar.push({
      dong,
      sgg,
      amt: parseNumber(row[`SANGWON${index}_AMT`]),
      pop: parseNumber(row[`SANGWON${index}_POP`]),
      upso: parseNumber(row[`SANGWON${index}_UPSO_COUNT`]),
    });
  }

  return similar;
}

function buildBaemin(row) {
  if (!String(row.BAEMIN_MONTH_AVG_CNT || '').trim()) return null;

  return {
    monthAvgCnt: parseNumber(row.BAEMIN_MONTH_AVG_CNT),
    weekday: parseNumber(row.BAEMIN_WEEKDAY),
    weekend: parseNumber(row.BAEMIN_WEEKEND),
    byDay: [
      row.BAEMIN_MON,
      row.BAEMIN_TUS,
      row.BAEMIN_WED,
      row.BAEMIN_THU,
      row.BAEMIN_FRI,
      row.BAEMIN_SAT,
      row.BAEMIN_SUN,
    ].map(parseNumber),
    byTime: [
      row.BAEMIN_TIME_05_09,
      row.BAEMIN_TIME_09_12,
      row.BAEMIN_TIME_12_14,
      row.BAEMIN_TIME_14_18,
      row.BAEMIN_TIME_18_23,
      row.BAEMIN_TIME_23_05,
    ].map(parseNumber),
    byAge: [
      row.BAEMIN_AGE_10,
      row.BAEMIN_AGE_20,
      row.BAEMIN_AGE_30,
      row.BAEMIN_AGE_40,
      row.BAEMIN_AGE_50,
      row.BAEMIN_AGE_60,
    ].map(parseNumber),
    byGender: {
      m: parseNumber(row.BAEMIN_M),
      w: parseNumber(row.BAEMIN_W),
    },
  };
}

function buildDistrictMonth(row) {
  return {
    amt: firstNumber(row.AMT_DONG, row.SIMPLE_INFO_AMT, row.AMT_AVG, row.AMT_SGG),
    amtLow: parseNumber(row.AMT_LOW),
    amtAvg: parseNumber(row.AMT_AVG),
    amtHigh: parseNumber(row.AMT_HIGH),
    amtDong: parseNumber(row.AMT_DONG),
    amtDongPres: parseNumber(row.AMT_DONG_PRES),
    amtSgg: parseNumber(row.AMT_SGG),
    amtSido: parseNumber(row.AMT_SIDO),
    amtYoY: parseNumber(row.AMT_ON_YEAR),
    amtMoM: parseNumber(row.AMT_ON_MONTH),
    upso: firstNumber(row.UPSO_COUNT, row.UPSO_COUNT_DONG, row.UPSO_COUNT_SGG),
    upsoDong: parseNumber(row.UPSO_COUNT_DONG),
    upsoSgg: parseNumber(row.UPSO_COUNT_SGG),
    upsoSido: parseNumber(row.UPSO_COUNT_SIDO),
    upsoYoY: parseNumber(row.UPSO_ON_YEAR),
    upsoMoM: parseNumber(row.UPSO_ON_MONTH),
    pop: parseNumber(row.POP_MONTH_AVG_CNT || row.SIMPLE_INFO_DAY_POP),
    popWeekday: parseNumber(row.POP_WEEKDAY),
    popWeekend: parseNumber(row.POP_WEEKEND),
    popByDay: DAY_FIELDS.map((field) => parseNumber(row[field])),
    popByTime: TIME_FIELDS.map((field) => parseNumber(row[field])),
    peakDay: String(row.SIMPLE_INFO_MANY_DAY_POP || '').trim() || null,
    peakTime: String(row.SIMPLE_INFO_MANY_TIME_POP || '').trim() || null,
    dataStatus: isNumericValue(row.AMT_DONG) ? 'direct' : 'sgg_sub',
    baemin: buildBaemin(row),
    similar: buildSimilar(row),
  };
}

function addDistrictIndustry(district, row, industryName, category) {
  district.industries[industryName] ??= {
    cat: [category.large, category.mid, industryName],
    m: {},
  };

  district.industries[industryName].m[String(row.CRTR_YM)] = buildDistrictMonth(row);
}

function levenshtein(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  const prev = Array.from({ length: right.length + 1 }, (_, index) => index);
  const curr = new Array(right.length + 1);

  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    prev.splice(0, prev.length, ...curr);
  }

  return prev[right.length];
}

function findClosestIndustry(target, industries) {
  const normalizedTarget = compact(target);
  const exact = industries.find((name) => compact(name) === normalizedTarget);
  if (exact) return exact;

  const contains = industries.find((name) => compact(name).includes(normalizedTarget) || normalizedTarget.includes(compact(name)));
  if (contains) return contains;

  return industries
    .map((name) => ({ name, score: levenshtein(normalizedTarget, compact(name)) }))
    .sort((a, b) => a.score - b.score || sortKo(a.name, b.name))[0]?.name || target;
}

function buildAliases(industries) {
  const aliases = {};

  for (const [alias, target] of Object.entries(DEFAULT_ALIASES)) {
    aliases[alias] = industries.includes(target) ? target : findClosestIndustry(target, industries);
  }

  return aliases;
}

function toPlainDistrict(district) {
  const industries = {};

  for (const industry of Object.keys(district.industries).sort(sortKo)) {
    const item = district.industries[industry];
    const months = {};
    for (const month of Object.keys(item.m).sort()) {
      months[month] = item.m[month];
    }
    industries[industry] = { cat: item.cat, m: months };
  }

  return {
    district: district.name,
    sgg: district.sgg,
    code: district.code,
    industries,
  };
}

function buildAggregateMetric(row, level) {
  if (level === 'sgg') {
    return {
      amt: parseNumber(row.AMT_SGG),
      upso: parseNumber(row.UPSO_COUNT_SGG),
    };
  }

  return {
    amt: parseNumber(row.AMT_SIDO),
    upso: parseNumber(row.UPSO_COUNT_SIDO),
  };
}

async function cleanOutput() {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.rm(DISTRICTS_DIR, { recursive: true, force: true });
  await fsp.mkdir(DISTRICTS_DIR, { recursive: true });
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, `${JSON.stringify(data)}\n`, 'utf8');
}

async function compile() {
  await cleanOutput();

  console.log('CSV를 읽는 중입니다. 파일이 커서 잠시 걸릴 수 있습니다...');

  const months = new Set();
  const districts = new Map();
  const industryMap = new Map();
  const aggregates = { sgg: {}, sido: {} };
  const counts = { rows: 0, ad: 0, sgg: 0, sido: 0 };

  await new Promise((resolve, reject) => {
    const parser = parse({
      columns: true,
      bom: true,
      relax_quotes: true,
      skip_empty_lines: true,
    });

    fs.createReadStream(CSV_PATH)
      .pipe(iconv.decodeStream('euc-kr'))
      .pipe(parser)
      .on('data', (row) => {
        counts.rows += 1;
        if (counts.rows % 50000 === 0) {
          console.log(`${counts.rows.toLocaleString('ko-KR')}행 처리 중...`);
        }

        const month = String(row.CRTR_YM || '').trim();
        if (month) months.add(month);

        const industryName = ensureIndustry(industryMap, row);
        if (!industryName) return;

        if (row.RGN_CD === 'AD_CL') {
          counts.ad += 1;
          const district = ensureDistrict(districts, row);
          if (!district) return;
          addDistrictIndustry(district, row, industryName, industryMap.get(industryName));
          return;
        }

        if (row.RGN_CD === 'SG_CL') {
          counts.sgg += 1;
          setNestedMetric(
            aggregates.sgg,
            String(row.SGG_NM || '').trim(),
            month,
            industryName,
            buildAggregateMetric(row, 'sgg'),
          );
          return;
        }

        if (row.RGN_CD === 'SI_CL') {
          counts.sido += 1;
          setNestedMetric(
            aggregates.sido,
            String(row.SIDO_NM || '').trim(),
            month,
            industryName,
            buildAggregateMetric(row, 'sido'),
          );
        }
      })
      .on('error', reject)
      .on('end', resolve);
  });

  console.log('JSON 파일을 쓰는 중입니다...');

  const monthList = Array.from(months).sort();
  const latestMonth = monthList[monthList.length - 1] || null;
  const industryList = Array.from(industryMap.keys()).sort(sortKo);
  const categories = Object.fromEntries(
    industryList.map((name) => [name, industryMap.get(name)]),
  );

  const index = {
    latestMonth,
    months: monthList,
    districts: Array.from(districts.values())
      .map((district) => ({
        code: district.code,
        name: district.name,
        sgg: district.sgg,
        sggCode: district.sggCode,
      }))
      .sort((a, b) => a.sggCode.localeCompare(b.sggCode) || a.code.localeCompare(b.code)),
  };

  const industries = {
    list: industryList,
    categories,
    aliases: buildAliases(industryList),
  };

  await Promise.all([
    writeJson(path.join(OUT_DIR, 'index.json'), index),
    writeJson(path.join(OUT_DIR, 'industries.json'), industries),
    writeJson(path.join(OUT_DIR, 'aggregates.json'), aggregates),
    ...Array.from(districts.values()).map((district) => (
      writeJson(path.join(DISTRICTS_DIR, `${district.code}.json`), toPlainDistrict(district))
    )),
  ]);

  const sample = districts.get('30110515')?.industries?.['편의점']?.m?.['202602']?.amt ?? null;

  console.log(JSON.stringify({
    rows: counts.rows,
    adRows: counts.ad,
    sggRows: counts.sgg,
    sidoRows: counts.sido,
    months: monthList.length,
    latestMonth,
    districts: districts.size,
    industries: industryList.length,
    sampleCentralConvenience202602Amt: sample,
  }, null, 2));
}

compile().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
