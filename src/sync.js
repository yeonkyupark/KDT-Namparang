/**
 * GitHub 동기화.
 *
 * 구조
 *   메모  : 메인 리포 `public/data/notes.json` 한 파일 (sha 낙관적 락 + 재시도)
 *   사진  : 사진 전용 리포 `{yyyy}/{id}.jpg`, `{yyyy}/{id}_t.jpg`
 *   읽기  : raw.githubusercontent.com (즉시 반영, CORS 열림, API 한도 무관)
 *   쓰기  : Contents API + 브라우저에만 보관하는 fine-grained PAT
 *
 * ── 계획에서 바꾼 것 ──
 * 원래 계획은 노트당 파일 1개(`data/notes/{id}.json`)였다. 단일 파일이 동시
 * 수정에 취약하다는 이유였다. 실제로 만들면서 단일 파일로 바꿨다:
 *   - 읽기가 요청 1번이면 끝난다. 노트당 파일이면 목록을 얻기 위해 디렉터리
 *     조회(인증 필요, API 한도) + 파일마다 요청이 필요하다. 450개면 451번이다.
 *   - 단일 사용자가 한 기기에서 쓰므로 충돌이 드물고, 충돌하면 409 가 오니
 *     다시 읽어 병합하고 재시도하면 정확하다.
 *   - `public/data/` 에 두면 배포 사이트에도 그대로 실린다.
 * 450개 × 약 300B = 135KB 수준이라 용량도 문제가 아니다.
 *
 * ── 병합 규칙 ──
 * `updatedAt` 이 늦은 쪽이 이긴다(LWW). 개인 단일 사용자에게는 이걸로 충분하고,
 * 삭제는 소프트 삭제(`deleted: true`)라 삭제도 기기 간에 전파된다.
 */

import { createClient } from './github.js'
import { allNotesRaw, putNoteRaw, getPhoto, setSyncedAt, getSyncedAt } from './store.js'

const NOTES_PATH = 'public/data/notes.json'
const MAX_PUT_RETRY = 3

/** 원격 notes.json 에 담는 필드만 골라낸다. Blob 은 올리지 않는다. */
function toRemote(note) {
  return {
    id: note.id,
    lat: note.lat,
    lng: note.lng,
    courseId: note.courseId ?? '',
    takenAt: note.takenAt ?? null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    title: note.title ?? '',
    memo: note.memo ?? '',
    rating: note.rating ?? 0,
    locationSource: note.locationSource ?? '',
    address: note.address ?? '',
    deleted: Boolean(note.deleted),
    photo: note.photo ?? null, // { full, thumb } — 사진 리포 안의 경로
  }
}

const laterOf = (a, b) => ((a?.updatedAt ?? '') >= (b?.updatedAt ?? '') ? a : b)

/**
 * 사진의 raw URL 을 **설정에서 조립한다.**
 *
 * 업로드 시점의 절대 URL 도 노트에 함께 저장하지만, 그것만 믿으면 사진 리포 이름을
 * 바꾸거나 계정을 옮긴 순간 기존 사진이 전부 깨진다. 경로(`photo.full`/`photo.thumb`)는
 * 안정적이므로 현재 설정 + 경로로 다시 만들고, 경로가 없는 옛 노트만 저장된 URL 로 폴백한다.
 *
 * @param {object} settings
 * @param {object} note
 * @param {'full'|'thumb'} kind
 */
export function photoUrl(settings, note, kind) {
  const p = note?.photo
  if (!p) return null
  const path = p[kind]
  if (path && settings?.owner && settings?.photoRepo) {
    const enc = path.split('/').map(encodeURIComponent).join('/')
    return `https://raw.githubusercontent.com/${settings.owner}/${settings.photoRepo}/${settings.branch || 'main'}/${enc}`
  }
  return p[`${kind}Url`] ?? null
}

export function createSync(getSettings) {
  const listeners = new Set()
  const emit = (state) => listeners.forEach((fn) => fn(state))

  let running = false

  function clients() {
    const s = getSettings()
    if (!s.token) throw new Error('토큰이 설정되지 않았습니다')
    if (!s.owner || !s.repo) throw new Error('리포지토리가 설정되지 않았습니다')
    const main = createClient({ owner: s.owner, repo: s.repo, branch: s.branch, token: s.token })
    const photos = s.photoRepo
      ? createClient({ owner: s.owner, repo: s.photoRepo, branch: s.branch, token: s.token })
      : null
    return { main, photos, settings: s }
  }

  /** 아직 원격에 올라가지 않은 사진을 올리고 경로를 note.photo 에 기록한다. */
  async function uploadPhotos(photosClient, notes, prefix) {
    if (!photosClient) return { uploaded: 0, skipped: 0, missing: notes.filter((n) => !n.photo).length }

    let uploaded = 0
    let skipped = 0
    let restored = 0
    let orphaned = 0

    // 리포에 실제로 뭐가 있는지 요청 1회로 확인한다.
    //
    // `n.photo` 가 있으면 올렸다는 뜻이지만, 그 파일이 지금도 있다는 보장은 없다.
    // GitHub 웹에서 지우거나 다른 정리 작업이 지나가면 notes.json 은 없는 파일을
    // 가리킨 채로 남고, 예전 코드는 `n.photo` 가 있으면 건너뛰어 영구히 복구되지
    // 않았다. 실제로 이 리포에서 그 일이 일어났다 (PLAN.md 6c 참조).
    let present = null
    try {
      present = await photosClient.listPaths()
    } catch {
      // 목록을 못 얻으면 복구 판정을 하지 않는다. 신규 업로드는 그대로 진행.
      present = null
    }

    for (const n of notes) {
      if (n.deleted) continue

      if (n.photo) {
        // 목록을 못 얻었거나 파일이 멀쩡하면 건드리지 않는다.
        if (!present) continue
        const gone = [n.photo.full, n.photo.thumb].filter((x) => x && !present.has(x))
        if (!gone.length) continue

        // 원격에서 사라졌다. 로컬 원본이 남아 있으면 다시 올린다.
        if (!(await getPhoto(n.id)) || !n.thumb) {
          orphaned++ // 로컬에도 없다 — 이 사진은 되살릴 수 없다
          continue
        }
        delete n.photo // 아래 신규 업로드 경로를 다시 타게 한다
        restored++
      }

      const full = await getPhoto(n.id)
      if (!full || !n.thumb) continue

      const year = (n.takenAt ?? n.createdAt ?? '').slice(0, 4) || 'misc'
      // 사진 리포는 여러 트레일이 공유할 수 있다. 접두어로 구분한다.
      const dir = prefix ? `${prefix}/${year}` : year
      const paths = { full: `${dir}/${n.id}.jpg`, thumb: `${dir}/${n.id}_t.jpg` }

      const a = await photosClient.putBlobIfAbsent(paths.full, full, `사진 추가 ${n.id}`)
      const b = await photosClient.putBlobIfAbsent(paths.thumb, n.thumb, `썸네일 추가 ${n.id}`)
      a.skipped && b.skipped ? skipped++ : uploaded++

      n.photo = {
        ...paths,
        fullUrl: photosClient.rawUrl(paths.full),
        thumbUrl: photosClient.rawUrl(paths.thumb),
      }
      await putNoteRaw(n)
    }
    return { uploaded, skipped, restored, orphaned, missing: 0 }
  }

  /**
   * 로컬 → 원격 → 로컬 한 바퀴.
   * @returns {Promise<{pushed:number, pulled:number, photos:object}>}
   */
  async function run() {
    if (running) return null
    running = true
    emit({ phase: 'start' })

    try {
      const { main, photos } = clients()

      // 1) 사진 먼저. notes.json 에 경로를 담아야 하므로 순서가 중요하다.
      emit({ phase: 'photos' })
      const local = await allNotesRaw()
      const photoStat = await uploadPhotos(photos, local, getSettings().photoPrefix ?? '')

      // 2) notes.json 을 읽어 병합하고 쓴다. 409 면 다시 읽어 재시도.
      emit({ phase: 'notes' })
      let pushed = 0
      let merged = null

      for (let attempt = 0; attempt < MAX_PUT_RETRY; attempt++) {
        // sha 와 내용을 원자적으로 읽는다. raw 는 5분 캐시라 쓰기 경로에 쓰면
        // 방금 올라온 원격 변경을 못 보고 되돌릴 수 있다.
        const head = await main.getFileJson(NOTES_PATH)
        const sha = head?.sha ?? null
        const remote = head?.json ?? null

        const byId = new Map()
        for (const r of remote?.notes ?? []) byId.set(r.id, r)

        pushed = 0
        for (const n of await allNotesRaw()) {
          const mine = toRemote(n)
          const theirs = byId.get(n.id)
          const winner = laterOf(mine, theirs)
          if (winner === mine && JSON.stringify(theirs) !== JSON.stringify(mine)) pushed++
          byId.set(n.id, winner)
        }

        merged = {
          version: 1,
          updatedAt: new Date().toISOString(),
          notes: [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)),
        }

        // 원격과 완전히 같으면 커밋을 만들지 않는다 (빈 커밋으로 CI 를 돌릴 이유가 없다)
        if (remote && JSON.stringify(remote.notes) === JSON.stringify(merged.notes)) break

        try {
          await main.putJson(NOTES_PATH, merged, {
            message: `기록 동기화 (${merged.notes.filter((n) => !n.deleted).length}개)`,
            sha,
          })
          break
        } catch (e) {
          // 409/422 = 그 사이 원격이 바뀌었다. 다시 읽어 병합한다.
          const retryable = e.status === 409 || e.status === 422
          if (!retryable || attempt === MAX_PUT_RETRY - 1) throw e
        }
      }

      // 3) 원격에만 있거나 더 최신인 노트를 로컬로 내린다.
      emit({ phase: 'pull' })
      let pulled = 0
      const localById = new Map((await allNotesRaw()).map((n) => [n.id, n]))
      for (const r of merged?.notes ?? []) {
        const mine = localById.get(r.id)
        if (mine && (mine.updatedAt ?? '') >= (r.updatedAt ?? '')) continue
        // 사진 Blob 은 내리지 않는다. 원격 raw URL 로 바로 표시한다
        // (450개 썸네일을 미리 받으면 9MB다).
        await putNoteRaw({ ...(mine ?? {}), ...r, thumb: mine?.thumb ?? null })
        pulled++
      }

      const at = new Date().toISOString()
      await setSyncedAt(at)
      emit({ phase: 'done', at, pushed, pulled, photos: photoStat })
      return { pushed, pulled, photos: photoStat, at }
    } catch (e) {
      emit({ phase: 'error', message: e.message, status: e.status })
      throw e
    } finally {
      running = false
    }
  }

  return {
    run,
    onState: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    lastSyncedAt: getSyncedAt,
    get busy() {
      return running
    },
  }
}
