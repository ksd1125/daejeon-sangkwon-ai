# 세션 68 — 3-Level Progressive Test Framework

- **날짜**: 2026-05-29
- **목표**: 82동 × 247업종 × 전체 questionType 자동화 테스트 프레임워크 구축
- **키워드**: `#테스트프레임워크` `#자동화테스트` `#FullMatrix` `#MessageChannel` `#버그수정`

---

## 작업 내용

### 1. 테스트 프레임워크 신규 구축 (4개 파일)

| 파일 | 역할 |
|------|------|
| `test-suites.js` | 테스트 케이스 동적 생성 + 검증 함수 |
| `test-runner.js` | main.js 파이프라인 재현 + 배치 실행 |
| `test-report.js` | 카테고리별 결과 렌더링 + HTML export |
| `test.html` | 독립 실행 테스트 페이지 |

### 2. 3-Level Progressive Testing

| Level | 설명 | 케이스 수 | 소요 시간 |
|-------|------|--------:|--------:|
| 1 | Smoke: merge(111) + questionType(46) + 82동 해석 | 239 | ~11s |
| 2 | Data Integrity: 82동 × 10 인기업종 | +820 = 1,059 | ~47s |
| 3 | Full Matrix: 82동 × 247업종 | +20,254 = 21,313 | ~11s |

### 3. Merge 테스트 3분류

- **법정동** (동으로 끝남): 반석동→반석1동+반석2동 — strict merge 검증
- **약어** (키가 타겟의 접두사): 가양→가양1동+가양2동 — lenient (disambiguation OR merge OK)
- **위치별칭** (키와 타겟 무관): 과학단지→전민동+신성동 — sourceLocation 검증

### 4. 버그 수정

**intent-parser.js**: `_extractLegalDongAlias` 반환값에 `locationAlias` 프로퍼티 미포함
- 영향: 과학단지/성심당/으능정이 등 위치별칭의 sourceLocation이 빈 문자열
- 수정: `locationAlias: legalAlias.alias || null` 추가 (2줄)

### 5. 성능 최적화

**문제**: Chrome setTimeout(0) 스로틀링으로 L3 실행 시 17시간+ 소요
- setTimeout(0)이 배경 탭이나 CPU 과부하 시 1초+ 지연
- 21,313건 / 20배치 = 1,066 배치 × 1초 = 18분+ (추가로 fetch 경합도)

**해결**:
1. `MessageChannel` 기반 zero-delay yield → setTimeout 스로틀링 완전 우회
2. `BATCH_SIZE` 20 → 200으로 증가 (배치 전환 횟수 감소)
3. `init()`에서 82개 행정동 데이터 pre-warm (동시 fetch 방지)
4. Per-case 5초 timeout (`Promise.race`) — hang 방지 안전장치

**결과**: 17시간 → 11초 (5,500배 개선)

---

## 테스트 결과

### Level 3 Full Matrix (최종)
```
Total: 21,313 | Pass: 21,313 | Fail: 0 | Error: 0 | 11.0s
커버리지: 82/82 행정동, 247/247 업종, 24/37 Merge
```

### 카테고리별
| 카테고리 | Pass | Total |
|----------|-----:|------:|
| 법정동 Merge | 72 | 72 |
| 약어 Merge | 27 | 27 |
| 위치별칭 Merge | 12 | 12 |
| QuestionType 커버리지 | 46 | 46 |
| 행정동 이름 해석 | 82 | 82 |
| 데이터 무결성 (L2) | 820 | 820 |
| 전체 매트릭스 (L3) | 20,254 | 20,254 |

---

### Follow-up 체인 테스트 (추가)

28건 체인 테스트 추가 — 각 follow-up 칩을 실제 파이프라인에 재입력하여 2차 응답 검증:
- 5개 대표 동 × 5 questionType = 25건
- merge 법정동 대표 3건
- 검증 항목: 응답 null 여부, merge 라벨 패턴 노출 여부

## 커밋
- `67088cf` feat: 3-level progressive test framework (21,313 cases, 11s)
- `8425545` feat: follow-up 체인 테스트 추가 (꼬리물기 28건)
