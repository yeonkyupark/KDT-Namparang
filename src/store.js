/**
 * IndexedDB 저장소 — 사진·메모의 **1차 저장소**.
 *
 * 클라우드(GitHub)는 단계 6b에서 붙이는 동기화 대상이고, 여기가 원본이다.
 * 등산 중 네트워크가 없어도 등록이 즉시 성공해야 한다.
 *
 * localStorage 를 쓰지 않는 이유: 5MB 한계 + 문자열만 저장 가능해서
 * 이미지를 담을 수 없다. IndexedDB 는 Blob 을 그대로 넣는다.
 *
 * 스토어
 *   notes  { id, lat, lng, courseId, takenAt, createdAt, updatedAt,
 *            title, memo, rating, thumb: Blob, deleted, synced }
 *   photos { id, blob }   — id 는 note.id 와 같다 (노트 1개 = 사진 1장)
 *
 * 본문 이미지를 분리해 둔 이유: 목록·핀을 그릴 때 썸네일만 읽으면 되고
 * 원본(150KB)은 모달을 열 때만 읽는다.
 */

const DB_NAME = 'namparang'
const DB_VERSION = 2
const NOTES = 'notes'
const PHOTOS = 'photos'
const META = 'meta'

let dbPromise = null

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(NOTES)) {
        const s = db.createObjectStore(NOTES, { keyPath: 'id' })
        s.createIndex('courseId', 'courseId')
        s.createIndex('updatedAt', 'updatedAt')
      }
      if (!db.objectStoreNames.contains(PHOTOS)) {
        db.createObjectStore(PHOTOS, { keyPath: 'id' })
      }
      // v2: 동기화 시각 등 잡다한 값
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 열기 실패'))
    req.onblocked = () => reject(new Error('다른 탭이 이전 버전 DB를 잡고 있습니다'))
  })
  return dbPromise
}

function tx(store, mode, run) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        t.oncomplete = () => resolve(req?.result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error ?? new Error('트랜잭션 중단'))
      }),
  )
}

export function newId() {
  // crypto.randomUUID 는 https/localhost 에서만 있다. 대비책을 둔다.
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  const r = crypto.getRandomValues(new Uint8Array(16))
  return [...r].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 노트 + 사진을 한 번에 저장한다. */
export async function saveNote(note, photoBlob) {
  const now = new Date().toISOString()
  const rec = { ...note, updatedAt: now, createdAt: note.createdAt ?? now, deleted: false }
  await tx(NOTES, 'readwrite', (s) => s.put(rec))
  if (photoBlob) await tx(PHOTOS, 'readwrite', (s) => s.put({ id: rec.id, blob: photoBlob }))
  return rec
}

/** 삭제되지 않은 노트 전부. 생성 순서(오름차순)로 준다. */
export async function allNotes() {
  const rows = await tx(NOTES, 'readonly', (s) => s.getAll())
  return (rows ?? [])
    .filter((n) => !n.deleted)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
}

export function getPhoto(id) {
  return tx(PHOTOS, 'readonly', (s) => s.get(id)).then((r) => r?.blob ?? null)
}

/**
 * 소프트 삭제. 실제로 지우지 않고 `deleted: true` 로 표시한다.
 * 단계 6b에서 기기 간 삭제를 전파하려면 "삭제됐다"는 사실 자체가 남아야 한다.
 * 사진 Blob 은 용량이 크므로 바로 지운다.
 */
export async function deleteNote(id) {
  const rec = await tx(NOTES, 'readonly', (s) => s.get(id))
  if (!rec) return
  await tx(NOTES, 'readwrite', (s) =>
    s.put({ ...rec, deleted: true, thumb: null, updatedAt: new Date().toISOString() }),
  )
  await tx(PHOTOS, 'readwrite', (s) => s.delete(id))
}

/**
 * 삭제 표시된 것까지 **전부** 준다.
 * 동기화는 "삭제됐다"는 사실도 원격에 올려야 하므로 필터링하면 안 된다.
 */
export async function allNotesRaw() {
  return (await tx(NOTES, 'readonly', (s) => s.getAll())) ?? []
}

/**
 * 노트를 그대로 넣는다. `updatedAt` 을 건드리지 않는다.
 *
 * `saveNote` 는 사용자 편집용이라 항상 `updatedAt` 을 지금으로 바꾼다.
 * 동기화가 그걸 쓰면 원격에서 내려받은 노트가 매번 "방금 수정됨"이 되어
 * LWW 병합이 영원히 끝나지 않는다.
 */
export function putNoteRaw(note) {
  return tx(NOTES, 'readwrite', (s) => s.put(note))
}

export async function setSyncedAt(iso) {
  await tx(META, 'readwrite', (s) => s.put({ key: 'syncedAt', value: iso }))
}

export async function getSyncedAt() {
  const r = await tx(META, 'readonly', (s) => s.get('syncedAt'))
  return r?.value ?? null
}

/** 브라우저가 알려주는 사용량 추정. 앱에 표시해 한도를 눈으로 보게 한다. */
export async function usage() {
  try {
    const e = await navigator.storage?.estimate?.()
    if (!e) return null
    return { usedBytes: e.usage ?? 0, quotaBytes: e.quota ?? 0 }
  } catch {
    return null
  }
}
