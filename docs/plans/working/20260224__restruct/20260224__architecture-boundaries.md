# 20260224 Architecture Boundaries

## Scope
- 계층 경계와 데이터 계약을 먼저 고정한다.

## Deliverables
- `core` / `application` / `view-model` / `view` / `adapter` 책임 정의 문서
- 확장 <-> webview 메시지 프로토콜 타입 초안
- 상태 라이프사이클 정의: `discovered -> candidate -> bound -> tracking -> closed`

## Decisions
- View에서 `vscode.postMessage` 직접 호출 금지
- 파일 I/O와 terminal 참조는 adapter 한정
- 상태 전이는 application 유스케이스를 통해서만 수행

## Done Criteria
- 신규 코드가 경계 규칙을 위반하지 않도록 체크리스트 마련
- 기존 주요 플로우(`+Agent`, layout save/load, sound setting)의 경로 매핑 완료

## PR Plan

### PR1 - Protocol/Contract 초안 고정
- 목표: extension <-> webview 메시지 계약과 도메인 상태 타입을 단일 소스로 정리
- 상태: done (초안 타입 파일 + extension inbound/outbound 타입 적용 + 타입체크 통과)
- 코드 범위(예시):
  - `src/contracts/messages.ts`
  - `src/contracts/session.ts`
- 코드 스케치:

```ts
export type SessionStage = 'discovered' | 'candidate' | 'bound' | 'tracking' | 'closed'

export interface SessionRecord {
  sessionId: string
  jsonlPath: string
  stage: SessionStage
  terminalId?: string
  lastSeenAt: number
}

export type ExtensionToViewMessage =
  | { type: 'layoutLoaded'; layout: unknown }
  | { type: 'agentCreated'; id: number }
  | { type: 'trackingEvent'; event: TrackingEvent }
```

### PR2 - Adapter Port/Usecase 경계 도입
- 목표: application은 VS Code API를 직접 참조하지 않도록 포트 인터페이스로 분리
- 상태: done (포트/유스케이스 스캐폴드 추가, 기존 런타임 비파괴 유지)
- 코드 범위(예시):
  - `src/application/ports.ts`
  - `src/application/usecases/*.ts`
- 코드 스케치:

```ts
export interface TerminalPort {
  listOpenTerminals(): TerminalRef[]
  focusTerminal(id: string): void
}

export interface SessionStorePort {
  listJsonl(projectDir: string): string[]
  readNewLines(path: string, offset: number): { lines: string[]; nextOffset: number }
}

export interface TrackingUsecase {
  onTick(now: number): void
  onTerminalFocus(terminalId: string): void
}
```

### PR3 - 경계 보호 규칙(정적 체크) 추가
- 목표: view/core/application 간 금지 import를 CI에서 차단
- 상태: done (webview ESLint에 금지 import 규칙 추가)
- 코드 범위(예시):
  - `eslint.config.mjs`
- 코드 스케치:

```js
{
  files: ['webview-ui/src/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: ['vscode', '../../src/*', '../../../src/*']
    }]
  }
}
```
