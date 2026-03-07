# 20260307 PR Workflow Rules

## Goal
- PR 단위 작업 품질과 추적 가능성을 고정한다.
- 각 PR 결과가 동일한 형식으로 검토/검증/요약되도록 강제한다.

## Scope
- `docs/plans/working/20260224__restruct.md`의 PR 트랙(PR1~) 전체에 적용한다.
- extension/desktop/webview/core 등 저장소 내 모든 변경에 적용한다.

## Mandatory Sequence (Per PR)
1. Plan Freeze
- PR 범위, 비범위(Non-goal), 검증 기준을 문서에 먼저 고정한다.
- 고정 후 범위 변경은 문서 업데이트와 함께 기록한다.

2. Review
- 현재 코드/동작 기준으로 문제점, 리스크, 회귀 가능성을 먼저 정리한다.
- "무엇이 깨질 수 있는지"를 우선 기록한다.

3. Improvement
- 구현은 PR 목표 범위 안에서만 수행한다.
- 관련 없는 리팩터링/정리는 별도 PR로 분리한다.

4. Validation
- 자동 검증 명령을 실행하고 결과(pass/fail)를 기록한다.
- 최소 검증은 아래 `Validation Baseline`을 따른다.

5. Validation Reflection
- 실패/불확실 항목이 있으면 원인, 영향 범위, 후속 조치를 기록한다.
- "추정"은 추정임을 명시한다.

6. Result Summary
- 사용자 관점 결과, 변경 파일, 잔여 리스크를 간결하게 요약한다.

## Validation Baseline
- 타입: `npm run check-types`
- 뷰 빌드: `npm run build:webview`
- 런타임(필요 시): `npm run dev:desktop` 또는 해당 PR 대상 실행 경로
- 기능 스크립트가 있는 경우: 해당 `npm run test:*` 항목 추가

## Commit Rules
- PR당 커밋은 의미 단위로 분할한다.
- 커밋 메시지는 영어로 작성한다.
- 커밋 본문에는 다음을 포함한다.
  - Why: 변경 이유
  - What: 핵심 변경
  - Validation: 실행한 검증 명령

## Reporting Rules
- PR 완료 시 아래 5개 항목을 반드시 남긴다.
  - Review
  - Improvement
  - Validation
  - Validation Reflection
  - Result Summary
- 작업 리포트는 `docs/plans/working/20260224__restruct/` 하위 문서에 누적한다.

## Multi-Agent Rules
- 독립 작업(파일 충돌 없음)만 병렬 에이전트로 분할한다.
- 충돌 가능 파일은 단일 에이전트/메인 에이전트가 담당한다.
- 병렬 작업 결과는 메인 에이전트가 최종 통합/검증 후 기록한다.

## Definition of Done (Per PR)
- PR 계획 범위 구현 완료
- 필수 검증 통과
- 문서/리포트 업데이트 완료
- 잔여 리스크와 후속 PR 필요 여부 명시
