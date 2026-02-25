// ── deck.gl v9 + maplibre interleaved renderer ──
import React from 'react';
import ReactDOM from 'react-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapboxOverlay } from '@deck.gl/mapbox';
import {
  EditableGeoJsonLayer,
  DrawPolygonMode,
  DrawPointMode,
  DrawLineStringMode,
  ViewMode,
  ModifyMode
} from '@deck.gl-community/editable-layers';

// ── Drawing mode definitions ──
const MODES = {
  view:       { label: '\u{1F446} Select',       mode: ViewMode },
  modify:     { label: '\u270F\uFE0F Modify',       mode: ModifyMode },
  nfz:        { label: '\u26D4 NFZ',             mode: DrawPolygonMode },
  searchZone: { label: '\u{1F50D} Search Zone',   mode: DrawPolygonMode },
  route:      { label: '\u2192 Route',            mode: DrawLineStringMode },
  searchPoint:{ label: '\u{1F4CD} Search Point',  mode: DrawPointMode },
  geofence:   { label: '\u{1F6A7} Geofence',       mode: DrawPolygonMode }
};

// ── Per-feature-type color palette ──
const FEATURE_COLORS = {
  nfz:         { fill: [220, 53, 69, 90],   line: [220, 53, 69, 220]  },
  searchZone:  { fill: [59, 130, 246, 80],  line: [59, 130, 246, 220] },
  route:       { fill: [156, 163, 175, 80], line: [156, 163, 175, 220]},
  searchPoint: { fill: [59, 130, 246, 200], line: [59, 130, 246, 255] },
  geofence:    { fill: [0, 0, 0, 0],        line: [255, 165, 0, 240]  },
  _default:    { fill: [78, 204, 163, 100], line: [78, 204, 163, 220] }
};

// ── Map styles ──
const STREET_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const SATELLITE_STYLE = {
  version: 8,
  sources: {
    'esri-satellite': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19
    }
  },
  layers: [{
    id: 'esri-satellite-layer',
    type: 'raster',
    source: 'esri-satellite',
    minzoom: 0,
    maxzoom: 22
  }]
};

// Initial view
const INITIAL_VIEW = {
  longitude: -84.388,
  latitude: 33.749,
  zoom: 9.5,
  pitch: 0,
  bearing: 0
};

function MapComponent() {
  const mapContainerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const deckOverlayRef = React.useRef(null);
  const terrainEnabledRef = React.useRef(false);
  const drawJustFinishedRef = React.useRef(false);
  const pendingClickRef = React.useRef(null);
  const satelliteInitRef = React.useRef(true);

  const [terrainEnabled, setTerrainEnabled] = React.useState(false);
  const [satelliteEnabled, setSatelliteEnabled] = React.useState(false);
  const [activeMode, setActiveMode] = React.useState('view');
  const [geoJson, setGeoJson] = React.useState({
    type: 'FeatureCollection',
    features: []
  });
  const [selectedFeatureIndexes, setSelectedFeatureIndexes] = React.useState([]);
  const [missionMenu, setMissionMenu] = React.useState({ visible: false, x: 0, y: 0, lngLat: null });

  // ── Initialize MapLibre + DeckGL MapboxOverlay ──
  React.useEffect(() => {
    // 1. MapLibre natively drives all navigation
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: STREET_STYLE,
      center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
      zoom: INITIAL_VIEW.zoom,
      pitch: INITIAL_VIEW.pitch,
      bearing: INITIAL_VIEW.bearing,
      maxPitch: 85,
      interactive: true,
      attributionControl: true
    });
    
    // Disable native double-click zoom so it doesn't conflict with drawing/menus
    map.doubleClickZoom.disable();
    mapRef.current = map;

    // 2. Instantiate the interleaved DeckGL overlay
    const deckOverlay = new MapboxOverlay({
      interleaved: true,
      layers: []
    });
    
    // 3. Inject DeckGL directly into MapLibre's WebGL context
    map.addControl(deckOverlay);
    deckOverlayRef.current = deckOverlay;

    return () => {
      map.removeControl(deckOverlay);
      deckOverlay.finalize();
      map.remove();
    };
  }, []);

  // ── Double-click mission editor menu on the map (only in view/modify mode) ──
  React.useEffect(() => {
    const container = mapContainerRef.current;
    const map = mapRef.current;
    if (!container || !map) return;

    const handleDblClick = (e) => {
      const mode = activeMode;
      if (mode !== 'view' && mode !== 'modify') return;
      
      if (drawJustFinishedRef.current) {
        drawJustFinishedRef.current = false;
        return;
      }

      // Calculate relative x/y coordinates from the DOM node
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const overlay = deckOverlayRef.current;
      if (overlay) {
        // Pick object using the overlay directly
        const picked = overlay.pickObject({ x, y });
        if (picked && picked.index != null && picked.index >= 0) {
          setSelectedFeatureIndexes([picked.index]);
          setActiveMode('modify');
          return;
        }
      }

      // Unproject pixel coordinates back to Lng/Lat for the new feature
      const lngLat = map.unproject([x, y]);

      e.preventDefault();
      e.stopPropagation();
      
      setMissionMenu({ 
        visible: true, 
        x: e.clientX, 
        y: e.clientY, 
        lngLat: [lngLat.lng, lngLat.lat] 
      });
    };

    const handleClick = () => {
      setMissionMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setMissionMenu((prev) => ({ ...prev, visible: false }));
        setActiveMode((prev) => (prev !== 'view' ? 'view' : prev));
        setSelectedFeatureIndexes([]);
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedFeatureIndexes.length > 0) {
        e.preventDefault();
        setGeoJson((prev) => ({
          ...prev,
          features: prev.features.filter((_, i) => !selectedFeatureIndexes.includes(i))
        }));
        setSelectedFeatureIndexes([]);
        setActiveMode('view');
      }
    };

    // Bind double-click directly to the native DOM element to avoid canvas event swallowing
    container.addEventListener('dblclick', handleDblClick);
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMode, selectedFeatureIndexes]);

  // ── Update deck.gl layers whenever drawing state changes ──
  React.useEffect(() => {
    const overlay = deckOverlayRef.current;
    const map = mapRef.current;
    if (!overlay || !map) return;

    const ModeClass = MODES[activeMode].mode;
    const isDrawing = activeMode !== 'view';
    const tentativeColors = FEATURE_COLORS[activeMode] || FEATURE_COLORS._default;

    const editableLayer = new EditableGeoJsonLayer({
      id: 'editable-geojson',
      data: geoJson,
      mode: ModeClass,
      selectedFeatureIndexes,

      onEdit: ({ updatedData, editType }) => {
        if (editType === 'addFeature') {
          const lastIdx = updatedData.features.length - 1;
          updatedData = {
            ...updatedData,
            features: updatedData.features.map((f, i) =>
              i === lastIdx
                ? { ...f, properties: { ...f.properties, featureType: activeMode } }
                : f
            )
          };
          drawJustFinishedRef.current = true;
          setGeoJson(updatedData);
          setActiveMode('view');
          setSelectedFeatureIndexes([lastIdx]);
        } else {
          setGeoJson(updatedData);
        }
      },

      getFillColor: (f) => (FEATURE_COLORS[f?.properties?.featureType] || FEATURE_COLORS._default).fill,
      getLineColor: (f) => (FEATURE_COLORS[f?.properties?.featureType] || FEATURE_COLORS._default).line,
      getLineWidth: 2,
      getPointRadius: 6,
      pointRadiusMinPixels: 4,
      lineWidthMinPixels: 2,

      getTentativeFillColor: tentativeColors.fill,
      getTentativeLineColor: tentativeColors.line,
      getTentativeLineWidth: 2,

      getEditHandlePointColor: [255, 255, 255, 255],
      getEditHandlePointRadius: 5,
      editHandlePointRadiusMinPixels: 4,

      pickable: true,
      autoHighlight: false
    });

    // Pass layers directly to the overlay
    overlay.setProps({
      layers: [editableLayer]
    });

    // Manage cursor directly on the map canvas
    map.getCanvas().style.cursor = isDrawing ? 'crosshair' : (activeMode === 'modify' ? 'grab' : '');

    // Simulate pending click for starting a drawing right at the double-click point
    if (pendingClickRef.current && activeMode !== 'view' && activeMode !== 'modify') {
      const pending = pendingClickRef.current;
      pendingClickRef.current = null;
      setTimeout(() => {
        const canvas = map.getCanvas();
        if (!canvas) return;
        const opts = {
          clientX: pending.screenX,
          clientY: pending.screenY,
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: 1
        };
        canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
        canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
      }, 80);
    }
  }, [geoJson, activeMode, selectedFeatureIndexes]);

  // ── Terrain helpers ──
  function applyTerrain(map) {
    if (!map.getSource('mapterhorn-dem')) {
      map.addSource('mapterhorn-dem', {
        type: 'raster-dem',
        tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
        encoding: 'terrarium',
        tileSize: 512
      });
    }
    if (!map.getLayer('mapterhorn-hillshade')) {
      map.addLayer({
        id: 'mapterhorn-hillshade',
        type: 'hillshade',
        source: 'mapterhorn-dem',
        paint: {
          'hillshade-exaggeration': 0.5,
          'hillshade-shadow-color': '#000000',
          'hillshade-highlight-color': '#ffffff'
        }
      });
    }
    map.setTerrain({ source: 'mapterhorn-dem', exaggeration: 1.5 });
  }

  function removeTerrain(map) {
    map.setTerrain(null);
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 }); // Smooth fly back to 2D
    
    if (map.getLayer('mapterhorn-hillshade')) {
      map.removeLayer('mapterhorn-hillshade');
    }
    if (map.getSource('mapterhorn-dem')) {
      map.removeSource('mapterhorn-dem');
    }
  }

  // ── Toggle terrain on/off ──
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    terrainEnabledRef.current = terrainEnabled;

    // Toggle maplibre's native rotation controls
    if (terrainEnabled) {
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
    } else {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
    }

    if (map.isStyleLoaded()) {
      if (terrainEnabled) applyTerrain(map);
      else removeTerrain(map);
    } else {
      map.once('style.load', () => {
        if (terrainEnabled) applyTerrain(map);
        else removeTerrain(map);
      });
    }
  }, [terrainEnabled]);

  // ── Toggle satellite / street view ──
  React.useEffect(() => {
    if (satelliteInitRef.current) {
      satelliteInitRef.current = false;
      return;
    }
    const map = mapRef.current;
    if (!map) return;

    const style = satelliteEnabled ? SATELLITE_STYLE : STREET_STYLE;
    map.setStyle(style);

    map.once('style.load', () => {
      if (terrainEnabledRef.current) applyTerrain(map);
    });
  }, [satelliteEnabled]);

  // ── Styles ──
  const btnBaseStyle = {
    position: 'absolute',
    right: '10px',
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: '#fff',
    borderRadius: '6px',
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: '13px',
    fontFamily: 'sans-serif',
    fontWeight: 500,
    backdropFilter: 'blur(4px)',
    transition: 'background 0.2s, border 0.2s'
  };

  return React.createElement('div', {
    style: { position: 'relative', width: '100%', height: '600px', marginTop: '1rem' }
  },
    // The unified Map container
    React.createElement('div', {
      id: 'map',
      ref: mapContainerRef,
      style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }
    }),
    
    // Mission editor menu
    missionMenu.visible && React.createElement('div', {
      style: {
        position: 'fixed',
        top: missionMenu.y,
        left: missionMenu.x,
        zIndex: 10,
        background: 'rgba(26, 26, 46, 0.95)',
        border: '1px solid rgba(255,255,255,0.2)',
        borderRadius: '8px',
        padding: '4px 0',
        minWidth: '160px',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(8px)',
        fontFamily: 'sans-serif',
        fontSize: '13px'
      },
      onClick: (e) => e.stopPropagation()
    },
      React.createElement('div', {
        style: { padding: '6px 12px', color: 'rgba(255,255,255,0.5)', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }
      }, 'Mission Objects'),
      ['nfz', 'searchZone', 'geofence', 'route', 'searchPoint'].map((key) =>
        React.createElement('div', {
          key,
          style: {
            padding: '8px 14px',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            transition: 'background 0.15s'
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(78, 204, 163, 0.3)'; },
          onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
          onClick: () => {
            const clickLngLat = missionMenu.lngLat;
            const clickScreenX = missionMenu.x;
            const clickScreenY = missionMenu.y;
            setMissionMenu({ visible: false, x: 0, y: 0, lngLat: null });

            if (key === 'searchPoint' && clickLngLat) {
              const newFeature = {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: clickLngLat },
                properties: { featureType: 'searchPoint' }
              };
              setGeoJson(prev => ({
                ...prev,
                features: [...prev.features, newFeature]
              }));
              setSelectedFeatureIndexes([geoJson.features.length]);
              setActiveMode('view');
            } else {
              if (clickLngLat) {
                pendingClickRef.current = { screenX: clickScreenX, screenY: clickScreenY };
              }
              setActiveMode(key);
              setSelectedFeatureIndexes([]);
            }
          }
        }, MODES[key].label)
      )
    ),
    // Terrain toggle
    React.createElement('button', {
      style: { ...btnBaseStyle, top: '10px', 
        background: terrainEnabled ? 'rgba(78, 204, 163, 0.9)' : 'rgba(26, 26, 46, 0.85)',
        border: terrainEnabled ? '1px solid #4ecca3' : '1px solid rgba(255,255,255,0.25)'
      },
      onClick: function () { setTerrainEnabled(!terrainEnabled); },
      title: terrainEnabled ? 'Disable 3D Terrain' : 'Enable 3D Terrain'
    }, terrainEnabled ? '\uD83C\uDF0D 3D' : '\uD83D\uDDFA\uFE0F 2D'),
    // Satellite toggle
    React.createElement('button', {
      style: { ...btnBaseStyle, top: '50px',
        background: satelliteEnabled ? 'rgba(59, 130, 246, 0.9)' : 'rgba(26, 26, 46, 0.85)',
        border: satelliteEnabled ? '1px solid #3b82f6' : '1px solid rgba(255,255,255,0.25)'
      },
      onClick: function () { setSatelliteEnabled(!satelliteEnabled); },
      title: satelliteEnabled ? 'Switch to Street Map' : 'Switch to Satellite'
    }, satelliteEnabled ? '\uD83D\uDEF0\uFE0F Street' : '\uD83D\uDEF0\uFE0F Satellite')
  );
}

function App() {
  return React.createElement('div', { style: { padding: '2rem', fontFamily: 'sans-serif' } },
    React.createElement('h1', null, 'OpenC2'),
    React.createElement('p', null, 'Initial window - map will be inserted here'),
    React.createElement(MapComponent)
  );
}

export default App;

ReactDOM.render(
  React.createElement(App),
  document.getElementById('root')
);