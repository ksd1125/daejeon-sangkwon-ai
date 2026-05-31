# Gemini 80% Phase 2 — 설계서

> **작성일**: 2026-05-26 (세션63)
> **목표**: Gemini 활용률 ~60% → ~80% (8개 스테이지 중 6~7개 Gemini)
> **키워드**: `#Phase2` `#맥락전달` `#Router보강` `#Narrative안정화`

---

## 1. 문제 진단 (Phase 1 테스트 결과 기반)

### 1.1 후속질문 맥락 전달 실패 (#8, P2)

**증상**: "궁동 치킨 매출" → (5/8 성공) → "유동인구는?" → 실패 (clarify 반환)

**근본 원인**:
- `ConversationState.resolve(intent)` 메서드가 **파이프라인에서 한 번도 호출되지 않음**
- `resolve()`는 빈 district/industry를 직전 턴에서 채우는 핵심 로직인데, 오케스트레이터가 이를 사용하지 않음
- Gemini Router에는 contextSummary 텍스트가 전달되지만, LLM이 "유동인구는?" 같은 질문에서 district/industry를 안정적으로 추출하지 못함
- Local IntentParser는 대화 맥락 자체를 모름

**영향 범위**: 모든 후속 질문 (district/industry 생략 시)

### 1.2 similar/sggIndustry Router 미포착 (#7, P2)

**증상**: "둔산1동 카페 비슷한 상권" → intent=local (2/8), "서구 카페 추세" → intent=local (2/8)

**근본 원인**:
- `_normalizeIntentPlan()`에 rankDistricts용 정규식 오버라이드(`asksDistrictRanking`)는 있지만, **similar/sggIndustry용 정규식 오버라이드가 없음**
- Router LLM이 `goal: "similar"` 또는 `goal: "sggIndustry"`를 정확히 반환하지 못할 때 후처리 보정이 없음
- "서구 카페 추세"에서 LLM이 `district`를 임의로 채우면 `asksSggIndustry` 조건(`!plan.district`)이 실패

**영향 범위**: similar, sggIndustry 질의 유형

### 1.3 Narrative 간헐적 local-fallback

**증상**: 동일 조건에서도 narrative가 gemini/local-fallback 사이에서 불안정

**근본 원인**:
- `_isBadNarrative()`: 12자 미만이면 즉시 local-fallback 판정
- Gemini SSE 스트리밍이 느리게 시작하면 10s 타임아웃에 걸려 짧은 텍스트만 생성
- 데이터 프롬프트(`_buildDataPrompt`)에 rankDistricts/sggIndustry 전용 데이터 포맷이 없음

**영향 범위**: 모든 질의 유형 (확률적)

---

## 2. 수정 계획

### 2.1 ConversationState 통합 (맥락 전달 해결)

**파일**: `response-orchestrator.js`
**위치**: `handleQuestion()` Stage 1 직후 (line ~82)

```
변경 전:
  const route = await this._resolveIntent(question, contextSummary, deadline, ctx);
  if (!route) return { fallbackToLocal: true };
  const intentPlan = this._enrichVagueCompareIntent(route.intentPlan);

변경 후:
  const route = await this._resolveIntent(question, contextSummary, deadline, ctx);
  if (!route) return { fallbackToLocal: true };
  let intentPlan = this._enrichVagueCompareIntent(route.intentPlan);
  intentPlan = this._fillFromConversation(intentPlan, conversationState); // 새 메서드
```

**새 메서드 `_fillFromConversation(intentPlan, conversationState)`**:
```javascript
_fillFromConversation(intentPlan, conversationState) {
  if (!conversationState?.hasContext()) return intentPlan;
  if (intentPlan.responseType === 'smalltalk') return intentPlan;
  
  const filled = { ...intentPlan };
  let changed = false;
  
  // district 빈 슬롯 채우기
  if (!filled.district && !filled.sgg && conversationState.activeDistrict?.name) {
    filled.district = conversationState.activeDistrict.name;
    filled._carriedDistrict = true;
    changed = true;
  }
  
  // industry 빈 슬롯 채우기
  if (!filled.industry && conversationState.activeIndustry) {
    filled.industry = conversationState.activeIndustry;
    filled._carriedIndustry = true;
    changed = true;
  }
  
  // missingSlots에서 채워진 슬롯 제거
  if (changed && Array.isArray(filled.missingSlots)) {
    filled.missingSlots = filled.missingSlots.filter(slot => {
      if (slot === 'district' && filled.district) return false;
      if (slot === 'industry' && filled.industry) return false;
      return true;
    });
  }
  
  // confidence 보정 (맥락에서 채웠으므로 약간 낮춤)
  if (changed) {
    filled.confidence = Math.max(0.5, (filled.confidence || 0.7) - 0.1);
    filled.rationale = (filled.rationale || '') + ' [맥락에서 지역/업종 보완]';
  }
  
  return filled;
}
```

**검증 시나리오**:
1. "궁동 치킨 매출" → "유동인구는?" → district=온천2동, industry=치킨 이어받기
2. "둔산1동 카페 매출" → "추세는?" → district=둔산1동, industry=카페 이어받기
3. "안녕" → "둔산1동 카페" → 맥락 없으므로 이어받기 없음 (정상)

### 2.2 Router similar/sggIndustry 정규식 보강

**파일**: `agent-router.js`
**위치**: `_normalizeIntentPlan()` (line 225~268)

```
변경: goal 결정 로직에 similar/sggIndustry 감지 추가

const asksSimilar = /(비슷|유사|같은|닮은|다른\s*곳|다른\s*상권)/.test(question || '');
const asksSggTrend = Boolean(sgg && plan.industry && !plan.district && !asksDistrictRanking && !asksSimilar);

// goal 결정 우선순위:
// 1. asksDistrictRanking → rankDistricts
// 2. asksIndustryRanking → overview
// 3. asksSimilar && plan.district → similar
// 4. asksSggTrend → sggIndustry
// 5. plan.goal 원본

const goal = asksDistrictRanking ? 'rankDistricts'
  : asksIndustryRanking ? 'overview'
  : (asksSimilar && (plan.district || plan.goal === 'similar')) ? 'similar'
  : asksSggTrend ? 'sggIndustry'
  : (allowedGoals.has(plan.goal) ? plan.goal : 'unknown');
```

**추가**: `_intentSystemPrompt()`에 similar/sggIndustry 예시 강화

```
현재:
- "비슷한 곳", "유사 상권"은 findSimilarDistricts를 호출하세요.

변경:
- "비슷한 곳", "유사 상권", "같은 패턴", "다른 상권"은 goal=similar로 설정하세요.
- "유성구 카페 추세", "서구 편의점 현황"처럼 구 이름 + 업종 + 추세/현황이면 goal=sggIndustry로 설정하세요.
- sggIndustry와 rankDistricts 구분: "높은 동", "1위 동", "순위"가 있으면 rankDistricts, "추세", "현황", "어때"이면 sggIndustry입니다.
```

**검증 시나리오**:
1. "둔산1동 카페 비슷한 상권" → goal=similar (현재 실패 → 성공)
2. "서구 카페 추세" → goal=sggIndustry (현재 실패 → 성공)
3. "유성구 편의점 높은 동" → goal=rankDistricts (기존 성공 유지)

### 2.3 Narrative 안정화

**파일**: `agent-analyst.js`
**변경 1**: `_buildDataPrompt()`에 rankDistricts/sggIndustry 전용 데이터 포맷 추가

```javascript
// rankDistricts 전용
if (toolResult.type === 'rankDistricts' && toolResult.rankings) {
  dataLines.push('행정동 순위:');
  toolResult.rankings.forEach((r, i) =>
    dataLines.push(`  ${i + 1}위: ${r.district} (${r.value?.toLocaleString()} ${r.unit || ''})`)
  );
}

// sggIndustry 전용
if (toolResult.type === 'sggIndustry') {
  if (toolResult.topDistricts) dataLines.push(`상위 행정동: ${toolResult.topDistricts}`);
  if (toolResult.trendDirection) dataLines.push(`추세 방향: ${toolResult.trendDirection}`);
}
```

**파일**: `response-orchestrator.js`
**변경 2**: `_isBadNarrative()` 기준 완화 + 재시도 로직

```javascript
_isBadNarrative(text) {
  const t = String(text || '').trim();
  if (t.length < 8) return true;   // 12 → 8 (한국어 2문장 최소)
  if (/[,，]\d{0,3}\.?$/.test(t)) return true;
  if (/\d+[,.]\d*$/.test(t) && t.length < 30) return true;  // 짧을 때만
  return false;
}
```

**변경 3**: `_resolveNarrative()`에서 geminiSummary에 더 많은 필드 전달

현재 `toolResult.geminiSummary`만 전달하는데, 이것이 sparse할 수 있음.
`_buildSummaryText()`와 유사한 구조화된 데이터를 Analyst에게 직접 전달.

```javascript
// 변경: geminiSummary 대신 더 풍부한 summary 전달
const summary = toolResult.geminiSummary || {};
// 기존 geminiSummary에 없는 필드를 raw toolResult에서 보강
const enrichedSummary = { ...summary };
if (!enrichedSummary.amt && toolResult.rawData?.amt) enrichedSummary.amt = toolResult.rawData.amt;
// ... 필요한 필드 보강
```

### 2.4 Router 프롬프트 맥락 활용 강화

**파일**: `agent-router.js`
**위치**: `_intentSystemPrompt()` 규칙 추가

```
추가 규칙:
- 대화 맥락에 "지역: X동, 업종: Y"가 있고 현재 질문에 지역/업종이 없으면, 맥락의 지역/업종을 district/industry에 채우세요. 예: 맥락="지역: 둔산1동, 업종: 카페" + 질문="유동인구는?" → district="둔산1동", industry="카페", goal="population"
- 맥락 보완 시 confidence를 0.7로 설정하고, rationale에 "맥락에서 보완"을 명시하세요.
```

---

## 3. 수정 파일 요약

| # | 파일 | 변경 내용 | 난이도 |
|---|------|----------|:---:|
| 1 | `response-orchestrator.js` | `_fillFromConversation()` 추가 + handleQuestion 통합 | ★★ |
| 2 | `agent-router.js` | `_normalizeIntentPlan` similar/sgg 정규식 + `_intentSystemPrompt` 프롬프트 보강 | ★★ |
| 3 | `agent-analyst.js` | `_buildDataPrompt` rankDistricts/sggIndustry 데이터 + 프롬프트 보강 | ★ |
| 4 | `response-orchestrator.js` | `_isBadNarrative` 완화 | ★ |
| 5 | `main.js` | MODULE_VERSION 업데이트 | ★ |

---

## 4. 검증 계획

### 브라우저 테스트 (12건)

| # | 질의 | 기대 결과 | 검증 포인트 |
|---|------|----------|------------|
| 1 | 둔산1동 카페 매출 | 기본 분석 | 기존 동작 유지 |
| 2 | 유동인구는? (후속) | 둔산1동 카페 유동인구 | **맥락 이어받기** |
| 3 | 추세는? (후속) | 둔산1동 카페 추세 | **맥락 이어받기** |
| 4 | 둔산1동 카페 비슷한 상권 | similar 5곳 | **similar intent** |
| 5 | 서구 카페 추세 | 서구 카페 sggIndustry | **sggIndustry intent** |
| 6 | 유성구 편의점 높은 동 | rankDistricts | 기존 동작 유지 |
| 7 | 중앙동 어때? | overview | 기존 동작 유지 |
| 8 | 둔산1동이랑 은행선화동 비교 | compare | 기존 동작 유지 |
| 9 | 안녕 | smalltalk | 기존 동작 유지 |
| 10 | 궁동 치킨 매출 | 법정동 해소 | 기존 동작 유지 |
| 11 | 업소 수는? (후속) | 궁동 치킨 업소 수 | **맥락 이어받기** |
| 12 | 대덕구 편의점 현황 | sggIndustry | **sggIndustry** |

### 성공 기준

- **Gemini 비율**: 12건 중 10건 이상 4/8 이상 달성
- **후속질문**: #2, #3, #11에서 맥락 이어받기 성공
- **similar**: #4에서 intent=gemini 또는 local→similar 정상 동작
- **sggIndustry**: #5, #12에서 sgg 분석 정상 동작
- **회귀 없음**: #1, #6, #7, #8, #9, #10 기존 동작 유지

---

## 5. 예상 효과

```
Phase 1 (현재)           Phase 2 (이 설계)
─────────────────       ─────────────────
활용률 ~60%             활용률 ~78%
similar 2/8             similar 4-5/8
sggIndustry 2/8         sggIndustry 4-5/8
후속질문 실패            후속질문 성공
narrative 불안정         narrative 안정

약점 질의 2/8 → 4-5/8  (Router 보강)
후속질문 1/2 → 4-5/8   (ConversationState 통합)
전체 평균 3.1/8 → 5.2/8
```

---

## 6. 구현 순서 (권장)

1. **`_fillFromConversation()`** — 가장 높은 ROI, 후속질문 전체 해결
2. **Router 정규식 보강** — similar/sgg 즉시 개선
3. **Router 프롬프트 보강** — LLM 수준 개선
4. **Analyst 데이터 프롬프트** — narrative 품질 향상
5. **`_isBadNarrative` 완화** — narrative 안정성
6. **MODULE_VERSION** — 캐시 무효화

각 단계마다 브라우저 테스트로 회귀 확인.
