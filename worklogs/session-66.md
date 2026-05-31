# 세션 66 — P0 follow-up carry + P1 법정동 매핑 + P2 가중평균

**날짜**: 2026-05-28
**목표**: P0 follow-up carry 수정 + P1 법정동/별칭 매핑 5개 구 전면 보강 + P2 merge 가중평균
**키워드**: `#P0수정` `#P1수정` `#P2수정` `#follow-up` `#context-carry` `#법정동매핑` `#5개구` `#가중평균`

---

## 수행 내용

### 1. 근본 원인 분석

**문제**: merge/sgg 도구 결과는 `intent.district` 필드가 없어서 `ConversationState.update()`가 activeDistrict를 저장하지 못함.
- merge 결과: `mergeDistricts` 배열만 있고 `district` 없음
- sggIndustry/rankDistricts 결과: `sgg` 필드만 있고 `district` 없음
- 결과적으로 후속 질문에서 지역 carry가 전면 실패 (5/24턴 = 21%)

### 2. 수정 내용

#### `conversation-state.js` — 상태 저장 보강

1. **`activeSgg` 필드 추가** (`clear()`): 구 단위 컨텍스트 별도 추적
2. **`update()` merge 처리**: `mergeDistricts[0]`을 대표 행정동으로 activeDistrict에 저장
3. **`update()` sgg 처리**: `intent.sgg`가 있고 district가 없으면 activeSgg 저장, activeDistrict 클리어
4. **`resolve()` sgg carry**: district도 sgg도 없을 때 activeSgg를 이어받기
5. **`toSummary()` 보강**: activeSgg 표시

#### `response-orchestrator.js` — 슬롯 채움 로직 보강

1. **`_fillFromConversation()` sgg carry 블록 추가**: district가 없고 activeSgg만 있을 때 sgg 슬롯 채움 + goal을 sggIndustry/rankDistricts로 전환
2. **industry carry 시 sgg-only 감지**: sgg만 있고 district 없으면 goal을 sggIndustry로 전환 (overview→sales 대신)
3. **`missingSlots` 필터 보강**: `slot === 'district'`일 때 `filled.sgg`도 대체 가능으로 인정

### 3. 검증 결과 (6건 모두 통과)

| # | 시나리오 | 원래 결과 | 수정 후 |
|---|---------|:---:|:---:|
| 1 | sgg follow-up: 서구 카페→편의점은? | ❌ | ✅ 서구 편의점 |
| 2 | sgg→sgg 전환: 서구 카페→유성구는? | ❌ | ✅ 유성구 카페 |
| 3 | merge follow-up: 둔산동 카페→유동인구는? | ❌ | ✅ 둔산1동 카페 유동인구 |
| 4 | merge→similar: 유성온천 카페→비슷한 상권? | ❌ | ✅ 온천1동 유사상권 |
| 5 | 단일동 regression: 관저1동 카페→편의점은? | ✅ | ✅ 관저1동 편의점 |
| 6 | rankDistricts follow-up: 서구 치킨 높은동→편의점은? | ❌ | ✅ 서구 편의점 순위 |

---

### 4. P1: 법정동 매핑 전면 보강

대전시청/동구청/위키백과의 행정동↔법정동 공식 대조표를 기반으로 매핑 보강.

#### 수정
- **"노은동"**: `["노은1동"]` → `["노은1동", "노은2동", "노은3동"]` (핵심 P1)

#### 신규 법정동 (공식 데이터 기반, 6건)
| 법정동 | → 행정동 | 구 |
|--------|---------|-----|
| 내탑동 | 대청동 | 동구 |
| 장척동 | 산내동 | 동구 |
| 용촌동 | 기성동 | 서구 |
| 용계동 | 진잠동, 대청동 | 유성구+동구 |
| 부수동 | 신탄진동 | 대덕구 |
| 황호동 | 신탄진동 | 대덕구 |

#### 위치 줄임말 별칭 (12건)
판암, 가양, 갈마, 관저, 도마, 월평 (서구/동구), 태평, 유천 (중구), 노은 (유성구), 신탄진, 회덕 (대덕구)

#### 랜드마크 별칭 (4건)
동대전역→용전동, 대전복합터미널→용전동, 중앙시장→중앙동, 보문산→대사동

#### locationAliases 추가 (5건)
노은, 판암, 신탄진, 중앙시장, 동대전

#### 검증 (6/6 통과)
| # | 시나리오 | 결과 |
|---|---------|------|
| 1 | "노은동 카페 추세" | ✅ merge 노은1+2+3동 |
| 2 | "판암 카페 매출" | ✅ merge 판암1+2동 |
| 3 | "태평 편의점 매출" | ✅ merge 태평1+2동 |
| 4 | "신탄진 치킨 매출" | ✅ 신탄진동 |
| 5 | "동대전역 카페 어때?" | ✅ 용전동 |
| 6 | "회덕 편의점 어때?" | ✅ 회덕동 |

---

## 변경 파일

- `app/js/conversation-state.js` — activeSgg 필드 + merge/sgg 상태 저장 + sgg carry in resolve()
- `app/js/response-orchestrator.js` — sgg carry 블록 + industry carry 시 sgg-only goal 전환 + missingSlots 필터
- `app/data/matching-dictionaries.json` — 노은동 수정 + 법정동 6건 + 줄임말 12건 + 랜드마크 4건 + locationAliases 5건
- `app/js/query-engine.js` — weightedAvgByUpso 함수 추가 + amt/amtYoY/amtMoM 가중평균 적용

### 5. P2: merge 평균 매출 → 가중평균 전환

#### 문제
법정동 merge 시 여러 행정동의 업소당 매출(amt)을 **단순평균**하면, 업소 수가 적은 동이 과대 대표됨.
예: 둔산3동(20개) 894만원이 둔산2동(121개) 2,077만원과 동일 비중.

#### 수정 (`query-engine.js`)
- `weightedAvgByUpso(key)` 함수 추가: 업소 수 기반 가중평균, 업소 데이터 없으면 단순평균 fallback
- 적용 필드: `amt`, `amtYoY`, `amtMoM` (업소당 매출 관련 3개)
- 미적용 필드: `upso`/`pop` (합산), `popWeekday`/`popWeekend` (단순평균 유지)

#### 검증 (둔산동 카페 교차검증)

| 구분 | 둔산1동 | 둔산2동 | 둔산3동 | 단순평균 | **가중평균** | **머지 결과** |
|------|---------|---------|---------|----------|-------------|---------------|
| 업소 수 | 80 | 121 | 20 | — | — | 221 |
| 매출(만원) | 1,645 | 2,077 | 894 | 1,539 | **1,814** | **1,814** ✅ |
| amtYoY(%) | -25.7 | -27.8 | -26.5 | -26.7 | -26.9 | -26.9 ✅ |

---

## 미해결 이슈

- P2: "작년 대비" 추세 전용 뷰 미분화
- P2: 데이터 없음 시 대안 미제안
- P2: 대화 맥락 기반 비교 추론 미지원
