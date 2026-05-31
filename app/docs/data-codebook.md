# Data Codebook Policy

이 앱은 화면 표시용 한글과 연동/저장용 코드를 분리한다.

## 원칙

- 내부 식별자는 ASCII 영문, 숫자, 밑줄만 사용한다.
- 행정동은 공공데이터 행정동 코드 숫자를 그대로 사용한다. 예: `30170555`.
- 업종은 `ind_0001` 형식의 코드로 관리한다.
- 업종 분류는 `cat_001` 형식의 코드로 관리한다.
- 한글은 표시 라벨 필드에만 둔다. 예: `labelKo`, `aliasKo`, `sggLabelKo`.
- 브라우저 저장소 키와 다운로드 파일명은 ASCII만 사용한다.

## 주요 파일

- `app/data/codebook.json`: 행정동, 자치구, 업종, 업종 별칭의 코드/라벨 매핑.
- `app/data/index.json`: 행정동 목록과 최신 데이터 월.
- `app/data/industries.json`: 기존 한글 업종 목록과 표시/검색용 별칭 원천.
- `app/js/data-loader.js`: `codebook.json`을 읽고 코드와 한글 라벨을 상호 변환한다.
- `app/js/tool-dispatcher.js`: `ind_0001` 같은 업종 코드를 받아도 기존 분석 로직의 한글 업종명으로 해석한다.

## 저장/내보내기 이름

- 오류 신고 저장소: `commercial_ai_error_reports`
- 수정 이력 저장소: `commercial_ai_change_log`
- 사용자 리포트 HTML: `commercial-ai-user-report-YYYYMMDD_HHMMSS.html`
- 관리자 리포트 HTML: `commercial-ai-admin-report-YYYYMMDD_HHMMSS.html`
- 오류 신고 JSON: `commercial-ai-error-reports.json`
- 수정 이력 JSON: `commercial-ai-change-log.json`

## 다음 작업자가 지킬 점

원본 대용량 JSON 전체를 한 번에 영문화하지 말고, 먼저 `codebook.json`을 확장한 뒤 로더에서 변환한다. 화면 문구와 사용자의 직접 입력은 한글을 허용하고, API 연동, 저장, 검증, 파일명에 쓰는 값만 ASCII 코드로 고정한다.
