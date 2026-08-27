# 남파랑길 가이드

부산 오륙도에서 전남 해남 땅끝탑까지, 남해안을 따라 이어지는 **남파랑길 90개 코스**를
지도에서 보고 구간을 골라 계획하고, 걸으면서 찍은 사진과 메모를 위치에 남기는 개인용 웹앱.

> **개발 중** — 현재 단계 0(배포 파이프라인) 완료. 진행 상황은 [PLAN.md](PLAN.md) 참고.

## 무엇을 하는가

- 90개 코스 전체를 지도에 표시 (+ 임시우회 노선 2개)
- **시작 코스 ~ 종료 코스를 골라** 구간의 총거리 · 예상 소요시간 · 누적 상승 · 난이도를 한 번에 확인
- 선택 구간의 고도 프로필 표시
- 사진을 올리면 **EXIF GPS로 위치를 뽑아 지도에 점으로 표시** — 클릭하면 사진과 메모가 나온다
  (EXIF가 없는 사진은 지도를 클릭해 위치 지정)

## 기술 스택

**서버가 없다.** 정적 파일과 GitHub만으로 돌아간다.

| | |
|---|---|
| 빌드 | Vite |
| 지도 | Leaflet + OSM / OpenTopoMap / Esri 타일 |
| 프레임워크 | 없음 (Vanilla JS + ES 모듈) |
| 로컬 저장 | IndexedDB (오프라인 1차 저장소) |
| 원격 저장 | GitHub Contents API — 리포 자체가 DB |
| 호스팅 | GitHub Pages |

GPX는 **빌드 타임에 한 번** JSON으로 전처리한다. 브라우저는 GPX를 파싱하지 않는다.

## 실행

```bash
npm install
npm run dev
```

빌드:

```bash
npm run build
```

데이터 재생성 (GPX가 바뀌었을 때만):

```bash
npm run build:ele    # DEM 고도 조회 -> data/cache/ele/ (캐시가 있으면 건너뛴다)
npm run build:data   # GPX -> public/data/
```

## 데이터 출처

GPX 노선은 Daum 카페 **["도보여행(섬&산) 좋은사람들"](https://cafe.daum.net/mtsingles/LN1X/1631)**
회원이 **90개 코스를 직접 걸으며** 정리해 공유한 자료다. 이 리포의 저작물이 아니다.

출처·원저작자·이용조건·수집 방법은 **[data/SOURCE.md](data/SOURCE.md)** 에 전부 기록해 두었다.
개인 비상업적 용도로만 사용하며, 원저작자가 요청하면 즉시 삭제한다.

고도는 원본 GPX에 사실상 없어서(92개 중 82개가 전부 0) **SRTM 30m DEM으로 산출한 추정값**이다.
소요시간도 계산값이다 — GPX의 `<time>`은 편집 시각이라 쓰지 않는다.

## GitHub 동기화 설정 (선택)

사진·메모는 기본적으로 **이 브라우저에만** 저장됩니다. 기기 간에 옮기려면 GitHub을 저장소로 씁니다.

1. **사진 리포지토리를 만든다** — 예: `KDT-Namparang-photos`
   소스 리포를 가볍게 유지하려고 사진은 따로 둡니다. 커밋된 사진은 삭제해도
   git 히스토리에 남으므로, 소스 리포에 섞으면 `git clone` 이 계속 무거워집니다.
2. **fine-grained PAT 를 만든다** — [토큰 만들기](https://github.com/settings/personal-access-tokens/new)
   - Repository access: 위 리포 2개만 선택
   - Permissions → Repository permissions → **Contents: Read and write**
   - 만료 90일 권장
3. 앱 사이드바 기록 섹션의 **⚙** 를 눌러 계정·리포·토큰을 넣고 **연결 확인** → **저장**
4. **동기화** 버튼을 누른다

저장 위치
- 메모: 메인 리포 `public/data/notes.json` (한 파일, sha 낙관적 락 + 재시도)
- 사진: 사진 리포 `{연도}/{id}.jpg`, `{연도}/{id}_t.jpg`
- 읽기는 `raw.githubusercontent.com` 으로 갑니다 — 즉시 반영되고 API 한도에 걸리지 않습니다

## 보안 주의

사진·메모 쓰기에는 **본인의 fine-grained PAT**가 필요하고, 이 토큰은
**브라우저 `localStorage`에만 저장된다.** 리포에는 어떤 비밀도 커밋하지 않는다.

- 토큰 권한은 이 리포 2개의 **Contents 쓰기로만** 제한할 것
- 토큰을 리포·이슈·PR에 절대 붙여넣지 말 것
- 다른 방문자에게는 읽기 전용으로 보인다

## 라이선스

앱 소스 코드는 MIT. **`data/gpx/` 및 `data/reference/` 는 제외** — 제3자 자료이며
[data/SOURCE.md](data/SOURCE.md)의 조건을 따른다.
