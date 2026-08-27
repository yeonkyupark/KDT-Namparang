// 지리 계산 공용 함수. 빌드 타임에만 쓰이므로 브라우저 번들에는 들어가지 않는다.

/** IUGG 평균 지구 반지름 (m) */
export const R = 6371008.8

const D2R = Math.PI / 180

/** 두 지점 사이 대권거리 (m). 인자는 [lat, lng]. */
export function haversine([lat1, lng1], [lat2, lng2]) {
  const p1 = lat1 * D2R
  const p2 = lat2 * D2R
  const dp = p2 - p1
  const dl = (lng2 - lng1) * D2R
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** 폴리라인 전체 길이 (m). */
export function pathLength(pts) {
  let d = 0
  for (let i = 0; i < pts.length - 1; i++) d += haversine(pts[i], pts[i + 1])
  return d
}

/**
 * 폴리라인을 일정 거리 간격으로 재샘플링한다.
 *
 * 고도 계산은 샘플 밀도에 민감하다. 원본 트랙포인트는 간격이 불규칙해서
 * (곡선부는 촘촘하고 직선부는 드문드문) 그대로 쓰면 곡선부의 DEM 노이즈가
 * 누적 상승을 부풀린다. 균일 간격으로 다시 뽑아야 고도 프로필의 x축도
 * 거리에 정비례한다.
 *
 * @param {Array<[number,number]>} pts [lat, lng] 배열
 * @param {number} spacing 샘플 간격 (m)
 * @returns {Array<{lat:number, lng:number, d:number}>} d = 시작점부터 누적거리(m)
 */
export function resample(pts, spacing) {
  if (pts.length === 0) return []
  const out = [{ lat: pts[0][0], lng: pts[0][1], d: 0 }]
  if (pts.length === 1) return out

  let carry = 0 // 마지막 샘플 이후 이미 지나온 거리
  let base = 0 // 현재 세그먼트 시작점의 누적거리

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const segLen = haversine(a, b)
    if (segLen === 0) continue

    let t = spacing - carry // 이 세그먼트 안에서 다음 샘플이 놓일 위치
    while (t <= segLen) {
      const f = t / segLen
      out.push({
        lat: a[0] + (b[0] - a[0]) * f,
        lng: a[1] + (b[1] - a[1]) * f,
        d: base + t,
      })
      t += spacing
    }
    carry = segLen - (t - spacing)
    base += segLen
  }

  // 마지막 원본 점은 항상 포함한다 (구간 끝 좌표가 잘리면 접합부 검증이 깨진다)
  const end = pts[pts.length - 1]
  const tail = out[out.length - 1]
  if (haversine([tail.lat, tail.lng], end) > 1) {
    out.push({ lat: end[0], lng: end[1], d: base })
  }
  return out
}

/** 이동평균. w는 홀수 창 크기. 양 끝은 가용한 값만으로 평균한다. */
export function movingAverage(values, w) {
  if (w <= 1) return values.slice()
  const half = Math.floor(w / 2)
  const out = new Array(values.length)
  for (let i = 0; i < values.length; i++) {
    let sum = 0
    let n = 0
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < values.length && values[j] != null) {
        sum += values[j]
        n++
      }
    }
    out[i] = n ? sum / n : values[i]
  }
  return out
}

/**
 * 누적 상승/하강 (히스테리시스 방식).
 *
 * 기준 고도에서 threshold 이상 벗어날 때만 합산하고 기준을 옮긴다.
 * SRTM은 정수 미터로만 값을 주기 때문에, 평지에서도 ±1m 계단이 끝없이
 * 생긴다. 단순 인접차 합산을 쓰면 이 계단이 전부 상승으로 잡혀
 * 실제의 몇 배가 나온다. threshold가 그걸 걸러낸다.
 *
 * @param {number[]} ele 고도 배열 (m)
 * @param {number} threshold 무시할 변화량 (m)
 */
export function ascentDescent(ele, threshold) {
  const vals = ele.filter((v) => v != null)
  if (vals.length < 2) return { ascentM: 0, descentM: 0 }

  let up = 0
  let down = 0
  let ref = vals[0]
  for (let i = 1; i < vals.length; i++) {
    const diff = vals[i] - ref
    if (diff >= threshold) {
      up += diff
      ref = vals[i]
    } else if (-diff >= threshold) {
      down += -diff
      ref = vals[i]
    }
  }
  return { ascentM: up, descentM: down }
}

/**
 * Douglas–Peucker 단순화. epsilon은 미터 단위.
 *
 * 위경도를 국소 등거리 평면으로 투영해서 수직거리를 재기 때문에
 * epsilon을 그대로 미터로 지정할 수 있다.
 */
export function simplify(pts, epsilon) {
  if (pts.length < 3) return pts.slice()

  const lat0 = pts[(pts.length / 2) | 0][0]
  const kx = Math.cos(lat0 * D2R) * R * D2R // 경도 1도당 미터
  const ky = R * D2R // 위도 1도당 미터
  const px = pts.map((p) => p[1] * kx)
  const py = pts.map((p) => p[0] * ky)

  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1

  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()
    if (e - s < 2) continue

    const x1 = px[s]
    const y1 = py[s]
    const dx = px[e] - x1
    const dy = py[e] - y1
    const len2 = dx * dx + dy * dy

    let maxD = -1
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      let t = len2 === 0 ? 0 : ((px[i] - x1) * dx + (py[i] - y1) * dy) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const ex = x1 + t * dx - px[i]
      const ey = y1 + t * dy - py[i]
      const d = ex * ex + ey * ey
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }

    if (Math.sqrt(maxD) > epsilon) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }

  return pts.filter((_, i) => keep[i])
}
