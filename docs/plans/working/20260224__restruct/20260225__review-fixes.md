# 20260225 Review Fixes Plan

## Scope
- 직전 코드리뷰에서 나온 구조/검증 리스크를 별도 PR 묶음으로 보완한다.

## PR Plan

### PR15 - Typecheck Coverage 복원
- 목표: 루트 타입체크에서 신규 `packages/*`, `apps/*` 경로 회귀를 놓치지 않게 보완
- 상태: done (`check-types:*` 집계 스크립트 + `tsconfig.packages.json` 추가)
- 핵심 작업:
  - 통합 타입체크 스크립트/프로젝트 체크 경로 추가
  - CI/로컬에서 한 번에 실행 가능한 엔트리 마련

### PR16 - Harness 계약 정합
- 목표: `apps/view-harness` 메시지 타입을 extension 계약(`src/contracts/messages.ts`)과 정렬
- 상태: done (하네스 inbound를 `ExtensionToWebviewMessage` 기반으로 정렬)
- 핵심 작업:
  - 메시지 이름 불일치(`agentToolClear` vs `agentToolsClear`) 수정
  - 하네스 입력 타입을 계약 기반으로 축소/정렬

### PR17 - View-model 경계 정리
- 목표: `packages/view-model`이 `packages/core/src/*`를 직접 import하지 않도록 경계 분리
- 상태: done (`CoreStateForViewModel` 로컬 계약 타입으로 대체)
- 핵심 작업:
  - view-model에서 필요한 core 상태를 로컬 계약 타입(`CoreStateLike`)으로 표현
  - mapper를 해당 계약 기준으로 동작하게 조정

### PR18 - 계약 타입 강화
- 목표: 느슨한 `unknown[]` payload를 구체 타입으로 강화해 컴파일 단계 보호 확보
- 상태: done (`furnitureAssetsLoaded.catalog`, `agentStatus.status`, `agentMeta` 등 계약 강화)
- 핵심 작업:
  - `src/contracts/messages.ts`의 `furnitureAssetsLoaded` payload 등 타입 구체화
  - 영향 받는 소비부 타입 정합 확인

## Done Criteria
- PR15~PR18 모두 타입체크 통과
- 기존 extension/webview 빌드 동작 유지
- 리뷰 지적된 4개 포인트(검증 범위, 계약 정합, 경계 의존, 느슨한 타입) 해소
