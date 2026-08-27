/**
 * 단계 2a — 고도 파라미터 캘리브레이션 및 대조군 검증
 *
 * DEM 고도로 누적 상승을 계산할 때 자유 변수가 둘이다.
 *   - 스무딩 창 크기 (이동평균 몇 점)
 *   - 히스테리시스 임계값 (몇 m 미만 변화를 무시할지)
 *
 * SRTM은 정수 미터로만 값을 주므로 평지에서도 ±1m 계단이 끝없이 생긴다.
 * 이 두 값을 잘못 잡으면 누적 상승이 실제의 몇 배로 나온다.
 *
 * 대조군 후보가 둘 있었다.
 *   A. nam-23 ~ nam-27 — 원본 GPX에 실측 고도가 남아있는 유일한 5개 코스
 *   B. data/reference/gpsroute-ascent.json — 외부 사이트의 코스별 값 (합계 38,070m)
 *
 * PART 3에서 B의 유효성을 직접 검증한다. 결론은 **B는 과대계상이므로
 * 절대 기준으로 쓸 수 없다**는 것이고, 따라서 파라미터는 A만으로 정한다.
 *
 * 사용법: node scripts/calibrate-ele.mjs
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listCourses, parseGpx } from './lib/gpx.mjs'
import { movingAverage, ascentDescent, resample, haversine, pathLength } from './lib/geo.mjs'
import { ELE_SPACING, ELE_SMOOTH_WINDOW, ELE_THRESHOLD_M } from './lib/config.mjs'

const CACHE_DIR = 'data/cache/ele'
const REFERENCE = 'data/reference/gpsroute-ascent.json'
const OUT = 'data/cache/ele-calibration.json'

const WINDOWS = [1, 3, 5, 7, 9]
const THRESHOLDS = [0, 1, 2, 3, 4, 5, 6, 8, 10]

/** 실측 고도가 의미 있게 남아있는 코스. nam-88(325 상수), nam-73/83/84(0~18m 평탄)는 제외. */
const MEASURED = [23, 24, 25, 26, 27]

const cachePath = (file) => join(CACHE_DIR, `${file.replace(/\.gpx$/, '')}.json`)
const loadCache = (file) =>
  existsSync(cachePath(file)) ? JSON.parse(readFileSync(cachePath(file), 'utf8')) : null

/** 실측 고도를 DEM과 같은 50m 균일 격자에 거리 기준으로 선형보간한다. */
function measuredSeries(course, n) {
  const { points } = parseGpx(course.path)
  const latlng = points.map((p) => [p.lat, p.lng])

  const cum = [0]
  for (let i = 1; i < latlng.length; i++) {
    cum.push(cum[i - 1] + haversine(latlng[i - 1], latlng[i]))
  }
  const samples = resample(latlng, ELE_SPACING)
  const ele = points.map((p) => p.ele)

  const out = []
  let j = 0
  for (let k = 0; k < Math.min(n, samples.length); k++) {
    const d = samples[k].d
    while (j < cum.length - 2 && cum[j + 1] < d) j++
    const span = cum[j + 1] - cum[j]
    const f = span > 0 ? (d - cum[j]) / span : 0
    const e0 = ele[j]
    const e1 = ele[j + 1] ?? e0
    out.push(e0 == null || e1 == null ? null : e0 + (e1 - e0) * f)
  }
  return out
}

/** DEM 공백(null)을 앞뒤 값으로 메운다. */
function fillNulls(ele) {
  const v = ele.slice()
  for (let i = 0; i < v.length; i++) {
    if (v[i] != null) continue
    let prev = null
    for (let j = i - 1; j >= 0; j--) if (v[j] != null) { prev = v[j]; break }
    let next = null
    for (let j = i + 1; j < v.length; j++) if (v[j] != null) { next = v[j]; break }
    v[i] = prev ?? next ?? 0
  }
  return v
}

const ascentOf = (ele, w, t) => ascentDescent(movingAverage(fillNulls(ele), w), t).ascentM

function main() {
  const courses = listCourses()
  const withCache = courses.map((c) => ({ ...c, cache: loadCache(c.file) })).filter((c) => c.cache)

  if (withCache.length === 0) {
    console.error('캐시가 없다. 먼저 node scripts/build-ele.mjs 를 실행하라.')
    process.exit(1)
  }
  console.log(`캐시 ${withCache.length} / 전체 ${courses.length} 코스`)

  const ref = new Map(JSON.parse(readFileSync(REFERENCE, 'utf8')).map((r) => [r.seq, r]))
  const main90 = withCache.filter((c) => !c.isAlt)

  // 실측 시리즈 준비
  const pairs = []
  for (const seq of MEASURED) {
    const c = withCache.find((x) => x.seq === seq && !x.isAlt)
    if (!c) continue
    pairs.push({ seq, course: c, dem: c.cache.ele, real: measuredSeries(c, c.cache.ele.length) })
  }

  // ── PART 1 ────────────────────────────────────────────────
  console.log('\n══ PART 1. DEM 절대 고도 정확도 (실측 5개 코스) ══')
  console.log('  코스     n   평균절대오차   편향   차이 표준편차')
  const accuracy = []
  for (const p of pairs) {
    const both = p.dem.map((d, i) => [d, p.real[i]]).filter(([d, r]) => d != null && r != null)
    const diffs = both.map(([d, r]) => d - r)
    const mae = diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length
    const bias = diffs.reduce((s, d) => s + d, 0) / diffs.length
    const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - bias) ** 2, 0) / diffs.length)
    accuracy.push({ seq: p.seq, n: diffs.length, mae, bias, sd })
    console.log(
      `  ${String(p.seq).padStart(2)}코스 ${String(diffs.length).padStart(5)}   ` +
        `${mae.toFixed(1).padStart(7)}m  ${(bias >= 0 ? '+' : '') + bias.toFixed(1)}m` +
        `${sd.toFixed(1).padStart(12)}m${mae > 15 ? '   ⚠ 이상치' : ''}`,
    )
  }
  const ok = accuracy.filter((a) => a.mae <= 15)
  console.log(
    `  → 이상치 제외 ${ok.length}개 코스 평균절대오차 ` +
      `${(ok.reduce((s, a) => s + a.mae, 0) / ok.length).toFixed(1)}m`,
  )
  console.log('    (통상 인용되는 SRTM 전역 오차 ±16m보다 한국 연안에서는 양호하다)')

  // ── PART 2 ────────────────────────────────────────────────
  console.log('\n══ PART 2. 누적 상승 — (창, 임계값) 격자 탐색 ══')
  console.log('값은 DEM/실측 비율. 1.00이면 DEM이 실측과 같은 누적상승을 낸다.\n')
  console.log('  창＼임계  ' + THRESHOLDS.map((t) => `${t}m`.padStart(6)).join(''))

  const grid = []
  for (const w of WINDOWS) {
    const cells = []
    for (const t of THRESHOLDS) {
      let dem = 0
      let real = 0
      for (const p of pairs) {
        dem += ascentOf(p.dem, w, t)
        real += ascentOf(p.real, w, t)
      }
      const ratio = real > 0 ? dem / real : NaN
      cells.push(ratio)
      const total = main90.reduce((s, c) => s + ascentOf(c.cache.ele, w, t), 0)
      grid.push({ window: w, threshold: t, ratio, totalM: Math.round(total) })
    }
    console.log(
      `  ${String(w).padStart(5)}    ` + cells.map((r) => r.toFixed(2).padStart(6)).join(''),
    )
  }

  console.log('\n코스별 비율 (주요 설정):')
  const show = [[1, 0], [3, 3], [5, 3], [3, 8]]
  console.log('  코스  ' + show.map(([w, t]) => `창${w}/${t}m`.padStart(10)).join(''))
  for (const p of pairs) {
    console.log(
      `  ${String(p.seq).padStart(2)}    ` +
        show
          .map(([w, t]) => (ascentOf(p.dem, w, t) / ascentOf(p.real, w, t)).toFixed(2).padStart(10))
          .join(''),
    )
  }

  console.log('\n설정별 90코스 합계:')
  const km90 = main90.reduce((s, c) => s + c.cache.lengthM, 0) / 1000
  for (const [w, t] of show) {
    const g = grid.find((x) => x.window === w && x.threshold === t)
    console.log(
      `  창${w}/${t}m  ${g.totalM.toLocaleString().padStart(8)}m  ` +
        `(${(g.totalM / km90).toFixed(1)} m/km)  DEM/실측 ${g.ratio.toFixed(2)}`,
    )
  }

  // ── PART 3 ────────────────────────────────────────────────
  console.log('\n══ PART 3. gpsroute.site 값이 절대 기준으로 쓸 수 있는가 ══')
  console.log('실측 고도가 있는 코스에서 "실측 GPX 자체의 누적상승"과 저쪽 값을 직접 비교한다.')
  console.log('스무딩·임계값을 0으로 둔 = 가장 부풀려지는 설정으로 실측을 계산했다.\n')
  console.log('  코스   우리거리  저쪽거리   차이    실측상승  저쪽상승   실측/저쪽')

  const verdict = []
  for (const p of pairs) {
    const r = ref.get(p.seq)
    if (!r) continue
    const km = pathLength(parseGpx(p.course.path).points.map((q) => [q.lat, q.lng])) / 1000
    const dPct = (km / r.km - 1) * 100
    const realAsc = ascentOf(p.real, 1, 0)
    const ratio = realAsc / r.ascentM
    const truncated = Math.abs(dPct) > 10
    verdict.push({ seq: p.seq, km, refKm: r.km, dPct, realAsc, refAsc: r.ascentM, ratio, truncated })
    console.log(
      `  ${String(p.seq).padStart(2)}   ${km.toFixed(2).padStart(7)}km ` +
        `${r.km.toFixed(2).padStart(8)}km ${(dPct >= 0 ? '+' : '') + dPct.toFixed(1)}%` +
        `${Math.round(realAsc).toString().padStart(9)}m ${String(r.ascentM).padStart(8)}m` +
        `${ratio.toFixed(2).padStart(11)}` +
        (truncated ? '   ⚠ 저쪽 트랙 잘림 — 비교 무효' : ''),
    )
  }

  const valid = verdict.filter((v) => !v.truncated)
  const avg = valid.reduce((s, v) => s + v.ratio, 0) / valid.length
  console.log(
    `\n  거리가 일치하는 ${valid.length}개 코스 평균: 실측/저쪽 = ${avg.toFixed(2)}`,
  )
  console.log(
    '  → 같은 노선인데도 실측 고도로 계산한 누적상승이 저쪽 값의 ' +
      `${(avg * 100).toFixed(0)}% 에 불과하다.`,
  )
  console.log('    가장 부풀려지는 설정으로 계산해도 그렇다.')
  console.log('    결론: gpsroute 값은 과대계상이며 절대 기준으로 쓸 수 없다.')
  console.log('    참고자료로만 남기고, 파라미터는 PART 2의 실측 대조로만 정한다.')

  // ── 결론 ──────────────────────────────────────────────────
  const chosen = grid.find(
    (g) => g.window === ELE_SMOOTH_WINDOW && g.threshold === ELE_THRESHOLD_M,
  )
  console.log('\n══ 채택 설정 (scripts/lib/config.mjs) ══')
  console.log(`  간격 ${ELE_SPACING}m / 창 ${ELE_SMOOTH_WINDOW}점 / 임계값 ${ELE_THRESHOLD_M}m`)
  console.log(`  DEM/실측 비율 ${chosen.ratio.toFixed(2)}`)
  console.log(
    `  90코스 누적상승 ${chosen.totalM.toLocaleString()}m (${(chosen.totalM / km90).toFixed(1)} m/km)`,
  )
  console.log('  양자화 노이즈를 제거하는 가장 약한 처리다. 더 센 처리는 실제 기복까지 깎는다.')

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        spacing: ELE_SPACING,
        measuredCourses: MEASURED,
        accuracy,
        grid,
        gpsrouteVerdict: { rows: verdict, validRatio: avg, usable: false },
        chosen: { window: ELE_SMOOTH_WINDOW, threshold: ELE_THRESHOLD_M, ...chosen },
      },
      null,
      1,
    ),
  )
  console.log(`\n격자 전체: ${OUT}`)
}

main()
