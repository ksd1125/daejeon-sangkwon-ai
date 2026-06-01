// ─────────────────────────────────────────────────────────────
// 이 파일을 복사해 같은 폴더에 `env.local.js` 로 저장하세요.
//   cp app/env.local.example.js app/env.local.js
// `env.local.js` 는 .gitignore 처리되어 커밋되지 않습니다.
//
// 로컬 개발에서 Gemini API 키를 자동 주입합니다.
// 배포된 공개 사이트에서는 방문자가 우측 '설정' 모달에서 각자 키를 입력합니다.
// 키 발급: https://aistudio.google.com/apikey
// 키가 없으면 앱은 로컬 모드로 정상 동작합니다(Gemini 해설만 비활성).
// ─────────────────────────────────────────────────────────────
window.__COMMERCIAL_AI_ENV = {
  // 단일 키 — 3개 에이전트(router/analyst/advisor)에 자동 복제됩니다.
  // GEMINI_API_KEY: 'YOUR_GEMINI_KEY',

  // 또는 에이전트별로 분리(429 할당량 분산):
  // GEMINI_API_KEY_ROUTER:  'YOUR_KEY',
  // GEMINI_API_KEY_ANALYST: 'YOUR_KEY',
  // GEMINI_API_KEY_ADVISOR: 'YOUR_KEY',
};
