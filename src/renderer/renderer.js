// ── deck.gl v9 + maplibre interleaved renderer ──
import React from 'react';
import ReactDOM from 'react-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapboxOverlay } from '@deck.gl/mapbox';
import { PolygonLayer, PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
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
  view:        { label: '\u{1F446} Select',        mode: ViewMode },
  modify:      { label: '\u270F\uFE0F Modify',        mode: ModifyMode },
  nfz:         { label: '\u26D4 NFZ',              mode: DrawPolygonMode },
  searchZone:  { label: '\u{1F50D} Search Zone',    mode: DrawPolygonMode },
  airRoute:    { label: '\u2708\uFE0F Air Route',    mode: DrawLineStringMode },
  groundRoute: { label: '\u{1F6E4}\uFE0F Ground Route', mode: DrawLineStringMode },
  searchPoint: { label: '\u{1F4CD} Search Point',   mode: DrawPointMode },
  geofence:    { label: '\u{1F6A7} Geofence',        mode: DrawPolygonMode }
};

// ── Per-feature-type color palette ──
// tentativeFill/tentativeLine are optional overrides for drawing preview
const FEATURE_COLORS = {
  nfz:         { fill: [220, 53, 69, 90],   line: [220, 53, 69, 220]  },
  searchZone:  { fill: [59, 130, 246, 80],  line: [59, 130, 246, 220] },
  airRoute:    { fill: [16, 185, 129, 80],  line: [16, 185, 129, 220] },  // Emerald green
  groundRoute: { fill: [139, 90, 43, 80],   line: [139, 90, 43, 220] },   // Brown/tan for ground
  searchPoint: { fill: [59, 130, 246, 200], line: [59, 130, 246, 255] },
  geofence:    { fill: [0, 0, 0, 0],        line: [0, 0, 0, 0],        tentativeFill: [255, 165, 0, 60], tentativeLine: [255, 165, 0, 240] }, // Invisible ground, walls rendered separately
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
  const [mapIdleToken, setMapIdleToken] = React.useState(0);
  const [showMissionFlyout, setShowMissionFlyout] = React.useState(false);
  const [cursorCoords, setCursorCoords] = React.useState(null);

  // ── Tactical Style Constants ──
  const FRAME_WIDTH = '24px'; // ~0.6cm - standard tactical frame
  const TACTICAL_BG = '#0a0a0c';
  const ACCENT_GREEN = '#4ecca3';
  const ACCENT_BLUE = '#3b82f6';
  const TACTICAL_FONT = "'JetBrains Mono', 'Roboto Mono', 'Consolas', monospace";

  // Default altitude values for each feature type
  const DEFAULT_ALTITUDES = {
    geofence: { altitude: 150 },
    nfz: { floor: 0, ceiling: 400 },
    searchZone: { altitude: 100 },
    airRoute: { altitude: 50 },
    groundRoute: {}  // No altitude - follows terrain
  };

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

  // ── Listen to map idle event for terrain tile loading ──
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleIdle = () => {
      // Only trigger a geometry rebuild if terrain is enabled 
      // (This prevents unnecessary React updates in flat 2D mode)
      if (terrainEnabledRef.current) {
        setMapIdleToken(prev => prev + 1);
      }
    };

    map.on('idle', handleIdle);

    return () => {
      map.off('idle', handleIdle);
    };
  }, []);

  // ── Track cursor coordinates ──
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleMouseMove = (e) => {
      setCursorCoords({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    };

    const handleMouseLeave = () => {
      setCursorCoords(null);
    };

    map.on('mousemove', handleMouseMove);
    map.on('mouseout', handleMouseLeave);

    return () => {
      map.off('mousemove', handleMouseMove);
      map.off('mouseout', handleMouseLeave);
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
      // Clear cursor style completely, including !important flag
      canvas.style.removeProperty('cursor');
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
        // Don't process this double-click further - it was used to finish drawing
        // The property panel will be shown by the useEffect
        return;
      }

      const overlay = deckOverlayRef.current;
      if (overlay) {
        // Check if user double-clicked an existing shape to modify it
        const picked = overlay.pickObject({ x, y });
        if (picked) {
          // Handle wall segment picks (geofence curtain)
          if (picked.object && picked.object.featureIndex != null) {
            const idx = picked.object.featureIndex;
            setSelectedFeatureIndexes([idx]);
            setActiveMode('modify');
            setShowMissionFlyout(true);
            return;
          }
          // Handle regular feature picks (EditableGeoJsonLayer)
          if (picked.index != null && picked.index >= 0) {
            const idx = picked.index;
            setSelectedFeatureIndexes([idx]);
            setActiveMode('modify');
            setShowMissionFlyout(true);
            return;
          }
        }
      }

      // User double-clicked empty space: exit modify mode or open menu
      if (activeMode === 'modify') {
        setActiveMode('view');
        setSelectedFeatureIndexes([]);
        return;
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
        if (activeMode !== 'view') {
          setActiveMode('view');
          setSelectedFeatureIndexes([]);
        } else if (showMissionFlyout) {
          setShowMissionFlyout(false);
        }
        drawJustFinishedRef.current = false; // Reset so double-click works again
      }
      if (e.key === 'Enter') {
        if (activeMode === 'modify') {
          setActiveMode('view');
          setSelectedFeatureIndexes([]);
        }
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
  }, [activeMode, selectedFeatureIndexes, showMissionFlyout, geoJson]);

  // ── 4. Render Deck.gl Layers ──
  React.useEffect(() => {
    const overlay = deckOverlayRef.current;
    const map = mapRef.current;
    if (!overlay || !map) return;

    const ModeClass = MODES[activeMode].mode;
    const colorDef = FEATURE_COLORS[activeMode] || FEATURE_COLORS._default;
    // Use tentative overrides if defined, otherwise fall back to fill/line
    const tentativeColors = {
      fill: colorDef.tentativeFill || colorDef.fill,
      line: colorDef.tentativeLine || colorDef.line
    };

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
          // Get default altitude properties for this feature type
          const altitudeProps = DEFAULT_ALTITUDES[activeMode] || {};
          const finalData = {
            ...cleanData,
            features: cleanData.features.map((f, i) =>
              i === lastIdx
                ? { ...f, properties: { ...f.properties, featureType: activeMode, ...altitudeProps } }
                : f
            )
          };
          drawJustFinishedRef.current = true;
          setGeoJson(finalData);
          setActiveMode('view');
          setSelectedFeatureIndexes([lastIdx]);
          // Auto-open flyout for features with altitude settings
          if (['geofence', 'nfz', 'searchZone', 'airRoute'].includes(activeMode)) {
            setShowMissionFlyout(true);
          }
        } else {
          setGeoJson(cleanData);
        }
      },

      // WHY: Hide route features in EditableGeoJsonLayer since they're rendered by dedicated layers
      // Routes are still editable/selectable, just visually rendered by PathLayers instead
      getFillColor: (f) => {
        const type = f?.properties?.featureType;
        if (type === 'airRoute' || type === 'groundRoute') return [0, 0, 0, 0];
        return (FEATURE_COLORS[type] || FEATURE_COLORS._default).fill;
      },
      getLineColor: (f) => {
        const type = f?.properties?.featureType;
        if (type === 'airRoute' || type === 'groundRoute') return [0, 0, 0, 0];
        return (FEATURE_COLORS[type] || FEATURE_COLORS._default).line;
      },
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

    // WHY: Geofence curtain layer creates a 3D extruded "fence" effect.
    // Instead of relying on PolygonLayer extrusion (which always draws a top cap),
    // we generate actual wall geometry as vertical quads for each edge.
    const geofenceFeatures = dataWithElevation.features.filter(f => f.properties?.featureType === 'geofence');
    
    // Build a map of geofence feature indices for picking
    const geofenceIndexMap = new Map();
    dataWithElevation.features.forEach((f, idx) => {
      if (f.properties?.featureType === 'geofence') {
        geofenceIndexMap.set(f, idx);
      }
    });
    
    // Transform polygon outlines into vertical wall segments
    const wallSegments = [];
    
    geofenceFeatures.forEach(feature => {
      const coords = feature.geometry.coordinates[0] || feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      
      const featureIndex = geofenceIndexMap.get(feature);
      const wallHeight = feature.properties?.altitude || 150; // Per-feature altitude
      
      // For each edge of the polygon, create a vertical wall quad
      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i + 1];
        const baseZ1 = p1[2] || 0;
        const baseZ2 = p2[2] || 0;
        
        // Create a vertical quad (4 corners forming a wall segment)
        // Order: bottom-left, bottom-right, top-right, top-left
        wallSegments.push({
          featureIndex,
          polygon: [
            [p1[0], p1[1], baseZ1],           // bottom-left
            [p2[0], p2[1], baseZ2],           // bottom-right
            [p2[0], p2[1], baseZ2 + wallHeight], // top-right
            [p1[0], p1[1], baseZ1 + wallHeight]  // top-left
          ]
        });
      }
    });
    
    const curtainLayer = new SolidPolygonLayer({
      id: 'geofence-curtain',
      data: wallSegments,
      _full3d: true, // WHY: Enable full 3D mode to properly render vertical wall geometry
      getPolygon: d => d.polygon,
      getFillColor: [255, 165, 0, 100], // Translucent Orange for walls
      pickable: true, // Enable picking on walls for geofence selection
      // WHY: Always enable depth for proper 3D rendering
      parameters: {
        depthWriteEnabled: true,
        depthCompare: 'less-equal'
      }
    });

    // WHY: PathLayer draws crisp border lines at the top of the curtain.
    // Separate from PolygonLayer wireframe for better visual control.
    // Add featureIndex for picking
    const geofenceBorderData = geofenceFeatures.map(f => ({
      feature: f,
      featureIndex: geofenceIndexMap.get(f)
    }));
    
    const curtainBorderLayer = new PathLayer({
      id: 'geofence-curtain-border',
      data: geofenceBorderData,
      getPath: d => {
        // Get the outer ring of the polygon and add elevation
        const coords = d.feature.geometry.coordinates[0] || d.feature.geometry.coordinates;
        const wallHeight = d.feature.properties?.altitude || 150;
        return coords.map(c => [c[0], c[1], (c[2] || 0) + wallHeight]); // Add curtain height
      },
      getColor: [255, 165, 0, 255],
      getWidth: 3,
      widthMinPixels: 2,
      pickable: true, // Enable picking on border for geofence selection
      parameters: {
        depthWriteEnabled: true,
        depthCompare: 'less-equal'
      },
      transitions: {
        getPath: 400
      }
    });

    // ── NFZ 3D Layers (Floor + Ceiling) ──
    const nfzFeatures = dataWithElevation.features.filter(f => f.properties?.featureType === 'nfz');
    const nfzIndexMap = new Map();
    dataWithElevation.features.forEach((f, idx) => {
      if (f.properties?.featureType === 'nfz') {
        nfzIndexMap.set(f, idx);
      }
    });

    // NFZ ceiling layer (top)
    const nfzCeilingData = nfzFeatures.map(f => ({
      feature: f,
      featureIndex: nfzIndexMap.get(f)
    }));

    const nfzCeilingLayer = new SolidPolygonLayer({
      id: 'nfz-ceiling',
      data: nfzCeilingData,
      getPolygon: d => {
        const coords = d.feature.geometry.coordinates[0] || d.feature.geometry.coordinates;
        const ceiling = d.feature.properties?.ceiling || 400;
        return coords.map(c => [c[0], c[1], (c[2] || 0) + ceiling]);
      },
      getFillColor: [220, 53, 69, 60],
      pickable: true,
      parameters: {
        depthWriteEnabled: true,
        depthCompare: 'less-equal'
      }
    });

    // NFZ walls (vertical sides from floor to ceiling)
    const nfzWallSegments = [];
    nfzFeatures.forEach(feature => {
      const coords = feature.geometry.coordinates[0] || feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      
      const featureIndex = nfzIndexMap.get(feature);
      const floor = feature.properties?.floor || 0;
      const ceiling = feature.properties?.ceiling || 400;
      
      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i + 1];
        const baseZ1 = (p1[2] || 0) + floor;
        const baseZ2 = (p2[2] || 0) + floor;
        
        nfzWallSegments.push({
          featureIndex,
          polygon: [
            [p1[0], p1[1], baseZ1],
            [p2[0], p2[1], baseZ2],
            [p2[0], p2[1], (p2[2] || 0) + ceiling],
            [p1[0], p1[1], (p1[2] || 0) + ceiling]
          ]
        });
      }
    });

    const nfzWallLayer = new SolidPolygonLayer({
      id: 'nfz-walls',
      data: nfzWallSegments,
      _full3d: true,
      getPolygon: d => d.polygon,
      getFillColor: [220, 53, 69, 40],
      pickable: true,
      parameters: {
        depthWriteEnabled: true,
        depthCompare: 'less-equal'
      }
    });

    // ── Search Zone and Route 3D Layers ──
    const searchZoneFeatures = dataWithElevation.features.filter(f => f.properties?.featureType === 'searchZone');
    const searchZoneIndexMap = new Map();
    dataWithElevation.features.forEach((f, idx) => {
      if (f.properties?.featureType === 'searchZone') {
        searchZoneIndexMap.set(f, idx);
      }
    });

    const searchZoneCeilingData = searchZoneFeatures.map(f => ({
      feature: f,
      featureIndex: searchZoneIndexMap.get(f)
    }));

    const searchZoneCeilingLayer = new SolidPolygonLayer({
      id: 'searchZone-ceiling',
      data: searchZoneCeilingData,
      getPolygon: d => {
        const coords = d.feature.geometry.coordinates[0] || d.feature.geometry.coordinates;
        const altitude = d.feature.properties?.altitude || 100;
        return coords.map(c => [c[0], c[1], (c[2] || 0) + altitude]);
      },
      getFillColor: [59, 130, 246, 40],
      pickable: true,
      parameters: {
        depthWriteEnabled: true,
        depthCompare: 'less-equal'
      }
    });

    // Air Route 3D layer (elevated path)
    const airRouteFeatures = dataWithElevation.features.filter(f => f.properties?.featureType === 'airRoute');
    const airRouteIndexMap = new Map();
    dataWithElevation.features.forEach((f, idx) => {
      if (f.properties?.featureType === 'airRoute') {
        airRouteIndexMap.set(f, idx);
      }
    });

    const airRouteElevatedData = airRouteFeatures.map(f => ({
      feature: f,
      featureIndex: airRouteIndexMap.get(f)
    }));

    const airRouteElevatedLayer = new PathLayer({
      id: 'airRoute-elevated',
      data: airRouteElevatedData,
      getPath: d => {
        const coords = d.feature.geometry.coordinates;
        const altitude = d.feature.properties?.altitude || 50;
        return coords.map(c => [c[0], c[1], (c[2] || 0) + altitude]);
      },
      getColor: [16, 185, 129, 255],  // Emerald green
      getWidth: 4,
      widthMinPixels: 3,
      pickable: true,
      parameters: {
        depthWriteEnabled: true,
        depthCompare: 'less-equal'
      }
    });

    // Ground Route layer (follows terrain using PathLayer with dense terrain sampling)
    // WHY: Use PathLayer for consistent screen-space width, but sample terrain at many
    // points along the path so it follows elevation changes smoothly.
    const groundRouteFeatures = geoJson.features.filter(f => f.properties?.featureType === 'groundRoute');
    const groundRouteIndexMap = new Map();
    geoJson.features.forEach((f, idx) => {
      if (f.properties?.featureType === 'groundRoute') {
        groundRouteIndexMap.set(f, idx);
      }
    });

    // Helper: interpolate points along a line segment for finer terrain sampling
    const interpolateSegment = (p1, p2, numPoints) => {
      const points = [];
      for (let i = 0; i <= numPoints; i++) {
        const t = i / numPoints;
        points.push([
          p1[0] + (p2[0] - p1[0]) * t,
          p1[1] + (p2[1] - p1[1]) * t
        ]);
      }
      return points;
    };

    const INTERPOLATION_POINTS = 15; // points per segment for smooth terrain following

    // Build dense paths with terrain elevations for each ground route
    const groundRouteData = groundRouteFeatures.map(feature => {
      const coords = feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) {
        return { feature, featureIndex: groundRouteIndexMap.get(feature), densePath: [] };
      }
      
      // Build dense point list with terrain elevations
      const densePoints = [];
      for (let i = 0; i < coords.length - 1; i++) {
        const segmentPoints = interpolateSegment(coords[i], coords[i + 1], INTERPOLATION_POINTS);
        // Avoid duplicating points at segment boundaries
        if (i > 0) segmentPoints.shift();
        segmentPoints.forEach(p => {
          const elev = getTerrainElevation(p);
          densePoints.push([p[0], p[1], elev]); // terrain elevation baked in
        });
      }
      
      return {
        feature,
        featureIndex: groundRouteIndexMap.get(feature),
        densePath: densePoints
      };
    });

    const groundRouteLayer = new PathLayer({
      id: 'groundRoute-path',
      data: groundRouteData,
      getPath: d => d.densePath,
      getColor: [139, 90, 43, 255],  // Brown/tan for ground
      getWidth: 4,  // Same as air route
      widthMinPixels: 3,  // Same as air route - constant screen pixels
      pickable: true,
      // WHY: depthCompare 'always' renders on top of terrain like a painted overlay
      parameters: {
        depthWriteEnabled: false,
        depthCompare: 'always'
      }
    });

    overlay.setProps({
      layers: [curtainLayer, curtainBorderLayer, nfzCeilingLayer, nfzWallLayer, searchZoneCeilingLayer, airRouteElevatedLayer, groundRouteLayer, editableLayer],
      // WHY: Sync internal deck.gl cursor state with our active mode
      getCursor: () => (activeMode !== 'view' ? (activeMode === 'modify' ? 'grab' : 'crosshair') : 'auto')
    });
  }, [geoJson, activeMode, selectedFeatureIndexes, terrainEnabled, mapIdleToken]);


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

  // ── Tactical Styles ──
  const HEADER_HEIGHT = '40px';
  
  const frameStyle = {
    position: 'relative',
    width: '100%',
    height: '100%',
    backgroundColor: TACTICAL_BG,
    padding: `${HEADER_HEIGHT} ${FRAME_WIDTH} ${FRAME_WIDTH} ${FRAME_WIDTH}`,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: TACTICAL_FONT
  };

  const mapViewportStyle = {
    position: 'relative',
    flex: 1,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    border: '1px solid #333'
  };

  const toolbarBtnStyle = (active, color = ACCENT_GREEN) => ({
    width: '32px',
    height: '26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: active ? color : 'transparent',
    border: `1px solid ${active ? color : '#444'}`,
    color: active ? '#000' : '#ccc',
    cursor: 'pointer',
    fontSize: '10px',
    fontWeight: 600,
    fontFamily: TACTICAL_FONT,
    borderRadius: '2px',
    transition: 'all 0.1s ease'
  });

  const bottomDekStyle = {
    position: 'absolute',
    bottom: '4px',
    left: FRAME_WIDTH,
    right: FRAME_WIDTH,
    height: '16px',
    fontSize: '9px',
    color: '#555',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 8px',
    fontFamily: TACTICAL_FONT,
    letterSpacing: '0.5px'
  };

  // Mode border color for active drawing states
  const getModeAccent = () => {
    if (activeMode === 'nfz') return 'rgba(220, 53, 69, 0.6)';
    if (activeMode === 'geofence') return 'rgba(255, 165, 0, 0.6)';
    if (activeMode === 'searchZone') return 'rgba(59, 130, 246, 0.6)';
    if (activeMode === 'airRoute' || activeMode === 'groundRoute') return 'rgba(16, 185, 129, 0.6)';
    if (activeMode === 'modify') return 'rgba(255, 255, 255, 0.3)';
    return '#333';
  };

  return React.createElement('div', { style: frameStyle },
    // ── TOP HEADER BAR (integrated toolbar) ──
    React.createElement('div', { 
      style: { 
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: HEADER_HEIGHT, 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between',
        padding: '0 24px',
        fontFamily: TACTICAL_FONT,
        borderBottom: '1px solid #222',
        zIndex: 2
      } 
    },
      // Left side - title
      React.createElement('div', { 
        style: { display: 'flex', alignItems: 'center', gap: '12px' } 
      },
        React.createElement('span', { 
          style: { color: ACCENT_GREEN, fontWeight: 600, fontSize: '13px', letterSpacing: '2px' } 
        }, 'OPENC2'),
        React.createElement('span', { 
          style: { color: '#444', fontSize: '10px', letterSpacing: '1px' } 
        }, 'C2 INTERFACE')
      ),
      // Right side - toolbar buttons
      React.createElement('div', { 
        style: { display: 'flex', alignItems: 'center', gap: '8px' } 
      },
        // Mission Flyout Toggle
        React.createElement('button', {
          style: toolbarBtnStyle(showMissionFlyout, ACCENT_GREEN),
          onClick: () => setShowMissionFlyout(!showMissionFlyout),
          title: 'Mission Elements'
        }, '\u2630'),
        // Terrain Toggle
        React.createElement('button', {
          style: toolbarBtnStyle(terrainEnabled, ACCENT_GREEN),
          onClick: () => setTerrainEnabled(!terrainEnabled),
          title: terrainEnabled ? 'Disable 3D Terrain' : 'Enable 3D Terrain'
        }, terrainEnabled ? '3D' : '2D'),
        // Satellite Toggle
        React.createElement('button', {
          style: toolbarBtnStyle(satelliteEnabled, ACCENT_BLUE),
          onClick: () => setSatelliteEnabled(!satelliteEnabled),
          title: satelliteEnabled ? 'Switch to Street Map' : 'Switch to Satellite'
        }, 'SAT')
      )
    ),
    // ── MAP VIEWPORT ──
    React.createElement('div', { style: { ...mapViewportStyle, borderColor: getModeAccent() } },
      // The unified Map container
      React.createElement('div', {
        id: 'map',
        ref: mapContainerRef,
        style: { width: '100%', height: '100%' }
      }),

      // ── MISSION FLYOUT (Right side panel with slide animation) ──
      React.createElement('div', {
        style: {
          position: 'absolute',
          right: 0,
          top: 0,
          bottom: 0,
          width: '260px',
          background: 'rgba(10, 10, 12, 0.95)',
          borderLeft: `1px solid ${ACCENT_GREEN}`,
          zIndex: 5,
          padding: '16px',
          backdropFilter: 'blur(10px)',
          fontFamily: TACTICAL_FONT,
          overflowY: 'auto',
          transform: showMissionFlyout ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 200ms ease-out',
          boxShadow: showMissionFlyout ? '-4px 0 20px rgba(0,0,0,0.4)' : 'none'
        },
        onClick: (e) => e.stopPropagation()
      },
        React.createElement('div', {
          style: { color: ACCENT_GREEN, marginBottom: '12px', fontWeight: 600, fontSize: '11px', letterSpacing: '1px' }
        }, '> MISSION_ELEMENTS'),
        
        // Drawing mode indicator
        activeMode !== 'view' && activeMode !== 'modify' && React.createElement('div', {
          style: {
            padding: '10px 12px',
            marginBottom: '12px',
            background: 'rgba(78, 204, 163, 0.1)',
            border: `1px dashed ${ACCENT_GREEN}`,
            borderRadius: '2px',
            fontSize: '10px',
            color: ACCENT_GREEN,
            textAlign: 'center',
            letterSpacing: '0.5px'
          }
        }, `DRAWING: ${activeMode.toUpperCase()}`),
        
        geoJson.features.length === 0
          ? React.createElement('div', {
              style: { color: '#555', fontSize: '11px', padding: '8px 0' }
            }, 'No elements. Double-click map to add.')
          : geoJson.features.map((f, i) => {
              const isSelected = selectedFeatureIndexes.includes(i);
              const featureType = f.properties?.featureType;
              const typeColors = {
                nfz: '#dc3545',
                searchZone: '#3b82f6',
                geofence: '#ffa500',
                airRoute: '#10b981',
                groundRoute: '#8b5a2b',
                searchPoint: '#3b82f6'
              };
              const featureColor = typeColors[featureType] || '#4ecca3';
              
              // Helper to update feature property
              const updateFeatureProperty = (propName, value) => {
                setGeoJson(prev => ({
                  ...prev,
                  features: prev.features.map((feat, idx) =>
                    idx === i
                      ? { ...feat, properties: { ...feat.properties, [propName]: Number(value) } }
                      : feat
                  )
                }));
              };
              
              // Inline input style
              const inlineInputStyle = {
                width: '60px',
                padding: '4px 6px',
                borderRadius: '2px',
                border: '1px solid rgba(255,255,255,0.2)',
                background: 'rgba(0,0,0,0.3)',
                color: '#ccc',
                fontSize: '11px',
                textAlign: 'center',
                fontFamily: TACTICAL_FONT
              };
              
              return React.createElement('div', { key: i },
                // Element row
                React.createElement('div', {
                  style: {
                    padding: '8px 10px',
                    marginBottom: isSelected ? '0' : '4px',
                    background: isSelected ? 'rgba(78, 204, 163, 0.15)' : 'transparent',
                    borderLeft: `2px solid ${featureColor}`,
                    fontSize: '11px',
                    color: isSelected ? '#fff' : '#aaa',
                    cursor: 'pointer',
                    transition: 'all 0.1s',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  },
                  onMouseEnter: (e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; },
                  onMouseLeave: (e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; },
                  onClick: () => {
                    if (isSelected) {
                      // Deselect
                      setSelectedFeatureIndexes([]);
                      setActiveMode('view');
                    } else {
                      setSelectedFeatureIndexes([i]);
                      setActiveMode('modify');
                    }
                  }
                }, 
                  `[${String(i).padStart(2, '0')}] ${(featureType || 'unknown').toUpperCase()}`,
                  isSelected && React.createElement('span', { style: { fontSize: '9px', color: '#666' } }, '\u25BC')
                ),
                
                // Expanded inline property editor (when selected)
                isSelected && ['geofence', 'nfz', 'searchZone', 'airRoute'].includes(featureType) && React.createElement('div', {
                  style: {
                    padding: '12px 10px',
                    marginBottom: '4px',
                    marginLeft: '2px',
                    borderLeft: `2px solid ${featureColor}`,
                    background: 'rgba(0, 0, 0, 0.3)',
                    fontSize: '10px'
                  },
                  onClick: (e) => e.stopPropagation()
                },
                  // NFZ: Floor and Ceiling
                  featureType === 'nfz' && React.createElement('div', null,
                    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
                      React.createElement('span', { style: { color: '#888' } }, 'Floor'),
                      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                        React.createElement('input', {
                          type: 'number',
                          value: f.properties?.floor ?? 0,
                          onChange: (e) => updateFeatureProperty('floor', e.target.value),
                          onKeyDown: (e) => e.stopPropagation(),
                          style: inlineInputStyle
                        }),
                        React.createElement('span', { style: { color: '#555', fontSize: '9px' } }, 'm')
                      )
                    ),
                    React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
                      React.createElement('span', { style: { color: '#888' } }, 'Ceiling'),
                      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                        React.createElement('input', {
                          type: 'number',
                          value: f.properties?.ceiling ?? 400,
                          onChange: (e) => updateFeatureProperty('ceiling', e.target.value),
                          onKeyDown: (e) => e.stopPropagation(),
                          style: inlineInputStyle
                        }),
                        React.createElement('span', { style: { color: '#555', fontSize: '9px' } }, 'm')
                      )
                    )
                  ),
                  
                  // Geofence, SearchZone, AirRoute: Single altitude
                  ['geofence', 'searchZone', 'airRoute'].includes(featureType) && React.createElement('div', {
                    style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }
                  },
                    React.createElement('span', { style: { color: '#888' } }, 'Altitude'),
                    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                      React.createElement('input', {
                        type: 'number',
                        value: f.properties?.altitude ?? (featureType === 'geofence' ? 150 : featureType === 'searchZone' ? 100 : 50),
                        onChange: (e) => updateFeatureProperty('altitude', e.target.value),
                        onKeyDown: (e) => e.stopPropagation(),
                        style: inlineInputStyle
                      }),
                      React.createElement('span', { style: { color: '#555', fontSize: '9px' } }, 'm')
                    )
                  ),
                  
                  // Delete button
                  React.createElement('button', {
                    style: {
                      width: '100%',
                      marginTop: '8px',
                      padding: '6px 10px',
                      borderRadius: '2px',
                      border: '1px solid rgba(220, 53, 69, 0.5)',
                      background: 'transparent',
                      color: '#dc3545',
                      fontSize: '10px',
                      fontWeight: 600,
                      fontFamily: TACTICAL_FONT,
                      cursor: 'pointer',
                      letterSpacing: '0.5px',
                      transition: 'all 0.1s'
                    },
                    onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(220, 53, 69, 0.2)'; },
                    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                    onClick: () => {
                      setGeoJson(prev => ({
                        ...prev,
                        features: prev.features.filter((_, idx) => idx !== i)
                      }));
                      setSelectedFeatureIndexes([]);
                      setActiveMode('view');
                    }
                  }, 'DELETE')
                ),
                
                // For elements without altitude (groundRoute, searchPoint), show just delete
                isSelected && !['geofence', 'nfz', 'searchZone', 'airRoute'].includes(featureType) && React.createElement('div', {
                  style: {
                    padding: '10px',
                    marginBottom: '4px',
                    marginLeft: '2px',
                    borderLeft: `2px solid ${featureColor}`,
                    background: 'rgba(0, 0, 0, 0.3)'
                  },
                  onClick: (e) => e.stopPropagation()
                },
                  React.createElement('button', {
                    style: {
                      width: '100%',
                      padding: '6px 10px',
                      borderRadius: '2px',
                      border: '1px solid rgba(220, 53, 69, 0.5)',
                      background: 'transparent',
                      color: '#dc3545',
                      fontSize: '10px',
                      fontWeight: 600,
                      fontFamily: TACTICAL_FONT,
                      cursor: 'pointer',
                      letterSpacing: '0.5px',
                      transition: 'all 0.1s'
                    },
                    onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(220, 53, 69, 0.2)'; },
                    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                    onClick: () => {
                      setGeoJson(prev => ({
                        ...prev,
                        features: prev.features.filter((_, idx) => idx !== i)
                      }));
                      setSelectedFeatureIndexes([]);
                      setActiveMode('view');
                    }
                  }, 'DELETE')
                )
              );
            })
      ),
    
    // Mission editor menu (context menu on double-click)
    missionMenu.visible && React.createElement('div', {
      style: {
        position: 'fixed',
        top: missionMenu.y,
        left: missionMenu.x,
        zIndex: 10,
        background: 'rgba(10, 10, 12, 0.95)',
        border: `1px solid ${ACCENT_GREEN}`,
        borderRadius: '2px',
        padding: '4px 0',
        minWidth: '180px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.6)',
        backdropFilter: 'blur(10px)',
        fontFamily: TACTICAL_FONT,
        fontSize: '12px'
      },
      onClick: (e) => e.stopPropagation()
    },
      React.createElement('div', {
        style: { padding: '6px 12px', color: ACCENT_GREEN, fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px' }
      }, '> ADD_ELEMENT'),
      ['nfz', 'searchZone', 'geofence', 'airRoute', 'groundRoute', 'searchPoint'].map((key) => {
        const menuColors = {
          nfz: '#dc3545',
          searchZone: '#3b82f6',
          geofence: '#ffa500',
          airRoute: '#10b981',
          groundRoute: '#8b5a2b',
          searchPoint: '#3b82f6'
        };
        return React.createElement('div', {
          key,
          style: {
            padding: '8px 14px',
            color: '#ccc',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            transition: 'all 0.1s',
            borderLeft: '2px solid transparent',
            fontFamily: TACTICAL_FONT
          },
          onMouseEnter: (e) => { 
            e.currentTarget.style.background = 'rgba(78, 204, 163, 0.15)'; 
            e.currentTarget.style.borderLeftColor = menuColors[key];
            e.currentTarget.style.color = '#fff';
          },
          onMouseLeave: (e) => { 
            e.currentTarget.style.background = 'transparent'; 
            e.currentTarget.style.borderLeftColor = 'transparent';
            e.currentTarget.style.color = '#ccc';
          },
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
              setShowMissionFlyout(true);
            } else {
              setActiveMode(key);
              setSelectedFeatureIndexes([]);
              setShowMissionFlyout(true);
            }
          }
        }, MODES[key].label);
      })
    )
    ), // End mapViewportStyle div

    // ── BOTTOM STATUS BAR (DEK) ──
    React.createElement('div', { style: bottomDekStyle },
      React.createElement('span', null, `ELEMENTS: ${geoJson.features.length} | MODE: ${activeMode.toUpperCase()}`),
      React.createElement('span', { style: { color: '#888' } }, 
        cursorCoords 
          ? `${cursorCoords.lat.toFixed(6)}, ${cursorCoords.lng.toFixed(6)}`
          : '--.--, --.--'
      )
    )
  );
}

function App() {
  return React.createElement('div', { 
    style: { 
      fontFamily: "'JetBrains Mono', 'Roboto Mono', 'Consolas', monospace",
      background: '#0a0a0c',
      width: '100vw',
      height: '100vh',
      boxSizing: 'border-box',
      overflow: 'hidden'
    } 
  },
    React.createElement(MapComponent)
  );
}

export default App;

ReactDOM.render(
  React.createElement(App),
  document.getElementById('root')
);