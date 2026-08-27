/** 브라우저에서 쓰는 최소 지리 계산. 빌드 스크립트의 scripts/lib/geo.mjs 와 별개다. */

const R = 6371008.8
const D2R = Math.PI / 180

export function haversine([lat1, lng1], [lat2, lng2]) {
  const p1 = lat1 * D2R
  const p2 = lat2 * D2R
  const dp = p2 - p1
  const dl = (lng2 - lng1) * D2R
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** 폴리라인의 누적거리 배열 (m). 길이는 pts 와 같다. */
export function cumulative(pts) {
  const out = [0]
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + haversine(pts[i - 1], pts[i]))
  return out
}

/**
 * 폴리라인에서 전체 길이의 f(0~1) 지점 좌표를 구한다.
 *
 * 거리(m)가 아니라 비율을 받는 이유: 지도에 그리는 선은 단순화된 것이라
 * 실제 코스 길이와 조금 다르다. 비율로 맞추면 그 차이가 상쇄된다.
 */
export function pointAtFraction(pts, cum, f) {
  if (pts.length === 0) return null
  if (pts.length === 1) return pts[0]

  const total = cum[cum.length - 1]
  if (!(total > 0)) return pts[0]

  const target = Math.min(Math.max(f, 0), 1) * total

  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= target) lo = mid
    else hi = mid
  }

  const span = cum[hi] - cum[lo]
  const t = span > 0 ? (target - cum[lo]) / span : 0
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t]
}
