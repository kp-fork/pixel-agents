# Pixel Agents 프로젝트 종합 분석

> 2026-02-26, 4개의 전문 에이전트가 병렬로 수행한 분석 결과

## 목차

1. [아키텍처 개요](#1-아키텍처-개요)
2. [백엔드 아키텍처](#2-백엔드-아키텍처)
3. [프론트엔드 아키텍처](#3-프론트엔드-아키텍처)
4. [통신 프로토콜](#4-통신-프로토콜)
5. [에셋 시스템 및 렌더링](#5-에셋-시스템-및-렌더링)
6. [개선 기회](#6-개선-기회)
7. [잘 설계된 부분](#7-잘-설계된-부분)

---

## 1. 아키텍처 개요

### 전체 구조

```
┌─────────────────────────────────────────────────────────────────┐
│                    VS Code Extension Host                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  extension.ts → PixelAgentsViewProvider                 │   │
│  │       ├── agentManager (터미널 생명주기)                │   │
│  │       ├── fileWatcher (JSONL 감시)                      │   │
│  │       ├── transcriptParser (JSONL 파싱)                 │   │
│  │       ├── timerManager (대기/권한 타이머)               │   │
│  │       ├── layoutPersistence (레이아웃 저장)             │   │
│  │       └── assetLoader (에셋 로딩)                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                          │ postMessage                          │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              React Webview (Vite)                        │   │
│  │  App.tsx                                                 │   │
│  │    ├── OfficeCanvas (Canvas 렌더링)                     │   │
│  │    ├── hooks/ (React 상태)                              │   │
│  │    └── office/                                           │   │
│  │         ├── engine/ (gameLoop, renderer, officeState)   │   │
│  │         ├── sprites/ (캐싱, 컬러라이제이션)            │   │
│  │         └── editor/ (레이아웃 에디터)                   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### 핵심 컨셉

- **Vocabulary**: Terminal = VS Code terminal running Claude. Session = JSONL conversation file. Agent = webview character bound 1:1 to a terminal.
- **확장 ↔ 웹뷰**: `postMessage` 프로토콜로 양방향 통신
- **One-agent-per-terminal**: 각 "+ Agent" 클릭 → 새 터미널 → 1:1 에이전트 매핑

---

## 2. 백엔드 아키텍처

### 모듈 의존성 다이어그램

```
extension.ts (진입점)
    │
    ▼
PixelAgentsViewProvider.ts (핵심 컨트롤러)
    ├── agentManager.ts
    ├── fileWatcher.ts
    │       └── transcriptParser.ts
    ├── timerManager.ts
    ├── layoutPersistence.ts
    └── assetLoader.ts
            │
            ▼
    contracts/
    ├── postMessage.ts
    ├── messages.ts
    └── session.ts
```

### 핵심 데이터 구조

#### AgentState (types.ts)

```typescript
interface AgentState {
  id: number;                           // 에이전트 고유 ID
  terminalRef: vscode.Terminal;         // VS Code 터미널 참조
  projectDir: string;                   // Claude 프로젝트 디렉토리
  jsonlFile: string;                    // JSONL 세션 파일 경로
  fileOffset: number;                   // 파일 읽기 오프셋
  lineBuffer: string;                   // 부분 라인 버퍼
  activeToolIds: Set<string>;           // 활성 툴 ID 집합
  activeToolStatuses: Map<string, string>; // 툴 ID → 상태 메시지
  activeToolNames: Map<string, string>; // 툴 ID → 툴 이름
  activeSubagentToolIds: Map<string, Set<string>>;    // 부모툴 → 서브툴 IDs
  activeSubagentToolNames: Map<string, Map<string, string>>; // 부모툴 → (서브툴 → 이름)
  isWaiting: boolean;                   // 대기 상태 플래그
  permissionSent: boolean;              // 권한 요청 알림 전송됨
  hadToolsInTurn: boolean;              // 현재 턴에서 툴 사용 여부
}
```

### 주요 함수 및 역할

| 파일 | 함수 | 역할 |
|------|------|------|
| extension.ts | `activate()` | 확장 활성화, WebviewViewProvider 등록 |
| PixelAgentsViewProvider.ts | `resolveWebviewView()` | 웹뷰 초기화, 메시지 핸들러 등록 |
| agentManager.ts | `launchNewTerminal()` | 새 터미널 생성 및 에이전트 등록 |
| agentManager.ts | `restoreAgents()` | 워크스페이스 복원 시 에이전트 재연결 |
| fileWatcher.ts | `startFileWatching()` | fs.watch + 폴링으로 파일 감시 |
| fileWatcher.ts | `readNewLines()` | JSONL 파일에서 새 라인 읽기 |
| transcriptParser.ts | `processTranscriptLine()` | 단일 JSONL 라인 처리 |
| timerManager.ts | `startWaitingTimer()` | 텍스트 전용 턴 대기 타이머 (5초) |
| timerManager.ts | `startPermissionTimer()` | 권한 대기 감지 타이머 (7초) |
| layoutPersistence.ts | `writeLayoutToFile()` | 원자적 레이아웃 파일 쓰기 |
| assetLoader.ts | `loadFurnitureAssets()` | 가구 카탈로그 및 스프라이트 로드 |

### 파일 감시 패턴

- **하이브리드 감시**: `fs.watch` (1차) + 2초 폴링 (백업)
- **부분 라인 버퍼링**: 미완료 라인을 버퍼에 저장하여 mid-write 읽기 지원
- **자체 쓰기 무시**: `markOwnWrite()`로 자신의 쓰기를 무시하여 루프 방지

### JSONL 파싱 전략

- **턴 종료 감지**: 두 가지 신호 사용
  1. `system` + `subtype: "turn_duration"` (툴 사용 턴 - 98% 신뢰)
  2. 5초 무음 타이머 (텍스트 전용 턴 - 폴백)
- **툴 상태 지연**: `agentToolDone` 300ms 지연으로 React 배칭 방지
- **서브에이전트 추적**: `progress` 타입으로 서브에이전트 툴 사용 추적

### 새로운 application/tracking 모듈

```
application/tracking/
├── jsonlRouting.ts      // JSONL 경로 결정
├── scanner.ts           // 세션 스캔/백필
├── sessionRegistry.ts   // 세션 상태 관리
├── candidateQueue.ts    // 후보 큐 관리
├── matcher.ts           // 터미널 매칭
└── events.ts            // 추적 이벤트
```

---

## 3. 프론트엔드 아키텍처

### 컴포넌트 계층 구조

```
App.tsx (컴포지션 루트)
├── OfficeCanvas (캔버스 렌더링 + 이벤트 처리)
├── ZoomControls (줌 +/- 버튼)
├── Vignette overlay (CSS)
├── BottomToolbar (+ Agent, Layout, Settings)
├── EditActionBar (편집 모드에서만: Undo/Redo/Save/Reset)
├── Rotate Hint (R 키 회전 안내)
├── EditorToolbar (편집 툴 팔레트)
├── ToolOverlay (캐릭터 위 활동 상태 표시)
└── DebugView (디버그 모드)
```

### 상태 관리: 이중 구조 (Hybrid)

#### React State (hooks/)

- `useExtensionMessages`: 에이전트 목록, 도구 상태, 서브에이전트, 레이아웃 준비 여부
- `useEditorActions`: 편집 모드, 줌, pan, dirty 플래그, undo/redo 스택
- `useEditorKeyboard`: 키보드 단축키 처리

#### Imperative State (클래스 인스턴스)

```typescript
// 싱글톤으로 관리
const officeStateRef = { current: null as OfficeState | null }
const editorState = new EditorState()
```

- **OfficeState**: 게임 월드의 단일 소스
  - `layout`, `tileMap`, `seats`, `furniture`, `characters`, `blockedTiles`
  - `selectedAgentId`, `hoveredAgentId`, `cameraFollowId`
  - `subagentIdMap`, `subagentMeta` (서브에이전트 추적)
- **EditorState**: 편집기 상태
  - `activeTool`, `selectedFurnitureType/Uid`, `ghostCol/Row`
  - `undoStack`, `redoStack`, `isDirty`

### 렌더링 파이프라인

```
requestAnimationFrame (gameLoop.ts)
    │
    ├── update(dt)
    │     └── OfficeState.update(dt)
    │           ├── Character FSM (idle/walk/type)
    │           ├── Matrix spawn/despawn effect
    │           └── Bubble timer
    │
    └── render(ctx)
          ├── renderTileGrid() (바닥 + 벽 베이스)
          ├── renderSeatIndicators()
          ├── getWallInstances()
          ├── renderScene() (Z-sort)
          │     ├── Furniture sprites
          │     ├── Character sprites + outline
          │     └── Matrix effect
          ├── renderBubbles()
          └── Editor overlays
```

### Character FSM (상태 머신)

- **TYPE**: 활성 상태, 타이핑/리딩 애니메이션 → 비활성화 시 seatTimer 후 IDLE 전이
- **IDLE**: 정지 상태 → wanderTimer 후 WALK 또는 활성화 시 좌석으로 이동
- **WALK**: 경로 따라 이동 → 목적지 도달 시 TYPE/IDLE 전이

### 게임 루프

```typescript
const frame = (time: number) => {
  const dt = Math.min((time - lastTime) / 1000, MAX_DELTA_TIME_SEC) // 0.1s 캡
  callbacks.update(dt)
  ctx.imageSmoothingEnabled = false  // 픽셀 아트 유지
  callbacks.render(ctx)
  rafId = requestAnimationFrame(frame)
}
```

---

## 4. 통신 프로토콜

### 메시지 타입 분류

#### WebviewToExtensionMessage (웹뷰 → 확장) - 11개

**명령형:**
- `openClaude`, `focusAgent`, `closeAgent`
- `openSessionsFolder`, `openExternal`
- `exportLayout`, `importLayout`

**상태 동기화:**
- `saveLayout`, `saveAgentSeats`
- `setSoundEnabled`, `setSpeechBubblesEnabled`

**이벤트형:**
- `webviewReady`

#### ExtensionToWebviewMessage (확장 → 웹뷰) - 18개

**에이전트 생명주기:**
- `agentCreated`, `agentClosed`, `agentSelected`, `existingAgents`

**도구 활동 추적:**
- `agentToolStart`, `agentToolDone`, `agentToolsClear`
- `subagentToolStart`, `subagentToolDone`, `subagentClear`

**상태 변경:**
- `agentStatus` ('active' | 'waiting')
- `agentToolPermission`, `agentToolPermissionClear`
- `subagentToolPermission`

**리소스 로딩:**
- `layoutLoaded`, `characterSpritesLoaded`, `floorTilesLoaded`, `wallTilesLoaded`
- `furnitureAssetsLoaded`, `settingsLoaded`

### 초기화 시퀀스

```
webviewReady → settingsLoaded
            → characterSpritesLoaded
            → floorTilesLoaded
            → wallTilesLoaded
            → furnitureAssetsLoaded
            → layoutLoaded
            → existingAgents
```

### 통신 패턴

- **Fire-and-forget**: 모든 메시지는 응답 대기 없이 단방향
- **상태 동기화**: 확장 → 웹뷰는 push 기반, 웹뷰 → 확장은 명시적 저장 시에만
- **크로스 윈도우 동기화**: `watchLayoutFile()` → 외부 변경 감지 → `layoutLoaded` push

### 파일별 메시지 송신 책임

| 파일 | 송신 메시지 |
|------|-------------|
| PixelAgentsViewProvider.ts | settingsLoaded, layoutLoaded, agentSelected, agentClosed |
| agentManager.ts | agentCreated, existingAgents |
| timerManager.ts | agentToolsClear, agentStatus, agentToolPermission |
| transcriptParser.ts | agentStatus, agentToolStart/Done/Clear, subagentToolStart/Done/Clear |
| fileWatcher.ts | agentToolPermissionClear, agentCreated |
| assetLoader.ts | *SpritesLoaded, *TilesLoaded, furnitureAssetsLoaded |

---

## 5. 에셋 시스템 및 렌더링

### 에셋 로딩 파이프라인

```
characterSpritesLoaded → floorTilesLoaded → wallTilesLoaded → furnitureAssetsLoaded → layoutLoaded
```

1. **캐릭터 스프라이트**: 6개 사전 채색 PNG (char_0.png ~ char_5.png)
2. **바닥 타일**: floors.png (112×16, 7개 패턴, 각 16×16)
3. **벽 타일**: walls.png (64×128, 4×4 그리드, 16개 비트마스크)
4. **가구 에셋**: furniture-catalog.json + 개별 PNG

### PNG → SpriteData 변환

```typescript
// PNG RGBA 버퍼 → 2D hex 배열
// alpha < 128 → '' (투명)
// alpha >= 128 → '#RRGGBB'
```

### 스프라이트 캐싱 전략

```typescript
// 2단계 WeakMap 캐시
const zoomCaches = new Map<number, WeakMap<SpriteData, HTMLCanvasElement>>()
```

- 1단계: 줌 레벨별 캐시 맵
- 2단계: SpriteData → Canvas (WeakMap으로 메모리 관리)

### 컬러라이제이션

#### Colorize 모드 (Photoshop 스타일)
- 용도: 바닥 타일, 벽 타일
- 그레이스케일 → 휘도 계산 → 대비/밝기 → 고정 HSL

#### Adjust 모드
- 용도: 가구, 캐릭터 hue shift
- 원본 HSL 값을 shift (H: ±180도, S: ±100)

### 벽 타일 자동 타일링

```
4-bit 비트마스크: N=1, E=2, S=4, W=8
이웃 벽 타일 체크 → 0-15 비트마스크 → 해당 스프라이트 선택
```

### Z-Sorting 알고리즘

```typescript
// 모든 요소를 zY 기준 정렬
drawables.sort((a, b) => a.zY - b.zY)
```

- **가구**: `zY = f.zY` (사전 계산)
- **벽**: `zY = (row + 1) * TILE_SIZE`
- **캐릭터**: `zY = ch.y + TILE_SIZE/2 + 0.5`
- **서피스 아이템**: 데스크 zY + 0.5

### 에셋 추출 파이프라인

```
scripts/
├── 0-import-tileset.ts      → CLI 래퍼
├── 1-detect-assets.ts       → Flood-fill로 에셋 영역 감지
├── 2-asset-editor.html      → 위치/경계 편집 UI
├── 3-vision-inspect.ts      → Claude Vision 메타데이터 자동 생성
├── 4-review-metadata.html   → 메타데이터 리뷰 UI
├── 5-export-assets.ts       → PNG 내보내기 + catalog 생성
└── asset-manager.html       → 통합 에디터 (2+4 결합)
```

---

## 6. 개선 기회

### 통신

1. **메시지 버퍼링**: 웹뷰 준비 전 메시지 유실 가능
2. **핸들러 분리**: `onDidReceiveMessage` 100+ 줄 → 핸들러 맵 패턴
3. **런타임 타입 검증**: zod 등으로 메시지 검증
4. **순서 의존성**: 에셋 로딩 순서 하드코딩 → 병렬 로딩 + 완료 대기

### 프론트엔드

1. **대형 파일 분리**:
   - `OfficeCanvas.tsx` 690줄 → 이벤트 핸들러 별도 파일
   - `useExtensionMessages.ts` 350줄 → 메시지 타입별 핸들러 분리
2. **책임 경계**: `EditorState`와 `useEditorActions` 간 일부 상태 중복

### 에셋

1. **캐시 키 중복**: `colorize.ts`와 `floorTiles.ts`에서 유사한 키 생성 로직 분산
2. **벽 타일 HSL 변환**: `wallColorToHex()`가 `hslToHex()`와 중복
3. **에셋 로딩 에러 처리**: 일부 실패 시 부분 로드만 경고

---

## 7. 잘 설계된 부분

### 아키텍처

- ✅ **상태 격리**: 게임 상태(OfficeState)와 React 상태 완전 분리 → 불필요한 리렌더링 방지
- ✅ **Provider 패턴**: WebviewViewProvider로 VS Code 패널 영역에 깔끔하게 통합
- ✅ **Ref 패턴**: `{ current: value }` 객체로 참조 전달 (함수 간 상태 공유)

### 백엔드

- ✅ **하이브리드 파일 감시**: `fs.watch` + 폴링으로 Windows 호환성 확보
- ✅ **부분 라인 버퍼링**: mid-write 읽기 지원
- ✅ **이중 턴 종료 감지**: turn_duration + 5초 무음 타이머

### 프론트엔드

- ✅ **WeakMap 캐싱**: 메모리 누수 방지
- ✅ **Delta time 캡**: `MAX_DELTA_TIME_SEC = 0.1`로 탭 전환 후 프레임 드랍 대응
- ✅ **Debounced 저장**: `LAYOUT_SAVE_DEBOUNCE_MS = 500ms`
- ✅ **다양한 팔레트**: `pickDiversePalette()`로 최소 사용 팔레트 우선 배정

### 렌더링

- ✅ **픽셀 퍼펙트**: 정수 줌만 사용, `imageSmoothingEnabled = false`
- ✅ **Z-sorting**: 올바른 깊이 표현
- ✅ **Matrix 이펙트**: 스폰/디스폰 애니메이션

---

## 부록: 디렉토리 구조

```
src/                          — Extension backend (Node.js, VS Code API)
  constants.ts                — All backend magic numbers/strings
  extension.ts                — Entry: activate(), deactivate()
  PixelAgentsViewProvider.ts  — WebviewViewProvider, message dispatch
  agentManager.ts             — Terminal lifecycle
  fileWatcher.ts              — fs.watch + polling, JSONL reading
  transcriptParser.ts         — JSONL parsing
  timerManager.ts             — Waiting/permission timer logic
  layoutPersistence.ts        — Layout file I/O
  assetLoader.ts              — PNG parsing, sprite conversion
  types.ts                    — Shared interfaces
  contracts/
    messages.ts               — Message type definitions

webview-ui/src/               — React + TypeScript (Vite)
  constants.ts                — All webview magic numbers/strings
  App.tsx                     — Composition root
  hooks/
    useExtensionMessages.ts   — Message handler
    useEditorActions.ts       — Editor state
    useEditorKeyboard.ts      — Keyboard shortcuts
  components/
    BottomToolbar.tsx
    ZoomControls.tsx
    SettingsModal.tsx
    DebugView.tsx
  office/
    types.ts
    toolUtils.ts
    colorize.ts
    floorTiles.ts
    wallTiles.ts
    sprites/
      spriteData.ts
      spriteCache.ts
    editor/
      editorActions.ts
      editorState.ts
      EditorToolbar.tsx
    layout/
      furnitureCatalog.ts
      layoutSerializer.ts
      tileMap.ts
    engine/
      characters.ts
      officeState.ts
      gameLoop.ts
      renderer.ts
      matrixEffect.ts
    components/
      OfficeCanvas.tsx
      ToolOverlay.tsx

scripts/                      — Asset extraction pipeline (7 stages)
```
