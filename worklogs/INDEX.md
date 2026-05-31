# 상권AI 챗봇 — 작업 로그 인덱스

> **운영 규칙**
> - 세션 시작 시 이 파일 읽기 → handover.md 필요 시 참조
> - 세션 종료 시 "현재 상태" 업데이트 + 해당 세션 파일 생성

---

## 현재 상태 (세션71, 2026-05-30)

**최근 작업**: 오류 감사 50건 → **전면 개선 41건 수정·검증 완료** (redteam-d)
- ✅ R3 조사(josa.js 신설), R4 분모(247→영업업종), R1 인사이트(업체당매출 제거), R2 sgg경고 렌더, R5 정형외과 오매칭 차단, R6 merge0/자동선택고지/delta0 등 + #48 배지회귀
- 🔍 검증: node --check 9파일 + ToolDispatcher 80회 회귀(크래시·누출·조사오류 0) + UI 라이브
- ✅ 전면 개선 완료(redteam-f): **정확 집계 40/50 완전 수정** + 5 부분완화 + 5 데이터/정책(코드 외)
  - (5차 "47건"은 번호 혼동 과대보고였고, 6차에서 정확 재집계 + 누락 8건 마무리: 밀도라우팅·유사상권dedup·빈추세·brand고지·맥락가드·지표라벨·소표본)
- 🔬 원자료 직접 조사(districts JSON + 12,206 레코드): #8·26·49·50 = **모두 데이터 정상, 버그 아님** 확인
  - #8 upso=100(100배수 1/12206), #26·49 peakTime 82/82 정확(오후피크 실제패턴), #50 목동 의류=일관 고가클러스터
- #37 disambiguation → **설계적정 종결**(법정동=생활권 auto-merge 적정, 고지+개별내역 이미 제공). 차단 프롬프트 미도입
- **→ 50/50 전부 정리 완료** (40 수정 + 5 완화 + 4 데이터정상 + 1 설계적정, 코드 미해결 0)
- 📒 **이력관리 시스템 구축**: `app/data/change-log.json`(시드 10건) + admin-reports.html이 로드·병합. CLAUDE.md에 "변동 이력 관리" 운영규칙 명문화
- 🔁 **자율 QA 루프 시뮬레이션**(체계+무작위): 탐지→기록→관리자 자동검토→수정→이력화 전 과정 실행
  - 330 계층표집(12질문유형×5구) production 0건 + 엣지/퍼징 + 다중턴 → **다중턴이 회귀 2건 포착·수정**
  - **QA-F2(High)**: 직전 #19 가드 과교정 회귀("그럼 둔산1동은?" 업종 미계승) → 명시 overview 키워드일 때만 차단으로 수정
  - **QA-F1(Low)**: #40 안내를 note로 이동(narrative 누락 해소)
  - findings→`data/error-reports.json`(admin 페이지 표시), 수정→change-log. 리포트: `outputs/qa-loop-20260531.html`. 캐시 qa-g
- 🔁🔁 **QA 반복 라운드(다지역 꼬리물기) 6회**: 5개 구 전역 미사용 동 + 법정동 별칭 + 의료 다중턴 → **3건 추가 발견·수정**
  - **QA-F4(High)**: '유성구 약국 1위'→일반병원 오매칭(별칭사전 약국→일반병원) → _resolveIndustry에 정확업종 별칭미적용 가드
  - **QA-F3(Mid)**: pop "피크 시간대는 토요일"(요일 오라벨) → 피크 요일/시간대 분리
  - **QA-F5(Mid)**: "한의원은?/약국은?" 조사포함 raw로 어색한 해석안내 → raw='업종+조사'면 안내 생략
  - 검증: 60쿼리 회귀 0 + 정확업종 보존 20/20. 캐시 qa-i. 데이터 후속과제: 의원→일반병원 별칭 정합성
- 🏗️ **무료 자동 QA 프레임워크 확장** (토큰 0): `test-suites.js`에 `regression`(과거 수정 재발 단언)·`regionSwitchChain`(지역전환 꼬리물기 carry) 유형 + josa/누출 validator(2만건 fullMatrix 적용). `test-runner.js`에 ToolDispatcher+orchestrator+ConversationState+다리(실패→localStorage→admin 페이지)
  - 비용구조: **반복 탐지=test.html(JS,토큰0) / triage=Gemini(선택) / 수정=Claude·사람(버그날때만)**
  - 프레임워크가 즉시 신규 버그 포착·수정: **QA-F6(High)** 브랜드 '정동'이 행정동 '오정동'에 오매칭 → _extractIndustry가 행정동명 제거 후 매칭. L1 275케이스 전부 통과(회귀4/4·지역전환4/4). 캐시 qa-j
  - ⚠️ josa validator false positive 정정: L3 전수서 109 '실패'는 전부 내 탐지기 오류('노래방은'·'업소 수와'는 정답). validator 수정(앱은 정상). 사용자는 admin '오류 신고 삭제' 후 L3 재실행 권장
- 🆕 **법정동 비교 지원**(사용자 제보→테스트→수정): "둔산동 카페" 뒤 "반석동과 비교"가 안 되던 문제(복수 행정동 묶음 법정동 간 비교). ConversationState merge소스명 보관 + compare carry가 법정동 인식. **legalDongCompare 자동화 테스트 신설**(제보가 영구 가드됨). UI 검증: 둔산동(3동merge) vs 반석동(2동merge) 정상. 캐시 qa-k
- 검증: node --check + 140회×7도구 회귀 0 + UI 다중턴 + 원자료. 📄 `outputs/error-audit-20260530.html`. 캐시 redteam-f
- 📄 산출물: `outputs/error-audit-20260530.html` (카테고리·심각도·소스라인·수정안)
- 🔴 High 5: ①overview "247개 업종" 오집계(모든 동) ②정형외과→성형외과 오매칭 ③merge 결손 "0개"+모순 평균 ④sgg_sub 참고값 경고 미렌더 ⑤미인식 업종 무고지 폴백
- 🟠 조사(은/는·과/와) 하드코딩 전반, 의료과목 미매칭, brand 무고지, "밀도" density 미트리거, "전국" 오표기 등
- ⚪ 기각: 스트리밍429/JSON/density0/insight NaN%/follow-up체인/amt0(2만건) = 기존 가드로 방어

**이전 (세션70)**: 레드팀 디버그 검토 + 안정성/a11y 개선
- ✅ **동시 질문 가드**: `handleQuestion`에 `inFlight` 락 (스트리밍 중 중복 질문/칩 경쟁 차단)
- ✅ **XSS 이스케이프**: `chat-ui.js` setMeta/setFilterRow/setMapCard에 `escapeHtml` + badge.color hex 검증
- ✅ **a11y**: narrative `aria-live`, 설정 모달 포커스 복원(ESC 포함)
- ✅ **견고성**: `_is429` 비-Error 방어, 데드코드 제거
- ✅ **레드팀 검증**: 감사 ~33건 중 false positive 6종 기각(이미 방어된 코드), 실제 결함만 수정
- ✅ **검증**: node --check 통과 + 브라우저 라이브(동시가드/모달포커스/회귀) 확인, 콘솔 에러 없음

**이전 (세션69)**: Follow-up 칩 버그 3건 수정 (꼬리물기 안정화)

### 다음 세션 작업 순서

| 순위 | 작업 | 비고 |
|:---:|------|------|
| **1** | P2: 대화 맥락 기반 비교 추론 미지원 | "A랑 비슷한 데는?" 등 |
| 2 | P3: 지도 표기 metric 반영 | 업소수 질의 시 지도 마커도 업소수 기준 |
| 3 | Local smalltalk 감지 추가 | IntentParser에 인사/잡담 패턴 추가 |
| 4 | v3 Phase 4: 지식배움터(KB) | 안정화 완료 후 착수 |

### 알려진 이슈

| # | 이슈 | 심각도 | 상태 |
|---|------|:---:|:---:|
| 12 | ~~merge/sgg 후 follow-up carry 실패~~ | P0 | ✅ 해결 — 세션66 |
| 13 | ~~"노은동" merge 미트리거~~ | P1 | ✅ 해결 — 세션66 (5개 구 매핑 보강) |
| 14 | ~~merge 평균 매출 단순평균~~ | P2 | ✅ 해결 — 세션66 (업소수 가중평균) |
| 15 | ~~"작년 대비" 추세 전용 뷰 미분화~~ | P2 | ✅ 해결 — 세션67 |
| 16 | ~~데이터 없음 시 대안 미제안~~ | P2 | ✅ 해결 — 세션67 |
| 18 | ~~follow-up 칩 크래시 (compareIndustry 빈 sides)~~ | P1 | ✅ 해결 — 세션69 |
| 17 | 대화 맥락 기반 비교 추론 미지원 | P2 | 미결 |
| 9 | Local IntentParser smalltalk 미감지 | P3 | 미결 |
| 5~8,10,11 | (이전 이슈) | — | ✅ 모두 해결 |

---

## 세션 목록

> 세션54~61은 공유 워크로그(`../../work/worklogs/`)에 기록됨. 세션62부터 이 위치에 기록.

| 세션 | 요약 | 키워드 |
|------|------|--------|
| [71](session-71.md) | 무작위 오류 감사 (레드팀 QA) — 22건 | `#오류감사` `#레드팀QA` `#조사버그` `#overview247` `#정형외과오매칭` `#sgg_sub무경고` |
| [70](session-70.md) | 레드팀 디버그 검토 + 안정성/a11y 개선 | `#레드팀검토` `#동시질문가드` `#XSS이스케이프` `#a11y` `#falsePositive검증` |
| [69](session-69.md) | Follow-up 칩 버그 3건 수정 (꼬리물기 안정화) | `#follow-up버그` `#compareIndustry크래시` `#industry누출` `#맥락명시` |
| [68](session-68.md) | 3-Level 자동화 테스트 프레임워크 (21,313건/11s) | `#테스트프레임워크` `#자동화테스트` `#FullMatrix` `#MessageChannel` `#버그수정` |
| [67](session-67.md) | P2 가중평균 + 추세뷰 + 대안 제안 | `#P2수정` `#가중평균` `#추세뷰` `#YoY라우팅` `#대안제안` |
| [66](session-66.md) | P0 follow-up carry + P1 법정동 매핑 + P2 가중평균 | `#P0수정` `#P1수정` `#P2수정` `#follow-up` `#법정동매핑` `#가중평균` |
| [65](session-65.md) | 페르소나 사용성 테스트 24턴 + HTML 리포트 | `#페르소나테스트` `#사용성` `#교차검증` `#follow-up이슈` `#HTML리포트` |
| [64](session-64.md) | P3 법정동 merge metric 버그 수정 + 검증 | `#P3버그` `#법정동merge` `#metric파라미터` `#업소수차트` `#추세차트` |
| [63](session-63.md) | 법정동 매칭사전 + Gemini Phase 1&2 + 라이브 19건 검증 | `#법정동매칭` `#Phase1` `#Phase2` `#맥락전달` `#Router보강` `#라이브검증` |
| [62](session-62.md) | 문서 분리 + P2 검증 + 통합 테스트 | `#문서정비` `#P2검증` `#통합테스트` `#프로젝트분리` |
| [61](../../work/worklogs/session-61.md) | P0/P1 후속 수정 + Gemini 라이브 검증 | `#비교라우팅` `#미니맵스타일` `#SGG라우팅` `#라이브검증` |
| [60](../../work/worklogs/session-60.md) | 하이브리드 파이프라인 구축 | `#하이브리드` `#PipelineContext` `#스테이지폴백` `#타임아웃단축` |
| [59](../../work/worklogs/session-59.md) | 3-Agent 디버깅 & 의도 에코 UX | `#3-agent` `#의도에코` `#디버깅` `#SSE안전정리` |
| [58](../../work/worklogs/session-58.md) | 디자인 적용 Phase A+B | `#시각정체성` `#그룹칩` `#헤더` `#종합카드` |
| [57](../../work/worklogs/session-57.md) | UX 개선 8건 + 점포 마커 | `#지도지연등장` `#점포마커` `#모바일최적화` |
| [56](../../work/worklogs/session-56.md) | v3 Phase 2 — 그래프+지도+디자인 | `#multiLine` `#stackedBar` `#비교` `#Pretendard` |
| [55](../../work/worklogs/session-55.md) | v3 Phase 1 — 오케스트레이션+비교 | `#orchestration` `#LocalRouter` `#compare` |
| [54](../../work/worklogs/session-54.md) | v2 전환 — GIS+Gemini+채팅UI | `#Leaflet` `#GIS` `#Gemini_narrator` `#chat_UI` |

### 아키텍처 참조
- `worklogs/handover.md` — 전체 아키텍처, 20개 파일 역할, 도구 선언, localStorage 키
