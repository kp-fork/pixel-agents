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
- 상태: pending
- 핵심 작업:
  - overlay 상태 계산 로직 분리 및 우선순위 정리
  - 활성 상태지만 도구 이벤트가 없는 구간 표현 개선

### PR21 - 버블 표현 토글 분리(상시 상태/이벤트 아이콘)
- 목표: 상시 상태 버블과 이벤트 아이콘 버블을 독립 설정으로 제어한다.
- 상태: pending
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
- Improvement:
- Validation:
- Validation Reflection:
- Summary:

### PR21
- Review:
- Improvement:
- Validation:
- Validation Reflection:
- Summary:

### PR22
- Review:
- Improvement:
- Validation:
- Validation Reflection:
- Summary:
