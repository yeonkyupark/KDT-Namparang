import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { XMLParser } from 'fast-xml-parser'

export const GPX_DIR = 'data/gpx'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // 코스가 1개뿐인 파일에서도 배열로 받아 분기를 없앤다
  isArray: (name) => name === 'trk' || name === 'trkseg' || name === 'trkpt',
})

/**
 * <trkpt> 를 컨테이너 이름과 무관하게 문서 순서대로 모은다.
 *
 * nam-03.gpx 는 한국관광공사가 만든 원본인데 세그먼트 태그가 <trkseg> 가 아니라
 * **<trkseq>** 로 오타가 나 있다. 92개 중 유일한 사례다.
 * 원본은 한 바이트도 고치지 않는다는 방침(data/SOURCE.md)이므로 파서를 관대하게 만든다.
 */
function collectTrkpts(node, out) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectTrkpts(item, out)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@')) continue
    if (key === 'trkpt') {
      for (const p of Array.isArray(value) ? value : [value]) out.push(p)
    } else if (value !== null && typeof value === 'object') {
      collectTrkpts(value, out)
    }
  }
}

/**
 * GPX 파일 하나를 읽는다.
 * @returns {{name: string, points: Array<{lat:number, lng:number, ele:number|null}>, nonstandard: boolean}}
 */
export function parseGpx(path) {
  const doc = parser.parse(readFileSync(path, 'utf8'))
  const gpx = doc?.gpx
  if (!gpx) throw new Error(`${path}: <gpx> 루트를 찾을 수 없다`)

  const trks = gpx.trk ?? []
  const name = trks.find((t) => t.name != null)?.name
  const raw = []
  let nonstandard = false

  for (const trk of trks) {
    if (trk.trkseg) {
      for (const seg of trk.trkseg) collectTrkpts(seg, raw)
    } else {
      // 표준 <trkseg> 가 없다 — 컨테이너 이름을 무시하고 긁는다
      nonstandard = true
      collectTrkpts(trk, raw)
    }
  }

  const points = []
  for (const p of raw) {
    const lat = Number(p['@lat'])
    const lng = Number(p['@lon'])
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const ele = p.ele == null ? NaN : Number(p.ele)
    points.push({ lat, lng, ele: Number.isFinite(ele) ? ele : null })
  }

  if (points.length === 0) throw new Error(`${path}: 트랙포인트가 없다`)
  return { name: name == null ? '' : String(name).trim(), points, nonstandard }
}

/** nam-07.gpx -> {id:'7', seq:7, sub:0, isAlt:false} / nam-17-1.gpx -> {id:'17-1', seq:17, sub:1, isAlt:true} */
export function parseCourseId(file) {
  const m = /^nam-(\d+)(?:-(\d+))?\.gpx$/.exec(basename(file))
  if (!m) throw new Error(`${file}: 파일명 규칙(nam-NN[-N].gpx)에 맞지 않는다`)
  const seq = Number(m[1])
  const sub = m[2] ? Number(m[2]) : 0
  return { id: sub ? `${seq}-${sub}` : String(seq), seq, sub, isAlt: sub > 0 }
}

/** data/gpx 의 모든 GPX를 코스 순서대로 나열한다. */
export function listCourses(dir = GPX_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.gpx'))
    .map((f) => ({ file: f, path: join(dir, f), ...parseCourseId(f) }))
    .sort((a, b) => a.seq - b.seq || a.sub - b.sub)
}
