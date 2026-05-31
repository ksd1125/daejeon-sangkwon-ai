# 세션 69 — Follow-up 칩 버그 3건 수정 (꼬리물기 안정화)

- **날짜**: 2026-05-29
- **목표**: 꼬리물기(follow-up) 옵션에서 발생하는 버그 파악 및 수정
- **키워드**: `#follow-up버그` `#compareIndustry크래시` `#industry누출` `#맥락명시`

---

## 작업 내용

### 1. Follow-up 칩 템플릿 맥락 명시 (response-builder.js)

**문제**: follow-up 칩에 지역/업종이 누락되어, 맥락 없이 클릭하면 IntentParser가 파싱 실패
- "매출이 급등했는데 추세가 어떻지?" → 지역·업종 누락
- "여기 치킨 장사가 잘 돼?" → "여기" 미해석
- "업소당 월평균 매출이 높은 이유는?" → 지역 누락

**수정**: 모든 `_smartFollowUps` 템플릿에 `${region}` + `${industry}` 명시
```javascript
// Before
"매출이 급등했는데 추세가 어떻지?"
// After  
"${region} ${industry} 매출이 급등했는데 추세는?"
```

### 2. Overview 응답 industry 누출 차단

**문제**: overview 쿼리("오정동 어때")의 `record.industry`가 follow-up 칩에 누출
- overview record에 top industry ("일식 카레/돈가스/덮밥") 존재
- 이 값이 compare 템플릿에 사용: "오정동이랑 둔산1동 일식 카레/돈가스/덮밥 비교해줘"
- IntentParser가 슬래시를 업종 구분자로 오인 → compareIndustry 타입으로 오분류

**수정** (2중 방어):
1. `type === 'overview'`일 때 `industry`를 `''`로 강제 초기화
2. compare follow-up 조건에 `type !== 'overview'` 가드 추가

### 3. _buildCompareIndustry 빈 sides 크래시 방지

**문제**: 슬래시 포함 업종명 → IntentParser가 compareIndustry로 오분류 → `result.industrySides` 미존재 → `sorted[0]` undefined → `winner.industry` 크래시
```
Cannot read properties of undefined (reading 'industry')
```

**수정**: `sides.length === 0` 시 early return + fallback 메시지

---

## 디버깅 과정

- L1 (267건): 항상 통과 — `Math.random()`이 compare 칩을 top 5에 선택 안 함
- L3 (21,341건): 비결정적 실패 — 랜덤 시드에 따라 compare 칩이 선택되면 크래시
- console.log 디버깅으로 overview 응답의 실제 follow-up 텍스트 캡처:
  ```
  parentQ="오정동 어때" texts= ["대덕구에서 일식 카레/돈가스/덮밥 매출 높은 행정동은?", ..., "오정동이랑 둔산1동 일식 카레/돈가스/덮밥 비교해줘"]
  ```
- 근본 원인: `_buildCompareIndustry`에서 빈 `sides`의 `sorted[0]` 접근 — null check 없음

## 테스트 결과

```
L3 Full Matrix: 21,341 / 21,341 Pass | 0 Fail | ~15s
연속 2회 통과 확인
```

## 커밋
- `6ecbb9a` fix: follow-up 칩 3건 버그 수정 (꼬리물기 안정화)
