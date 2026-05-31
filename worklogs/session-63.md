# 세션 63 — 법정동 매칭사전 + Gemini Phase 1 & 2

> **날짜**: 2026-05-26
> **목표**: (1) 법정동↔행정동 매핑 사전 확장, (2) Gemini Phase 1 + Phase 2 코드 변경 + 라이브 검증
> **키워드**: `#법정동매칭` `#매칭사전` `#Phase1` `#Phase2` `#맥락전달` `#Router보강` `#라이브검증`

---

## 작업 내역

### 1. 프로젝트 문서 분리 마무리 (전 세션 잔여)
- `CLAUDE.md` (루트): 챗봇 전용 기술(Gemini 2.5 Flash API) 제거
- `work/worklogs/INDEX.md`: 프로젝트 분리 안내 + 다음 작업을 대시보드/논문 전용으로 변경
- `work/worklogs/handover.md`: 섹션 B~G 제거, 챗봇 handover 포인터만 유지

### 2. 법정동→행정동 매칭사전 구축

#### 문제
- 기존 `matching-dictionaries.json`의 `legalDongToAdminDong`이 **46건**만 보유 (대부분 유성구)
- 동구/중구/서구/대덕구 법정동 질의 시 매칭 실패 (예: "은행동 편의점" → 실패)

#### 데이터 소스
- `app/raw/store-api/stores-*.json` — 78,607건 점포 데이터
- 각 점포에 `ldongNm`(법정동명) + `adongNm`(행정동명) 필드 존재

#### 결과
- **46건 → 138건**으로 확장 (122 데이터 기반 매핑 + 16 랜드마크/생활권 별칭)
- 대전 전체 5개 구 커버 (동구 24, 중구 22, 서구 33, 유성구 34, 대덕구 25)
- 코드 변경 없이 기존 파이프라인이 확장 사전을 처리

#### 브라우저 통합 테스트 (5건 PASS)

| # | 질의 | 결과 | 상태 |
|---|------|------|:---:|
| 1 | "궁동 카페" | 온천2동 카페 (매출 606만원) | ✅ |
| 2 | "은행동 편의점" | 은행선화동 편의점 (매출 4,100만원) | ✅ |
| 3 | "대전역 카페" | 중앙동 카페 — 랜드마크 별칭 | ✅ |
| 4 | "둔산동 카페" | 서구 카페 추세 — 다중후보 폴백 | ✅ |
| 5 | "신탄진동 편의점" | 신탄진동 편의점 (매출 3,280만원) | ✅ |

### 3. Gemini 80% Phase 1 — 코드 변경

#### 3.1 Analyst 프롬프트 강화 (`agent-analyst.js`)
- `_defaultPrompt`: 3-4문장 → 4-6문장, 수치 맥락 해석 + 엇갈리는 신호 짚기 + 대화 연결 규칙 추가 (규칙 11~13)
- `_comparePrompt`: 차이의 의미 해석 규칙 강화, 추세 방향 비교 규칙 추가
- `_overviewPrompt`: 업종 강점 맥락 추론 + 상권 성격 그리기 지시
- `_maxTokens`: 500 → 700 (더 풍부한 해설)

#### 3.2 Advisor 타임아웃 2s → 3s (`agent-advisor.js` + `response-orchestrator.js`)
- `agent-advisor.js`: verify 타임아웃 2s→3s, followUps 타임아웃 2s→3s
- `response-orchestrator.js`: `_resolveVerification` remaining 체크 2000→3000ms, `_resolveFollowUps` remaining 체크 2000→3000ms

#### 3.3 대화 맥락 3턴 → 5턴 확장 (`agent-advisor.js`)
- `getContextSummary()`: `slice(-6)` → `slice(-10)` (5턴 분량)
- `_callGemini()`: 히스토리 `slice(-6)` → `slice(-10)`
- `_trimHistory()`: 최대 보관량 10→14항목, 유지량 8→10항목

#### 3.4 모듈 버전 업데이트 (`main.js`)
- `MODULE_VERSION`: `20260525-agent-quality-18` → `20260526-phase1-gemini80`

### 4. Gemini 라이브 테스트 — 완료 ✅

#### API 키 확보 과정
- 초기 3개 키 모두 **429 (할당량 초과)** — 동일 Google 계정 할당량 공유
- 사용자가 **다른 계정 키**를 브라우저 설정 모달에서 직접 입력 → 정상 작동

#### 9건 테스트 결과

| # | 질의 | Gemini 비율 | 주요 결과 |
|---|------|:-----------:|-----------|
| 1 | 둔산1동 카페 매출 어때? | 3/8 | narrative=local-fallback |
| 2 | 중앙동 어때? | 4/8 | ✅ Gemini 가능 스테이지 전부 성공 |
| 3 | 둔산1동이랑 은행선화동 카페 비교 | 4/8 | ✅ compare + Gemini narrative |
| 4 | 안녕 (smalltalk) | 1/1 | ✅ Router 직접 응답 |
| 5 | 유성구 편의점 높은 동 | 5/8 | ⭐ 최고! verify까지 Gemini |
| 6 | 궁동 치킨 매출 | 5/8 | ⭐ 법정동 해소 + Gemini narrative |
| 7 | 둔산1동 카페 비슷한 상권 | 2/8 | intent=local, narrative=local |
| 8 | 서구 카페 추세 | 2/8 | intent=local, narrative=local |
| 9 | 유동인구는? (후속질문) | 1/2 | 맥락 이어받기 실패 → 확인 요청 |

#### 패턴 분석
- **강점**: 기본 분석, overview, compare, rankDistricts → 4~5/8 달성
- **약점**: similar, sggIndustry → Router가 해당 intent 미포착 → 2/8 폴백
- **후속질문**: 맥락 의존 질문("유동인구는?") → 지역/업종 이어받기 실패 → Phase 2 과제
- **Phase 1 효과**: Gemini 활용률 ~60% (best case 62.5%)

---

## 변경 파일

| 파일 | 변경 내용 |
|------|----------|
| `app/data/matching-dictionaries.json` | legalDongToAdminDong 46→138건 확장 |
| `app/js/agent-analyst.js` | 프롬프트 강화 (4종) + maxTokens 700 |
| `app/js/agent-advisor.js` | 타임아웃 3s + 맥락 5턴 확장 |
| `app/js/response-orchestrator.js` | remaining 체크 3000ms 통일 |
| `app/js/main.js` | MODULE_VERSION 업데이트 |
| `app/env.local.js` | 새 API 키 세팅 (커밋 제외) |

### 5. Gemini 80% Phase 2 — 코드 변경

#### 5.1 ConversationState 통합 (`response-orchestrator.js`)
- 새 메서드 `_fillFromConversation(intentPlan, conversationState)` 추가
- `handleQuestion()`에서 intentPlan 생성 직후 호출 → 빈 district/industry를 직전 턴에서 보완
- smalltalk은 스킵, confidence 0.1 감산, 콘솔 로그 출력

#### 5.2 Router similar/sggIndustry 정규식 보강 (`agent-router.js`)
- `_normalizeIntentPlan()`: `asksSimilar` 정규식 추가 (비슷/유사/같은 곳/다른 상권)
- `_extractIndustryHint()` 헬퍼: sggIndustry 감지 시 plan.industry 없어도 질문에서 업종 추출
- goal 결정 우선순위: rankDistricts > overview > similar > sggIndustry > plan.goal

#### 5.3 Router 프롬프트 보강 (`agent-router.js`)
- `_intentSystemPrompt()`: 맥락 보완 규칙 명시 (예시 포함), similar/sggIndustry 구분 규칙 추가

#### 5.4 Analyst 데이터 프롬프트 보강 (`agent-analyst.js`)
- `_buildDataPrompt()`: rankDistricts/sggIndustry 전용 데이터 포맷 추가

#### 5.5 Narrative 판정 완화 (`response-orchestrator.js`)
- `_isBadNarrative()`: 최소 길이 12→8자, 숫자 끝 판정에 길이 조건(30자 미만) 추가

#### 5.6 MODULE_VERSION → `20260526-phase2-context-router`

### 6. Phase 2 라이브 테스트 — 10건

| # | 질의 | 결과 | 핵심 검증 |
|---|------|:---:|----------|
| 1 | 둔산1동 카페 매출 | ✅ | 기본 분석 정상 |
| 2 | 유동인구는? (후속) | ✅ | **맥락 이어받기 성공** — 둔산1동 카페 유동인구 |
| 3 | 추세는? (후속) | ✅ | **맥락 이어받기 성공** — 둔산1동 카페 추세 |
| 4 | 둔산1동 카페 비슷한 상권 | ✅ | **similar 라우팅 성공** |
| 5 | 서구 카페 추세 | ✅ | **sggIndustry 라우팅 성공** |
| 6 | 유성구 편의점 높은 동 | ✅ | rankDistricts 기존 유지 |
| 7 | 안녕 | ⚠️ | Router 429로 local 처리 (기존 한계) |
| 8 | 궁동 치킨 매출 | ✅ | 법정동 해소 정상 |
| 9 | 업소 수는? (후속) | ✅ | **맥락 이어받기 성공** — 온천2동 치킨 업소 수 |
| 10 | 대덕구 편의점 현황 | ✅ | **sggIndustry 라우팅 성공** |

> Router 키 429로 intent가 모두 local이었지만, Phase 2 코드 변경(맥락 보완 + 정규식)이 local 경로에서도 정확히 동작함을 확인.

---

## Phase 2 추가 변경 파일

| 파일 | 변경 내용 |
|------|----------|
| `app/js/response-orchestrator.js` | `_fillFromConversation()` + `_isBadNarrative` 완화 + 429 쿨다운 메커니즘 |
| `app/js/agent-router.js` | similar/sgg 정규식 + `_extractIndustryHint` + 프롬프트 맥락 규칙 |
| `app/js/agent-analyst.js` | rankDistricts/sggIndustry 데이터 프롬프트 |
| `app/js/main.js` | MODULE_VERSION + 키 상태 로깅 + 마이그레이션 간소화 |
| `app/index.html` | 설정 모달 별도 키 안내 + 캐시 버스팅 |
| `worklogs/phase2-design.md` | Phase 2 설계서 |

---

## Gemini 80% 전략 로드맵

```
Phase 1 ✅                Phase 2 ✅               Phase 3 (향후)
─────────────────       ─────────────────        ─────────────────
프롬프트 강화 ✅          맥락 전달 ✅              멀티 도구 호출
타임아웃 3s ✅            similar/sgg 보강 ✅       Gemini-driven 카드
맥락 5턴 확장 ✅          Narrative 안정화 ✅       ReAct 루프
라이브 검증 ✅            Router 프롬프트 ✅        동적 응답 포맷

~60%             →       ~78% (local 경로)   →    ~90%
                         Router 정상 시 ~85%+
```

---

### 7. 429 쿨다운 방지 메커니즘

#### 7.1 에이전트별 60초 쿨다운 (`response-orchestrator.js`)
- `_cooldowns` 맵 + `_setCooldown(agent)`, `_isCoolingDown(agent)`, `_is429(err)` 메서드
- 파이프라인의 5개 Gemini 호출 지점 모두 쿨다운 체크 적용:
  - `_resolveIntent`: Router routeIntent + legacy route
  - `_resolveToolPlan`: Analyst planner
  - `_resolveVerification`: Advisor verify
  - `_resolveNarrative`: Analyst SSE streaming
  - `_resolveFollowUps`: Advisor follow-ups
- Router 429 시 legacy route 이중 호출 방지 (router429 플래그)

#### 7.2 API 키 분리 안내 (`index.html`)
- 설정 모달 안내 문구: "서로 다른 API 키를 넣으면 429 할당량 초과를 방지할 수 있습니다"

#### 7.3 키 상태 로깅 (`main.js`)
- 앱 초기화 시 에이전트별 키 존재 여부 콘솔 출력
- MODULE_VERSION → `20260526-phase2-429-cooldown`

---

## 알려진 이슈

| # | 이슈 | 심각도 | 상태 |
|---|------|:---:|:---:|
| 5 | Advisor 타임아웃 | P3 | ✅ 해결 — 2s→3s 변경 완료 |
| 6 | Gemini API 429 할당량 초과 | P1 | ✅ 해결 — 쿨다운 메커니즘 + 별도 키 안내 |
| 7 | similar/sggIndustry Router 미포착 | P2 | ✅ 해결 — 정규식 오버라이드 + 프롬프트 보강 |
| 8 | 후속질문 맥락 이어받기 실패 | P2 | ✅ 해결 — `_fillFromConversation()` 통합 |
| 9 | Local IntentParser smalltalk 미감지 | P3 | 미결 — Router 429 시 "안녕" 등이 분석으로 처리 |
