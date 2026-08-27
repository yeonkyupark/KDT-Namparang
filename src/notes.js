/**
 * 사진 + 메모 기록.
 *
 * 흐름
 *   파일 선택 → EXIF 좌표 확인 → (없으면) 지도 클릭으로 위치 지정
 *   → 리사이즈 → 메모 입력 → IndexedDB 저장 → 지도에 핀
 *
 * 좌표가 없는 사진이 예외가 아니라 기본이다(메신저·SNS를 거치면 EXIF가 지워진다).
 * 지도 클릭 경로를 곁가지가 아니라 정식 경로로 취급한다.
 */

import { allNotes, saveNote, deleteNote, getPhoto, newId, usage } from './store.js'
import { readExif, processImage, formatBytes } from './photos.js'
import { haversine } from './geo.js'

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(+d)
    ? ''
    : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.host  사이드바 안의 기록 섹션 컨테이너
 * @param {object} deps.view       createMap 이 돌려준 지도 뷰
 * @param {Array}  deps.courses    courses.json
 */
export function createNotes({ host, view, courses }) {
  const mainCourses = courses.filter((c) => !c.isAlt)

  /** @type {Map<string, object>} */
  const notes = new Map()
  let picking = null

  // ── 사이드바 섹션 ────────────────────────────────────
  const head = el('div', 'notes-head')
  const headTitle = el('span', 'notes-title', '기록')
  const headCount = el('span', 'notes-count')
  head.append(headTitle, headCount)

  const addBtn = el('button', 'add-btn', '+ 사진 · 메모 추가')
  addBtn.type = 'button'

  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.hidden = true

  const list = el('ul', 'notes-list')
  const usageLine = el('div', 'notes-usage')

  host.append(head, addBtn, input, list, usageLine)

  addBtn.onclick = () => input.click()
  input.onchange = async () => {
    const files = [...input.files]
    input.value = '' // 같은 파일을 다시 골라도 change 가 오게
    for (const file of files) await ingest(file)
  }

  // ── 가장 가까운 코스 찾기 ────────────────────────────
  /**
   * 좌표에서 가장 가까운 코스를 고른다.
   * 오버뷰 라인(코스당 43점)으로만 재기 때문에 정확한 최단거리가 아니라
   * "어느 코스 근처냐"를 가리는 수준이다. 그 용도에는 충분하다.
   */
  function nearestCourse(latlng) {
    let best = null
    let bestD = Infinity
    for (const c of mainCourses) {
      for (const p of c.overview) {
        const d = haversine(latlng, p)
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
    }
    return bestD <= 3000 ? { course: best, distM: bestD } : null
  }

  // ── 등록 ─────────────────────────────────────────────
  async function ingest(file) {
    if (!file.type.startsWith('image/')) {
      toast(`${file.name}: 이미지 파일이 아닙니다`)
      return
    }

    let exif
    let image
    try {
      ;[exif, image] = await Promise.all([readExif(file), processImage(file)])
    } catch (e) {
      toast(`${file.name}: 처리 실패 — ${e.message}`)
      return
    }

    let latlng = exif.latlng
    let source = 'exif'
    if (!latlng) {
      latlng = await askLocation(file.name)
      source = 'map'
      if (!latlng) return // 사용자가 취소
    }

    const near = nearestCourse(latlng)
    openForm({
      draft: {
        id: newId(),
        lat: latlng[0],
        lng: latlng[1],
        courseId: near?.course?.id ?? '',
        takenAt: exif.takenAt,
        title: '',
        memo: '',
        rating: 0,
        locationSource: source,
      },
      image,
      near,
    })
  }

  /** 지도를 클릭해 위치를 받는다. */
  function askLocation(fileName) {
    const banner = el('div', 'pick-banner')
    banner.append(
      el('b', null, '지도를 클릭해 위치를 지정하세요'),
      el(
        'span',
        'pick-sub',
        `${fileName} — 사진에 GPS 정보가 없습니다 (메신저·SNS를 거치면 지워집니다)`,
      ),
    )
    const cancel = el('button', 'pick-cancel', '취소')
    cancel.type = 'button'
    banner.append(cancel)
    document.querySelector('.map-overlay').append(banner)

    picking = view.pickLocation()
    cancel.onclick = () => picking?.cancel()

    return picking.promise.finally(() => {
      banner.remove()
      picking = null
    })
  }

  // ── 입력 폼 ──────────────────────────────────────────
  function openForm({ draft, image, near, existingThumbUrl }) {
    const back = el('div', 'modal-back')
    const box = el('div', 'modal form-modal')

    const previewUrl = image ? URL.createObjectURL(image.thumb) : existingThumbUrl
    const cleanup = () => {
      if (image && previewUrl) URL.revokeObjectURL(previewUrl)
      back.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup()
    }
    document.addEventListener('keydown', onKey)

    const h = el('div', 'modal-head')
    h.append(el('b', null, image ? '기록 추가' : '기록 수정'))
    const x = el('button', 'modal-x', '✕')
    x.type = 'button'
    x.setAttribute('aria-label', '닫기')
    x.onclick = cleanup
    h.append(x)
    box.append(h)

    if (previewUrl) {
      const img = el('img', 'form-preview')
      img.src = previewUrl
      img.alt = '미리보기'
      box.append(img)
    }

    const meta = el('div', 'form-meta')
    const courseSel = document.createElement('select')
    const none = document.createElement('option')
    none.value = ''
    none.textContent = '코스 지정 없음'
    courseSel.append(none)
    for (const c of mainCourses) {
      const o = document.createElement('option')
      o.value = c.id
      o.textContent = `${c.seq}코스 · ${c.region || '—'}`
      courseSel.append(o)
    }
    courseSel.value = draft.courseId ?? ''

    meta.append(labelled('코스', courseSel))
    const infoBits = []
    if (draft.takenAt) infoBits.push(`촬영 ${fmtDate(draft.takenAt)}`)
    infoBits.push(draft.locationSource === 'exif' ? '위치: 사진 EXIF' : '위치: 지도 지정')
    if (near) infoBits.push(`코스에서 ${Math.round(near.distM)}m`)
    meta.append(el('div', 'form-info', infoBits.join(' · ')))
    box.append(meta)

    const titleIn = document.createElement('input')
    titleIn.type = 'text'
    titleIn.maxLength = 80
    titleIn.placeholder = '예: 학동고개 정상'
    titleIn.value = draft.title ?? ''
    box.append(labelled('제목', titleIn))

    const memoIn = document.createElement('textarea')
    memoIn.rows = 4
    memoIn.maxLength = 2000
    memoIn.placeholder = '메모'
    memoIn.value = draft.memo ?? ''
    box.append(labelled('메모', memoIn))

    const stars = el('div', 'stars')
    let rating = draft.rating ?? 0
    const starBtns = []
    for (let i = 1; i <= 5; i++) {
      const b = el('button', 'star', '★')
      b.type = 'button'
      b.setAttribute('aria-label', `${i}점`)
      b.onclick = () => {
        rating = rating === i ? 0 : i
        paintStars()
      }
      starBtns.push(b)
      stars.append(b)
    }
    const paintStars = () => starBtns.forEach((b, i) => b.classList.toggle('is-on', i < rating))
    paintStars()
    box.append(labelled('평점', stars))

    const foot = el('div', 'modal-foot')
    const cancelBtn = el('button', 'btn', '취소')
    cancelBtn.type = 'button'
    cancelBtn.onclick = cleanup
    const saveBtn = el('button', 'btn btn-primary', '저장')
    saveBtn.type = 'button'
    saveBtn.onclick = async () => {
      saveBtn.disabled = true
      saveBtn.textContent = '저장 중…'
      try {
        const rec = await saveNote(
          {
            ...draft,
            courseId: courseSel.value,
            title: titleIn.value.trim(),
            memo: memoIn.value.trim(),
            rating,
            thumb: image ? image.thumb : notes.get(draft.id)?.thumb ?? null,
          },
          image ? image.full : null,
        )
        notes.set(rec.id, rec)
        view.setNotePin(rec, { onClick: openViewer })
        renderList()
        refreshUsage()
        cleanup()
      } catch (e) {
        saveBtn.disabled = false
        saveBtn.textContent = '저장'
        toast(`저장 실패 — ${e.message}`)
      }
    }
    foot.append(cancelBtn, saveBtn)
    box.append(foot)

    back.append(box)
    back.onclick = (e) => {
      if (e.target === back) cleanup()
    }
    document.body.append(back)
    titleIn.focus()
  }

  function labelled(text, control) {
    const wrap = el('label', 'form-row')
    wrap.append(el('span', 'form-label', text), control)
    return wrap
  }

  // ── 보기 모달 ────────────────────────────────────────
  async function openViewer(note) {
    const ordered = [...notes.values()]
    let idx = ordered.findIndex((n) => n.id === note.id)
    if (idx < 0) idx = 0

    const back = el('div', 'modal-back')
    const box = el('div', 'modal view-modal')
    let objectUrl = null

    const cleanup = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      back.remove()
      document.removeEventListener('keydown', onKey)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup()
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    document.addEventListener('keydown', onKey)

    const h = el('div', 'modal-head')
    const hTitle = el('b')
    const nav = el('span', 'view-nav')
    const x = el('button', 'modal-x', '✕')
    x.type = 'button'
    x.setAttribute('aria-label', '닫기')
    x.onclick = cleanup
    h.append(hTitle, nav, x)

    const figure = el('div', 'view-figure')
    const img = el('img', 'view-img')
    img.alt = ''
    figure.append(img)

    const prev = el('button', 'view-arrow view-prev', '‹')
    const next = el('button', 'view-arrow view-next', '›')
    prev.type = next.type = 'button'
    prev.setAttribute('aria-label', '이전 기록')
    next.setAttribute('aria-label', '다음 기록')
    prev.onclick = () => step(-1)
    next.onclick = () => step(1)
    figure.append(prev, next)

    const body = el('div', 'view-body')
    const foot = el('div', 'modal-foot')
    const editBtn = el('button', 'btn', '수정')
    const delBtn = el('button', 'btn btn-danger', '삭제')
    editBtn.type = delBtn.type = 'button'
    foot.append(delBtn, editBtn)

    box.append(h, figure, body, foot)
    back.append(box)
    back.onclick = (e) => {
      if (e.target === back) cleanup()
    }
    document.body.append(back)

    const step = (d) => {
      const n = ordered.length
      if (n <= 1) return
      idx = (idx + d + n) % n
      paint()
    }

    async function paint() {
      const cur = ordered[idx]
      hTitle.textContent = cur.title || '(제목 없음)'
      nav.textContent = ordered.length > 1 ? `${idx + 1} / ${ordered.length}` : ''
      prev.hidden = next.hidden = ordered.length <= 1

      body.textContent = ''
      const course = courses.find((c) => c.id === cur.courseId)
      const bits = []
      if (course) bits.push(course.name + (course.region ? ` · ${course.region}` : ''))
      if (cur.takenAt) bits.push(`촬영 ${fmtDate(cur.takenAt)}`)
      else if (cur.createdAt) bits.push(`등록 ${fmtDate(cur.createdAt)}`)
      if (cur.rating) bits.push('★'.repeat(cur.rating))
      body.append(el('div', 'view-meta', bits.join(' · ')))
      if (cur.memo) body.append(el('p', 'view-memo', cur.memo)) // textContent — HTML 로 렌더하지 않는다

      if (objectUrl) URL.revokeObjectURL(objectUrl)
      objectUrl = null
      img.removeAttribute('src')
      const blob = (await getPhoto(cur.id)) ?? cur.thumb
      if (blob) {
        objectUrl = URL.createObjectURL(blob)
        img.src = objectUrl
        img.alt = cur.title || '사진'
      }

      editBtn.onclick = () => {
        cleanup()
        openForm({
          draft: { ...cur },
          image: null,
          near: null,
          existingThumbUrl: cur.thumb ? URL.createObjectURL(cur.thumb) : null,
        })
      }
      delBtn.onclick = async () => {
        if (!confirm(`"${cur.title || '이 기록'}"을 삭제할까요?`)) return
        await deleteNote(cur.id)
        notes.delete(cur.id)
        view.removeNotePin(cur.id)
        renderList()
        refreshUsage()
        cleanup()
      }

      view.panTo([cur.lat, cur.lng])
    }

    await paint()
  }

  // ── 목록 ─────────────────────────────────────────────
  const listUrls = new Set()

  function renderList() {
    for (const u of listUrls) URL.revokeObjectURL(u)
    listUrls.clear()
    list.textContent = ''

    const ordered = [...notes.values()].reverse() // 최근 등록이 위로
    headCount.textContent = ordered.length ? `${ordered.length}개` : ''

    if (ordered.length === 0) {
      list.append(
        el('li', 'notes-empty', '아직 기록이 없습니다. 사진을 올리면 지도에 위치가 표시됩니다.'),
      )
      return
    }

    for (const n of ordered) {
      const li = el('li', 'note-item')
      if (n.thumb) {
        const url = URL.createObjectURL(n.thumb)
        listUrls.add(url)
        const img = el('img', 'note-thumb')
        img.src = url
        img.alt = ''
        li.append(img)
      } else {
        li.append(el('span', 'note-thumb is-empty', '📷'))
      }

      const mid = el('span', 'note-mid')
      mid.append(el('span', 'note-name', n.title || '(제목 없음)'))
      const course = courses.find((c) => c.id === n.courseId)
      mid.append(
        el('span', 'note-sub', [course?.name, fmtDate(n.takenAt ?? n.createdAt)].filter(Boolean).join(' · ')),
      )
      li.append(mid)

      li.onclick = () => openViewer(n)
      list.append(li)
    }
  }

  async function refreshUsage() {
    const u = await usage()
    const count = notes.size
    usageLine.textContent = u
      ? `사진 ${count}장 · 이 브라우저에 약 ${formatBytes(u.usedBytes)} 저장됨`
      : `사진 ${count}장`
  }

  function toast(message) {
    const t = el('div', 'toast', message)
    document.body.append(t)
    setTimeout(() => t.remove(), 4000)
  }

  // ── 초기 로딩 ────────────────────────────────────────
  async function load() {
    try {
      for (const n of await allNotes()) notes.set(n.id, n)
    } catch (e) {
      usageLine.textContent = `저장소를 열 수 없습니다 — ${e.message}`
      return
    }
    view.clearNotePins()
    for (const n of notes.values()) view.setNotePin(n, { onClick: openViewer })
    renderList()
    refreshUsage()
  }

  return { load, get count() { return notes.size } }
}
