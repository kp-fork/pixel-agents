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
- 상태: pending
- 핵심 작업:
  - `Pixel Agents: Show Runtime Info` 출력에 agent/project/settings 스냅샷 추가
  - output channel 로그 포맷 표준화

### PR30 - 품질 게이트 강화(경고/오류 정책)
- 목표: 릴리즈 직전 품질 리스크를 자동 감지
- 상태: pending
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
