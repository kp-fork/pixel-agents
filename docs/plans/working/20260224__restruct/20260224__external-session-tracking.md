# 20260224 External Session Tracking

## Scope
- 수동 실행 Claude 세션의 자동 인식률을 개선한다.

## Strategy
- `known` 단일 집합을 `seen`/`bound`로 분리
- 시작 시 기존 JSONL을 소급 스캔(backfill)
- active terminal 단일 의존을 줄이고 후보 매칭 전략 도입
- 매칭 실패 후보를 재시도 큐로 관리

## Metrics
- 자동 인식률
- 첫 인식까지 걸린 시간
- 오탐(잘못된 터미널 매칭) 비율

## Done Criteria
- 선실행/후실행/다중터미널/`/clear`/재시작 복원 시나리오 통과
- 디버그 로그에서 `attempt/success/deferred/fail` 원인 추적 가능

## PR Plan

### PR4 - Session Registry 분리(`seen`/`bound`)
- 목표: 기존 `known` 집합을 역할 기반 상태로 분리
- 상태: done (in-memory session registry + snapshot 지원)
- 코드 범위(예시):
  - `src/application/tracking/sessionRegistry.ts`
- 코드 스케치:

```ts
export interface SessionRegistry {
  seenJsonl: Set<string>
  boundJsonl: Map<string, number> // jsonl -> agentId
  markSeen(path: string): void
  bind(path: string, agentId: number): void
  isBound(path: string): boolean
}
```

### PR5 - Backfill + Candidate Queue 도입
- 목표: 시작 시 기존 JSONL도 후보로 올려 인식 기회를 부여
- 상태: done (backfill candidate builder + defer/backoff queue)
- 코드 범위(예시):
  - `src/application/tracking/scanner.ts`
  - `src/application/tracking/candidateQueue.ts`
- 코드 스케치:

```ts
export interface CandidateSession {
  jsonlPath: string
  mtimeMs: number
  size: number
  retryCount: number
}

export function buildBackfillCandidates(paths: string[]): CandidateSession[] {
  return paths
    .map(toCandidate)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}
```

### PR6 - 터미널 매칭 전략 고도화
- 목표: active terminal 1개 의존 제거, 미등록 터미널 풀에서 점수 기반 선택
- 상태: done (score breakdown + best-match selector)
- 코드 범위(예시):
  - `src/application/tracking/matcher.ts`
- 코드 스케치:

```ts
export interface TerminalMatchScoreInput {
  terminal: TerminalRef
  candidate: CandidateSession
  now: number
}

export function scoreTerminalMatch(input: TerminalMatchScoreInput): number {
  // 최근 활성 시간, 이름 패턴, cwd 일치도 등
  return 0
}
```

### PR7 - Tracking Telemetry/Debug 이벤트
- 목표: 추적 실패 원인을 재현 가능한 이벤트로 남기기
- 상태: done (typed event emitters + ring buffer + debug snapshot serializer)
- 코드 범위(예시):
  - `src/application/tracking/events.ts`
  - `webview-ui/src/components/DebugView.tsx`
- 코드 스케치:

```ts
export type TrackingEventType =
  | 'tracking_attempt'
  | 'tracking_success'
  | 'tracking_deferred'
  | 'tracking_failed'

export interface TrackingEvent {
  type: TrackingEventType
  jsonlPath: string
  terminalId?: string
  reason?: string
  at: number
}
```
