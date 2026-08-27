/**
 * `<trk><name>` 에서 코스 메타데이터를 뽑는다.
 *
 * 92개의 이름 형식이 통일되어 있지 않다. 실제 분포:
 *
 *   70개  `017-거제시 고현버스터미널~거제시 장목면 장목파출소`      (표준)
 *    5개  `004 [1203 수정] 감천사거리~신평동교차로 (20191009 윤)`  (앞뒤 군더더기)
 *   11개  `남파랑길 36코스 (남해바래길 03코스 동대만길) 20200906`  (지점명 없음, 별칭만)
 *    3개  `남파랑길-001코스-부산 19.2km_노선수정`                  (정보 거의 없음)
 *    1개  `GPX`                                                    (nam-03, 한국관광공사 원본)
 *    2개  임시노선 (17-1, 61-1)
 *
 * 지점명을 지어내지 않는다. 못 뽑으면 빈 값으로 두고 `data/courses.meta.csv`로 보정한다.
 */

/** 이름 앞쪽의 코스번호·"남파랑길"·대괄호 메모를 걷어낸다. */
function stripLead(s) {
  let t = s
  for (let i = 0; i < 6; i++) {
    const before = t
    t = t
      .replace(/^\s*[-–]\s*/, '')
      .replace(/^남파랑길\s*/, '')
      // 코스번호 접두어. `(?:코스)?` 로 묶어야 한다 — `코스?` 는 '코' + 선택적 '스' 가 된다.
      .replace(/^0*\d{1,3}\s*(?:\(\d+\))?\s*(?:코스)?\s*[-–]?\s*/, '')
      .replace(/^\[[^\]]*[\]}]\s*/, '') // [1203 수정] — 닫는 괄호가 } 로 오타난 경우도 있다
    if (t === before) break
  }
  return t.trim()
}

/** 이름 뒤쪽의 날짜·거리·수정메모를 걷어낸다. */
function stripTail(s) {
  let t = s
  for (let i = 0; i < 6; i++) {
    const before = t
    t = t
      .replace(/\s*\(\s*\d{6,8}[^)]*\)\s*$/, '') // (20191009 윤)
      .replace(/\s*\((?:시종점변경|시점변경|종점변경)\)\s*$/, '')
      .replace(/\s*[-–]?\s*\d+(?:\.\d+)?\s*km.*$/i, '') // 27.6km(...)  / 13.7km_20201101(...)
      .replace(/\s*_\s*(?:노선수정|우회노선활용|\d+.*)$/, '')
      .replace(/\s*\d{8}\s*$/, '')
      .replace(/\s*[-–]\s*$/, '')
    if (t === before) break
  }
  return t.trim()
}

/**
 * 지점명에서 앞머리 행정구역(시/군/구)을 뽑는다.
 *
 * 주의: `\b` 를 쓰면 안 된다. JS의 `\b` 는 `[A-Za-z0-9_]` 기준이라
 * 한글 뒤에서는 경계가 성립하지 않아 전부 실패한다. `(?=\s|$)` 를 쓴다.
 */
export function extractRegion(place) {
  if (!place) return ''
  const s = place.trim()
  const m = /^([가-힣]{2,4}(?:특별자치시|특별자치도|광역시|특별시|시|군|구))(?=\s|$)/.exec(s)
  if (m) return m[1]
  // '순천 별량면 …' 처럼 시/군 접미사가 빠진 경우
  const m2 = /^([가-힣]{2,3})\s+[가-힣]{1,4}(?:면|읍|동|리)(?=\s|$)/.exec(s)
  return m2 ? m2[1] : ''
}

/** 남해바래길처럼 병기된 코스 별칭을 뽑는다. */
export function extractAlias(name) {
  const m = /\(\s*남해바래길\s*0*\d+\s*코스\s*([^)]+?)\s*\)/.exec(name)
  if (m) return m[1].trim()
  // '04코스 고사리밭길(남37)' / '07코스 화전별곡길(40)'
  const m2 = /^0*\d{1,2}코스\s+([가-힣]+길)/.exec(name)
  return m2 ? m2[1] : ''
}

/**
 * @returns {{start:string, end:string, region:string, alias:string, parsed:boolean}}
 */
export function parseTrackName(name, { isAlt = false } = {}) {
  const alias = extractAlias(name)
  const raw = (name ?? '').trim()

  // 임시노선의 이름은 구간 표기가 아니라 설명문이다. 지점 추출을 시도하지 않는다.
  if (isAlt) return { start: '', end: '', region: '', alias: '', parsed: false, note: raw }

  const body = stripTail(stripLead(raw))
  const parts = body.split('~')

  if (parts.length === 2) {
    const start = stripLead(stripTail(parts[0]))
    const end = stripLead(stripTail(parts[1]))
    if (start && end) {
      return { start, end, region: extractRegion(start), alias, parsed: true }
    }
  }

  return { start: '', end: '', region: '', alias, parsed: false }
}

/**
 * 코스가 연속이라는 성질로 빈 지점명을 메운다.
 * 앞 코스의 종점 = 다음 코스의 시점.
 *
 * 접합부 89곳이 모두 500m 이내로 검증됐으므로(data/raw/validate.json) 이 전제는 안전하다.
 * 연속된 공백 구간의 내부는 메울 수 없다 — 경계만 채워진다.
 *
 * @param {Array<{seq:number, isAlt:boolean, start:string, end:string, region:string}>} rows
 *        seq 오름차순, 본 코스만 (isAlt 제외)
 */
export function chainFill(rows) {
  const filled = { start: 0, end: 0, region: 0 }

  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1]
    const next = rows[i + 1]
    if (!rows[i].start && prev?.end) {
      rows[i].start = prev.end
      rows[i].startSource = 'chain'
      filled.start++
    }
    if (!rows[i].end && next?.start) {
      rows[i].end = next.start
      rows[i].endSource = 'chain'
      filled.end++
    }
  }

  // 지점명이 채워졌으면 지역도 다시 시도
  for (const r of rows) {
    if (!r.region) {
      const reg = extractRegion(r.start) || extractRegion(r.end)
      if (reg) {
        r.region = reg
        r.regionSource = 'chain'
        filled.region++
      }
    }
  }

  return filled
}

/**
 * 접합부 라벨을 통일한다.
 *
 * 같은 장소인데 코스마다 표기가 다른 경우가 7곳 있다. 예:
 *   `송정공원` vs `강서구 송정공원`                      (행정구역 접두어 누락)
 *   `장승포시외버스정류장` vs `장승포 시외버스터미널`      (정류장/터미널)
 *   `부용교 동쪽사거리` vs `부굥교 동쪽사거리`            (원본 오타)
 *
 * 좌표상 접합부 89곳이 모두 500m 이내로 검증됐으므로(data/raw/validate.json)
 * 이들은 확실히 같은 지점이다. 더 상세한(긴) 쪽으로 양쪽을 맞춘다.
 *
 * @returns {Array<{seq:number, from:string, to:string}>} 변경 내역
 */
export function normalizeJunctions(rows) {
  const changes = []
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]
    const b = rows[i + 1]
    if (!a.end || !b.start || a.end === b.start) continue

    const pick = a.end.length >= b.start.length ? a.end : b.start
    const other = pick === a.end ? b.start : a.end
    changes.push({ seq: a.seq, from: other, to: pick })
    a.end = pick
    b.start = pick
  }
  return changes
}

/**
 * 지역명을 통일한다. 같은 곳이 `순천시`/`순천` 두 표기로 나오는 문제.
 * 접미사가 빠진 이름은, 데이터셋 안에 `+시`/`+군` 형태가 있으면 그쪽으로 맞춘다.
 */
export function normalizeRegions(rows) {
  const known = new Set(rows.map((r) => r.region).filter(Boolean))
  const changes = []
  for (const r of rows) {
    if (!r.region || /(시|군|구|도)$/.test(r.region)) continue
    const cand = ['시', '군'].map((s) => r.region + s).find((x) => known.has(x))
    if (cand) {
      changes.push({ seq: r.seq, from: r.region, to: cand })
      r.region = cand
    }
  }
  return changes
}
