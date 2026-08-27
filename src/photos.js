/**
 * 사진 처리 — EXIF 좌표 추출 + 리사이즈.
 *
 * `exifr` 는 사진을 실제로 등록할 때만 필요하므로 동적 import 한다.
 * 랜딩에서 지도만 보는 사람에게 파서를 내려보낼 이유가 없다.
 */

/** 저장할 최대 변 길이(px)와 JPEG 품질. 1장 약 150KB. */
const MAX_EDGE = 1280
const QUALITY = 0.75

/** 목록·지도 핀에 쓰는 썸네일. 약 20KB. */
const THUMB_EDGE = 256
const THUMB_QUALITY = 0.7

/**
 * EXIF에서 좌표와 촬영일시를 읽는다.
 *
 * **대부분의 사진에는 좌표가 없다.** 카카오톡·인스타그램 등을 거치면
 * EXIF가 지워진다. 그래서 좌표가 없는 경우가 예외가 아니라 기본 경로다.
 */
export async function readExif(file) {
  try {
    // 기본 진입점은 full 빌드(25.5KB gzip)다. 우리에게 필요한 건 gps + 촬영일시뿐이고
    // lite(14.5KB)에 그 둘과 HEIC 지원이 다 들어 있다. mini(8.9KB)는 HEIC 가 없어
    // 아이폰 원본 파일을 못 읽는다.
    const exifr = await import('exifr/dist/lite.esm.mjs')

    // 태그를 골라 읽는 pick 옵션은 lite 빌드에서 예외를 던진다
    // ("undefined is not iterable") — 작은 빌드는 태그 이름 사전이 잘려 있다.
    // 기본 parse 가 좌표와 촬영일시를 한 번에 주므로 그걸 쓴다.
    const parsed = await exifr.parse(file).catch(() => null)

    let lat = parsed?.latitude
    let lng = parsed?.longitude
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      // 기본 parse 가 GPS 블록을 못 읽는 파일이 있을 수 있어 한 번 더 시도한다
      const gps = await exifr.gps(file).catch(() => null)
      lat = gps?.latitude
      lng = gps?.longitude
    }

    const taken = parsed?.DateTimeOriginal ?? parsed?.CreateDate

    return {
      latlng: Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null,
      takenAt: taken instanceof Date && !Number.isNaN(+taken) ? taken.toISOString() : null,
    }
  } catch {
    // 파서 로딩 실패나 손상된 EXIF. 사진 등록 자체를 막을 이유는 없다.
    return { latlng: null, takenAt: null }
  }
}

async function loadBitmap(file) {
  // imageOrientation: 'from-image' 가 EXIF 회전을 반영한다.
  // 이게 없으면 세로로 찍은 사진이 눕는다.
  if (globalThis.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // 일부 브라우저는 옵션을 거부한다. 옵션 없이 재시도.
      try {
        return await createImageBitmap(file)
      } catch {
        /* 아래 <img> 경로로 */
      }
    }
  }

  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'sync'
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다'))
      img.src = url
    })
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function scaleTo(src, maxEdge, quality) {
  const w = src.width
  const h = src.height
  const ratio = Math.min(1, maxEdge / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * ratio))
  const ch = Math.max(1, Math.round(h * ratio))

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, cw, ch)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve({ blob: b, width: cw, height: ch }) : reject(new Error('인코딩 실패'))),
      'image/jpeg',
      quality,
    )
  })
}

/**
 * 원본을 저장용 크기와 썸네일로 줄인다.
 *
 * 원본은 보관하지 않는다. 요즘 휴대폰 사진은 장당 3~5MB인데,
 * 90개 코스를 기록하면 리포·저장소 용량이 곧 한도에 닿는다.
 */
export async function processImage(file) {
  const src = await loadBitmap(file)
  try {
    const full = await scaleTo(src, MAX_EDGE, QUALITY)
    const thumb = await scaleTo(src, THUMB_EDGE, THUMB_QUALITY)
    return { full: full.blob, thumb: thumb.blob, width: full.width, height: full.height }
  } finally {
    src.close?.()
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}
