# 20260224 View Decoupling

## Scope
- UI를 호스트 독립 모듈로 분리해 재사용성을 확보한다.

## Strategy
- Office 상태 관리 로직을 `core`로 이동
- UI 입력 처리(use hooks)와 렌더러를 분리
- webview 전용 브리지는 adapter에서만 유지
- 최소 1개 독립 하네스(브라우저 데모 또는 테스트 앱)에서 동일 view-model 검증

## Migration Notes
- 1단계: 타입/상태 모델 추출
- 2단계: 메시지 핸들러를 application 유스케이스로 이동
- 3단계: React 컴포넌트는 view-model prop 기반으로 단순화

## Done Criteria
- view 패키지가 VS Code 의존성 없이 단독 실행 가능
- 기존 기능 회귀 없이 동일 레이아웃/애니메이션/도구 표시 유지

## PR Plan

### PR8 - Core 상태/전이 추출
- 목표: Office 상태/전이 로직을 host-agnostic 모듈로 이동
- 상태: done (core store/reducer/session transition 스캐폴드 추가)
- 코드 범위(예시):
  - `packages/core/src/officeState.ts`
  - `packages/core/src/sessionState.ts`
- 코드 스케치:

```ts
export interface CoreState {
  agents: Map<number, AgentCoreState>
  layout: OfficeLayout
}

export class CoreStore {
  private state: CoreState
  dispatch(event: CoreEvent): void {}
  snapshot(): CoreState { return this.state }
}
```

### PR9 - ViewModel Mapper 도입
- 목표: React 렌더링은 ViewModel만 소비하도록 단순화
- 상태: done (view-model 타입 + core->vm mapper 추가)
- 코드 범위(예시):
  - `packages/view-model/src/mapToViewModel.ts`
- 코드 스케치:

```ts
export interface PixelAgentsViewModel {
  characters: CharacterVM[]
  overlays: OverlayVM[]
  toolbar: ToolbarVM
}

export function mapToViewModel(state: CoreState): PixelAgentsViewModel {
  return { characters: [], overlays: [], toolbar: { isEditMode: false } }
}
```

### PR10 - Webview Adapter 분리
- 목표: `postMessage`/메시지 핸들링을 adapter로 격리
- 상태: done (HostBridge + MessageRouter + 기존 vscodeApi 호환 브리지 적용)
- 코드 범위(예시):
  - `webview-ui/src/adapter/vscodeBridge.ts`
  - `webview-ui/src/adapter/messageRouter.ts`
- 코드 스케치:

```ts
export interface HostBridge {
  send(msg: unknown): void
  onMessage(handler: (msg: unknown) => void): () => void
}

export function createVsCodeBridge(vscodeApi: { postMessage: (m: unknown) => void }): HostBridge {
  return {
    send: (msg) => vscodeApi.postMessage(msg),
    onMessage: (handler) => {
      const listener = (e: MessageEvent) => handler(e.data)
      window.addEventListener('message', listener)
      return () => window.removeEventListener('message', listener)
    },
  }
}
```

### PR11 - 재사용 하네스 추가
- 목표: VS Code 밖에서도 동일 ViewModel로 렌더링 검증
- 상태: done (`apps/view-harness` 콘솔 하네스 추가)
- 코드 범위(예시):
  - `apps/view-harness/src/main.tsx`
  - `apps/view-harness/src/mockBridge.ts`
- 코드 스케치:

```ts
const bridge = createMockBridge()
const store = new CoreStore(seedState())

setInterval(() => {
  store.dispatch(nextMockEvent())
  render(mapToViewModel(store.snapshot()))
}, 500)
```
