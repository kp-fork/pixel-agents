# 20260226 History Sessions Plan

## Scope
- 프로젝트가 열릴 때 해당 Claude project 디렉토리의 최근 N일 세션을 history 캐릭터로 배치한다.
- history 캐릭터는 runtime 추적 대상이 아니며, 클릭 시 transcript를 연다.
- 좌석 재배치는 허용, 직접 이동은 불가로 고정한다.

## PR Plan

### PR23 - 프로젝트 최근 세션 history 후보 스캔/전달
- 목표: extension에서 history 세션 목록을 수집해 webview로 전달
- 상태: done
- 핵심 작업:
  - `collectHistorySessions` 도입
  - 설정(`enabled/lookbackDays/maxVisible`) 추가
  - `historySessionsLoaded`/`openSessionTranscript` 메시지 계약 추가

### PR24 - history 세션 캐릭터 배치/클릭 동작
- 목표: webview에서 history 캐릭터를 배치하고 클릭 행동을 분리
- 상태: done
- 핵심 작업:
  - history 캐릭터 타입/상태 동기화
  - 클릭 시 transcript 열기
  - 좌석 재배치 허용, 직접 이동 금지

### PR25 - history 세션 테스트/문서화
- 목표: history 세션 필터링 로직 회귀 테스트와 사용자 문서 반영
- 상태: done
- 핵심 작업:
  - `test-history-sessions` 추가
  - `test:runtime` 통합
  - README 설정 문서화

## Execution Log

### PR23
- Review:
  - 기존 구조는 live agent 복원/추적에만 초점이 있어 최근 세션을 별도 시각화할 경로가 없었다.
- Improvement:
  - `src/historySessions.ts` 추가(`collectHistorySessions`).
  - `package.json` 설정 추가:
    - `pixel-agents.historySessions.enabled`
    - `pixel-agents.historySessions.lookbackDays`
    - `pixel-agents.historySessions.maxVisible`
  - 계약/호스트 반영:
    - outbound `historySessionsLoaded`
    - inbound `openSessionTranscript`
    - webviewReady 시 history 목록 전송
- Validation:
  - `npm run check-types` 통과
- Summary:
  - 프로젝트 단위 history 세션 후보 스캔/전달 경로가 추가됨.

### PR24
- Review:
  - 캐릭터를 단순 추가하면 live/subagent와 상호작용 경로가 충돌할 수 있어 분리된 동작 규칙이 필요했다.
- Improvement:
  - `isHistorical` 캐릭터 속성 추가.
  - `historySessionsLoaded` 수신 시 office state에 history 캐릭터 동기화.
  - 클릭 분기:
    - history 캐릭터: `openSessionTranscript`
    - live/subagent: 기존 focus 동작 유지
  - 동작 정책:
    - 좌석 재배치 가능
    - 우클릭 직접 이동 불가
    - 시각적으로 낮은 alpha로 구분
- Validation:
  - `npm run check-types` 통과
  - `npm run build:webview` 통과
  - `npm run test:runtime` 통과
- Summary:
  - history 캐릭터가 live agent와 충돌 없이 배치/클릭/좌석 재배치 가능 상태로 동작함.

### PR25
- Review:
  - history 필터링은 시간 조건/라이브 제외/최대 개수 제한이 핵심이라 고정 테스트가 필요했다.
- Improvement:
  - `scripts/test-history-sessions.ts` 추가.
  - `test:runtime`에 history 테스트 포함.
  - README에 history 기능/설정 키 문서화.
- Validation:
  - `npm run test:runtime` 통과
  - `npm run check-types` 통과
- Summary:
  - history 경로에 대한 최소 회귀 안전망과 운영 문서가 확보됨.
