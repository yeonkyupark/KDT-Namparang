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
  async function uploadPhotos(photosClient, notes) {
    if (!photosClient) return { uploaded: 0, skipped: 0, missing: notes.filter((n) => !n.photo).length }

    let uploaded = 0
    let skipped = 0
    for (const n of notes) {
      if (n.deleted || n.photo) continue
      const full = await getPhoto(n.id)
      if (!full || !n.thumb) continue

      const year = (n.takenAt ?? n.createdAt ?? '').slice(0, 4) || 'misc'
      const paths = { full: `${year}/${n.id}.jpg`, thumb: `${year}/${n.id}_t.jpg` }

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
    return { uploaded, skipped, missing: 0 }
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
      const photoStat = await uploadPhotos(photos, local)

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
