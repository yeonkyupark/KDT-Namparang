import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

/** 난이도별 색. 밝은/어두운 타일과 위성 영상 위에서 모두 구분되는 값으로 골랐다. */
export const DIFFICULTY_COLOR = {
  쉬움: '#1f9d5c',
  보통: '#d98026',
  어려움: '#cf4436',
}

const ALT_COLOR = '#8b8f98'

/**
 * 선택된 코스 / 선택 밖 코스의 선 두께·투명도.
 *
 * OFF를 너무 낮추면(0.28 이하) 밝은 OSM 타일에서 나머지 구간이 사실상 사라져
 * 전체 경로 안에서 지금 구간이 어디인지 감이 안 온다. 맥락은 남긴다.
 */
const ON = { weight: 4, opacity: 1, casing: 8, casingOpacity: 0.8 }
const OFF = { weight: 2, opacity: 0.45, casing: 5, casingOpacity: 0.3 }

const GPX_ATTR =
  'GPX <a href="https://cafe.daum.net/mtsingles/LN1X/1631" target="_blank" rel="noopener">도보여행(섬&산) 좋은사람들</a>'

export const TILE_NAMES = ['기본', '지형', '위성']

function tileLayers() {
  return {
    기본: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: `&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · ${GPX_ATTR}`,
    }),
    지형: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      subdomains: 'abc',
      attribution: `&copy; <a href="https://opentopomap.org/" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA) · ${GPX_ATTR}`,
    }),
    위성: L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: `Esri, Maxar, Earthstar Geographics · ${GPX_ATTR}` },
    ),
  }
}

/**
 * 지도를 만들고 92개 코스를 그린다.
 *
 * 코스 하나를 폴리라인 2개로 그린다 — 아래에 굵은 흰 테두리(casing), 위에 난이도 색.
 * 위성 영상이나 지형도 위에서 선이 배경에 묻히는 것을 막는다.
 */
export function createMap(el, courses, { onSelect, getInsets } = {}) {
  const layers = tileLayers()

  const map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    layers: [layers.기본],
  })

  L.control.zoom({ position: 'topright' }).addTo(map)
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map)

  const casingGroup = L.layerGroup().addTo(map)
  const lineGroup = L.layerGroup().addTo(map)
  const markerGroup = L.layerGroup().addTo(map)

  /** @type {Map<string, object>} id -> {casing, line, marker, course, on, detail} */
  const rendered = new Map()

  /** 고도 프로필 hover 위치를 표시하는 마커. 필요할 때 만든다. */
  let cursor = null

  for (const c of courses) {
    if (!c.overview?.length) continue

    const color = c.isAlt ? ALT_COLOR : (DIFFICULTY_COLOR[c.difficulty] ?? ALT_COLOR)

    const casing = L.polyline(c.overview, {
      color: '#ffffff',
      weight: ON.casing,
      opacity: ON.casingOpacity,
      interactive: false,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(casingGroup)

    const line = L.polyline(c.overview, {
      color,
      weight: ON.weight,
      opacity: ON.opacity,
      dashArray: c.isAlt ? '7 6' : null,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(lineGroup)

    const marker = L.circleMarker(c.startLatLng, {
      radius: 4,
      color: '#ffffff',
      weight: 1.5,
      fillColor: color,
      fillOpacity: 1,
    }).addTo(markerGroup)

    const rec = { casing, line, marker, course: c, on: true, detail: null }

    const label = tooltipHtml(c)
    line.bindTooltip(label, { sticky: true })
    marker.bindTooltip(label)

    const select = () => onSelect?.(c)
    line.on('click', select)
    marker.on('click', select)

    // 선이 얇아서 hover 판정이 어렵다. 굵게 잡아준다.
    // 선택 상태에 따라 기준 두께가 달라지므로 rec.on 을 보고 되돌린다.
    line.on('mouseover', () => line.setStyle({ weight: (rec.on ? ON : OFF).weight + 3 }))
    line.on('mouseout', () => line.setStyle({ weight: (rec.on ? ON : OFF).weight }))

    rendered.set(c.id, rec)
  }

  // 시작점 마커 90개를 전국 줌에서 원래 크기로 두면 코스 선을 덮어버려
  // 경로가 점선처럼 보인다. 줌에 따라 크기를 줄인다.
  function syncMarkerSize() {
    const z = map.getZoom()
    const base =
      z < 9 ? { radius: 2, weight: 0 } : z < 12 ? { radius: 3.5, weight: 1 } : { radius: 5, weight: 1.5 }
    for (const rec of rendered.values()) {
      const dim = rec.on ? 1 : 0.3
      rec.marker
        .setStyle({ ...base, color: '#ffffff', opacity: base.weight ? dim : 0, fillOpacity: dim })
        .setRadius(base.radius)
    }
  }
  map.on('zoomend', syncMarkerSize)

  function boundsOf(ids) {
    const b = L.latLngBounds([])
    for (const [id, rec] of rendered) {
      if (ids && !ids.has(id)) continue
      b.extend(rec.line.getBounds())
    }
    return b
  }

  function fitBounds(b, options) {
    if (!b.isValid()) return
    const ins = getInsets?.() ?? {}
    map.fitBounds(b, {
      paddingTopLeft: [ins.left ?? 24, ins.top ?? 20],
      paddingBottomRight: [ins.right ?? 24, ins.bottom ?? 40],
      ...options,
    })
    syncMarkerSize()
  }

  return {
    map,
    layers,
    rendered,
    syncMarkerSize,

    /** 전체 코스가 보이도록 맞춘다. */
    fitAll(options) {
      fitBounds(boundsOf(null), options)
    },

    /** 주어진 코스들만 보이도록 맞춘다. */
    fitIds(ids, options) {
      fitBounds(boundsOf(ids), options)
    },

    /**
     * 선택 구간을 강조하고 나머지를 흐리게 한다.
     * `ids`가 null이면 전부 강조(= 흐린 코스 없음).
     */
    setSelection(ids) {
      for (const [id, rec] of rendered) {
        const on = !ids || ids.has(id)
        rec.on = on
        const s = on ? ON : OFF
        rec.line.setStyle({ weight: s.weight, opacity: s.opacity })
        rec.casing.setStyle({ weight: s.casing, opacity: s.casingOpacity })
        // 강조된 선이 흐린 선 위에 오게 한다
        if (on) rec.line.bringToFront()
      }
      syncMarkerSize()
    },

    /** 오버뷰 라인을 고해상도 상세 라인으로 교체한다. 한 번 바꾸면 되돌리지 않는다. */
    upgradeToDetail(id, latlngs) {
      const rec = rendered.get(id)
      if (!rec || rec.detail || !latlngs?.length) return
      rec.detail = latlngs
      rec.line.setLatLngs(latlngs)
      rec.casing.setLatLngs(latlngs)
    },

    /** 코스 하나를 화면에 담는다. */
    focus(id, options) {
      const rec = rendered.get(id)
      if (rec) fitBounds(rec.line.getBounds(), options)
    },

    /** 목록에서 hover 했을 때 지도에서 해당 코스를 두드러지게 한다. */
    accent(id, on) {
      const rec = rendered.get(id)
      if (!rec) return
      const base = (rec.on ? ON : OFF).weight
      rec.line.setStyle({ weight: on ? base + 3 : base })
      if (on) rec.line.bringToFront()
    },

    /**
     * 고도 프로필에서 가리키는 지점을 지도에 표시한다.
     * `latlng`가 null이면 지운다.
     */
    setCursor(latlng) {
      if (!latlng) {
        cursor?.remove()
        cursor = null
        return
      }
      if (!cursor) {
        cursor = L.circleMarker(latlng, {
          radius: 6,
          color: '#ffffff',
          weight: 2.5,
          fillColor: '#111418',
          fillOpacity: 1,
          interactive: false,
        }).addTo(map)
        cursor.bringToFront()
      } else {
        cursor.setLatLng(latlng)
      }
    },

    setTile(name) {
      for (const [key, layer] of Object.entries(layers)) {
        if (key === name) layer.addTo(map)
        else map.removeLayer(layer)
      }
    },
  }
}

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  )
}

function tooltipHtml(c) {
  const route = c.start && c.end ? `${esc(c.start)} → ${esc(c.end)}` : '지점명 정보 없음'
  const bits = [`${c.distanceKm} km`, `↑ ${c.ascentM.toLocaleString()} m`, formatDuration(c.durationMin)]
  return (
    `<div class="tip"><b>${esc(c.name)}</b>` +
    (c.region ? ` <span class="tip-region">${esc(c.region)}</span>` : '') +
    (c.alias ? `<div class="tip-alias">${esc(c.alias)}</div>` : '') +
    `<div class="tip-route">${route}</div>` +
    `<div class="tip-stats">${bits.join(' · ')}</div>` +
    (c.isAlt ? '<div class="tip-note">임시/우회 노선 · 합계 제외</div>' : '') +
    '</div>'
  )
}

export function formatDuration(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`
}
