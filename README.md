# 대전 상권 AI 챗봇

대전 82개 행정동 · 247개 업종의 매출 · 업소 수 · 유동인구 데이터를 자연어로 질의하는
정적 웹 챗봇입니다. 지역과 업종을 물어보면 매출/업소/유동인구/추세/밀도, 지역 비교,
순위, 유사 상권 등을 카드 · 차트 · 미니맵으로 보여줍니다.

🔗 **라이브**: `https://<your-username>.github.io/<repo>/`
*(배포 후 실제 URL로 교체하세요)*

## 특징

- **하이브리드 7-스테이지 파이프라인**: 의도 파악 → 계획 → 실행 → 빌드 → 검증 → 렌더 → 보강.
  각 단계가 Gemini ↔ 로컬로 독립 폴백 → **API 키 없이도 로컬 모드로 동작**.
- Vanilla JavaScript (ES Modules), 외부 프레임워크 없음.
- Chart.js(차트) · Leaflet(미니맵 GIS).
- 꼬리물기(다중턴) 대화: "둔산동 카페 매출" → "반석동과 비교해줘" 같은 맥락 연결 지원.

## 로컬 실행

```bash
cd app
python -m http.server 3456
# 브라우저에서 http://localhost:3456 접속
```

> ⚠️ `serve`의 `-s`/`--single`(SPA) 플래그는 쓰지 마세요 — `admin-reports.html`이 열리지 않습니다.

## API 키 설정

모든 키는 **저장소에 커밋되지 않으며**, 각 위치에서 별도로 주입합니다.
(`.env`, `app/env.local.js`, `app/build/secrets/`는 모두 `.gitignore` 처리)

### 1) Gemini (런타임 · 선택)
키가 없어도 로컬 데이터로 동작합니다. 더 자연스러운 해설·후속 질문을 원할 때만 필요합니다.
- **배포된 공개 사이트**: 방문자가 우측 상단 **설정** 모달에서 각자
  [Gemini 키](https://aistudio.google.com/apikey)를 입력 (브라우저 localStorage에만 저장).
- **로컬 개발 자동 주입**: `app/env.local.example.js` → `app/env.local.js`로 복사 후 키 입력.

### 2) 공공데이터 (빌드 시 · 데이터 재생성용)
상가 데이터를 다시 수집·빌드할 때만 필요합니다. 루트 `.env`에 키를 넣습니다.
```bash
cp .env.example .env     # 후 PUBLIC_DATA_STORE_API_KEY / FAIRTRADE_FRANCHISE_API_KEY 입력
node app/build/collect-store-api.js                  # 소상공인 상가 API
node app/build/collect-franchise-brand-dictionary.js # 공정위 가맹사업 API
```
빌드 스크립트는 `.env`(또는 환경변수, `--service-key`/`--key-file` 플래그) 순으로 키를 찾습니다.

## 배포 (GitHub Pages)

`main` 브랜치에 push하면 `.github/workflows/deploy-pages.yml`이 `app/` 폴더를
Pages 사이트 루트로 자동 발행합니다. 저장소 **Settings → Pages → Source**가
**GitHub Actions**로 설정되어 있어야 합니다.

## 데이터

대전광역시 상권 분석용 가공 데이터(2026년 기준). 런타임은 `app/data/`의 행정동별 ·
업종별 집계 JSON과 행정동 경계 GeoJSON을 지연 로드합니다. 원본 수집 · 빌드 스크립트와
API 키는 배포본에 포함되지 않습니다.
