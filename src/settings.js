/**
 * 동기화 설정 — 리포지토리와 개인 액세스 토큰(PAT).
 *
 * ── 왜 PAT 를 브라우저에 두는가 ──
 * Public 리포의 정적 사이트에는 비밀을 숨길 수 없다. 검토한 선택지:
 *   PAT 를 리포에 커밋      → 누구나 리포에 쓸 수 있다. 불가.
 *   OAuth (표준)            → 토큰 교환에 client_secret 필요 → 서버 필요.
 *   OAuth Device Flow       → client_secret 은 없어도 되지만 GitHub 토큰
 *                             엔드포인트가 CORS 를 허용하지 않아 브라우저에서
 *                             직접 호출 못 한다 → 프록시(=서버) 필요.
 *   본인 PAT 를 브라우저에   → 서버가 필요 없는 **유일한** 해법. 채택.
 *
 * ── 위험과 완화 ──
 * localStorage 의 토큰은 XSS 가 터지면 유출된다. 그래서:
 *   - 서드파티 스크립트 0개 (분석·광고·CDN 스크립트 없음)
 *   - 사용자 입력은 절대 innerHTML 로 렌더하지 않는다 (textContent 만)
 *   - PAT 권한을 이 리포 2개의 Contents 쓰기로만 제한 (fine-grained PAT)
 *   - 만료 90일
 * 권한이 파일 쓰기로 한정되므로 최악의 피해는 "리포 2개 오염"이고 git 으로 복구된다.
 */

const KEY = 'namparang.sync'

const DEFAULTS = {
  owner: 'yeonkyupark',
  repo: 'KDT-Namparang',
  photoRepo: 'KDT-Namparang-photos',
  branch: 'main',
  token: '',
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS }
  } catch {
    // 시크릿 모드 등에서 접근이 막힐 수 있다
    return { ...DEFAULTS }
  }
}

export function saveSettings(next) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

/** 토큰 문자열을 로그·화면에 그대로 쓰지 않기 위한 가림 처리. */
export function maskToken(t) {
  if (!t) return ''
  return t.length <= 12 ? '•'.repeat(t.length) : `${t.slice(0, 7)}…${t.slice(-4)}`
}

/**
 * 설정 모달.
 * @param {{current: object, onSave: (s: object) => void, onCheck: (s: object) => Promise<object>}} opts
 */
export function openSettings({ current, onSave, onCheck }) {
  const back = el('div', 'modal-back')
  const box = el('div', 'modal settings-modal')

  const cleanup = () => {
    back.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => {
    if (e.key === 'Escape') cleanup()
  }
  document.addEventListener('keydown', onKey)

  const head = el('div', 'modal-head')
  head.append(el('b', null, 'GitHub 동기화 설정'))
  const x = el('button', 'modal-x', '✕')
  x.type = 'button'
  x.setAttribute('aria-label', '닫기')
  x.onclick = cleanup
  head.append(x)
  box.append(head)

  const field = (label, value, { placeholder = '', type = 'text', hint = '' } = {}) => {
    const wrap = el('label', 'form-row')
    wrap.append(el('span', 'form-label', label))
    const input = document.createElement('input')
    input.type = type
    input.value = value ?? ''
    input.placeholder = placeholder
    input.autocomplete = 'off'
    input.spellcheck = false
    wrap.append(input)
    if (hint) wrap.append(el('span', 'form-hint', hint))
    box.append(wrap)
    return input
  }

  const ownerIn = field('GitHub 계정', current.owner)
  const repoIn = field('메모 리포지토리', current.repo, { hint: 'public/data/notes.json 에 기록을 저장합니다' })
  const photoIn = field('사진 리포지토리', current.photoRepo, {
    hint: '소스 리포를 가볍게 유지하기 위해 사진은 따로 둡니다. 비워두면 사진을 올리지 않습니다',
  })
  const tokenIn = field('Personal Access Token', current.token, {
    type: 'password',
    placeholder: current.token ? maskToken(current.token) : 'github_pat_...',
    hint: '이 브라우저에만 저장됩니다. 리포에는 절대 커밋되지 않습니다',
  })

  const guide = el('div', 'settings-guide')
  guide.append(el('b', null, '토큰 만드는 법'))
  const ol = el('ol')
  for (const t of [
    'GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens',
    'Repository access: 위에 적은 리포 2개만 선택',
    'Permissions → Repository permissions → Contents: Read and write',
    '만료 90일 권장. 이 토큰으로 할 수 있는 일은 그 리포 2개의 파일 쓰기뿐입니다',
  ]) {
    ol.append(el('li', null, t))
  }
  guide.append(ol)
  const link = el('a', null, 'Fine-grained token 만들기 →')
  link.href = 'https://github.com/settings/personal-access-tokens/new'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  guide.append(link)
  box.append(guide)

  const status = el('div', 'settings-status')
  box.append(status)

  const collect = () => ({
    ...current,
    owner: ownerIn.value.trim(),
    repo: repoIn.value.trim(),
    photoRepo: photoIn.value.trim(),
    token: tokenIn.value.trim() || current.token,
  })

  const foot = el('div', 'modal-foot')

  const checkBtn = el('button', 'btn', '연결 확인')
  checkBtn.type = 'button'
  checkBtn.onclick = async () => {
    status.className = 'settings-status'
    status.textContent = '확인 중…'
    checkBtn.disabled = true
    try {
      const r = await onCheck(collect())
      status.className = 'settings-status is-ok'
      status.textContent =
        `${r.login} 계정으로 ${r.repo} 접근 확인. ` +
        (r.canWrite ? '쓰기 권한 있음.' : '⚠ 쓰기 권한이 없습니다 — Contents: Read and write 로 설정하세요.')
    } catch (e) {
      status.className = 'settings-status is-bad'
      status.textContent =
        e.status === 401
          ? '토큰이 유효하지 않습니다 (401)'
          : e.status === 404
            ? '리포지토리를 찾을 수 없거나 토큰에 접근 권한이 없습니다 (404)'
            : `실패 — ${e.message}`
    } finally {
      checkBtn.disabled = false
    }
  }

  const clearBtn = el('button', 'btn btn-danger', '토큰 삭제')
  clearBtn.type = 'button'
  clearBtn.hidden = !current.token
  clearBtn.onclick = () => {
    onSave({ ...collect(), token: '' })
    cleanup()
  }

  const saveBtn = el('button', 'btn btn-primary', '저장')
  saveBtn.type = 'button'
  saveBtn.onclick = () => {
    onSave(collect())
    cleanup()
  }

  foot.append(clearBtn, checkBtn, saveBtn)
  box.append(foot)

  back.append(box)
  back.onclick = (e) => {
    if (e.target === back) cleanup()
  }
  document.body.append(back)
  ;(current.token ? checkBtn : tokenIn).focus()
}
