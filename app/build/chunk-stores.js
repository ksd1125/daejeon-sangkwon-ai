/**
 * chunk-stores.js — 42MB 점포 데이터를 행정동별 청크로 분할
 * 입력: data/micro/stores-daejeon.synthetic.json (78,607건)
 * 출력: data/micro/stores/{districtCode}.json + manifest.json
 *
 * Usage: node build/chunk-stores.js
 */
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('fs');
const { join } = require('path');
const dataDir = join(__dirname, '..', 'data', 'micro');
const outDir = join(dataDir, 'stores');

// 출력 디렉토리 생성
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log('[chunk-stores] Loading stores-daejeon.synthetic.json...');
const raw = JSON.parse(readFileSync(join(dataDir, 'stores-daejeon.synthetic.json'), 'utf8'));
const stores = raw.stores || [];
console.log(`[chunk-stores] Total stores: ${stores.length}`);

// districtCode 기준 그룹핑
const groups = {};
for (const s of stores) {
  const code = s.districtCode;
  if (!code) continue;
  if (!groups[code]) groups[code] = [];
  // 5필드만 추출 (용량 절감)
  groups[code].push({
    id: s.id,
    name: s.name || '',
    industry: s.industry || '',
    coordinates: s.coordinates || null,
    sales: s.syntheticSalesManwon || {},
  });
}

// 각 행정동별 파일 출력
const manifest = {};
for (const [code, items] of Object.entries(groups)) {
  writeFileSync(join(outDir, `${code}.json`), JSON.stringify(items));
  manifest[code] = items.length;
}

// manifest 출력
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const codes = Object.keys(manifest);
const totalOut = Object.values(manifest).reduce((a, b) => a + b, 0);
console.log(`[chunk-stores] Done: ${codes.length} districts, ${totalOut} stores total`);
console.log(`[chunk-stores] Output: ${outDir}`);
