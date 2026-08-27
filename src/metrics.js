/**
 * 난이도 계산.
 *
 * 경계값을 클라이언트에 하드코딩하면 `scripts/lib/config.mjs`의 값과 어긋날 수 있다.
 * 빌드가 `meta.json`에 실어 보내주고, 여기서는 그걸 받아 쓴다.
 * (아래 기본값은 meta.json 로딩 실패 시 대비용이며 config.mjs 와 같은 값이다.)
 */

let breaks = [
  { max: 16, label: '쉬움' },
  { max: 22, label: '보통' },
  { max: null, label: '어려움' }, // JSON에는 Infinity가 없다 → null 이 무한대
]

export function configureDifficulty(fromMeta) {
  if (Array.isArray(fromMeta) && fromMeta.length) breaks = fromMeta
}

/** 점수 = 거리km + 상승m/100 */
export function difficultyScore(km, ascentM) {
  return km + ascentM / 100
}

export function difficultyOf(km, ascentM) {
  const s = difficultyScore(km, ascentM)
  return (breaks.find((b) => b.max == null || s <= b.max) ?? breaks.at(-1)).label
}
