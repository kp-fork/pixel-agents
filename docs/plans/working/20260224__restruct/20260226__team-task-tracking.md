# 20260226 Team/Task Tracking Follow-up

## Scope
- PR19~PR22를 순차 수행하고, 각 PR마다 리뷰/개선/검증/검증반영/결과요약을 남긴다.

## PR Plan

### PR19 - 실데이터 기반 runtime 검증 경로 강화
- 목표: 로컬 Claude 세션 JSONL을 다건으로 점검해 실제 동작 신호를 빠르게 검증할 수 있게 한다.
- 상태: done
- 핵심 작업:
  - 다건 JSONL 점검 스크립트 추가(최신 N개/실패 집계)
  - 기존 `test:flow`와 함께 실행 가능한 검증 스크립트 구성

### PR20 - Orchestration 상태 표현 우선순위/완료표현 정리
- 목표: Team*/Task 흐름에서 `Idle` 과다 노출을 줄이고 진행/완료 상태 문구를 일관화한다.
- 상태: done
- 핵심 작업:
  - overlay 상태 계산 로직 분리 및 우선순위 정리
  - 활성 상태지만 도구 이벤트가 없는 구간 표현 개선

### PR21 - 버블 표현 토글 분리(상시 상태/이벤트 아이콘)
- 목표: 상시 상태 버블과 이벤트 아이콘 버블을 독립 설정으로 제어한다.
- 상태: done
- 핵심 작업:
  - 설정 키/메시지 계약 분리
  - Settings UI에 독립 토글 추가
  - overlay/renderer가 각 설정을 독립 참조하도록 반영

### PR22 - 최소 회귀 테스트(Team/Overlay/Toggle) 추가
- 목표: Team 추적/상태표현/토글 경로에 대해 빠른 회귀 검증을 추가한다.
- 상태: pending
- 핵심 작업:
  - parser Team 경로 단위 테스트
  - overlay 상태 계산/토글 기본 동작 테스트

## Execution Log

### PR19
- Review:
  - 단일 파일 검증(`test:flow`)만으로는 최근 회귀를 넓게 확인하기 어렵고, Team/Task 계열 신호 누락 여부를 다건에서 빠르게 확인하기 어려웠다.
- Improvement:
  - `scripts/verify-agent-flow-batch.ts` 추가.
  - 최신 N개 JSONL(기본 5개)을 순회하며 핵심 불변식 점검:
    - `raw tool_use > 0`이면 `agentToolStart > 0`
    - `agentToolStart > 0`이면 `agentStatus(active) > 0`
    - `raw subagent tool_use > 0`이면 `subagentToolStart > 0`
  - `package.json`에 `test:flow:batch` 스크립트 추가.
  - README에 실데이터 검증 커맨드(`test:flow`, `test:flow:batch`) 문서화.
- Validation:
  - `npm run test:flow` 통과
  - `npm run test:flow:batch` 통과
  - `npm run check-types` 통과
- Validation Reflection:
  - 실데이터 다건 점검으로 "최근 세션에서 이벤트 파이프라인이 실제로 살아있는지"를 빠르게 확인 가능해졌다.
  - 다만 CI 고정 회귀 검증은 별도 fixture 기반 테스트(PR22)로 보완이 필요하다.
- Summary:
  - PR19 완료. 실데이터 기준 런타임 검증 경로를 단건→다건으로 확장했다.

### PR20
- Review:
  - 기존 오버레이는 상태 계산이 컴포넌트 내부 분기문에 섞여 있어 우선순위가 명확하지 않았고, 활성 상태에서 도구 이벤트가 늦게 오면 `Idle`이 쉽게 노출됐다.
- Improvement:
  - `webview-ui/src/office/components/toolOverlayState.ts` 추가:
    - 오버레이 텍스트/점 상태 계산을 순수 함수로 분리.
    - 우선순위 정리: `Needs approval > Coordinating > tool status > Working > Idle`.
    - subtask 진행 문구를 `Coordinating done/total` 형태로 통일.
  - `ToolOverlay.tsx`는 계산 결과를 소비만 하도록 단순화.
  - 활성인데 도구가 비어있는 구간은 `Working`으로 표시되도록 개선.
- Validation:
  - `npm run build:webview` 통과
  - `npm run test:flow:batch` 통과
- Validation Reflection:
  - UI 표현 로직을 pure function으로 분리해 PR22에서 단위 테스트를 직접 붙일 수 있는 형태가 되었다.
- Summary:
  - PR20 완료. Team/Task orchestration 상태 표현 우선순위와 진행 문구를 정리하고 `Idle` 과다 노출을 완화했다.

### PR21
- Review:
  - 기존 `speechBubblesEnabled` 단일 플래그가 상태 오버레이와 이벤트 아이콘 버블을 동시에 제어해, 사용자 의도(상시 상태만 켜기/끄기, 이벤트 아이콘만 켜기/끄기)를 분리할 수 없었다.
- Improvement:
  - 설정 키 분리:
    - `pixel-agents.alwaysStatusBubblesEnabled`
    - `pixel-agents.eventBubblesEnabled`
  - 메시지 계약 확장:
    - inbound: `setAlwaysStatusBubblesEnabled`, `setEventBubblesEnabled`
    - outbound `settingsLoaded`에 분리 필드 추가(legacy `speechBubblesEnabled` 호환 유지)
  - UI 반영:
    - Settings에 `Always status bubbles on`, `Event bubble icons on` 독립 체크 추가
    - `ToolOverlay`는 always-status 플래그만 참조
    - 캔버스 renderer의 이벤트 아이콘 버블은 event-bubbles 플래그만 참조
- Validation:
  - `npm run check-types` 통과
  - `npm run build:webview` 통과
  - `npm run test:flow:batch` 통과
- Validation Reflection:
  - 호환 경로를 유지해 기존 설정값을 잃지 않고 자연스럽게 신규 분리 키로 이행된다.
- Summary:
  - PR21 완료. 상태 오버레이와 이벤트 아이콘 버블을 독립적으로 켜고 끌 수 있게 분리했다.

### PR22
- Review:
- Improvement:
- Validation:
- Validation Reflection:
- Summary:
