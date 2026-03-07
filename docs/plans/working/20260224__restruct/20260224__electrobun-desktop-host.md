# 20260224 Electrobun Desktop Host

## Scope
- VS Code extension을 유지하면서 Electrobun 기반 desktop host를 병행 지원한다.

## Strategy
- 전환(replace) 대신 병행(additive) 접근을 사용한다.
- view는 host-agnostic view-model만 소비한다.
- host별 책임은 adapter/bridge 레이어에서 격리한다.

## Risks
- VS Code 전용 기능(터미널 제어/포커스/패널 수명주기) 의존도가 높아 desktop host에서 동일 UX 재현이 어려울 수 있다.
- bridge 계약이 약하면 host별 분기 코드가 다시 view로 침투할 수 있다.

## PR Plan

### PR12 - HostBridge 표준 인터페이스 확정
- 목표: VS Code와 Electrobun이 동일 application/view-model 계약을 사용하도록 bridge 인터페이스를 고정
- 상태: done (`src/application/ports/hostBridge.ts` + webview adapter HostBridge 확장)
- 코드 범위(예시):
  - `src/application/ports/hostBridge.ts`
  - `webview-ui/src/adapter/hostBridge.ts`
- 코드 스케치:

```ts
export interface HostBridge {
  send(message: unknown): void
  onMessage(handler: (message: unknown) => void): () => void
  openExternal?(urlOrPath: string): Promise<void>
}
```

### PR13 - Electrobun 최소 호스트 프로토타입
- 목표: layout 렌더링 + 메시지 왕복 + mock agent 이벤트까지 동작하는 desktop 프로토타입 구축
- 상태: done (`apps/desktop` 프로토타입 스캐폴드 + 실윈도우 부팅 경로 반영)
- 코드 범위(예시):
  - `apps/desktop/src/main.ts` (console prototype)
  - `apps/desktop/src/bun/index.ts` (Electrobun window entry)
  - `apps/desktop/electrobun.config.ts`
- 코드 스케치:

```ts
const bridge = createElectrobunBridge()
const app = createPixelAgentsApp({ bridge })

bridge.onMessage((msg) => {
  app.handleHostMessage(msg)
})
```

### PR14 - VS Code / Electrobun 듀얼 타겟 실행 플로우
- 목표: 동일 코드베이스에서 host 선택 실행 및 기본 검증 시나리오 정착
- 상태: done (root scripts + README dual-host section + dependency bootstrap 보강)
- 코드 범위(예시):
  - `package.json` scripts
  - `README.md` 개발 섹션
  - `docs/plans/working/...` 테스트 체크리스트
- 코드 스케치:

```json
{
  "scripts": {
    "dev:vscode": "npm run watch",
    "dev:desktop": "npm run setup:desktop && npm --prefix apps/desktop run start"
  }
}
```

## 2026-03-04 Follow-up
- `electrobun dev`에서 `latest` core URL 404 이슈를 확인했고, 로컬 의존성 기반(`apps/desktop/node_modules/electrobun`)으로 버전 고정 다운로드 경로(`v1.14.4`)를 사용하도록 실행 플로우를 정리했다.
- `npm run dev:desktop` 검증에서 런처/웹뷰 로드 및 `BrowserWindow` 렌더 로그를 확인했다.
- Electrobun `copy` 설정으로 `dist/webview`를 `views/pixel`에 포함하고, `BrowserWindow(url='views://pixel/index.html')`로 캐릭터 웹뷰를 직접 로드하도록 변경했다.
- VS Code host가 없는 경우 `useExtensionMessages` standalone fallback으로 demo agent를 생성해 캐릭터 씬이 바로 보이도록 연결했다.
- `host-message` 기반 bridge를 추가해 desktop host가 webview 이벤트 발행 주체 역할을 수행하도록 변경했다.
  - webview -> host: `__electrobunSendToHost` (`openClaude`, `focusAgent`, `closeAgent`, `set*`)
  - host -> webview: `window.dispatchEvent(new MessageEvent('message', { data }))` (`settingsLoaded`, `existingAgents`, `layoutLoaded`, `historySessionsLoaded`, `agent*`)
- desktop host history 옵션 소스를 프로젝트 루트 `settings.json`으로 고정하고(`pixel-agents.historySessions.*`), 실행 로그에서 로드 파일 경로/값을 직접 확인할 수 있게 했다.

## Done Criteria
- VS Code host 경로 회귀 없음
- Electrobun host에서 최소 시나리오(레이아웃 렌더, 메시지 수신, mock 이벤트 반영) 통과
- host 분기 코드가 view 레이어로 유입되지 않음
