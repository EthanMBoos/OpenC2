// ── deck.gl v9 + editable-layers integrated renderer ──
import React from 'react';
import ReactDOM from 'react-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { Deck } from '@deck.gl/core';
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
  searchPoint:{ label: '\u{1F4CD} Search Point',  mode: DrawPointMode }
};

// ── Per-feature-type color palette ──
const FEATURE_COLORS = {
  nfz:         { fill: [220, 53, 69, 90],   line: [220, 53, 69, 220]  },  // red
  searchZone:  { fill: [59, 130, 246, 80],  line: [59, 130, 246, 220] },  // blue
  route:       { fill: [156, 163, 175, 80], line: [156, 163, 175, 220]},  // gray
  searchPoint: { fill: [59, 130, 246, 200], line: [59, 130, 246, 255] },  // blue
  _default:    { fill: [78, 204, 163, 100], line: [78, 204, 163, 220] }   // fallback teal
};

// Initial view
const INITIAL_VIEW = {
  longitude: 13.388,
  latitude: 52.517,
  zoom: 9.5,
  pitch: 0,
  bearing: 0
};

function MapComponent() {
  const mapContainerRef = React.useRef(null);
  const deckContainerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const deckRef = React.useRef(null);
  const terrainEnabledRef = React.useRef(false);
  const viewStateRef = React.useRef(INITIAL_VIEW);
  const drawJustFinishedRef = React.useRef(false);

  const [terrainEnabled, setTerrainEnabled] = React.useState(false);
  const [activeMode, setActiveMode] = React.useState('view');
  const [geoJson, setGeoJson] = React.useState({
    type: 'FeatureCollection',
    features: []
  });
  const [selectedFeatureIndexes, setSelectedFeatureIndexes] = React.useState([]);
  const [contextMenu, setContextMenu] = React.useState({ visible: false, x: 0, y: 0 });

  // ── Initialize map (tiles only) + standalone Deck (interaction + drawing) ──
  React.useEffect(() => {
    // MapLibre renders tiles but does NOT handle user interaction
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [INITIAL_VIEW.longitude, INITIAL_VIEW.latitude],
      zoom: INITIAL_VIEW.zoom,
      pitch: 0,
      bearing: 0,
      maxPitch: 85,             // high ceiling – deck.gl controller enforces the real limit
      interactive: false,       // deck.gl drives all navigation
      attributionControl: true
    });
    mapRef.current = map;

    // Standalone Deck instance on top of the map – receives ALL pointer events
    const deck = new Deck({
      parent: deckContainerRef.current,
      viewState: INITIAL_VIEW,
      controller: {
        doubleClickZoom: false,     // avoid conflict with double-click to finish polygon
        dragRotate: false,          // we enable this dynamically when terrain is on
        touchRotate: false
      },
      layers: [],
      onViewStateChange: ({ viewState }) => {
        viewStateRef.current = viewState;
        deck.setProps({ viewState });
        // Sync MapLibre to match deck.gl's view
        map.jumpTo({
          center: [viewState.longitude, viewState.latitude],
          zoom: viewState.zoom,
          bearing: viewState.bearing,
          pitch: viewState.pitch
        });
      },
      getCursor: ({ isDragging }) => isDragging ? 'grabbing' : 'grab',
      style: { position: 'absolute', top: 0, left: 0, zIndex: 1 },
      useDevicePixels: true
    });
    deckRef.current = deck;

    return () => {
      deck.finalize();
      map.remove();
    };
  }, []);

  // ── Double-click context menu on the map (only in view/modify mode) ──
  React.useEffect(() => {
    const container = deckContainerRef.current;
    if (!container) return;

    const handleDblClick = (e) => {
      // Only show menu when not actively drawing (avoid conflict with finish-drawing double-click)
      const mode = activeMode;
      if (mode !== 'view' && mode !== 'modify') return;
      // Suppress menu if a drawing just finished on this same double-click
      if (drawJustFinishedRef.current) {
        drawJustFinishedRef.current = false;
        return;
      }

      // Check if a feature was double-clicked – if so, enter edit mode on it
      const deck = deckRef.current;
      if (deck) {
        const rect = deckContainerRef.current.getBoundingClientRect();
        const picked = deck.pickObject({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        if (picked && picked.index != null && picked.index >= 0) {
          setSelectedFeatureIndexes([picked.index]);
          setActiveMode('modify');
          return;
        }
      }

      e.preventDefault();
      e.stopPropagation();
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY });
    };

    const handleClick = () => {
      setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setContextMenu((prev) => ({ ...prev, visible: false }));
        // Exit any drawing/modify mode back to view
        setActiveMode((prev) => (prev !== 'view' ? 'view' : prev));
        setSelectedFeatureIndexes([]);
      }
    };

    container.addEventListener('dblclick', handleDblClick);
    window.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      window.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeMode]);

  // ── Update deck.gl layers whenever drawing state changes ──
  React.useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;

    const ModeClass = MODES[activeMode].mode;
    const isDrawing = activeMode !== 'view';

    // Resolve tentative colors from the active drawing mode
    const tentativeColors = FEATURE_COLORS[activeMode] || FEATURE_COLORS._default;

    const editableLayer = new EditableGeoJsonLayer({
      id: 'editable-geojson',
      data: geoJson,
      mode: ModeClass,
      selectedFeatureIndexes,

      onEdit: ({ updatedData, editType }) => {
        // Tag newly added features with the current drawing type
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

      // Per-feature-type styling
      getFillColor: (f) => {
        const c = FEATURE_COLORS[f?.properties?.featureType] || FEATURE_COLORS._default;
        return c.fill;
      },
      getLineColor: (f) => {
        const c = FEATURE_COLORS[f?.properties?.featureType] || FEATURE_COLORS._default;
        return c.line;
      },
      getLineWidth: 2,
      getPointRadius: 6,
      pointRadiusMinPixels: 4,
      lineWidthMinPixels: 2,

      // Tentative (in-progress drawing) styling – matches the active mode color
      getTentativeFillColor: tentativeColors.fill,
      getTentativeLineColor: tentativeColors.line,
      getTentativeLineWidth: 2,

      // Edit handle styling
      getEditHandlePointColor: [255, 255, 255, 255],
      getEditHandlePointRadius: 5,
      editHandlePointRadiusMinPixels: 4,

      pickable: true,
      autoHighlight: true
    });

    // Update cursor based on mode
    deck.setProps({
      layers: [editableLayer],
      getCursor: isDrawing
        ? () => 'crosshair'
        : ({ isDragging }) => isDragging ? 'grabbing' : 'grab'
    });
  }, [geoJson, activeMode, selectedFeatureIndexes]);

  // ── Toggle terrain on/off ──
  React.useEffect(() => {
    const map = mapRef.current;
    const deck = deckRef.current;
    if (!map || !deck) return;
    terrainEnabledRef.current = terrainEnabled;

    // Enable/disable right-click rotation on deck controller
    deck.setProps({
      controller: {
        doubleClickZoom: false,
        dragRotate: terrainEnabled,
        touchRotate: terrainEnabled,
        maxPitch: terrainEnabled ? 75 : 0
      }
    });

    function applyTerrain() {
      if (terrainEnabled) {
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
      } else {
        map.setTerrain(null);
        // Reset view to flat
        const vs = { ...viewStateRef.current, pitch: 0, bearing: 0 };
        viewStateRef.current = vs;
        deck.setProps({ viewState: vs });
        map.jumpTo({ center: [vs.longitude, vs.latitude], zoom: vs.zoom, bearing: 0, pitch: 0 });
        if (map.getLayer('mapterhorn-hillshade')) {
          map.removeLayer('mapterhorn-hillshade');
        }
        if (map.getSource('mapterhorn-dem')) {
          map.removeSource('mapterhorn-dem');
        }
      }
    }

    if (map.isStyleLoaded()) {
      applyTerrain();
    } else {
      map.once('style.load', applyTerrain);
    }
  }, [terrainEnabled]);

  // ── Styles ──
  const toggleBtnStyle = {
    position: 'absolute',
    top: '10px',
    right: '10px',
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    background: terrainEnabled ? 'rgba(78, 204, 163, 0.9)' : 'rgba(26, 26, 46, 0.85)',
    color: '#fff',
    border: terrainEnabled ? '1px solid #4ecca3' : '1px solid rgba(255,255,255,0.25)',
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
    // MapLibre container (tiles only)
    React.createElement('div', {
      id: 'map',
      ref: mapContainerRef,
      style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }
    }),
    // Deck.gl container (transparent overlay – handles interaction + drawing)
    React.createElement('div', {
      ref: deckContainerRef,
      style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 1 }
    }),
    // Right-click context menu
    contextMenu.visible && React.createElement('div', {
      style: {
        position: 'fixed',
        top: contextMenu.y,
        left: contextMenu.x,
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
      }, 'Draw'),
      ['nfz', 'searchZone', 'route', 'searchPoint'].map((key) =>
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
            setActiveMode(key);
            setSelectedFeatureIndexes([]);
            setContextMenu({ visible: false, x: 0, y: 0 });
          }
        }, MODES[key].label)
      )
    ),
    // Terrain toggle
    React.createElement('button', {
      style: toggleBtnStyle,
      onClick: function () { setTerrainEnabled(!terrainEnabled); },
      title: terrainEnabled ? 'Disable 3D Terrain' : 'Enable 3D Terrain'
    }, terrainEnabled ? '\uD83C\uDF0D 3D' : '\uD83D\uDDFA\uFE0F 2D')
  );
}

function App() {
  return React.createElement('div', { style: { padding: '2rem', fontFamily: 'sans-serif' } },
    React.createElement('h1', null, 'OpenC2'),
    React.createElement('p', null, 'Initial window - map will be inserted here'),
    React.createElement(MapComponent)
  );
}

ReactDOM.render(
  React.createElement(App),
  document.getElementById('root')
);
