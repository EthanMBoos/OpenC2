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

  // ── 1. Initialize Interleaved MapLibre + Deck.gl ──
  React.useEffect(() => {
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
    
    // Disable native double-click zoom to prevent conflicts with drawing/menus
    map.doubleClickZoom.disable();
    mapRef.current = map;

    // Use MapboxOverlay to share the WebGL context. 
    // WHY: This eliminates Electron compositing bugs (the gray overlay) 
    // and guarantees perfect 3D depth sorting.
    const deckOverlay = new MapboxOverlay({
      interleaved: true,
      layers: []
    });
    
    map.addControl(deckOverlay);
    deckOverlayRef.current = deckOverlay;

    return () => {
      map.removeControl(deckOverlay);
      deckOverlay.finalize();
      map.remove();
    };
  }, []);

  // ── 2. Manage MapLibre Interactions & Cursor Lock ──
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const canvas = map.getCanvas();
    const isDrawingOrEditing = activeMode !== 'view';

    if (isDrawingOrEditing) {
      // WHY: MapLibre natively steals pan/drag events. We MUST disable it 
      // when drawing so @deck.gl-community/editable-layers can capture mouse drags.
      map.dragPan.disable();
      
      // WHY: MapLibre constantly resets the canvas cursor back to 'grab' on mousemove.
      // We use !important to strictly override the browser engine and force the crosshair.
      canvas.style.setProperty(
        'cursor', 
        activeMode === 'modify' ? 'grab' : 'crosshair', 
        'important'
      );
    } else {
      map.dragPan.enable();
      canvas.style.cursor = ''; 
    }
  }, [activeMode]);

  // ── 3. Handle Complex Events (Double Clicks & Keydowns) ──
  React.useEffect(() => {
    const container = mapContainerRef.current;
    const map = mapRef.current;
    if (!container || !map) return;

    const handleDblClick = (e) => {
      const mode = activeMode;
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // --- SCENARIO A: User is actively drawing a shape ---
      if (mode !== 'view' && mode !== 'modify') {
        e.preventDefault();
        e.stopPropagation();

        const overlay = deckOverlayRef.current;
        if (overlay && overlay._deck) {
          // WHY: MapboxOverlay intentionally swallows dblclicks. EditableGeoJsonLayer 
          // never knows the user tried to finish the line/polygon. We bypass the overlay 
          // and forcefully inject a synthetic dblclick directly into Deck.gl's private event bus.
          overlay._deck._onEvent({
            type: 'dblclick',
            offsetCenter: { x, y },
            srcEvent: e
          });

          // Bulletproof fallback for specific DrawLineStringMode bugs
          overlay._deck._onEvent({
            type: 'keyup',
            key: 'Enter',
            srcEvent: e
          });
        }
        return; // Prevent the menu from opening
      }
      
      // --- SCENARIO B: User is in View/Modify mode ---
      if (drawJustFinishedRef.current) {
        drawJustFinishedRef.current = false;
        return;
      }

      const overlay = deckOverlayRef.current;
      if (overlay) {
        // Check if user double-clicked an existing shape to modify it
        const picked = overlay.pickObject({ x, y });
        if (picked && picked.index != null && picked.index >= 0) {
          setSelectedFeatureIndexes([picked.index]);
          setActiveMode('modify');
          return;
        }
      }

      // User double-clicked empty space: Open the mission menu
      const lngLat = map.unproject([x, y]);
      e.preventDefault();
      e.stopPropagation();
      setMissionMenu({ visible: true, x: e.clientX, y: e.clientY, lngLat: [lngLat.lng, lngLat.lat] });
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

    // WHY: We bind to the native DOM element to ensure we catch the double-click 
    // before the MapLibre canvas or WebGL context has a chance to call stopPropagation()
    container.addEventListener('dblclick', handleDblClick);
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMode, selectedFeatureIndexes]);

  // ── 4. Render Deck.gl Layers ──
  React.useEffect(() => {
    const overlay = deckOverlayRef.current;
    const map = mapRef.current;
    if (!overlay || !map) return;

    const ModeClass = MODES[activeMode].mode;
    const tentativeColors = FEATURE_COLORS[activeMode] || FEATURE_COLORS._default;

    // WHY: Query terrain elevation at each coordinate so geometry follows terrain surface.
    // Without this, geometries render at sea level and appear to slide around.
    const getTerrainElevation = (coord) => {
      if (!terrainEnabled || !map.getTerrain()) return 0;
      try {
        const elev = map.queryTerrainElevation({ lng: coord[0], lat: coord[1] });
        return (elev || 0) + 10; // +10m offset to float above terrain
      } catch {
        return 10;
      }
    };

    // WHY: Transform 2D coordinates to 3D by adding terrain elevation as z-coordinate.
    // This makes geometry follow the terrain surface instead of rendering at sea level.
    const addElevationToCoords = (coords) => {
      if (!Array.isArray(coords)) return coords;
      if (typeof coords[0] === 'number') {
        // Single coordinate [lng, lat] or [lng, lat, z]
        return [coords[0], coords[1], getTerrainElevation(coords)];
      }
      // Nested array (rings, lines, etc.)
      return coords.map(c => addElevationToCoords(c));
    };

    const transformGeometry = (geom) => {
      if (!geom || !terrainEnabled) return geom;
      return {
        ...geom,
        coordinates: addElevationToCoords(geom.coordinates)
      };
    };

    // Transform geoJson to include z-coordinates when terrain is enabled
    const dataWithElevation = terrainEnabled ? {
      ...geoJson,
      features: geoJson.features.map(f => ({
        ...f,
        geometry: transformGeometry(f.geometry)
      }))
    } : geoJson;

    const editableLayer = new EditableGeoJsonLayer({
      id: 'editable-geojson',
      data: dataWithElevation,
      mode: ModeClass,
      selectedFeatureIndexes,

      // WHY: Disable depth testing so layers render on top of terrain
      parameters: terrainEnabled ? {
        depthWriteEnabled: false,
        depthCompare: 'always'
      } : {},

      onEdit: ({ updatedData, editType }) => {
        // WHY: Strip z-coordinates from edited data so we always store 2D coords.
        // Elevation is added dynamically during render based on current terrain.
        const stripElevation = (coords) => {
          if (!Array.isArray(coords)) return coords;
          if (typeof coords[0] === 'number') {
            return [coords[0], coords[1]]; // Keep only lng, lat
          }
          return coords.map(c => stripElevation(c));
        };
        
        const cleanData = {
          ...updatedData,
          features: updatedData.features.map(f => ({
            ...f,
            geometry: f.geometry ? {
              ...f.geometry,
              coordinates: stripElevation(f.geometry.coordinates)
            } : f.geometry
          }))
        };

        if (editType === 'addFeature') {
          const lastIdx = cleanData.features.length - 1;
          const finalData = {
            ...cleanData,
            features: cleanData.features.map((f, i) =>
              i === lastIdx
                ? { ...f, properties: { ...f.properties, featureType: activeMode } }
                : f
            )
          };
          drawJustFinishedRef.current = true;
          setGeoJson(finalData);
          setActiveMode('view');
          setSelectedFeatureIndexes([lastIdx]);
        } else {
          setGeoJson(cleanData);
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
      autoHighlight: false,

      // WHY: Propagate depth parameters to all sublayers (polygons, lines, points, edit handles)
      // EditableGeoJsonLayer is composite, so parameters must reach each sublayer.
      _subLayerProps: terrainEnabled ? {
        'polygons-fill': { parameters: { depthWriteEnabled: false, depthCompare: 'always' } },
        'polygons-stroke': { parameters: { depthWriteEnabled: false, depthCompare: 'always' } },
        'linestrings': { parameters: { depthWriteEnabled: false, depthCompare: 'always' } },
        'points-circle': { parameters: { depthWriteEnabled: false, depthCompare: 'always' } },
        'points-icon': { parameters: { depthWriteEnabled: false, depthCompare: 'always' } }
      } : {}
    });

    overlay.setProps({
      layers: [editableLayer],
      // WHY: Sync internal deck.gl cursor state with our active mode
      getCursor: () => (activeMode !== 'view' ? (activeMode === 'modify' ? 'grab' : 'crosshair') : 'auto')
    });
  }, [geoJson, activeMode, selectedFeatureIndexes, terrainEnabled]);

  // ── 5. Native MapLibre Terrain Helpers ──
  // WHY: We use MapLibre's native terrain instead of deck.gl's TerrainLayer 
  // because it's significantly faster and doesn't cause transparent compositing bugs.
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
    map.easeTo({ pitch: 0, bearing: 0, duration: 600 }); 
    
    if (map.getLayer('mapterhorn-hillshade')) map.removeLayer('mapterhorn-hillshade');
    if (map.getSource('mapterhorn-dem')) map.removeSource('mapterhorn-dem');
  }

  // ── Toggle terrain on/off ──
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    terrainEnabledRef.current = terrainEnabled;

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
    // The unified Map container (Only one canvas!)
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