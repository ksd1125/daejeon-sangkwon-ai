# 상권AI 챗봇 — 인수인계 문서

> **최종 업데이트**: 2026-05-26 (세션63 라이브 검증 완료 기준)

---

## 아키텍처 (세션61 기준)

### 기술 스택
- **Vanilla JavaScript** (ES Modules), HTML5, CSS3 — 프레임워크 없음
- **Gemini 2.5 Flash API** (클라이언트 사이드, function calling + JSON mode + SSE streaming)
- **Chart.js** (차트), **Leaflet** (미니맵 GIS)
- **GitHub Pages** 배포 가능한 정적 사이트
- **디자인 토큰**: BRAND=#2D4540, BG=#F5F2EC, Pretendard 폰트

### 하이브리드 7-스테이지 파이프라인

```
사용자 질문
    │
    ▼
[Stage 1 Intent]   Gemini Router(4s) → legacy route(4s) → local IntentParser
[Stage 2 Plan]     Gemini Analyst(3s) → legacy plan → local _fallbackToolPlan
[Stage 3 Execute]  항상 local ToolDispatcher (QueryEngine + DataLoader)
[Stage 4 Build]    항상 local ResponseBuilder (카드/차트/지도 HTML 생성)
[Stage 5 Verify]   local _localVerification → Gemini Advisor(2s) (조건부)
[Stage 6 Render]   항상 local ChatUI (버블 렌더링 + 차트 삽입)
[Stage 7 Enrich]   병렬: Gemini streaming(10s) OR local typeText
                   병렬: Gemini follow-ups(2s) OR local response.followUps
```

- 각 스테이지가 독립적으로 Gemini↔Local 폴백
- 전체 15초 데드라인 (`PIPELINE_TIMEOUT`)
- `PipelineContext`가 매 질문마다 `[Pipeline] 3/5 gemini, 2400ms` 콘솔 출력

### 3-Agent 구성

| Agent | 파일 | API Key | 역할 | 타임아웃 |
|-------|------|---------|------|---------|
| Router | `agent-router.js` | `gemini_api_key_router` | 질문→intentPlan (JSON) + legacy route (FC) | 4s |
| Analyst | `agent-analyst.js` | `gemini_api_key_analyst` | intentPlan→toolPlan (planner) + 해설 (SSE stream) | 3s / 10s |
| Advisor | `agent-advisor.js` | `gemini_api_key_advisor` | 검증 + follow-up 생성 + 맥락 요약 | 3s |

**키 마이그레이션**: `gemini_api_key` (레거시) → 3개 키로 자동 복제 (main.js init)

### 20개 JS 파일 역할

| 파일 | 역할 |
|------|------|
| `main.js` | 앱 진입점, 로컬 라우트 핸들러, 이벤트 바인딩 |
| `response-orchestrator.js` | **하이브리드 파이프라인 조율** (핵심) |
| `agent-router.js` | Gemini Router (intent + legacy FC) |
| `agent-analyst.js` | Gemini Analyst (planner + SSE narrator) |
| `agent-advisor.js` | Gemini Advisor (verify + follow-ups) |
| `chat-ui.js` | 채팅 버블 UI + typeText 애니메이션 |
| `tool-dispatcher.js` | Gemini FC → QueryEngine 로컬 실행 |
| `tool-definitions.js` | 7개 도구 JSON 선언 |
| `response-builder.js` | intent+data → 카드/차트/지도 HTML 생성 |
| `intent-parser.js` | 로컬 의도 파싱 (행정동/업종/질문유형) |
| `local-router.js` | 로컬 라우팅 (explain/refine/compare/new) |
| `conversation-state.js` | 대화 맥락 상태 관리 |
| `query-engine.js` | 로컬 데이터 쿼리 (82행정동 × 업종) |
| `data-loader.js` | JSON 데이터 로드 + 캐시 |
| `ui-controller.js` | orbit 상태바 + 히스토리 + 카드 HTML |
| `chart-renderer.js` | Chart.js 기반 차트 렌더링 |
| `map-controller.js` | Leaflet 미니맵 + 점포 마커 |
| `gemini-narrator.js` | 레거시 Gemini SSE narrator |
| `gemini-fallback.js` | Gemini 일반 대화 폴백 |
| `insight-engine.js` | (미사용, 향후 확장용) |

### localStorage 키

| 키 | 용도 |
|----|------|
| `gemini_api_key` | 레거시 단일 키 |
| `gemini_api_key_router` | Router 전용 키 |
| `gemini_api_key_analyst` | Analyst 전용 키 |
| `gemini_api_key_advisor` | Advisor 전용 키 |

---

## Git 상태 (세션61 종료 시)

- **최신 커밋**: `b75563ca chore: load local Gemini env for testing`
- **Working tree**: 클린
- **주요 커밋 이력** (세션59~61):
  - `5c306057` feat: Gemini 3-agent 아키텍처 도입
  - `8d2f9590` feat: improve commercial AI agent pipeline
  - `d7a787db` fix: improve comparison map store rendering
  - `11770f47` fix: strengthen sgg routing diagnostics
  - `b75563ca` chore: load local Gemini env for testing

---

## 알려진 이슈 (세션63 기준)

| # | 이슈 | 심각도 | 상태 |
|---|------|:---:|:---:|
| 5 | Advisor 타임아웃 | P3 | ✅ 해결 — 2s→3s 변경 (세션63) |
| 6 | Gemini API 429 할당량 초과 | P1 | ✅ 해결 — 다른 계정 키로 라이브 테스트 완료 |
| 7 | similar/sggIndustry Router 미포착 | P2 | ✅ 해결 — 정규식 오버라이드 + 프롬프트 보강 (세션63) |
| 8 | 후속질문 맥락 이어받기 실패 | P2 | ✅ 해결 — `_fillFromConversation()` 통합 (세션63) |
| 9 | Local IntentParser smalltalk 미감지 | P3 | 미결 — Router 429 시 "안녕" 등이 분석으로 처리 |

> 이슈 #1~#8은 세션61~63에서 해결됨

---

## 핵심 참조 파일

| 순서 | 파일 | 이유 |
|:---:|------|------|
| 1 | `app/js/response-orchestrator.js` | 하이브리드 파이프라인 핵심 |
| 2 | `app/js/main.js` | 앱 진입점 + 로컬 핸들러 |
| 3 | `app/js/response-builder.js` | 카드/차트 생성 로직 |
| 4 | `app/js/tool-dispatcher.js` | 도구 실행 + 법정동 해소 |
| 5 | `app/js/agent-router.js` | 의도 라우팅 + 정규식 |

---

## 즉시 실행 가능 명령

```bash
# 로컬 서버 실행
python -m http.server 3456
# 또는
npx serve -l 3456 -s app

# JS 구문 검증 (전체 20파일)
cd app/js && for %f in (*.js) do @echo %f: & node -c %f
```

---

## 이력

이 프로젝트의 이전 세션(54~61)은 `../../work/worklogs/`에 기록되어 있습니다.
세션62부터 이 디렉토리(`worklogs/`)에 독립 기록합니다.
