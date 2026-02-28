# Layout Presets

## 20260227__cozy-house-dense.json

- 목적: 기본 구성요소만으로도 공간이 덜 비어 보이는 "밀도 높은 하우스형" 레이아웃
- 규격: `version: 1`, `21x21`, 가구 76개
- 호환: 내장 가구 타입(`desk`, `chair`, `bookshelf`, `plant`, `cooler`, `whiteboard`, `pc`, `lamp`)만 사용

## 20260227__theme-office.json

- 목적: 칸막이+좌석 중심의 사무실형 테마 레이아웃 (라운지/장비 존 추가)
- 규격: `version: 1`, `21x21`, 가구 67개
- 호환: 커스텀 가구 에셋 필요 (`assets/furniture/furniture-catalog.json` + `assets/furniture/custom/*.png`)

## 20260227__theme-cafe.json

- 목적: 카운터/테이블/스툴 중심의 카페형 테마 레이아웃 (파티션/키오스크 존 추가)
- 규격: `version: 1`, `21x21`, 가구 45개
- 호환: 커스텀 가구 에셋 필요 (`assets/furniture/furniture-catalog.json` + `assets/furniture/custom/*.png`)

## 20260227__theme-lab.json

- 목적: 실험 벤치/장비 중심의 연구실형 테마 레이아웃 (분리대/보조 카운터 추가)
- 규격: `version: 1`, `21x21`, 가구 47개
- 호환: 커스텀 가구 에셋 필요 (`assets/furniture/furniture-catalog.json` + `assets/furniture/custom/*.png`)

## Import 방법

1. Pixel Agents 패널에서 `Settings` 열기
2. `Import Layout` 클릭
3. 아래 중 원하는 파일 선택:
   - `docs/layouts/20260227__cozy-house-dense.json`
   - `docs/layouts/20260227__theme-office.json`
   - `docs/layouts/20260227__theme-cafe.json`
   - `docs/layouts/20260227__theme-lab.json`

필요하면 현재 레이아웃은 먼저 `Export Layout`으로 백업하세요.

## Pack 문서

- Pack 구조 명세: `packs/README.md`
- Pack 템플릿: `packs/template/`
