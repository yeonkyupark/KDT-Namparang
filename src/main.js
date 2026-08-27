import './style.css'
import { loadIndex, loadMeta, loadCourse } from './data.mjs'
import { createMap, TILE_NAMES, formatDuration } from './map.js'
import { createSidebar } from './sidebar.js'
import { createProfile } from './profile.js'
import { readState, writeState } from './state.js'
import { configureDifficulty } from './metrics.js'
import { cumulative, pointAtFraction } from './geo.js'

/**
 * 선택 구간이 이 개수 이하일 때만 상세 라인·고도를 받는다.
 *
 * 상세 파일은 코스당 8KB다. 90개 전 구간을 고르면 745KB인데, 그 줌에서는
 * 오버뷰(코스당 43점)와 눈으로 구분되지 않고 프로필도 픽셀당 1.8km라
 * `eleLow`(코스당 32점)로 충분하다. 확대해서 볼 만한 구간에서만 받는다.
 */
const DETAIL_LIMIT = 30

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function renderShell() {
  const app = document.getElementById('app')
  app.textContent = ''
  app.className = 'shell'

  const header = el('header', 'topbar')

  const sideBtn = el('button', 'icon-btn')
  sideBtn.type = 'button'
  sideBtn.setAttribute('aria-controls', 'sidepanel')
  header.append(sideBtn)

  const brand = el('div', 'brand')
  brand.append(el('b', null, '남파랑길'))
  brand.append(el('span', 'brand-sub', '부산 오륙도 → 해남 땅끝탑'))
  header.append(brand)

  const tools = el('div', 'tools')
  const tileGroup = el('div', 'seg')
  tileGroup.setAttribute('role', 'group')
  tileGroup.setAttribute('aria-label', '지도 종류')
  tools.append(tileGroup)
  header.append(tools)

  const stage = el('div', 'stage')
  const mapwrap = el('div', 'mapwrap')
  const mapEl = el('div', 'map')
  mapEl.id = 'map'
  mapwrap.append(mapEl)
  stage.append(mapwrap)

  app.append(header, stage)
  return { header, tileGroup, tools, stage, mapwrap, mapEl, sideBtn }
}

function renderInfoCard(host, course) {
  document.querySelector('.infocard')?.remove()

  const card = el('div', 'infocard')

  const head = el('div', 'ic-head')
  head.append(el('b', null, course.name))
  if (course.region) head.append(el('span', 'ic-region', course.region))
  const close = el('button', 'ic-close')
  close.type = 'button'
  close.setAttribute('aria-label', '닫기')
  close.textContent = '✕'
  close.onclick = () => card.remove()
  head.append(close)
  card.append(head)

  if (course.alias) card.append(el('div', 'ic-alias', course.alias))
  card.append(
    el(
      'div',
      'ic-route',
      course.start && course.end ? `${course.start} → ${course.end}` : '지점명 정보 없음',
    ),
  )

  const stats = el('div', 'ic-stats')
  for (const [k, v] of [
    ['거리', `${course.distanceKm} km`],
    ['예상 소요', formatDuration(course.durationMin)],
    ['누적 상승', `${course.ascentM.toLocaleString()} m`],
    ['누적 하강', `${course.descentM.toLocaleString()} m`],
    ['고도', `${course.eleMin}–${course.eleMax} m`],
    ['난이도', course.difficulty],
  ]) {
    const s = el('div', 'ic-stat')
    s.append(el('span', 'k', k), el('span', 'v', v))
    stats.append(s)
  }
  card.append(stats)

  if (course.isAlt) card.append(el('div', 'ic-note', '임시·우회 노선 — 구간 합계에서 제외됩니다.'))
  if (course.note) card.append(el('div', 'ic-note', course.note))
  card.append(el('div', 'ic-foot', '고도는 DEM 추정값 · 소요시간은 계산값'))

  host.append(card)
}

function renderError(message) {
  const app = document.getElementById('app')
  app.textContent = ''
  app.className = ''
  const box = el('div', 'errorbox')
  box.append(el('h1', null, '데이터를 불러오지 못했습니다'))
  box.append(el('p', null, message))
  box.append(el('p', 'hint', 'npm run build:data 를 실행해 public/data/ 를 생성했는지 확인하세요.'))
  app.append(box)
}

async function main() {
  let courses
  let meta
  try {
    ;[courses, meta] = await Promise.all([loadIndex(), loadMeta()])
  } catch (e) {
    renderError(e.message)
    return
  }

  configureDifficulty(meta.difficulty?.breaks)

  const byId = new Map(courses.map((c) => [c.id, c]))
  const { tileGroup, tools, stage, mapwrap, mapEl, sideBtn } = renderShell()

  /**
   * fitBounds가 피해야 하는 영역.
   * 사이드바(넓은 화면)와 하단 시트(좁은 화면) 모두 그리드로 분리되어 있어
   * 지도를 덮지 않는다. 남는 건 Leaflet 컨트롤과 attribution 정도다.
   */
  const getInsets = () => ({ left: 24, top: 20, right: 24, bottom: 34 })

  const view = createMap(mapEl, courses, {
    getInsets,
    onSelect: (c) => renderInfoCard(mapwrap, c),
  })

  // ── 고도 프로필 ──────────────────────────────────────
  /** 지도 커서를 놓을 좌표를 구하기 위한, 코스별 폴리라인 + 누적거리 캐시 */
  const lineCache = new Map()

  function lineFor(id) {
    if (!lineCache.has(id)) {
      const rec = view.rendered.get(id)
      const pts = rec?.detail ?? byId.get(id)?.overview ?? []
      lineCache.set(id, { pts, cum: cumulative(pts) })
    }
    return lineCache.get(id)
  }

  const profile = createProfile(mapwrap, {
    onHover: (s) => {
      if (!s) return view.setCursor(null)
      const { pts, cum } = lineFor(s.courseId)
      const p = pointAtFraction(pts, cum, s.frac)
      view.setCursor(p)
    },
  })

  // ── 구간 적용 ────────────────────────────────────────
  const maxSeq = Math.max(...courses.filter((c) => !c.isAlt).map((c) => c.seq))
  const opts = { maxSeq, tiles: TILE_NAMES }
  const initial = readState(opts)
  let layer = initial.layer

  /** 프로필은 본 코스만 이어 붙인다. 임시노선은 경로를 두 번 세게 만든다. */
  function profileSegments(from, to) {
    return courses
      .filter((c) => !c.isAlt && c.seq >= from && c.seq <= to)
      .sort((a, b) => a.seq - b.seq)
      .map((c) => {
        const detail = view.rendered.get(c.id)?.eleDetail
        return { course: c, ele: detail ?? c.eleLow ?? [], lengthM: c.distanceM }
      })
  }

  let applyToken = 0

  async function applyRange({ from, to }, { fit = true } = {}) {
    const ids = new Set(courses.filter((c) => c.seq >= from && c.seq <= to).map((c) => c.id))
    view.setSelection(ids.size === courses.length ? null : ids)
    if (fit) view.fitIds(ids)

    writeState({ from, to, layer }, opts)
    profile.setSegments(profileSegments(from, to))

    const token = ++applyToken
    if (ids.size > DETAIL_LIMIT) return

    // 상세는 뒤늦게 도착해도 되므로 await 하지 않는다.
    for (const id of ids) {
      loadCourse(id)
        .then((d) => {
          if (token !== applyToken) return
          view.upgradeToDetail(id, d.line)
          lineCache.delete(id) // 상세 라인으로 커서 정확도가 올라간다
          const rec = view.rendered.get(id)
          if (rec) rec.eleDetail = d.ele?.values
          profile.setSegments(profileSegments(from, to))
        })
        .catch(() => {}) // 상세는 있으면 좋은 것이다. 실패해도 오버뷰로 동작한다.
    }
  }

  const sidebar = createSidebar(stage, courses, {
    onRangeChange: (r) => applyRange(r),
    onPick: (c) => {
      renderInfoCard(mapwrap, c)
      view.focus(c.id)
      sidebar.collapse()
    },
    onHover: (id, on) => view.accent(id, on),
  })

  // ── 타일 토글 ────────────────────────────────────────
  const buttons = TILE_NAMES.map((name) => {
    const b = el('button', 'seg-btn' + (name === layer ? ' is-on' : ''), name)
    b.type = 'button'
    b.onclick = () => {
      if (name === layer) return
      layer = name
      view.setTile(name)
      for (const other of buttons) other.classList.toggle('is-on', other.textContent === name)
      writeState({ ...sidebar.getRange(), layer }, opts)
    }
    tileGroup.append(b)
    return b
  })

  // ── 고도 프로필 접기 ─────────────────────────────────
  const profBtn = el('button', 'ghost-btn is-on', '고도')
  profBtn.type = 'button'
  profBtn.setAttribute('aria-pressed', 'true')
  let profOpen = window.innerWidth >= 861 // 좁은 화면은 자리가 없어 기본 접힘
  const syncProf = () => {
    mapwrap.classList.toggle('no-profile', !profOpen)
    profBtn.classList.toggle('is-on', profOpen)
    profBtn.setAttribute('aria-pressed', String(profOpen))
  }
  profBtn.onclick = () => {
    profOpen = !profOpen
    syncProf()
  }
  tools.append(profBtn)

  const fitBtn = el('button', 'ghost-btn', '전체보기')
  fitBtn.type = 'button'
  fitBtn.onclick = () => view.fitAll()
  tools.append(fitBtn)

  // ── 사이드바 접기 ────────────────────────────────────
  // 화면 상태가 아니라 개인 취향이므로 URL이 아니라 localStorage 에 둔다.
  // (URL은 공유용이다 — 남에게 보낸 링크가 내 패널 상태까지 강제하면 안 된다)
  const SIDE_KEY = 'namparang.sidebar'
  let sideOpen = true
  try {
    sideOpen = localStorage.getItem(SIDE_KEY) !== 'closed'
  } catch {
    // 시크릿 모드 등에서 접근 자체가 막힐 수 있다. 기본값으로 간다.
  }

  const syncSide = () => {
    document.querySelector('.shell').classList.toggle('side-closed', !sideOpen)
    sideBtn.textContent = sideOpen ? '◀' : '▶'
    sideBtn.title = sideOpen ? '사이드 메뉴 접기' : '사이드 메뉴 펼치기'
    sideBtn.setAttribute('aria-label', sideBtn.title)
    sideBtn.setAttribute('aria-expanded', String(sideOpen))
  }
  sideBtn.onclick = () => {
    sideOpen = !sideOpen
    syncSide()
    try {
      localStorage.setItem(SIDE_KEY, sideOpen ? 'open' : 'closed')
    } catch {
      // 저장이 막혀도 이번 세션에서는 정상 동작한다
    }
  }

  // ── 초기 상태 반영 ───────────────────────────────────
  syncSide()
  syncProf()
  view.setTile(layer)
  sidebar.setRange(initial.from, initial.to, { notify: false })
  await applyRange({ from: initial.from, to: initial.to })

  window.addEventListener('popstate', () => {
    const s = readState(opts)
    layer = s.layer
    view.setTile(layer)
    for (const b of buttons) b.classList.toggle('is-on', b.textContent === layer)
    sidebar.setRange(s.from, s.to, { notify: false })
    applyRange({ from: s.from, to: s.to })
  })
}

main()
