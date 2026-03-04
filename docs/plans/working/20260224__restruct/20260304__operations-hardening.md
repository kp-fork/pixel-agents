# 20260304 Operations Hardening Plan

## Scope
- Epic 4(운영 안정화) 트랙을 시작한다.
- 릴리즈 전 검증 루틴을 단일 엔트리포인트로 표준화한다.
- 런타임 디버그 신호와 품질 게이트를 단계적으로 강화한다.

## PR Plan

### PR28 - 운영 검증 엔트리포인트 추가
- 목표: 반복 실행 가능한 운영 검증 명령을 스크립트로 고정
- 상태: done
- 핵심 작업:
  - 루트 `package.json`에 `verify:ops`, `verify:ops:vsix` 추가
  - README에 운영 검증 실행 순서 문서화

### PR29 - Runtime Info 진단 스냅샷 강화
- 목표: 운영 이슈 대응을 위한 런타임 상태 신호를 명확히 노출
- 상태: done
- 핵심 작업:
  - `Pixel Agents: Show Runtime Info` 출력에 agent/project/settings 스냅샷 추가
  - output channel 로그 포맷 표준화

### PR30 - 품질 게이트 강화(경고/오류 정책)
- 목표: 릴리즈 직전 품질 리스크를 자동 감지
- 상태: done
- 핵심 작업:
  - lint warning/테스트 실패에 대한 CI 정책 정리
  - 릴리즈 체크리스트 문서화

## Execution Log

### PR28
- Review:
  - 기존에는 운영 검증 절차가 개별 명령(`check-types`, `test:runtime`, `build`, `package:vsix`)로 흩어져 있어 누락 가능성이 있었다.
- Improvement:
  - `package.json`:
    - `verify:ops` 추가 (`check-types -> test:runtime -> build`)
    - `verify:ops:vsix` 추가 (`verify:ops -> package:vsix`)
  - `README.md`에 운영 검증 명령 안내 추가
- Validation:
  - `npm run verify:ops` 통과
  - `npm run verify:ops:vsix`는 `package:vsix` 수행 완료로 검증 대체(설치는 별도 `install:vsix`)
- Summary:
  - 운영 검증 루틴이 단일 명령으로 재현 가능해져 릴리즈/회귀 확인 절차가 단순화되었다.

### PR29
- Review:
  - 기존 `Pixel Agents: Show Runtime Info`는 extension id/version/path 중심이라, 실제 운영 이슈(세션/설정/에이전트 상태) 진단에 필요한 컨텍스트가 부족했다.
- Improvement:
  - `src/PixelAgentsViewProvider.ts`:
    - `getRuntimeSnapshot()` 추가
    - workspace/project/webview/layout-watcher/known-jsonl/settings/agent 상태 스냅샷 제공
  - `src/extension.ts`:
    - runtime 로그를 `[runtime][section]` 형식으로 표준화
    - `extension/workspace/settings/agents/webview` 섹션 로그 + 전체 JSON snapshot 동시 출력
- Validation:
  - `npm run check-types` 통과
  - `npm run lint` 실행(기존 경고 다수 유지, 신규 error 없음)
- Summary:
  - 운영 현장에서 `Show Runtime Info` 한 번으로 agent/project/settings 진단 정보를 일관 포맷으로 수집할 수 있게 되었다.

### PR30
- Review:
  - 현재 lint에는 legacy warning이 누적되어 있어 `--max-warnings=0` 즉시 적용은 현실적으로 어렵지만, warning 증가 회귀는 자동 차단이 필요했다.
- Improvement:
  - `scripts/check-lint-warning-budget.js` 추가
    - eslint JSON 결과에서 warning/error 수 집계
    - `docs/quality/lint-warning-budget.json` 초과 시 실패 처리
  - `package.json`:
    - `quality:lint-budget` 추가
    - `verify:ops`에 warning budget 게이트 포함
  - 문서:
    - `docs/quality/ci-policy.md` 추가
    - `docs/release-checklist.md` 추가
    - README에 quality gate/checklist 경로 안내 추가
- Validation:
  - `npm run quality:lint-budget` 통과
  - `npm run test:runtime` 통과
  - `npm run build` 통과
- Summary:
  - 기존 warning을 유지한 채로도 warning 증가를 차단하는 자동 게이트가 생겼고, 릴리즈 전 점검 절차가 문서+스크립트로 고정되었다.
