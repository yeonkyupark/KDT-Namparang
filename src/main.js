import './style.css'
import { loadIndex, loadMeta } from './data.mjs'
import { createMap, DIFFICULTY_COLOR, formatDuration } from './map.js'

const TILES = ['기본', '지형', '위성']

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

  const mapEl = el('div', 'map')
  mapEl.id = 'map'

  app.append(header, mapEl)
  return { header, tileGroup, mapEl, tools }
}

function renderLegend(container, counts) {
  const legend = el('div', 'legend')
  legend.append(el('span', 'legend-title', '난이도'))
  for (const [label, color] of Object.entries(DIFFICULTY_COLOR)) {
    const item = el('span', 'legend-item')
    const sw = el('i', 'sw')
    sw.style.background = color
    item.append(sw, el('span', null, `${label} ${counts[label] ?? 0}`))
    legend.append(item)
  }
  const alt = el('span', 'legend-item')
  alt.append(el('i', 'sw sw-alt'), el('span', null, '임시노선 2'))
  legend.append(alt)
  container.append(legend)
}

function renderSummary(container, meta, courses) {
  const box = el('div', 'summary')
  const rows = [
    ['코스', `${meta.mainCourseCount}개`],
    ['총 거리', `${meta.totalKm.toLocaleString()} km`],
    ['누적 상승', `${meta.totalAscentM.toLocaleString()} m`],
    // 총합에서 분 단위는 무의미하다. 시간으로 끊는다.
    [
      '예상 소요',
      `약 ${Math.round(
        courses.filter((c) => !c.isAlt).reduce((s, c) => s + c.durationMin, 0) / 60,
      ).toLocaleString()}시간`,
    ],
  ]
  for (const [k, v] of rows) {
    const r = el('div', 'summary-row')
    r.append(el('span', 'k', k), el('span', 'v', v))
    box.append(r)
  }
  const note = el('div', 'summary-note')
  note.textContent = '고도는 SRTM DEM 추정값, 소요시간은 계산값입니다.'
  box.append(note)
  container.append(box)
}

function renderInfoCard(course) {
  let card = document.querySelector('.infocard')
  if (!card) {
    card = el('div', 'infocard')
    document.querySelector('.shell').append(card)
  }
  card.textContent = ''

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
  const pairs = [
    ['거리', `${course.distanceKm} km`],
    ['예상 소요', formatDuration(course.durationMin)],
    ['누적 상승', `${course.ascentM.toLocaleString()} m`],
    ['누적 하강', `${course.descentM.toLocaleString()} m`],
    ['고도', `${course.eleMin}–${course.eleMax} m`],
    ['난이도', course.difficulty],
  ]
  for (const [k, v] of pairs) {
    const s = el('div', 'ic-stat')
    s.append(el('span', 'k', k), el('span', 'v', v))
    stats.append(s)
  }
  card.append(stats)

  if (course.note) card.append(el('div', 'ic-note', course.note))
  card.append(el('div', 'ic-foot', '고도는 DEM 추정값 · 소요시간은 계산값'))
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

  const { tileGroup, mapEl, tools } = renderShell()

  /**
   * fitBounds가 피해야 하는 화면 영역.
   * 넓은 화면은 오버레이가 좌상단, 좁은 화면은 하단에 있다.
   * 오버레이 높이는 내용에 따라 달라지므로 실제로 측정한다.
   */
  const getInsets = () => {
    const w = window.innerWidth
    const overlayH = document.querySelector('.overlay')?.offsetHeight ?? 0
    if (w < 641) return { left: 12, top: 12, right: 12, bottom: overlayH + 44 }
    return { left: Math.min(230, Math.round(w * 0.18)), top: 20, right: 24, bottom: 40 }
  }

  const view = createMap(mapEl, courses, { onSelect: renderInfoCard, getInsets })

  // 타일 토글
  let active = TILES[0]
  const buttons = TILES.map((name) => {
    const b = el('button', 'seg-btn' + (name === active ? ' is-on' : ''), name)
    b.type = 'button'
    b.onclick = () => {
      if (name === active) return
      active = name
      view.setTile(name)
      for (const other of buttons) other.classList.toggle('is-on', other.textContent === name)
    }
    tileGroup.append(b)
    return b
  })

  const fit = el('button', 'ghost-btn', '전체보기')
  fit.type = 'button'
  fit.onclick = () => view.fitAll()
  tools.append(fit)

  const counts = {}
  for (const c of courses) if (!c.isAlt) counts[c.difficulty] = (counts[c.difficulty] ?? 0) + 1

  const overlay = el('div', 'overlay')
  renderSummary(overlay, meta, courses)
  renderLegend(overlay, counts)
  document.querySelector('.shell').append(overlay)

  // 오버레이를 붙인 뒤에 맞춘다 — getInsets가 그 높이를 재기 때문이다.
  view.fitAll({ animate: false })
}

main()
