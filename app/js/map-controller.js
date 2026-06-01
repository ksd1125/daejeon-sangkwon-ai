/**
 * map-controller.js — 인라인 미니맵 전용 (챗 버블 내 MapCard)
 * 대전 82개 행정동 GeoJSON 기반
 */
export class MapController {
  constructor() {
    this._geojsonCache = null;
  }

  /**
   * 채팅 카드 내부에 Leaflet 미니맵을 생성한다.
   * +/- 줌, 드래그 활성화. 줌 레벨에 따라 마커 크기 동적 조절.
   */
  async createMiniMap(container, opts = {}) {
    if (typeof L === 'undefined' || !container) return null;

    const uid = 'mini-' + Math.random().toString(36).slice(2, 8);
    container.id = uid;

    const mini = L.map(uid, {
      center: [36.35, 127.385],
      zoom: 12,
      zoomControl: true,
      dragging: true,
      scrollWheelZoom: false,
      doubleClickZoom: true,
      touchZoom: true,
      boxZoom: false,
      keyboard: false,
      tap: true,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
    }).addTo(mini);

    // GeoJSON 캐싱
    if (!this._geojsonCache) {
      this._geojsonCache = await fetch('./data/daejeon-districts.geojson').then(r => r.json());
    }
    const geojsonData = this._geojsonCache;

    const targetCodes = new Set([opts.districtCode, ...(opts.districtCodes || [])].filter(Boolean).map(String));
    const compareCodes = new Set([opts.compareCode, ...(opts.compareCodes || [])].filter(Boolean).map(String));
    const targetBounds = [];

    L.geoJSON(geojsonData, {
      style: (feature) => {
        const code = feature.properties.code;
        if (targetCodes.has(String(code))) {
          return {
            fillColor: '#0E7C66',
            fillOpacity: 0.28,
            color: '#005F4E',
            opacity: 1,
            weight: 4,
            lineJoin: 'round',
          };
        }
        if (compareCodes.has(String(code))) {
          return {
            fillColor: '#4F5FA8',
            fillOpacity: 0.32,
            color: '#34439B',
            opacity: 1,
            weight: 4,
            dashArray: '8 5',
            lineJoin: 'round',
          };
        }
        return { fill: false, stroke: false };
      },
      onEachFeature: (feature, layer) => {
        const code = feature.properties.code;
        if (targetCodes.has(String(code)) || compareCodes.has(String(code))) {
          targetBounds.push(layer.getBounds());
          layer.bringToFront();
          const name = feature.properties.name;
          const center = layer.getBounds().getCenter();
          const isCompare = compareCodes.has(String(code));
          L.marker(center, {
            icon: L.divIcon({
              className: 'minimap-label',
              html: `<span class="minimap-label-text ${isCompare ? 'minimap-label--compare' : 'minimap-label--target'}">${name}</span>`,
              iconSize: [96, 24],
              iconAnchor: [48, 12],
            }),
            interactive: false,
          }).addTo(mini);
        }
      },
    }).addTo(mini);

    // 점포 마커 — 줌 레벨 기반 동적 크기
    const catMarkers = [];
    const otherMarkers = [];

    if (opts.stores?.length) {
      const catColor = '#E04A3A'; // 선택 업종: 항상 빨간색
      const allColor = '#2D4540'; // overview(전체 업종): 브랜드 색상
      const filter = (opts.industry || '').toLowerCase();
      const isOverview = !filter; // 업종 지정 없으면 overview 모드

      for (const s of opts.stores) {
        const coords = s.coordinates;
        if (!coords || coords.length < 2) continue;
        const isCat = filter && (s.industry || '').toLowerCase().includes(filter);
        const showAsActive = isCat || isOverview; // overview면 전체 활성화
        const marker = L.circleMarker([coords[1], coords[0]], {
          radius: showAsActive ? (isOverview ? 3.5 : 5) : 1.5,
          weight: showAsActive ? (isOverview ? 0.8 : 1.5) : 0,
          color: showAsActive ? '#fff' : 'transparent',
          fillColor: showAsActive ? (isOverview ? allColor : catColor) : '#C5C0B5',
          fillOpacity: showAsActive ? (isOverview ? 0.7 : 0.9) : 0.12,
          interactive: showAsActive,
        }).addTo(mini);

        if (showAsActive) {
          catMarkers.push(marker);
          const name = s.name || '';
          const industry = s.industry || '';
          if (name || industry) {
            marker.bindTooltip(`${name}${industry ? ' · ' + industry : ''}`, {
              direction: 'top', offset: [0, -6],
              className: 'minimap-store-tooltip',
            });
          }
          const popupRows = [
            name ? `<tr><td class="sp-k">업소명</td><td>${name}</td></tr>` : '',
            industry ? `<tr><td class="sp-k">업종</td><td>${industry}</td></tr>` : '',
            s.address ? `<tr><td class="sp-k">위치</td><td>${s.address}</td></tr>` : '',
          ].filter(Boolean).join('');
          if (popupRows) {
            marker.bindPopup(`<table class="store-popup-table">${popupRows}</table>`, {
              className: 'minimap-store-popup', closeButton: false, maxWidth: 200,
            });
          }
        } else {
          otherMarkers.push(marker);
        }
      }
    }

    // 줌 변경 시 마커 크기 동적 조절 (겹침 해소)
    const isOverview = !(opts.industry || '').trim();
    const updateMarkerSizes = () => {
      const z = mini.getZoom();
      // overview: 점포가 많으므로 더 작은 크기, 업종 지정: 기존대로
      const catR = isOverview
        ? Math.max(2, Math.min(6, 1.5 + (z - 13) * 1))
        : Math.max(3, Math.min(10, 2 + (z - 13) * 1.5));
      const catW = isOverview ? (z >= 16 ? 1 : 0.8) : (z >= 16 ? 2 : 1.5);
      const otherR = z >= 16 ? 2.5 : z >= 14 ? 1.5 : 1;
      const otherOp = z >= 16 ? 0.2 : 0.1;

      for (const m of catMarkers) {
        m.setRadius(catR);
        m.setStyle({ weight: catW });
      }
      for (const m of otherMarkers) {
        m.setRadius(otherR);
        m.setStyle({ fillOpacity: otherOp });
      }
    };

    mini.on('zoomend', updateMarkerSizes);

    // 초기 뷰
    if (targetBounds.length) {
      let merged = targetBounds[0];
      for (let i = 1; i < targetBounds.length; i++) merged.extend(targetBounds[i]);
      // 분석 동이 화면을 채우도록 타이트하게 (여백 최소화). maxZoom 캡을 높여 작은 동도 확대
      mini.fitBounds(merged, { padding: [10, 10], maxZoom: 17 });
    }

    // 초기 마커 사이즈 설정
    updateMarkerSizes();

    container._leafletMap = mini;
    return mini;
  }
}

export default MapController;
