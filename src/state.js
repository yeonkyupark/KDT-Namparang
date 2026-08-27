/**
 * URL 쿼리스트링에 화면 상태를 보관한다.
 * `?from=17&to=23&layer=지형` — 새로고침·북마크·공유에서 그대로 복원된다.
 */

const KEYS = { from: 'from', to: 'to', layer: 'layer' }

export function readState({ maxSeq, tiles }) {
  const q = new URLSearchParams(location.search)

  const num = (key, fallback) => {
    const n = Number.parseInt(q.get(KEYS[key]) ?? '', 10)
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), maxSeq) : fallback
  }

  let from = num('from', 1)
  let to = num('to', maxSeq)
  if (from > to) [from, to] = [to, from]

  const layer = tiles.includes(q.get(KEYS.layer)) ? q.get(KEYS.layer) : tiles[0]

  return { from, to, layer }
}

/** 히스토리를 더럽히지 않도록 replaceState 로 갱신한다. */
export function writeState({ from, to, layer }, { maxSeq, tiles }) {
  const q = new URLSearchParams(location.search)

  // 기본값이면 파라미터를 지운다 — URL이 짧을수록 공유하기 좋다
  if (from === 1) q.delete(KEYS.from)
  else q.set(KEYS.from, String(from))

  if (to === maxSeq) q.delete(KEYS.to)
  else q.set(KEYS.to, String(to))

  if (layer === tiles[0]) q.delete(KEYS.layer)
  else q.set(KEYS.layer, layer)

  const qs = q.toString()
  history.replaceState(null, '', qs ? `?${qs}${location.hash}` : location.pathname + location.hash)
}
