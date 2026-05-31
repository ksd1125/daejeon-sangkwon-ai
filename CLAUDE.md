# 상권AI 챗봇

## Working Directory
- 소스코드: `app/` (ES Modules, 20개 JS 파일)
- 작업 로그: `worklogs/INDEX.md` (세션 시작 시 반드시 읽기)
- 세션 상세: `worklogs/session-N.md`
- 인수인계: `worklogs/handover.md` (아키텍처 + 전체 맥락)
- 서버 실행: `python -m http.server 3456` (app 폴더에서) 또는 `npx serve -l 3456 app`
  - ⚠️ `serve`에 `-s`/`--single`(SPA) 플래그 금지 — index.html로 폴백되어 `admin-reports.html`이 안 열림 (이 사이트는 2개 페이지 정적 사이트)

## Tech Stack
- Vanilla JavaScript (ES Modules), HTML5, CSS3
- Gemini 2.5 Flash API (클라이언트 사이드, function calling + JSON mode + SSE streaming)
- Chart.js (차트), Leaflet (미니맵 GIS)
- GitHub Pages 배포 가능한 정적 사이트
- 디자인 토큰: BRAND=#2D4540, BG=#F5F2EC, Pretendard 폰트

## Architecture — 하이브리드 7-스테이지 파이프라인

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
- API 키 없어도 orchestrator가 로컬 모드로 정상 동작

### 3-Agent 구성

| Agent | 파일 | 역할 | 타임아웃 |
|-------|------|------|---------|
| Router | `agent-router.js` | 질문→intentPlan (JSON) + legacy route (FC) | 4s |
| Analyst | `agent-analyst.js` | intentPlan→toolPlan (planner) + 해설 (SSE stream) | 3s / 10s |
| Advisor | `agent-advisor.js` | 검증 + follow-up 생성 + 맥락 요약 | 2s |

### 7개 도구 (Tool Declarations)

| 도구 | 용도 |
|------|------|
| `analyzeDistrictIndustry` | 행정동+업종 분석 (매출/업소/유동인구/추세/밀도) |
| `getDistrictOverview` | 행정동 전체 상권 현황 |
| `compareDistricts` | 2지역 비교 |
| `findSimilarDistricts` | 유사 상권 5곳 |
| `mergeDistricts` | 생활권 합산 분석 |
| `rankDistrictsByIndustry` | 구 내 행정동 순위 |
| `analyzeSggIndustry` | 구 단위 추세 |

## Session Protocol

### 세션 시작 (필수)
1. `worklogs/INDEX.md` 읽기 → 현재 상태 + 다음 작업 파악
2. 작업 성격에 맞는 superpowers 스킬 확인 → `../../superpowers/skills/<skill-name>/SKILL.md`

### 세션 종료
3. `worklogs/session-N.md` 생성 (날짜/목표/키워드 태그)
4. `worklogs/INDEX.md` "현재 상태" + 세션 목록 업데이트

### 규칙
- 서브에이전트는 worklogs 파일을 직접 수정하지 않음 (메인 에이전트만 기록)
- `.env`와 `app/env.local.js`는 커밋 금지

## 변동 이력 관리 (필수)

**코드·데이터·설정에 변동을 가하는 모든 작업은 `app/data/change-log.json`에 항목을 추가한다.**
관리자 페이지(`/admin-reports.html`)가 이 파일을 로드해 최신순으로 표시하며, 이것이 영구 이력 원장이다.

### 기록 시점
- 기능 추가/수정, 버그 수정, 리팩터, 데이터/설정 변경, 회귀 수정, 중요한 설계 판단(미변경 결정 포함)

### 항목 스키마 (배열의 한 객체)
```json
{
  "id": "<actor>-<YYYYMMDD>-<slug>",   // 고유. 같은 id면 덮어씀(수정)
  "at": "ISO8601 timestamp",
  "actor": "Claude|Codex|Gemini|사람",
  "tool": "Claude|Codex|Gemini|Human|Other",
  "scope": "상권 AI · <영역>",
  "method": "무엇을 왜 어떻게 고쳤는지",
  "files": ["app/js/..."],
  "verification": ["node --check", "회귀 N회", "UI 확인"],
  "note": "다음 작업자가 주의할 점·트레이드오프"
}
```

### 운영
- 새 항목은 **배열 끝에 추가**(정렬은 페이지가 `at` 기준 최신순으로 처리)
- 기존 변경을 되돌리지 말 것 — `note`/이력을 존중하고 필요한 부분만 surgical하게
- 관리자 페이지 폼으로 추가하면 브라우저 localStorage에 누적되지만, **영구 기록은 반드시 `change-log.json`에 반영**(localStorage는 브라우저별 휘발)
- worklogs(session-N.md)는 서술형 상세, change-log.json은 구조화된 원장 — 둘 다 갱신

## Coding Guidelines (Karpathy 4원칙)

### 1. Think Before Coding
가정하지 말고, 트레이드오프를 드러내라. 불확실하면 질문.

### 2. Simplicity First
요청 범위 밖의 기능 없음. 단일 사용 코드에 추상화 없음.

### 3. Surgical Changes
꼭 필요한 부분만 수정. 변경된 모든 줄이 사용자 요청으로 직접 추적 가능해야 함.

### 4. Goal-Driven Execution
성공 기준을 정의하고 검증될 때까지 반복.

## 산출물 작성 규칙 — HTML 우선

사용자에게 전달하는 산출물(보고서, 서베이, 기획서)은 `.html`로 작성.
- 자체 완결(CSS 인라인), 반응형(max-width: 960px), 인쇄 친화(@media print)
- 저장 위치: `outputs/` 또는 worklogs 내 참조
- worklogs, CLAUDE.md 등 시스템 문서는 `.md` 유지

## Gemini Env Flow

```
.env → app/env.local.js → window.__COMMERCIAL_AI_ENV → localStorage keys
```

키 구조: `gemini_api_key` (레거시) → `gemini_api_key_router`, `_analyst`, `_advisor` 자동 복제
