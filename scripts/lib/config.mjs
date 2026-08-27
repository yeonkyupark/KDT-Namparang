/**
 * 데이터 파이프라인 공용 설정.
 *
 * 고도 관련 상수는 추측이 아니라 `scripts/calibrate-ele.mjs`의 캘리브레이션
 * 결과로 정한 값이다. 바꾸려면 그 스크립트를 다시 돌려 근거를 확인하라.
 */

/** 고도 샘플 간격 (m). SRTM 30m 대비 적당한 오버샘플. */
export const ELE_SPACING = 50

export const ELE_DATASET = 'srtm30m'

/** 실측 5개 코스 대조 결과 nearest/bilinear보다 정확했다 (평균절대오차 2.8m vs 3.2/3.4m). */
export const ELE_INTERPOLATION = 'cubic'

/**
 * 누적 상승 계산 파라미터.
 *
 * SRTM은 정수 미터로만 값을 준다. 그래서 평지에서도 ±1m 계단이 끝없이 생기고,
 * 스무딩·임계값 없이 인접차를 합산하면 누적 상승이 실측의 1.2~1.8배로 부풀려진다
 * (90코스 합계 47,568m = 32.5 m/km — 비현실적).
 *
 * 실측 고도가 남아있는 nam-23~27로 대조해 (창, 임계값) 격자를 탐색한 결과:
 *
 *   설정        DEM/실측 비율   90코스 합계
 *   창1 / 0m        1.20        47,568m  (32.5 m/km)  <- 양자화 노이즈로 부풀려짐
 *   창3 / 3m        1.05        29,220m  (20.0 m/km)  <- 채택
 *   창5 / 3m        1.04        25,527m  (17.4 m/km)
 *   창3 / 8m        1.02        24,354m  (16.6 m/km)  <- 실제 기복까지 지움
 *
 * 창3/3m 을 고른 이유: 양자화 노이즈를 제거하는 가장 약한 처리다.
 * 창5(=250m 창)나 임계값 8m는 비율이 1.0에 더 가깝지만, 실제 지형의
 * 100m 규모 기복까지 깎아내면서 우연히 맞는 것이다.
 */
export const ELE_SMOOTH_WINDOW = 3
export const ELE_THRESHOLD_M = 3

/** 지도용 오버뷰 라인 단순화 허용오차 (m). */
export const SIMPLIFY_OVERVIEW_M = 60

/** 코스 상세 라인 단순화 허용오차 (m). */
export const SIMPLIFY_DETAIL_M = 8

/** 소요시간 — 네이스미스 규칙 변형. */
export const WALK_SPEED_KMH = 4
export const ASCENT_SPEED_MH = 600

/** 난이도 구분: 점수 = 거리km + 상승m/100 */
export const DIFFICULTY_BREAKS = [
  { max: 10, label: '쉬움' },
  { max: 16, label: '보통' },
  { max: Infinity, label: '어려움' },
]
