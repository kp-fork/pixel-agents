# Pixel Agents 프로젝트 분석

**분석 일자**: 2026-02-24
**프로젝트**: VS Code 확장 - AI 에이전트 피크셀 아트 오피스

---

## 1. 프로젝트 개요

### 1.1 목적
VS Code 확장 기능에 '피크셀 에이전트'를 띄우는 애니메이션 터미널을 제공한다.
- 사용자는 `claude --session-id <uuid>` 로 생성된 터미널 각각에 대해 1:1 매핑되는 웹뷰 캐릭터(에이전트)를 띄워 인터페이스를 제공한다.
- 캐릭터는 **터미널 상태(대기·작업·종료)** 를 UI(버블, 불빛, 소리)로 표시하고, 사용자 편의성을 위해 레이아웃·시트·색상 등을 커스터마이징한다.

### 1.2 기술 스택
| 계층 | 기술 |
|------|------|
| **백엔드** | Node.js (VS Code API) + TypeScript (strict 모드) |
| **프론트엔드** | React + Vite (webview-ui) + TypeScript |
| **빌드** | esbuild (확장) + vite (webview) |
| **자산 파이프라인** | 7단계 스크립트 (tileset 탐지 → PNG → SpriteData → 카탈로그 → 내보내기) |

### 1.3 빌드 & 개발 흐름
```bash
npm install                # 백엔드 + 웹뷰 의존성
cd webview-ui && npm install && cd ..
npm run build              # esbuild + vite 번들링
npm run dev                # Extension Dev Host 실행
```

---

## 2. 아키텍처

### 2.1 디렉터리 구조
```
src/                     // 백엔드 핵심 로직
  constants.ts           // 전역 상수·타이머·파싱 값
  extension.ts           // activate/deactivate 진입점
  PixelAgentsViewProvider.ts // 웹뷰 제공
  assetLoader.ts         // PNG → SpriteData 변환
  agentManager.ts        // 에이전트 라이프사이클 관리
  layoutPersistence.ts   // 레이아웃 JSON 파일 I/O 및 마이그레이션
  fileWatcher.ts         // fs.watch + 폴링 백업
  transcriptParser.ts    // JSONL → 웹뷰 메시지 변환
  timerManager.ts        // 권한 타이머 로직
  types.ts               // 공통 인터페이스 정의

webview-ui/src/          // 리액트 프론트엔드
  constants.ts           // 웹뷰 전용 상수
  App.tsx                // 루트 컴포넌트
  hooks/…                // 메시지·에디터·키보드 상태
  components/…           // 툴바·줌·설정·디버그 UI
  office/                // 레이아웃·가구·타일 타입 정의
  components/…           // 에디터 툴 구현
  engine/                // 캐릭터 FSM·렌더링·매트릭스 효과
```

### 2.2 핵심 모듈 분석

| 모듈 | 역할 | 주요 포인트 |
|------|------|--------------|
| **assetLoader.ts** | PNG → SpriteData 변환 | `pngjs` 로 RGBA 버퍼 → 투명도 ≥ 128이면 opaque, `SpriteData` (2D hex 배열) 생성. 캐시 (`spriteCache`) 로 재사용. |
| **agentManager.ts** | 에이전트 생성·관리 | `launchAgent()` → `~/.claude/projects/<hash>/<session-id>.jsonl` 파일 감시. `adoptTerminal()` 로 알 수 없는 JSONL 파일을 자동 승계. |
| **layoutPersistence.ts** | 레이아웃 영구 저장·마이그레이션 | `~/.pixel-agents/layout.json` 파일을 읽고 쓰며, 없을 경우 `default-layout.json` 사용. `watchLayoutFile()` 로 변경 감지. |
| **renderer.ts** | 화면 그리기 | `zoom = round(2 * devicePixelRatio)` 로 캐논ical 1배 확대. `TILE_SIZE = 16` 픽셀. Canvas 2D 로 타일·가구·캐릭터 그리기. |
| **officeState.ts** | 전 세계 상태 관리 | `layout`, `characters`, `seats`, `selection` 등을 보관. `layoutToSeats()` 로 모든 의자·소파를 seat 로 변환. |
| **editor/** | 레이아웃 편집 API | `paint`, `place`, `remove`, `move`, `rotate`, `toggleState` 등 순수 함수. `expandLayout()` 로 그리드 확장 (최대 64×64). |
| **fileWatcher.ts** | 파일 변화 감지 | `fs.watch` + 2s 폴링 백업. Partial line buffering 로 중간 쓰기 처리. |
| **timerManager.ts** | 권한 타이머 | 비엑셈트 툴 실행 시 5s 타이머 시작. 초과 시 permission bubbles 표시. |

---

## 3. 핵심 개념

### 3.1 용어 정의
| 용어 | 정의 |
|------|------|
| **Terminal** | VS Code 터미널에서 Claude를 실행하는 프로세스 |
| **Session** | JSONL 대화 파일 (`~/.claude/projects/<project-hash>/<session-id>.jsonl`) |
| **Agent** | 웹뷰 캐릭터, 터미널과 1:1 매핑 |

### 3.2 Extension ↔ Webview 통신
`postMessage` 프로토콜 사용. 주요 메시지:
- `openClaude`, `agentCreated/Closed`, `focusAgent`
- `agentToolStart/Done/Clear`, `agentStatus`
- `layoutLoaded`, `furnitureAssetsLoaded`, `floorTilesLoaded`, `wallTilesLoaded`
- `saveLayout`, `exportLayout`, `importLayout`

### 3.3 JSONL 레코드 타입
| 타입 | 설명 |
|------|------|
| `assistant` | tool_use 블록 또는 thinking |
| `user` | tool_result 또는 텍스트 프롬프트 |
| `system` + `subtype: "turn_duration"` | 신뢰할 수 있는 턴 종료 시그널 |
| `progress` | `agent_progress`, `bash_progress`, `mcp_progress` |

---

## 4. UI/UX 흐름

### 4.1 에이전트 생성
1. `+ Agent` 클릭 → 새 터미널 실행
2. `session-id.jsonl` 생성 → 파일 감시 시작
3. 에이전트 생성 (대기 UI 표시)

### 4.2 터미널 채팅
1. `assistant`/`user`/`system` 레코드 파싱
2. `system` + `subtype: "turn_duration"` 로 턴 종료 감지
3. `agentStatus: 'waiting'` → 초록 체크마크 + 청각 피드백

### 4.3 레이아웃 편집
- 툴바에서 **Floor**, **Wall**, **Furniture** 선택
- `layout.json` 파일에 저장 → `layoutLoaded` 메시지로 동기화
- `expandLayout()` 로 그리드 확장 (최대 64×64)
- **Undo/Redo** 50 단계 지원 (`Ctrl+Z/Y`)

### 4.4 시각·청각 피드백
| 피드백 | 의미 | 동작 |
|--------|------|------|
| **버블 (amber dots)** | 사용자 조치 필요 | 클릭/클리어 시까지 유지 |
| **초록 체크마크** | 작업 완료 | 2s 후 자동 소멸 |
| **청각 알림 (E5→E6)** | 대기 상태 진입 | Web Audio API, 설정에서 토글 |

---

## 5. 렌더링 시스템

### 5.1 캐릭터 FSM
```
active (경로 찾기 → 자리 이동) → idle (무작위 워드) → 휴식
```
- 6가지 팔레트 → `pickDiversePalette()` 로 색상 분배
- `hueShift` 로 HSL hue 변환 (`adjustSprite`)
- 스폰/디스폰 시 **매트릭스 효과** (0.3s 디지털 레인)

### 5.2 렌더링 파라미터
| 파라미터 | 값 | 설명 |
|----------|-----|------|
| `TILE_SIZE` | 16px | 기본 타일 크기 |
| `zoom` | `round(2 * devicePixelRatio)` | 정수 배율 (1x–10x) |
| Z‑sort | `y + TILE_SIZE/2 + 0.5` | Y 좌표 기반 정렬 |

### 5.3 스프라이트 캐시
- `spriteCache`: `Map<string, SpriteData>` → 키: `"palette:hueShift"`
- PNG → SpriteData 변환 결과 메모리 재사용

---

## 6. 자산 시스템

### 6.1 가구 카탈로그
`furniture-catalog.json` 구조:
```json
{
  "id": "MONITOR_FRONT_OFF",
  "name": "Monitor",
  "category": "electronics",
  "footprint": [[1, 1]],
  "orientation": "front",
  "state": "off",
  "canPlaceOnSurfaces": true,
  "groupId": "MONITOR"
}
```

### 6.2 회전/상태 그룹
- **rotationGroups**: `groupId` 로 연결된 방향들 (front/back/left/right)
- **stateGroups**: 동일 `groupId` + `orientation` 의 on/off 토글

### 6.3 바닥/벽 타일
| 자산 | 크기 | 설명 |
|------|------|------|
| `floors.png` | 112×16 (7패턴) | 그레이스케일, HSBC 컬러라이즈 |
| `walls.png` | 64×128 (4×4 그리드) | 16×32 오토‑타일, 4‑비트 마스크 |

---

## 7. 주요 정책

### 7.1 에이전트·터미널 1:1 매핑
- 한 터미널에 하나의 에이전트만 존재
- `launchAgent()` 가 자동 매핑

### 7.2 레이아웃 영구화
- `layoutPersistence.ts` 가 파일 쓰기 전 `markOwnWrite()` 로 자기 파일 재읽기 방지
- 기본 레이아웃 없을 시 `createDefaultLayout()` 로 자동 생성

### 7.3 파일 감시
- `fs.watch` + 2s 폴링 백업 (Windows 호환성)
- Partial line buffering 로 중간 쓰기 처리

### 7.4 권한 타이머
- 비엑셈트 툴 실행 시 5s 타이머
- 만료 시 permission bubbles 표시

---

## 8. TypeScript 제약사항

| 제약 | 설명 |
|------|------|
| `erasableSyntaxOnly` | `enum` 사용 금지 → `as const` 객체 사용 |
| `verbatimModuleSyntax` | 타입 전용 import에 `import type` 필수 |
| `noUnusedLocals` / `noUnusedParameters` | 미사용 변수/파라미터 금지 |

---

## 9. 상수 관리

### 9.1 백엔드 상수
`src/constants.ts`:
- 타이머 간격
- 디스플레이 트렁케이션 한계
- PNG/자산 파싱 값
- VS Code 명령/키 식별자

### 9.2 웹뷰 상수
`webview-ui/src/constants.ts`:
- 그리드/레이아웃 크기
- 캐릭터 애니메이션 속도
- 매트릭스 효과 파라미터
- 렌더링 오프셋/색상

### 9.3 CSS 변수
`webview-ui/src/index.css` `:root` 블록:
```css
:root {
  --pixel-bg: #1e1e2e;
  --pixel-border: #2px solid;
  --pixel-accent: ...;
}
```

---

## 10. 추천 분석 포인트

| 분석 항목 | 중요성 |
|-----------|--------|
| **에이전트 상태·터미널 매핑** | UI와 실제 작업 흐름 연결 핵심 |
| **레이아웃 영구화 & 마이그레이션** | 프로젝트 간 레이아웃 공유·전환 방식 |
| **시각·청각 피드백 설계** | 사용자 행동 감지 UI·소리 |
| **자산 파이프라인** | 스프라이트·가구·타일 동적 생성·관리 |
| **권한 타이머와 서브‑에이전트** | 협업/멀티‑에이전트 권한 관리 |

---

## 11. 요약

- **구조**: 백엔드(`src/`) + 리액트 웹뷰(`webview-ui/src/`) 모듈형 아키텍처
- **에이전트**: 터미널 1:1 매핑, JSONL 로그·파일 감시·시스템 메시지로 상태 관리
- **레이아웃**: JSON 기반 영구 저장·마이그레이션, 확장·축소 지원
- **렌더링**: 피크셀 아트 스타일, Canvas 2D, Z‑sort 기반
- **자산**: PNG → SpriteData 파이프라인, 효율적 캐시 재사용
- **확장점**: 툴바·에디터·설정·소리·시트 등 UI 제공
