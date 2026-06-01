#!/usr/bin/env node
/**
 * extract-geojson.js — 전국 행정동 GeoJSON에서 대전 82개만 추출
 * 좌표 소수점 5자리 반올림, properties를 { code, name, sgg }로 축소
 *
 * Usage: node app/build/extract-geojson.js
 */
const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

const SOURCE = resolve(
  __dirname,
  '../../../sns-placeness-replication/sns-placeness-portable-bundle-2026-04-21/raw/geo/HangJeongDong_ver20250401.geojson'
);
const OUTPUT = resolve(__dirname, '../data/daejeon-districts.geojson');
const INDEX  = resolve(__dirname, '../data/index.json');

// 1) index.json에서 유효 코드 목록 확보
const indexData = JSON.parse(readFileSync(INDEX, 'utf-8'));
const validCodes = new Set(indexData.districts.map(d => String(d.code)));
const codeToInfo = Object.fromEntries(
  indexData.districts.map(d => [String(d.code), { name: d.name, sgg: d.sgg }])
);

// 2) 전국 GeoJSON 로드
console.log('Reading source GeoJSON...');
const source = JSON.parse(readFileSync(SOURCE, 'utf-8'));
console.log(`Total features: ${source.features.length}`);

// 3) 대전 필터 + 좌표 경량화
function roundCoords(coords) {
  if (typeof coords[0] === 'number') {
    return [+(coords[0].toFixed(5)), +(coords[1].toFixed(5))];
  }
  return coords.map(roundCoords);
}

const features = source.features
  .filter(f => {
    const cd2 = String(f.properties.adm_cd2 || '');
    const code = cd2.slice(0, 8);
    return code.startsWith('30') && validCodes.has(code);
  })
  .map(f => {
    const code = String(f.properties.adm_cd2 || '').slice(0, 8);
    const info = codeToInfo[code] || {};
    return {
      type: 'Feature',
      properties: { code, name: info.name || '', sgg: info.sgg || '' },
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) },
    };
  });

// 4) 저장
const output = { type: 'FeatureCollection', features };
writeFileSync(OUTPUT, JSON.stringify(output), 'utf-8');

const sizeKB = (Buffer.byteLength(JSON.stringify(output)) / 1024).toFixed(1);
console.log(`Output: ${OUTPUT}`);
console.log(`Features: ${features.length} / Expected: ${validCodes.size}`);
console.log(`Size: ${sizeKB} KB`);

// 검증
const outputCodes = new Set(features.map(f => f.properties.code));
const missing = [...validCodes].filter(c => !outputCodes.has(c));
if (missing.length) {
  console.warn(`WARNING: ${missing.length} codes missing:`, missing);
} else {
  console.log('All district codes matched.');
}
