#!/usr/bin/env node
/**
 * update-data.js — 상권 AI 데이터 갱신 CLI 스크립트
 *
 * 사용법:
 *   node scripts/update-data.js --source ./raw-data/
 *   node scripts/update-data.js --help
 *
 * 기능:
 *   1. 원본 CSV/JSON → app/data/districts/*.json 변환
 *   2. app/data/index.json 버전 자동 갱신
 *   3. GeoJSON ↔ districts 불일치 감지
 */

const fs = require('fs');
const path = require('path');

const APP_DATA = path.resolve(__dirname, '..', 'app', 'data');

function showHelp() {
  console.log(`
상권 AI 데이터 갱신 스크립트

사용법:
  node scripts/update-data.js [옵션]

옵션:
  --source <dir>   원본 데이터 디렉토리 (CSV/JSON)
  --validate       GeoJSON ↔ index.json 불일치만 검사
  --help           이 도움말 표시

예시:
  node scripts/update-data.js --validate
  node scripts/update-data.js --source ./raw-data/

갱신 절차:
  1. 소상공인시장진흥공단에서 최신 상가정보 CSV 다운로드
  2. --source 옵션으로 원본 디렉토리 지정하여 실행
  3. 실행 결과로 app/data/districts/*.json 갱신
  4. app/data/index.json의 dataVersion, lastUpdated 자동 업데이트
  5. 행정동 변경 시 GeoJSON도 별도 교체 필요
`);
}

function validateConsistency() {
  console.log('\n[검증] GeoJSON ↔ index.json 불일치 검사...');

  const indexPath = path.join(APP_DATA, 'index.json');
  const geojsonPath = path.join(APP_DATA, 'daejeon-districts.geojson');

  if (!fs.existsSync(indexPath)) {
    console.error('  ✗ index.json 없음:', indexPath);
    return false;
  }
  if (!fs.existsSync(geojsonPath)) {
    console.error('  ✗ GeoJSON 없음:', geojsonPath);
    return false;
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));

  const indexCodes = new Set((index.districts || []).map(d => String(d.code)));
  const geoCodes = new Set(
    (geojson.features || []).map(f => String(f.properties?.code || '')).filter(Boolean)
  );

  const missingInGeo = [...indexCodes].filter(c => !geoCodes.has(c));
  const missingInIndex = [...geoCodes].filter(c => !indexCodes.has(c));

  console.log(`  index.json: ${indexCodes.size}개 행정동`);
  console.log(`  GeoJSON:    ${geoCodes.size}개 피처`);

  if (missingInGeo.length === 0 && missingInIndex.length === 0) {
    console.log('  ✓ 불일치 없음 — 모든 코드가 일치합니다.');
    return true;
  }

  if (missingInGeo.length > 0) {
    console.warn(`  ✗ index에만 있는 코드 (GeoJSON 누락): ${missingInGeo.join(', ')}`);
  }
  if (missingInIndex.length > 0) {
    console.warn(`  ✗ GeoJSON에만 있는 코드 (index 누락): ${missingInIndex.join(', ')}`);
  }
  return false;
}

function checkDistrictFiles() {
  console.log('\n[검증] districts/*.json 파일 검사...');

  const indexPath = path.join(APP_DATA, 'index.json');
  const districtsDir = path.join(APP_DATA, 'districts');

  if (!fs.existsSync(indexPath)) {
    console.error('  ✗ index.json 없음');
    return;
  }
  if (!fs.existsSync(districtsDir)) {
    console.error('  ✗ districts/ 디렉토리 없음');
    return;
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const codes = (index.districts || []).map(d => String(d.code));
  const files = fs.readdirSync(districtsDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

  const missingFiles = codes.filter(c => !files.includes(c));
  const extraFiles = files.filter(f => !codes.includes(f));

  console.log(`  index.json: ${codes.length}개 행정동`);
  console.log(`  districts/: ${files.length}개 파일`);

  if (missingFiles.length > 0) {
    console.warn(`  ✗ 파일 누락 (${missingFiles.length}개): ${missingFiles.slice(0, 5).join(', ')}${missingFiles.length > 5 ? '...' : ''}`);
  }
  if (extraFiles.length > 0) {
    console.warn(`  ✗ 불필요 파일 (${extraFiles.length}개): ${extraFiles.slice(0, 5).join(', ')}${extraFiles.length > 5 ? '...' : ''}`);
  }
  if (missingFiles.length === 0 && extraFiles.length === 0) {
    console.log('  ✓ 모든 행정동 파일이 일치합니다.');
  }
}

function updateVersion() {
  const indexPath = path.join(APP_DATA, 'index.json');
  if (!fs.existsSync(indexPath)) return;

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.lastUpdated = new Date().toISOString();
  index.dataVersion = index.latestMonth || index.dataVersion;
  index.districtCount = (index.districts || []).length;

  fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');
  console.log(`\n[갱신] index.json 업데이트 완료`);
  console.log(`  dataVersion:   ${index.dataVersion}`);
  console.log(`  districtCount: ${index.districtCount}`);
  console.log(`  lastUpdated:   ${index.lastUpdated}`);
}

// ── CLI 실행 ──

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  showHelp();
  process.exit(0);
}

console.log('=== 상권 AI 데이터 갱신 스크립트 ===');

if (args.includes('--validate')) {
  validateConsistency();
  checkDistrictFiles();
  process.exit(0);
}

const sourceIdx = args.indexOf('--source');
if (sourceIdx !== -1 && args[sourceIdx + 1]) {
  const sourceDir = path.resolve(args[sourceIdx + 1]);
  if (!fs.existsSync(sourceDir)) {
    console.error(`원본 디렉토리가 없습니다: ${sourceDir}`);
    process.exit(1);
  }
  console.log(`원본 디렉토리: ${sourceDir}`);
  console.log('※ CSV → JSON 변환은 원본 데이터 형식에 따라 커스터마이징이 필요합니다.');
  console.log('  현재는 검증만 실행합니다.');
}

validateConsistency();
checkDistrictFiles();
updateVersion();

console.log('\n완료.');
