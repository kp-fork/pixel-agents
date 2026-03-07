# 20260307 Desktop PTY Stabilization Plan

## Scope
- Desktop(Electrobun) 경로에서 PTY 출력 누락/간헐 `EBADF`를 제거한다.
- PTY 라이브러리 자체 문제와 host↔webview 통합 문제를 분리해서 검증한다.
- PR 단위로 `Review -> 개선 -> 검증 -> 검증반영 -> 결과요약`을 강제한다.

## Problem Statement
- 독립 `@lydell/node-pty` 스모크에서는 `spawn/write/read/resize`가 정상 동작한다.
- 실제 앱 경로에서는 `terminalResize` 타이밍/메시지 수명주기에서 `EBADF`가 간헐 발생한다.
- 사용자는 "명령은 입력되는데 이후 출력이 안 보이는" 상태를 경험한다.

## Non-Goals
- VS Code extension 트래킹 로직 전면 개편
- Electrobun 외 런타임(예: Electron, browser-only) 이식
- terminal renderer 교체(xterm/ghostty-web 전환 재논의)

## PR Plan

### PR31 - Desktop PTY 독립 검증 스위트 도입
- 상태: in_problem
- 목표:
  - PTY 독립 실행 검증을 자동화하여 회귀 기준선 확보
- 작업:
  - `scripts/test-desktop-pty-smoke.ts` 추가
  - `package.json`에 `test:desktop-pty` 추가
  - 검증 항목: `spawn`, `write echo marker`, `read marker`, `resize`, `kill`
- Review:
  - PTY 실패와 브리지 실패를 로그 레벨에서 분리할 수 있는지 점검
- 개선:
  - 실패 케이스에서 재현 가능한 최소 로그 포맷 고정
- 검증:
  - `npm run test:desktop-pty` pass
- 검증반영:
  - flaky 징후가 있으면 timeout/재시도 규칙 명시
- 결과요약:
  - PTY 엔진 단위 건강상태를 숫자/pass-fail로 보고

### PR32 - Desktop PTY 브리지 채널 정식화
- 상태: in_problem
- 목표:
  - host->webview 메시지를 임시 `executeJavascript(MessageEvent)` 주입 의존에서 분리
- 작업:
  - Electrobun `receiveMessageFromBun` 표준 경로를 1급 채널로 고정
  - webview 수신 초기화 순서(리스너 등록 -> create 요청) 고정
  - 수신 payload 파싱(JSON/string/object) 단일 유틸로 통합
- Review:
  - 초기 이벤트 유실 가능성(ready/data race) 제거 여부 점검
- 개선:
  - 채널별 fallback 정책 명확화(표준 실패 시 fallback 1개만 허용)
- 검증:
  - `npm run dev:desktop` 실행 시 `webviewReady` 후 `terminalReady/terminalData` 수신 확인
- 검증반영:
  - 유실 로그가 있으면 브리지 계측(log key) 추가
- 결과요약:
  - 브리지 경로와 포맷 규약 확정

### PR33 - Desktop PTY 세션 상태머신/이벤트 차단
- 상태: in_problem
- 목표:
  - stale `terminalResize/input` 이벤트가 죽은 PTY 핸들을 건드리지 않게 차단
- 작업:
  - terminal instance id 도입(호스트/웹뷰 공통)
  - 상태머신 도입: `starting -> running -> closing -> closed`
  - 규칙: active instance와 state가 일치할 때만 `input/resize` 허용
  - `resize` 실패는 세션 파괴 대신 계측/무시, `write` 실패는 재생성+1회 재시도
- Review:
  - `EBADF` 발생 시 후속 출력 단절이 사라지는지 점검
- 개선:
  - 과도한 자동 재생성 루프 방지(최대 재시도/쿨다운) 적용
- 검증:
  - 5회 반복 실행에서 `EBADF`가 발생해도 출력 경로 유지 확인
- 검증반영:
  - 상태 전이 로그를 `runtime info`와 연계 가능하도록 정리
- 결과요약:
  - PTY 수명주기 안정화 결과와 잔여 리스크 명시

### PR34 - Desktop PTY 통합 검증 자동화/보고
- 상태: in_problem
- 목표:
  - 사용자 체감 시나리오를 자동화 가능한 회귀 테스트로 고정
- 작업:
  - 통합 스크립트: terminal open -> command -> output marker -> history resume -> output marker
  - 운영 문서/작업리포트 업데이트
  - `verify:ops`에 desktop PTY 검증 포함 여부 검토
- Review:
  - 실사용 경로(+Agent, history click, toggle) 커버리지 점검
- 개선:
  - false pass 방지를 위해 marker/timeouts를 엄격화
- 검증:
  - 통합 스크립트 pass + 수동 샘플 1회 확인
- 검증반영:
  - 실패 로그 분류표(PTY/Bridge/StateMachine) 추가
- 결과요약:
  - 배포 전 판단 가능한 최소 신뢰 신호 제공

## Execution Log
- 2026-03-07: 계획 문서 초안 작성(PR31~PR34), 구현 시작 전 검토 대기.
- 2026-03-07: 상태 재분류.
  - PR31~PR34를 `done`에서 `in_problem`으로 변경.
  - 사유: "명령 입력 후 출력 미표시" 사용자 재현 경로가 해소되지 않았고, 근본 원인(PTY/bridge/lifecycle 경계) 확정이 미완료.

### PR31
- Review:
  - PTY 엔진 자체 결함인지, host↔webview 브리지 결함인지 경계가 불분명했다.
  - 기존에는 통합 실행(`dev:desktop`) 로그에 의존해 원인 분리가 어려웠다.
- Improvement:
  - `scripts/test-desktop-pty-smoke.ts` 추가
  - 독립 항목 검증: `spawn`, `write/read(marker)`, `resize`, `kill`
  - root 스크립트 `test:desktop-pty` 추가
- Validation:
  - `npm run test:desktop-pty` pass
  - `npm run check-types` pass
- Validation Reflection:
  - 독립 스모크 기준으로 PTY 엔진(`@lydell/node-pty`)은 정상 동작이 확인됨
  - 따라서 남은 리스크는 통합 경로(host message/order/lifecycle)로 좁혀짐
  - `field repro invalidation (2026-03-07)`: 사용자 실사용 경로에서 "명령 입력 후 출력 미표시"가 재현되어, 본 PR의 pass만으로는 문제 해소 증거로 인정하지 않는다.
- Result Summary:
  - PTY 엔진 건강 상태를 자동 검증하는 기준선이 생겼다.
  - 단, 사용자 재현 경로 해소에는 직접 연결되지 않아 현재 상태는 `in_problem`.

### PR32
- Review:
  - host 메시지 파싱 규칙이 분산되어 문자열/객체 처리 일관성이 부족했다.
  - 터미널 패널 토글 수명주기에서 dispose/re-init 경로가 꼬일 수 있었다.
- Improvement:
  - `webview-ui/src/adapter/hostMessage.ts` 추가(문자열/객체 통합 파서)
  - `useExtensionMessages`, `EmbeddedTerminal`에 공통 파서 적용
  - `App.tsx`에서 Electrobun `receiveMessageFromBun` 채널을 `window.message`로 일관 브리지
  - `EmbeddedTerminal` 수명주기 정리: 토글 시 불필요한 terminate 방지, unmount 시 정리
- Validation:
  - `npm run check-types` pass
  - `npm run build:webview` pass
  - `npm run test:desktop-pty` pass
  - `npm run dev:desktop` 60s 관찰: `webviewReady` 확인, `EBADF` 미재현
- Validation Reflection:
  - 관찰 중 1회 Bun bus-error(133) 조기 종료가 있었고 재시도로 정상 확인됨
  - 해당 이슈는 PTY/브리지 외 런타임 안정성 항목으로 잔여 리스크로 유지
  - `field repro invalidation (2026-03-07)`: 수동/로그 기반 통과 기록이 사용자 재현 이슈를 막지 못해 종료 근거로 사용할 수 없다.
- Result Summary:
  - host->webview 메시지 파싱/전달 규칙 정리까지는 완료.
  - 단, 출력 누락 재현이 남아 현재 상태는 `in_problem`.

### PR33
- Review:
  - PR32 이후에도 간헐 `EBADF`가 남아 stale resize 경로가 완전히 차단되지 않았다.
  - terminal 이벤트가 인스턴스/상태를 모르는 채 처리되어 죽은 핸들을 건드릴 수 있었다.
- Improvement:
  - 메시지 계약에 `terminal*` `instanceId` 추가(`terminalCreate/input/resize/close`, `terminalReady/data/exit`)
  - host 상태에 `terminalInstanceId`, `terminalLifecycle(starting/running/closing/stopped)` 추가
  - active instance 불일치 이벤트 무시(`input/resize/close`)
  - resize 실패 시 stale 핸들 폐기 + 상태 전이(`stopped`) + 재생성 경로 보강
- Validation:
  - `npm run check-types` pass
  - `npm run build:webview` pass
  - `npm run test:desktop-pty` pass
  - `npm run dev:desktop` 60s 관찰: `webviewReady` 확인, `EBADF` 미재현, `Ctrl+C` 종료코드 0
- Validation Reflection:
  - 상태머신은 최소 구현이라 lifecycle telemetry가 아직 충분히 상세하진 않다.
  - 다만 stale 이벤트 차단/핸들 폐기 규칙으로 `EBADF` 재현률을 낮추는 실효 확인.
  - `field repro invalidation (2026-03-07)`: 출력 누락이 남아 있어 상태머신 도입 효과를 "문제 해결"로 판정할 수 없다.
- Result Summary:
  - lifecycle 가드 적용까지는 진행.
  - 단, 사용자 체감 경로에서 문제 미해결로 현재 상태는 `in_problem`.

### PR34
- Review:
  - 기존에는 `dev:desktop` 수동 관찰 결과를 사람이 해석해야 해서 회귀 감지가 늦었다.
  - 종료 시점 stale resize 복구 로그에 `EBADF`가 그대로 노출되어 실패처럼 보이는 혼선이 있었다.
- Improvement:
  - `scripts/test-desktop-runtime.ts` 추가
    - 자동 실행: `npm run dev:desktop`
    - 판정: `server start`/`webviewReady`/`EBADF`/종료코드
  - root 스크립트 `test:desktop-runtime` 추가
  - PTY resize 복구 로그를 정규화(기본 모드에서 raw `EBADF` 비노출, `PIXEL_AGENTS_DEBUG_TERMINAL=1`일 때 상세 로그)
- Validation:
  - `npm run check-types` pass
  - `npm run test:desktop-pty` pass
  - `npm run test:desktop-runtime` pass
- Validation Reflection:
  - 통합 테스트는 현재 "startup + runtime log health" 중심이며, UI 클릭 시나리오 자동화는 후속 과제다.
  - 그래도 기존 수동 확인 대비 회귀 탐지 속도/재현성이 크게 개선됨.
  - `field repro invalidation (2026-03-07)`: 현재 통합 테스트는 사용자 클릭 시나리오(`+ Agent -> 명령 -> 출력`)를 종료조건으로 검증하지 못한다.
- Result Summary:
  - 통합 검증 스크립트는 추가되었으나 실사용 출력 누락 이슈가 남음.
  - Desktop PTY 트랙(PR31~PR34)은 종료 상태가 아니라 `in_problem`으로 유지한다.

## Recovery PR Chain (Re-opened)

### PR35 - Desktop PTY End-to-End Trace Lock
- 상태: planned
- Owner: desktop-runtime
- ETA: 2026-03-08
- 목표:
  - `+ Agent -> openClaude -> terminalInput -> terminalData` 전체 경로를 단일 trace id로 관측 가능하게 고정
- 작업:
  - host/webview/pty 경로에 공통 trace id 주입
  - trace 누락 시 즉시 실패하는 검증 스크립트 추가
- Exit Criteria:
  - 사용자 재현 경로에서 trace가 매 단계 연속으로 관측된다.
  - 출력 누락 시 어떤 단계에서 유실됐는지 단일 로그로 식별된다.

### PR36 - Desktop Terminal Session Contract Simplification
- 상태: planned
- Owner: desktop-runtime
- ETA: 2026-03-09
- 목표:
  - 현재 메시지/라이프사이클 분기에서 발생하는 불확실성을 제거
- 작업:
  - terminal session contract를 단일 활성 세션 모델로 축소
  - close/toggle/remount 시 detach/attach 규칙을 문서와 코드에서 동일하게 고정
  - resize/input 실패 시 공통 복구 규칙(무시/재시도/중단) 명문화
- Exit Criteria:
  - 세션 토글/리사이즈 반복에서도 세션이 끊기지 않는다.
  - 동일 시나리오 10회 반복에서 출력 미표시 재현 0회.

### PR37 - Field Repro Closure and Release Gate
- 상태: planned
- Owner: desktop-runtime + qa
- ETA: 2026-03-10
- 목표:
  - 사용자 재현 경로를 종료조건으로 승격하고 release gate에 편입
- 작업:
  - 사용자 시나리오 기반 검증 케이스 추가(`+ Agent`, history click, terminal toggle)
  - `verify:ops`에 desktop interaction gate를 선택적으로 포함
  - 결과 리포트 템플릿(통과/실패/근거 로그) 고정
- Exit Criteria:
  - 사용자 시나리오 검증 전부 pass
  - "명령 입력 후 출력 미표시" 재현 불가를 로그+시연으로 확인
  - PR31~PR34 상태를 `done`으로 되돌릴지 여부를 근거와 함께 결정

## Acceptance Criteria
- PTY 독립 테스트가 항상 통과하고 실패 원인이 브리지와 분리되어 식별된다.
- Desktop 통합 경로에서 명령 입력 후 출력 누락이 재현되지 않는다.
- 간헐 `EBADF`가 발생해도 세션 출력 경로가 유지된다.
- PR별 작업기록에 `Review/개선/검증/검증반영/결과요약`이 누락 없이 남는다.
- `+ Agent` 사용자 경로에서 첫 출력이 관측 가능하고, 유실 시 trace로 원인 단계가 즉시 식별된다.
