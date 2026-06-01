// 최소 .env 로더 (의존성 없음).
// 저장소 루트의 .env 를 읽어 process.env 에 채웁니다. 이미 설정된 값은 덮어쓰지 않음.
// 키는 .env(gitignore)로 별도 주입 — 소스에 하드코딩하지 않습니다.
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.resolve(__dirname, '../../.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
}

loadEnv();
module.exports = { loadEnv };
