/**
 * 사진 처리 — 위치 정보 추출 + 리사이즈.
 *
 * `exifr` 는 사진을 실제로 등록할 때만 필요하므로 동적 import 한다.
 * 랜딩에서 지도만 보는 사람에게 파서를 내려보낼 이유가 없다.
 *
 * ── 왜 full 빌드인가 ──
 * 처음엔 lite(14.6KB)를 썼다. GPS·촬영일시·HEIC 가 다 있어서 충분해 보였다.
 * 그런데 갤럭시 등 일부 기기는 좌표 대신(또는 좌표와 함께) **주소 문자열**을
 * XMP / IPTC 블록에 넣는다. lite 에는 그 파서와 태그 사전이 없어서
 * 그런 사진은 "위치 정보 없음"으로만 보인다.
 * full(25.5KB)은 XMP·IPTC·ICC·MakerNote 를 다 읽는다. 사진 등록 시에만
 * 지연 로딩되는 청크라 11KB 차이는 감수할 만하다.
 */

/** 목록·지도 핀에 쓰는 썸네일. 약 20KB. */
const THUMB_EDGE = 256
const THUMB_QUALITY = 0.7

/** 주소가 담길 수 있는 표준 필드들. 앞쪽이 더 구체적인 순서다. */
const ADDRESS_KEYS = [
  'Sublocation',
  'Sub-location',
  'Location',
  'City',
  'Province-State',
  'State',
  'Country-PrimaryLocationName',
  'Country',
  'CountryCode',
]

/**
 * Latin1 으로 잘못 읽힌 UTF-8 문자열을 되살린다.
 *
 * IPTC-IIM 은 인코딩을 헤더에 담지 않고 별도 태그(1:90 CodedCharacterSet)로
 * 선언한다. **exifr 은 그 태그를 무시하고 항상 Latin1 로 읽는다** — 실측 확인:
 * `1:90 = ESC % G`(UTF-8)를 넣어도 `학동고개` 가 `íëê³ ê°` 로 나온다.
 *
 * 각 문자를 바이트로 되돌려 UTF-8 로 다시 디코딩한다. `fatal: true` 라
 * 실제로 UTF-8 이 아니면 예외가 나므로 원본을 그대로 둔다. 추가로 되살린
 * 결과에 한글·CJK 가 있을 때만 채택해서, 진짜 Latin1 텍스트(Café 등)를
 * 건드리지 않는다.
 */
function fixMojibake(s) {
  if (typeof s !== 'string' || !/[-ÿ]/.test(s)) return s
  try {
    const bytes = Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff)
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return /[㄰-㆏가-힯一-鿿]/.test(decoded) ? decoded : s
  } catch {
    return s
  }
}

/** 한글 주소처럼 보이는 문자열인가 — 커스텀 필드에 들어간 주소를 건지기 위한 휴리스틱. */
function looksKoreanAddress(v) {
  return (
    typeof v === 'string' &&
    v.length >= 4 &&
    v.length <= 120 &&
    /[가-힣]/.test(v) &&
    /(특별시|광역시|특별자치|[가-힣]{2,}(시|군|구|읍|면|동|리|로|길))/.test(v)
  )
}

/**
 * 파싱 결과에서 주소를 조립한다.
 * 표준 필드를 먼저 보고, 없으면 값 전체를 훑어 한글 주소처럼 보이는 것을 찾는다.
 */
function extractAddress(parsed) {
  if (!parsed || typeof parsed !== 'object') return { address: '', addressSource: '' }

  const parts = []
  for (const k of ADDRESS_KEYS) {
    const v = fixMojibake(parsed[k])
    if (typeof v === 'string' && v.trim() && !parts.includes(v.trim())) parts.push(v.trim())
  }
  if (parts.length) return { address: parts.join(' '), addressSource: 'iptc/xmp' }

  for (const [k, v] of Object.entries(parsed)) {
    const fixed = fixMojibake(v)
    if (looksKoreanAddress(fixed)) return { address: fixed.trim(), addressSource: k }
  }
  return { address: '', addressSource: '' }
}

/** 좌표를 담을 수 있는 여러 표기를 훑는다. */
function extractLatLng(parsed) {
  if (!parsed) return null

  const pairs = [
    [parsed.latitude, parsed.longitude],
    [parsed.GPSLatitude, parsed.GPSLongitude],
    [parsed.lat, parsed.lon ?? parsed.lng],
  ]
  for (const [a, b] of pairs) {
    const lat = typeof a === 'number' ? a : Number(a)
    const lng = typeof b === 'number' ? b : Number(b)
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) return [lat, lng]
  }
  return null
}

/**
 * 사진에서 위치 정보를 읽는다.
 *
 * **좌표가 없는 사진이 예외가 아니라 기본이다.** 메신저·SNS를 거치면 EXIF가
 * 지워지고, 촬영 시 위치 태그가 꺼져 있었으면 애초에 기록되지 않는다.
 *
 * @returns {Promise<{latlng: [number,number]|null, takenAt: string|null,
 *                    address: string, addressSource: string, diag: object}>}
 */
export async function readExif(file) {
  const empty = { latlng: null, takenAt: null, address: '', addressSource: '', diag: {} }

  try {
    const exifr = await import('exifr/dist/full.esm.mjs')

    // 태그를 골라 읽는 pick 옵션은 작은 빌드에서 예외를 던진다
    // ("undefined is not iterable" — 태그 이름 사전이 잘려 있다).
    // 블록을 켜서 통째로 읽는 편이 안전하고, 파일 1장이라 비용도 무의미하다.
    const parsed = await exifr
      .parse(file, {
        tiff: true,
        exif: true,
        gps: true,
        xmp: true,
        iptc: true,
        ifd0: true,
        mergeOutput: true,
        reviveValues: true,
        translateKeys: true,
        translateValues: true,
      })
      .catch(() => null)

    let latlng = extractLatLng(parsed)
    if (!latlng) {
      const gps = await exifr.gps(file).catch(() => null)
      if (Number.isFinite(gps?.latitude) && Number.isFinite(gps?.longitude)) {
        latlng = [gps.latitude, gps.longitude]
      }
    }

    const taken = parsed?.DateTimeOriginal ?? parsed?.CreateDate ?? parsed?.ModifyDate
    const { address, addressSource } = extractAddress(parsed)

    return {
      latlng,
      takenAt: taken instanceof Date && !Number.isNaN(+taken) ? taken.toISOString() : null,
      address,
      addressSource,
      // 진단용: 어떤 키가 실제로 들어 있었는지. "주소는 보이는데 좌표가 없다"는
      // 제보를 받았을 때 어디를 봐야 하는지 알려면 이게 필요하다.
      diag: {
        keys: parsed ? Object.keys(parsed).sort() : [],
        hasGpsKeys: parsed
          ? Object.keys(parsed).filter((k) => /gps|latitude|longitude/i.test(k))
          : [],
        textValues: parsed
          ? Object.entries(parsed)
              .filter(([, v]) => typeof v === 'string' && v.trim() && v.length <= 120)
              .slice(0, 40)
              .map(([k, v]) => `${k}=${fixMojibake(v)}`)
          : [],
      },
    }
  } catch {
    return empty
  }
}

async function loadBitmap(file) {
  // imageOrientation: 'from-image' 가 EXIF 회전을 반영한다.
  // 이게 없으면 세로로 찍은 사진이 눕는다.
  if (globalThis.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
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
 * 원본은 그대로 두고, 목록·지도 핀에 쓸 작은 썸네일만 만든다.
 *
 * 원래는 저장용 사본도 1280px로 줄여 다시 인코딩했다. 그런데 사용자가
 * 등록 전에 이미 사진을 정리·리사이즈해 두므로, 앱이 한 번 더 압축하면
 * 화질만 떨어뜨릴 뿐이다. 출력은 원본 크기 그대로여야 한다는 요구사항이라
 * `full`은 원본 File을 그대로 돌려준다 — 재인코딩도, 용량 절감도 없다.
 */
export async function processImage(file) {
  const src = await loadBitmap(file)
  try {
    const thumb = await scaleTo(src, THUMB_EDGE, THUMB_QUALITY)
    return { full: file, thumb: thumb.blob, width: src.width, height: src.height }
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
