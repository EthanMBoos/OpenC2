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
  view:    { label: '\u{1F446} Select',  mode: ViewMode },
  modify:  { label: '\u270F\uFE0F Modify',  mode: ModifyMode },
  polygon: { label: '\u2B21 Polygon', mode: DrawPolygonMode },
  line:    { label: '\u2571 Line',     mode: DrawLineStringMode },
  point:   { label: '\u25CF Point',   mode: DrawPointMode }
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

  const [terrainEnabled, setTerrainEnabled] = React.useState(false);
  const [activeMode, setActiveMode] = React.useState('view');
  const [geoJson, setGeoJson] = React.useState({
    type: 'FeatureCollection',
    features: []
  });
  const [selectedFeatureIndexes, setSelectedFeatureIndexes] = React.useState([]);

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

  // ── Update deck.gl layers whenever drawing state changes ──
  React.useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;

    const ModeClass = MODES[activeMode].mode;
    const isDrawing = activeMode !== 'view';

    const editableLayer = new EditableGeoJsonLayer({
      id: 'editable-geojson',
      data: geoJson,
      mode: ModeClass,
      selectedFeatureIndexes,

      onEdit: ({ updatedData, editType }) => {
        setGeoJson(updatedData);
        // After finishing a feature, switch to select mode
        if (editType === 'addFeature') {
          setActiveMode('view');
          setSelectedFeatureIndexes([updatedData.features.length - 1]);
        }
      },

      // Styling
      getFillColor: [78, 204, 163, 100],
      getLineColor: [78, 204, 163, 220],
      getLineWidth: 2,
      getPointRadius: 6,
      pointRadiusMinPixels: 4,
      lineWidthMinPixels: 2,

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

  const toolbarStyle = {
    position: 'absolute',
    top: '10px',
    left: '10px',
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px'
  };

  const toolBtnStyle = (key) => ({
    background: activeMode === key ? 'rgba(78, 204, 163, 0.9)' : 'rgba(26, 26, 46, 0.85)',
    color: '#fff',
    border: activeMode === key ? '1px solid #4ecca3' : '1px solid rgba(255,255,255,0.25)',
    borderRadius: '6px',
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: '13px',
    fontFamily: 'sans-serif',
    fontWeight: 500,
    backdropFilter: 'blur(4px)',
    transition: 'background 0.2s, border 0.2s',
    textAlign: 'left'
  });

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
    // Drawing toolbar
    React.createElement('div', { style: toolbarStyle },
      Object.keys(MODES).map((key) =>
        React.createElement('button', {
          key,
          style: toolBtnStyle(key),
          onClick: () => {
            setActiveMode(key);
            if (key !== 'modify' && key !== 'view') {
              setSelectedFeatureIndexes([]);
            }
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
