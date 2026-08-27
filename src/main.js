import './style.css'
import { loadIndex, loadMeta, loadCourse } from './data.mjs'
import { createMap, TILE_NAMES, formatDuration } from './map.js'
import { createSidebar } from './sidebar.js'
import { readState, writeState } from './state.js'
import { configureDifficulty } from './metrics.js'

/**
 * 선택 구간이 이 개수 이하일 때만 상세 라인을 받아 선을 고해상도로 교체한다.
 *
 * 상세 파일은 코스당 8KB다. 90개 전 구간을 고르면 745KB인데, 그 줌에서는
 * 오버뷰(코스당 43점)와 눈으로 구분되지 않는다. 확대해서 볼 만한 구간에서만 받는다.
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
  const mapEl = el('div', 'map')
  mapEl.id = 'map'
  stage.append(mapEl)

  app.append(header, stage)
  return { header, tileGroup, tools, stage, mapEl }
}

function renderInfoCard(stage, course) {
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

  stage.append(card)
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

  const { tileGroup, tools, stage, mapEl } = renderShell()

  /**
   * fitBounds가 피해야 하는 화면 영역.
   * 넓은 화면은 사이드바가 왼쪽(그리드로 분리되어 있어 지도를 가리지 않음),
   * 좁은 화면은 하단 시트가 지도를 덮는다.
   */
  const getInsets = () => {
    if (window.innerWidth >= 861) return { left: 24, top: 20, right: 24, bottom: 40 }
    const sheetH = document.querySelector('.panel')?.offsetHeight ?? 0
    return { left: 12, top: 12, right: 12, bottom: sheetH + 20 }
  }

  const view = createMap(mapEl, courses, {
    getInsets,
    onSelect: (c) => renderInfoCard(stage, c),
  })

  const maxSeq = Math.max(...courses.filter((c) => !c.isAlt).map((c) => c.seq))
  const opts = { maxSeq, tiles: TILE_NAMES }
  const initial = readState(opts)
  let layer = initial.layer

  // ── 구간 적용 ────────────────────────────────────────
  let applyToken = 0

  async function applyRange({ from, to }, { fit = true } = {}) {
    const ids = new Set(courses.filter((c) => c.seq >= from && c.seq <= to).map((c) => c.id))
    view.setSelection(ids.size === courses.length ? null : ids)
    if (fit) view.fitIds(ids)

    writeState({ from, to, layer }, opts)

    // 상세 라인은 뒤늦게 도착해도 되므로 await 하지 않고 흘려보낸다.
    const token = ++applyToken
    const targets = [...ids]
    if (targets.length > DETAIL_LIMIT) return

    for (const id of targets) {
      loadCourse(id)
        .then((d) => {
          if (token === applyToken) view.upgradeToDetail(id, d.line)
        })
        .catch(() => {}) // 상세는 있으면 좋은 것이다. 실패해도 오버뷰로 동작한다.
    }
  }

  const sidebar = createSidebar(stage, courses, {
    onRangeChange: (r) => applyRange(r),
    onPick: (c) => {
      renderInfoCard(stage, c)
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

  const fitBtn = el('button', 'ghost-btn', '전체보기')
  fitBtn.type = 'button'
  fitBtn.onclick = () => view.fitAll()
  tools.append(fitBtn)

  // ── 초기 상태 반영 ───────────────────────────────────
  view.setTile(layer)
  sidebar.setRange(initial.from, initial.to, { notify: false })
  await applyRange({ from: initial.from, to: initial.to })

  // 브라우저 뒤로/앞으로
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
