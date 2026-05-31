# 세션 67 — P2 가중평균 검증 + 추세 전용 뷰 분화

**날짜**: 2026-05-29
**목표**: P2 merge 가중평균 검증/커밋 + P2 "작년 대비" 추세 전용 뷰 분화
**키워드**: `#P2수정` `#가중평균` `#추세뷰` `#YoY라우팅` `#statsCard`

---

## 수행 내용

### 1. P2: merge 매출 가중평균 — 검증 및 커밋

세션66에서 코드 수정은 완료했으나 검증 미완이었던 가중평균 로직을 교차검증.

#### 검증 방법
둔산동(둔산1동+2동+3동) 카페 데이터를 raw JSON에서 직접 추출하여 수동 계산 후 merge 결과와 대조.

#### 검증 결과

| 구분 | 둔산1동 | 둔산2동 | 둔산3동 | 단순평균 | **가중평균** | **머지 결과** |
|------|---------|---------|---------|----------|-------------|---------------|
| 업소 수 | 80 | 121 | 20 | — | — | 221 (합산) |
| 매출(만원) | 1,645 | 2,077 | 894 | 1,539 | **1,814** | **1,814** ✅ |
| amtYoY(%) | -25.7 | -27.8 | -26.5 | -26.7 | -26.9 | -26.9 ✅ |

**커밋**: `37786bd`

---

### 2. P2: "작년 대비" 추세 전용 뷰 분화

#### 문제
"작년 대비 어때?" 질문이 `sales` 뷰로 라우팅되어 YoY 정보가 소형 delta 뱃지로만 표시됨.
추세 전용 뷰가 없어서 "작년 대비" 의도가 제대로 반영되지 않음.

#### 수정

**`intent-parser.js` — 우선 라우팅**
- `_extractQuestionType()`에서 compare 체크 직후, 일반 키워드 루프 전에 early-check 추가
- `/작년대비|전년대비|지난해대비|전년비/` → `trend` 반환
- "매출 작년 대비"처럼 sales+YoY 동시 키워드도 trend로 올바르게 라우팅

**`response-builder.js` — _buildTrend 보강**
1. **요약 텍스트 YoY 강조**: amtYoY 있으면 "전년 동월 대비 X% 상승/하락하여 현재 Y만원" 형식
2. **statsCard 신규 추가**: "전년 동월 대비" 제목 + 4셀 그리드
   - 업소당 월평균 매출 (▲/▼ YoY% 전년동월)
   - 업소 수 (▲/▼ YoY% 전년동월)
   - 매출 전월 대비 (MoM%)
   - 일평균 유동인구
3. **기존 trendCard(12개월 라인차트) 유지**: tierTrend 3-tier + fallback 단일 시리즈

#### 검증 (5/5 통과)

| # | 쿼리 | 기대 | 결과 |
|---|------|------|------|
| 1 | 둔산1동 카페 작년 대비 어때? | trend | ✅ 지표추세 + "전년 동월 대비" statsCard |
| 2 | 둔산1동 카페 추세 | trend | ✅ 지표추세 (기존 동작 유지) |
| 3 | 둔산1동 카페 매출 | sales | ✅ 지표매출 (회귀 없음) |
| 4 | 둔산1동 카페 매출 작년 대비 | trend | ✅ early-check 우선 |
| 5 | 관저1동 편의점 전년 대비 어때? | trend | ✅ 다른 동/업종 정상 |

**커밋**: `e289908`

---

### 3. P2: 데이터 없음 시 대안 업종·인근 동 제안

#### 문제
데이터 없는 업종 조회 시 "데이터가 없습니다" 한 줄만 표시. 사용자가 다음 행동을 모름.

#### 수정 (5개 파일)

**`query-engine.js` — `suggestAlternatives()` 신규**
- 같은 동의 인기 업종 Top 5 (업소 수 기준)
- 같은 구에서 해당 업종 데이터 있는 인근 동 최대 3개

**`tool-dispatcher.js` — 대안 데이터 첨부**
- `record === null` 시 alternatives 포함하여 반환
- `record.amt === null || record.upso === 0` 시에도 alternatives 첨부

**`response-orchestrator.js` — error+alternatives 통과**
- alternatives 있으면 error 조기 반환 대신 intent 생성 후 빌더로 통과

**`response-builder.js` — 대안 표시**
- `!record` 조기 반환: alternatives bullets + followUp 칩
- `_buildSales` amt=null: bullets에 인기업종·인근동 추가 + followUp 칩
- `_smartFollowUps` 호출 시 빌더가 설정한 대안 칩 보존

**`main.js` — 로컬 내러티브 보강**
- sales 타입 데이터 없음 시 대안 bullets 포함 + "추천 질문을 눌러보세요" 안내

#### 검증 (동구/대덕구/중구 9건, 드문 업종 포함)

| # | 구 | 동 | 업종 | 데이터 | 대안 | 결과 |
|---|---|---|------|:---:|:---:|:---:|
| 1 | 동구 | 효동 | 스쿼시 | ❌ | ✅ 인기업종 4개 | ✅ |
| 2 | 대덕구 | 대화동 | 수상레저 | ❌ | ✅ 인기업종 4개 | ✅ |
| 3 | 중구 | 문창동 | 낚시터 | ✅ 1,001만 | — | ✅ 정상 |
| 4 | 동구 | 신인동 | 캠핑 | ❌ | ✅ 인기업종+인근동 | ✅ |
| 5 | 대덕구 | 회덕동 | 볼링장 | ✅ 1,416만 | — | ✅ 정상 |
| 6 | 중구 | 대흥동 | 예식장 | — | — | 타이밍 미캡처 |
| 7 | 동구 | 용운동 | 호텔 | ✅ 2,613만 | — | ✅ 정상 |
| 8 | 대덕구 | 비래동 | 스쿼시 | ❌ | ✅ 인기업종+인근동 | ✅ |
| 9 | 중구 | 목동 | 수영장 | ✅ 1,390만 | — | ✅ 정상 |

**커밋**: `f23b386`

---

## 변경 파일

- `app/js/query-engine.js` — weightedAvgByUpso + suggestAlternatives
- `app/js/intent-parser.js` — "작년대비/전년대비" → trend 우선 라우팅
- `app/js/response-builder.js` — _buildTrend YoY statsCard + 대안 bullets/followUps
- `app/js/response-orchestrator.js` — alternatives 통과 로직
- `app/js/tool-dispatcher.js` — alternatives 첨부
- `app/js/main.js` — 로컬 내러티브 대안 안내

## 미해결 이슈

- P2: 대화 맥락 기반 비교 추론 미지원
- P3: 지도 표기 metric 반영
- P3: Local IntentParser smalltalk 미감지
