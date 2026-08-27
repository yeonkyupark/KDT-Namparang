import './style.css'

// 단계 0 플레이스홀더.
// 배포 파이프라인이 살아있는지 확인하는 용도이며, 단계 3에서 지도로 교체된다.

const STATS = [
  { n: '90', k: '코스 (+ 임시노선 2)' },
  { n: '1,476', k: '총 거리 (km)' },
  { n: '134,697', k: '트랙포인트' },
  { n: '89 / 89', k: '접합부 500m 이내' },
]

const STEPS = [
  { s: 'done', t: '데이터 확보', d: 'GPX 92개 수집 · 전수 검증' },
  { s: 'done', t: '출처 표기', d: 'data/SOURCE.md' },
  { s: 'now',  t: '배포 파이프라인', d: 'Vite + GitHub Actions + Pages' },
  { s: 'todo', t: '고도 확보', d: 'SRTM DEM 조회 · 이중 대조 검증' },
  { s: 'todo', t: '전처리', d: 'GPX → courses.json' },
  { s: 'todo', t: '랜딩 지도', d: 'Leaflet · 92개 코스 표시' },
  { s: 'todo', t: '구간 선택', d: '시작~종료 코스 · 요약 정보' },
  { s: 'todo', t: '고도 프로필', d: 'SVG 차트' },
  { s: 'todo', t: '사진 · 메모', d: 'EXIF GPS · IndexedDB' },
  { s: 'todo', t: 'GitHub 동기화', d: 'Contents API' },
]

const MARK = { done: '✓', now: '▸', todo: '·' }

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function render() {
  const app = document.getElementById('app')
  app.textContent = ''

  const h1 = el('h1')
  h1.append('남파랑길 가이드 ', el('span', 'badge', '개발 중'))
  app.append(h1)

  app.append(el('p', 'sub', '부산 오륙도 → 해남 땅끝탑 · 남해안 90개 코스'))

  const ul = el('ul', 'stats')
  for (const s of STATS) {
    const li = el('li')
    li.append(el('span', 'n', s.n), el('span', 'k', s.k))
    ul.append(li)
  }
  app.append(ul)

  app.append(el('h2', null, '진행 상황'))

  const ol = el('ol', 'steps')
  for (const step of STEPS) {
    const li = el('li', `is-${step.s}`)
    li.append(
      el('span', `mark ${step.s}`, MARK[step.s]),
      el('span', null, ''),
    )
    const body = li.lastChild
    body.append(el('b', null, step.t), ' — ', step.d)
    ol.append(li)
  }
  app.append(ol)

  const foot = el('footer')
  const a = el('a', null, 'Daum 카페 "도보여행(섬&산) 좋은사람들"')
  a.href = 'https://cafe.daum.net/mtsingles/LN1X/1631'
  a.rel = 'noopener noreferrer'
  a.target = '_blank'
  foot.append('GPX 노선 © ', a, ' — 원저작자가 90개 코스를 직접 걸어 정리한 자료입니다. ')
  foot.append('개인 비상업적 용도로만 사용합니다.')
  app.append(foot)
}

render()
