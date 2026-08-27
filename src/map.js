import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

/** 난이도별 색. 밝은/어두운 타일과 위성 영상 위에서 모두 구분되는 값으로 골랐다. */
export const DIFFICULTY_COLOR = {
  쉬움: '#1f9d5c',
  보통: '#d98026',
  어려움: '#cf4436',
}

const ALT_COLOR = '#8b8f98'

const GPX_ATTR =
  'GPX <a href="https://cafe.daum.net/mtsingles/LN1X/1631" target="_blank" rel="noopener">도보여행(섬&산) 좋은사람들</a>'

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
      {
        maxZoom: 19,
        attribution: `Esri, Maxar, Earthstar Geographics · ${GPX_ATTR}`,
      },
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

  /** @type {Map<string, {casing: L.Polyline, line: L.Polyline, marker: L.CircleMarker, course: object}>} */
  const rendered = new Map()

  for (const c of courses) {
    if (!c.overview?.length) continue

    const color = c.isAlt ? ALT_COLOR : (DIFFICULTY_COLOR[c.difficulty] ?? ALT_COLOR)

    const casing = L.polyline(c.overview, {
      color: '#ffffff',
      weight: 6,
      opacity: 0.75,
      interactive: false,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(casingGroup)

    const line = L.polyline(c.overview, {
      color,
      weight: 3,
      opacity: 0.95,
      dashArray: c.isAlt ? '6 6' : null,
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

    const label = tooltipHtml(c)
    line.bindTooltip(label, { sticky: true })
    marker.bindTooltip(label)

    const select = () => onSelect?.(c)
    line.on('click', select)
    marker.on('click', select)

    // 선이 얇아서 hover 판정이 어렵다. 굵게 잡아준다.
    line.on('mouseover', () => line.setStyle({ weight: 6 }))
    line.on('mouseout', () => line.setStyle({ weight: 3 }))

    rendered.set(c.id, { casing, line, marker, course: c })
  }

  // 시작점 마커 90개를 전국 줌에서 원래 크기로 두면 코스 선을 덮어버려
  // 경로가 점선처럼 보인다. 줌에 따라 크기를 줄인다.
  function syncMarkerSize() {
    const z = map.getZoom()
    const style =
      z < 9 ? { radius: 2, weight: 0 } : z < 12 ? { radius: 3.5, weight: 1 } : { radius: 5, weight: 1.5 }
    for (const { marker } of rendered.values()) marker.setStyle(style).setRadius(style.radius)
  }
  map.on('zoomend', syncMarkerSize)

  return {
    syncMarkerSize,
    map,
    layers,
    rendered,
    markerGroup,

    /**
     * 전체 코스가 보이도록 맞춘다.
     *
     * 오버레이(요약·범례) 뒤로 경로가 숨지 않게 그만큼 여백을 준다.
     * 오버레이 위치가 화면 크기에 따라 바뀌므로(넓으면 좌상단, 좁으면 하단)
     * 실제 여백은 `getInsets`가 알려준다. 고정값을 쓰면 좁은 화면에서
     * 지도가 과하게 축소된다.
     */
    fitAll(options) {
      const bounds = L.latLngBounds([])
      for (const { line } of rendered.values()) bounds.extend(line.getBounds())
      if (!bounds.isValid()) return

      const ins = getInsets?.() ?? {}
      map.fitBounds(bounds, {
        paddingTopLeft: [ins.left ?? 24, ins.top ?? 20],
        paddingBottomRight: [ins.right ?? 24, ins.bottom ?? 40],
        ...options,
      })
      syncMarkerSize()
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
  return String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
}

function tooltipHtml(c) {
  const route = c.start && c.end ? `${esc(c.start)} → ${esc(c.end)}` : '지점명 정보 없음'
  const bits = [
    `${c.distanceKm} km`,
    `↑ ${c.ascentM.toLocaleString()} m`,
    formatDuration(c.durationMin),
  ]
  return (
    `<div class="tip"><b>${esc(c.name)}</b>` +
    (c.region ? ` <span class="tip-region">${esc(c.region)}</span>` : '') +
    (c.alias ? `<div class="tip-alias">${esc(c.alias)}</div>` : '') +
    `<div class="tip-route">${route}</div>` +
    `<div class="tip-stats">${bits.join(' · ')}</div>` +
    (c.isAlt ? '<div class="tip-note">임시/우회 노선</div>' : '') +
    '</div>'
  )
}

export function formatDuration(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`
}
