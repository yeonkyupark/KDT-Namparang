/**
 * 단계 2b — GPX + 고도 캐시 → public/data/
 *
 * 브라우저는 GPX를 절대 파싱하지 않는다. 여기서 한 번 구워둔 JSON만 받는다.
 *
 * 산출물
 *   public/data/courses.json      92개 메타 + 저해상도 오버뷰 라인 (랜딩에서 이것만 받는다)
 *   public/data/course/{id}.json  상세 라인 + 고도 프로필 (코스 선택 시 lazy fetch)
 *   public/data/meta.json         생성 정보 · 출처 · 합계
 *
 * 사용법: node scripts/build-data.mjs   (npm run build:data)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { listCourses, parseGpx } from './lib/gpx.mjs'
import { parseTrackName, chainFill, normalizeJunctions, normalizeRegions } from './lib/names.mjs'
import { pathLength, simplify, movingAverage, ascentDescent } from './lib/geo.mjs'
import {
  ELE_SPACING,
  ELE_DATASET,
  ELE_SMOOTH_WINDOW,
  ELE_THRESHOLD_M,
  SIMPLIFY_OVERVIEW_M,
  SIMPLIFY_DETAIL_M,
  WALK_SPEED_KMH,
  ASCENT_SPEED_MH,
  DIFFICULTY_BREAKS,
} from './lib/config.mjs'

const ELE_CACHE = 'data/cache/ele'
const META_CSV = 'data/courses.meta.csv'
const OUT_DIR = 'public/data'
const OUT_COURSE = join(OUT_DIR, 'course')

const r5 = (n) => Math.round(n * 1e5) / 1e5 // 좌표 소수점 5자리 ≈ 1m
const r1 = (n) => Math.round(n * 10) / 10

/** 수기 보정 CSV를 읽는다. 빈 칸은 덮어쓰지 않는다. */
function loadOverrides() {
  if (!existsSync(META_CSV)) return new Map()
  const lines = readFileSync(META_CSV, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (lines.length === 0) return new Map()

  const cols = lines[0].split(',').map((s) => s.trim())
  const map = new Map()
  for (const line of lines.slice(1)) {
    // 지점명에 콤마가 없다는 전제. 있으면 CSV 파서를 붙여야 한다.
    const cells = line.split(',')
    const row = {}
    cols.forEach((c, i) => {
      const v = (cells[i] ?? '').trim()
      if (v) row[c] = v
    })
    if (row.id) map.set(String(row.id), row)
  }
  return map
}

function difficultyOf(km, ascentM) {
  const score = km + ascentM / 100
  return { score: r1(score), label: DIFFICULTY_BREAKS.find((b) => score <= b.max).label }
}

/**
 * 고도 프로필의 저해상도 요약. courses.json 에 실어 보낸다.
 *
 * 전 구간(90개) 프로필을 그리려면 코스별 상세 파일 92개(745KB)가 필요하다.
 * 하지만 1,464km를 800px에 그리면 픽셀당 1.8km라 32점이면 충분하다.
 * 구간을 좁히면 상세 파일이 도착해 고해상도로 교체된다.
 *
 * 버킷 평균을 쓰므로 좁은 봉우리는 뭉개진다 — 개요용이라는 뜻이다.
 */
function lowResProfile(values, n = 32) {
  if (values.length <= n) return values.map((v) => Math.round(v))
  const out = []
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * values.length) / n)
    const b = Math.max(a + 1, Math.floor(((i + 1) * values.length) / n))
    let sum = 0
    for (let j = a; j < b; j++) sum += values[j]
    out.push(Math.round(sum / (b - a)))
  }
  return out
}

/** 네이스미스 규칙 변형. GPX <time> 은 편집 시각이라 쓰지 않는다. */
function durationMin(km, ascentM) {
  const min = (km / WALK_SPEED_KMH) * 60 + (ascentM / ASCENT_SPEED_MH) * 60
  return Math.round(min / 10) * 10
}

function main() {
  const courses = listCourses()
  const overrides = loadOverrides()

  // ── 1. GPX 파싱 + 고도 캐시 결합 ─────────────────────────
  const built = []
  const warnings = []

  for (const c of courses) {
    const { name, points, nonstandard } = parseGpx(c.path)
    if (nonstandard) warnings.push(`${c.file}: 비표준 세그먼트 태그 (파서가 흡수)`)

    const latlng = points.map((p) => [p.lat, p.lng])
    const lengthM = pathLength(latlng)

    const cachePath = join(ELE_CACHE, `${c.file.replace(/\.gpx$/, '')}.json`)
    if (!existsSync(cachePath)) {
      throw new Error(`${c.file}: 고도 캐시가 없다. 먼저 npm run build:ele 를 실행하라.`)
    }
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (cache.ele.some((v) => v == null)) warnings.push(`${c.file}: 고도 null 포함`)

    const smooth = movingAverage(cache.ele, ELE_SMOOTH_WINDOW)
    const { ascentM, descentM } = ascentDescent(smooth, ELE_THRESHOLD_M)

    built.push({
      ...c,
      trackName: name,
      ...parseTrackName(name, { isAlt: c.isAlt }),
      lengthM,
      km: r1(lengthM / 1000),
      ascentM: Math.round(ascentM),
      descentM: Math.round(descentM),
      eleMin: Math.round(Math.min(...smooth)),
      eleMax: Math.round(Math.max(...smooth)),
      eleProfile: smooth.map(r1),
      eleDist: cache.dist,
      overview: simplify(latlng, SIMPLIFY_OVERVIEW_M),
      detail: simplify(latlng, SIMPLIFY_DETAIL_M),
      rawPoints: latlng.length,
      bbox: [
        r5(Math.min(...latlng.map((p) => p[1]))),
        r5(Math.min(...latlng.map((p) => p[0]))),
        r5(Math.max(...latlng.map((p) => p[1]))),
        r5(Math.max(...latlng.map((p) => p[0]))),
      ],
      startLatLng: [r5(latlng[0][0]), r5(latlng[0][1])],
      endLatLng: [r5(latlng.at(-1)[0]), r5(latlng.at(-1)[1])],
    })
  }

  // ── 2. 지점명 보정 ───────────────────────────────────────
  const mainCourses = built.filter((c) => !c.isAlt)
  const chained = chainFill(mainCourses)
  const junctions = normalizeJunctions(mainCourses)
  const regionFixes = normalizeRegions(mainCourses)

  // CSV 덮어쓰기는 맨 마지막 (수기 보정이 최우선)
  let overridden = 0
  for (const c of built) {
    const o = overrides.get(c.id)
    if (!o) continue
    for (const k of ['name', 'region', 'start', 'end', 'difficulty', 'alias', 'note']) {
      if (o[k]) {
        c[k] = o[k]
        c[`${k}Source`] = 'csv'
      }
    }
    overridden++
  }

  // ── 3. 파생 지표 ─────────────────────────────────────────
  for (const c of built) {
    const d = difficultyOf(c.km, c.ascentM)
    c.difficultyScore = d.score
    if (!c.difficulty) c.difficulty = d.label
    c.durationMin = durationMin(c.km, c.ascentM)
    if (!c.name) c.name = c.isAlt ? `${c.id}코스 (우회)` : `${c.seq}코스`
  }

  // ── 4. 출력 ──────────────────────────────────────────────
  if (existsSync(OUT_COURSE)) rmSync(OUT_COURSE, { recursive: true })
  mkdirSync(OUT_COURSE, { recursive: true })

  const index = built.map((c) => ({
    id: c.id,
    seq: c.seq,
    isAlt: c.isAlt,
    name: c.name,
    region: c.region || '',
    start: c.start || '',
    end: c.end || '',
    alias: c.alias || '',
    note: c.note || '',
    distanceKm: c.km,
    // 구간 합계용. distanceKm(반올림값)을 더하면 오차가 쌓인다.
    distanceM: Math.round(c.lengthM),
    durationMin: c.durationMin,
    ascentM: c.ascentM,
    descentM: c.descentM,
    eleMin: c.eleMin,
    eleMax: c.eleMax,
    difficulty: c.difficulty,
    bbox: c.bbox,
    startLatLng: c.startLatLng,
    endLatLng: c.endLatLng,
    overview: c.overview.map((p) => [r5(p[0]), r5(p[1])]),
    // 전 구간 고도 프로필을 상세 파일 없이도 그릴 수 있게 하는 요약
    eleLow: lowResProfile(c.eleProfile),
  }))

  writeFileSync(join(OUT_DIR, 'courses.json'), JSON.stringify(index))

  for (const c of built) {
    writeFileSync(
      join(OUT_COURSE, `${c.id}.json`),
      JSON.stringify({
        id: c.id,
        line: c.detail.map((p) => [r5(p[0]), r5(p[1])]),
        ele: { spacing: ELE_SPACING, dataset: ELE_DATASET, dist: c.eleDist, values: c.eleProfile },
      }),
    )
  }

  const mainOnly = built.filter((c) => !c.isAlt)
  writeFileSync(
    join(OUT_DIR, 'meta.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        courseCount: built.length,
        mainCourseCount: mainOnly.length,
        // 코스별 반올림값을 더하면 오차가 쌓인다. 원시 미터로 합산한 뒤 반올림한다.
        totalKm: r1(mainOnly.reduce((s, c) => s + c.lengthM, 0) / 1000),
        totalAscentM: mainOnly.reduce((s, c) => s + c.ascentM, 0),
        elevation: {
          source: `${ELE_DATASET} (opentopodata)`,
          note: 'DEM 추정값. 원본 GPX에는 고도가 사실상 없다.',
          spacing: ELE_SPACING,
          smoothWindow: ELE_SMOOTH_WINDOW,
          thresholdM: ELE_THRESHOLD_M,
        },
        duration: {
          note: '네이스미스 규칙 계산값. GPX의 <time>은 편집 시각이라 쓰지 않는다.',
          walkSpeedKmh: WALK_SPEED_KMH,
          ascentSpeedMh: ASCENT_SPEED_MH,
        },
        // 난이도 경계를 클라이언트에 중복 정의하지 않도록 실어 보낸다.
        // JSON에는 Infinity가 없어서 마지막 max 는 null 로 직렬화된다.
        difficulty: { formula: '거리km + 상승m/100', breaks: DIFFICULTY_BREAKS },
        source: {
          gpx: 'Daum 카페 "도보여행(섬&산) 좋은사람들" — https://cafe.daum.net/mtsingles/LN1X/1631',
          detail: 'data/SOURCE.md',
        },
      },
      null,
      1,
    ),
  )

  // ── 5. 리포트 ────────────────────────────────────────────
  const sum = (f) => mainOnly.reduce((s, c) => s + f(c), 0)
  const size = (p) => (readFileSync(p).length / 1024).toFixed(1) + 'KB'
  const courseDirKB = built.reduce(
    (s, c) => s + readFileSync(join(OUT_COURSE, `${c.id}.json`)).length,
    0,
  )

  console.log(`전처리 완료 — ${built.length}개 코스 (본 코스 ${mainOnly.length} + 임시노선 ${built.length - mainOnly.length})\n`)
  console.log('합계 (본 코스 90개만)')
  console.log(`  거리        ${r1(sum((c) => c.lengthM) / 1000).toLocaleString()} km`)
  console.log(`  누적 상승   ${sum((c) => c.ascentM).toLocaleString()} m  (${(sum((c) => c.ascentM) / sum((c) => c.km)).toFixed(1)} m/km)`)
  console.log(`  예상 시간   ${Math.round(sum((c) => c.durationMin) / 60).toLocaleString()} 시간`)
  const diff = {}
  for (const c of mainOnly) diff[c.difficulty] = (diff[c.difficulty] ?? 0) + 1
  console.log(`  난이도      ${Object.entries(diff).map(([k, v]) => `${k} ${v}`).join(' / ')}`)

  console.log('\n좌표 단순화')
  console.log(`  원본        ${sum((c) => c.rawPoints).toLocaleString()}점`)
  console.log(`  오버뷰 ε${SIMPLIFY_OVERVIEW_M}m  ${sum((c) => c.overview.length).toLocaleString()}점 (코스당 평균 ${Math.round(sum((c) => c.overview.length) / mainOnly.length)})`)
  console.log(`  상세   ε${SIMPLIFY_DETAIL_M}m   ${sum((c) => c.detail.length).toLocaleString()}점 (코스당 평균 ${Math.round(sum((c) => c.detail.length) / mainOnly.length)})`)

  console.log('\n지점명')
  console.log(`  자동 파싱   ${mainOnly.filter((c) => c.parsed).length} / ${mainOnly.length}`)
  console.log(`  연쇄 보정   시점 ${chained.start} · 종점 ${chained.end} · 지역 ${chained.region}`)
  console.log(`  접합부 통일 ${junctions.length}곳`)
  for (const j of junctions) {
    // 자동 통일 뒤에 CSV가 다시 덮어썼을 수 있으므로 최종값을 보여준다
    const final = mainOnly.find((c) => c.seq === j.seq)?.end
    const tag = final !== j.to ? `  (CSV가 재교정: "${final}")` : ''
    console.log(`      ${j.seq}/${j.seq + 1}  "${j.from}" -> "${j.to}"${tag}`)
  }
  if (regionFixes.length) {
    console.log(`  지역 통일   ${regionFixes.map((f) => `${f.from}->${f.to}`).join(', ')}`)
  }
  console.log(`  CSV 보정    ${overridden}개 코스`)
  const noPlace = built.filter((c) => !c.isAlt && (!c.start || !c.end))
  console.log(`  지점명 미확인 ${noPlace.length}개: ${noPlace.map((c) => c.id).join(',') || '없음'}`)
  const noRegion = built.filter((c) => !c.region)
  if (noRegion.length) console.log(`  지역 미확인 ${noRegion.length}개: ${noRegion.map((c) => c.id).join(',')}`)

  console.log('\n산출물')
  console.log(`  courses.json   ${size(join(OUT_DIR, 'courses.json'))}   <- 랜딩에서 이것만 받는다`)
  console.log(`  course/*.json  ${(courseDirKB / 1024).toFixed(1)}KB 총 / 코스당 평균 ${(courseDirKB / built.length / 1024).toFixed(1)}KB   <- lazy fetch`)
  console.log(`  meta.json      ${size(join(OUT_DIR, 'meta.json'))}`)

  if (warnings.length) {
    console.log(`\n경고 ${warnings.length}건`)
    for (const w of warnings) console.log(`  - ${w}`)
  }
}

main()
