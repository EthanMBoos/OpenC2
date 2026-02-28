// ── deck.gl v9 + maplibre interleaved renderer ──
import React from 'react';
import ReactDOM from 'react-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { MapboxOverlay } from '@deck.gl/mapbox';
import { sampleTerrainAsync, clearTerrainCache } from './terrainSampler.js';
import { computeGeometryHash } from './terrainCache.js';
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
// NFZ, searchZone, and geofence have invisible fills - their 3D walls are rendered separately
const FEATURE_COLORS = {
  nfz:         { fill: [0, 0, 0, 0],         line: [0, 0, 0, 0],         tentativeFill: [220, 53, 69, 60], tentativeLine: [220, 53, 69, 240] },
  searchZone:  { fill: [0, 0, 0, 0],         line: [0, 0, 0, 0],         tentativeFill: [59, 130, 246, 60], tentativeLine: [59, 130, 246, 240] },
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
  const cameraControlRef = React.useRef({ 
    active: false, 
    lastX: 0, 
    lastY: 0,
    source: null // 'middle', 'right', or 'option'
  });
  const rightClickRef = React.useRef({
    startTime: 0,
    startX: 0,
    startY: 0,
    isCameraMode: false,
    pendingMenu: null // Stores event coords if menu was deferred
  });

  // WHY: Keep state in a ref for stable event handler access.
  // This allows us to bind event listeners once (empty dep array)
  // while still accessing current state values.
  const eventStateRef = React.useRef({
    activeMode: 'view',
    selectedFeatureIndexes: [],
    showMissionFlyout: false,
    geoJson: { type: 'FeatureCollection', features: [] },
    missionMenuVisible: false,
    showHelpOverlay: false
  });

  const [terrainEnabled, setTerrainEnabled] = React.useState(false);
  const [satelliteEnabled, setSatelliteEnabled] = React.useState(false);
  const [activeMode, setActiveMode] = React.useState('view');
  const [geoJson, setGeoJson] = React.useState({
    type: 'FeatureCollection',
    features: []
  });
  const [selectedFeatureIndexes, setSelectedFeatureIndexes] = React.useState([]);
  const [missionMenu, setMissionMenu] = React.useState({ visible: false, x: 0, y: 0, lngLat: null, featureIndex: null });
  const [showMissionFlyout, setShowMissionFlyout] = React.useState(false);
  const coordsSpanRef = React.useRef(null);
  const [showHelpOverlay, setShowHelpOverlay] = React.useState(false);
  
  // ── Async Terrain Sampling State ──
  // WHY: Pre-computed 3D coordinates from async terrain sampling.
  // This moves terrain queries off the render path for better performance.
  const [elevatedGeoJson, setElevatedGeoJson] = React.useState(null);
  const [groundRoutePathsCache, setGroundRoutePathsCache] = React.useState([]);
  const lastGeometryHashRef = React.useRef(null);
  const terrainSamplingInProgressRef = React.useRef(false);

  // ── Style Constants ──
  const FRAME_WIDTH = '20px';
  const SURFACE_BG = '#1c1c1e';
  const ACCENT_PRIMARY = '#64748b'; // Slate blue
  const ACCENT_SECONDARY = '#6b8afd'; // Soft blue
  const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif";

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

  // ── Track cursor coordinates ──
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleMouseMove = (e) => {
      if (coordsSpanRef.current) {
        coordsSpanRef.current.textContent = `${e.lngLat.lat.toFixed(6)}, ${e.lngLat.lng.toFixed(6)}`;
      }
    };

    const handleMouseLeave = () => {
      if (coordsSpanRef.current) {
        coordsSpanRef.current.textContent = '—';
      }
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

  // Sync state to ref for stable event handler access
  React.useEffect(() => {
    eventStateRef.current = {
      activeMode,
      selectedFeatureIndexes,
      showMissionFlyout,
      geoJson,
      missionMenuVisible: missionMenu.visible,
      showHelpOverlay
    };
  }, [activeMode, selectedFeatureIndexes, showMissionFlyout, geoJson, missionMenu.visible, showHelpOverlay]);

  // ── 3. Handle Complex Events (Clicks, Right-clicks, Double Clicks & Keydowns) ──
  // WHY: Bound once with empty dependency array to avoid listener churn.
  // State is accessed via eventStateRef.current for fresh values.
  React.useEffect(() => {
    const container = mapContainerRef.current;
    const map = mapRef.current;
    if (!container || !map) return;

    // Helper to pick a feature at screen coordinates
    const pickFeatureAt = (x, y) => {
      const overlay = deckOverlayRef.current;
      if (!overlay) return null;
      try {
        const picked = overlay.pickObject({ x, y });
        if (picked) {
          // Handle wall segment picks (geofence curtain, NFZ walls, etc.)
          if (picked.object && picked.object.featureIndex != null) {
            return picked.object.featureIndex;
          }
          // Handle regular feature picks (EditableGeoJsonLayer)
          if (picked.index != null && picked.index >= 0) {
            // Geofences should only be selectable via their walls/border layers,
            // not from clicking the invisible fill area in EditableGeoJsonLayer
            const feature = eventStateRef.current.geoJson.features[picked.index];
            if (feature?.properties?.featureType === 'geofence') {
              return null;
            }
            return picked.index;
          }
        }
      } catch (err) {
        console.warn('Deck.gl pickObject failed:', err);
      }
      return null;
    };

    // Handle double-click: finish drawing OR enter modify mode on feature
    const handleDblClick = (e) => {
      try {
        const mode = eventStateRef.current.activeMode;
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Scenario A: Actively drawing a shape - finish it
        if (mode !== 'view' && mode !== 'modify') {
          e.preventDefault();
          e.stopPropagation();

          const overlay = deckOverlayRef.current;
          if (overlay && overlay._deck) {
            try {
              overlay._deck._onEvent({
                type: 'dblclick',
                offsetCenter: { x, y },
                srcEvent: e
              });
              overlay._deck._onEvent({
                type: 'keyup',
                key: 'Enter',
                srcEvent: e
              });
            } catch (err) {
              console.warn('Deck.gl event injection failed:', err);
            }
          }
          return;
        }

        // Scenario B: In view mode - double-click a feature to enter modify mode
        if (mode === 'view') {
          const featureIdx = pickFeatureAt(x, y);
          if (featureIdx !== null) {
            e.preventDefault();
            e.stopPropagation();
            setSelectedFeatureIndexes([featureIdx]);
            setActiveMode('modify');
            setShowMissionFlyout(true);
          }
        }
      } catch (err) {
        console.error('Double-click handler error:', err);
      }
    };

    // ── Camera orbit/pan helper ──
    const HOLD_THRESHOLD = 200; // ms - hold longer than this to enable camera mode
    
    const doCameraMove = (dx, dy) => {
      // In 3D mode (terrain enabled), control pitch and bearing
      // In 2D mode, pan the map
      if (terrainEnabledRef.current) {
        const currentBearing = map.getBearing();
        const currentPitch = map.getPitch();
        map.setBearing(currentBearing - dx * 0.5);
        map.setPitch(Math.max(0, Math.min(85, currentPitch - dy * 0.5)));
      } else {
        map.panBy([-dx, -dy], { animate: false });
      }
    };

    const enterCameraMode = (x, y, source) => {
      cameraControlRef.current = {
        active: true,
        lastX: x,
        lastY: y,
        source
      };
      container.style.cursor = 'grabbing';
    };

    const exitCameraMode = () => {
      cameraControlRef.current.active = false;
      cameraControlRef.current.source = null;
      container.style.cursor = '';
    };

    // ── Mouse down: middle = instant camera, right = start hold detection, option+left = trackpad camera ──
    const handleMouseDown = (e) => {
      // Middle mouse: instant camera mode
      if (e.button === 1) {
        e.preventDefault();
        enterCameraMode(e.clientX, e.clientY, 'middle');
        return;
      }
      
      // Option/Alt + left click: camera mode (trackpad-friendly)
      if (e.button === 0 && e.altKey) {
        e.preventDefault();
        enterCameraMode(e.clientX, e.clientY, 'option');
        return;
      }
      
      // Right mouse: record start time for hold detection
      if (e.button === 2) {
        rightClickRef.current = {
          startTime: Date.now(),
          startX: e.clientX,
          startY: e.clientY,
          isCameraMode: false,
          pendingMenu: null
        };
      }
    };

    const handleMouseMove = (e) => {
      // Option+left drag: handle camera if active
      if (cameraControlRef.current.source === 'option' && !(e.buttons & 1)) {
        exitCameraMode();
        return;
      }
      
      // If right button held and past threshold, enter camera mode
      if ((e.buttons & 2) && !cameraControlRef.current.active) {
        const elapsed = Date.now() - rightClickRef.current.startTime;
        if (elapsed > HOLD_THRESHOLD) {
          rightClickRef.current.isCameraMode = true;
          enterCameraMode(e.clientX, e.clientY, 'right');
        }
      }
      
      // Handle active camera control (from middle, right, or option+left)
      if (cameraControlRef.current.active) {
        const dx = e.clientX - cameraControlRef.current.lastX;
        const dy = e.clientY - cameraControlRef.current.lastY;
        cameraControlRef.current.lastX = e.clientX;
        cameraControlRef.current.lastY = e.clientY;
        doCameraMove(dx, dy);
      }
    };

    const handleMouseUp = (e) => {
      // Middle mouse release
      if (e.button === 1 && cameraControlRef.current.source === 'middle') {
        exitCameraMode();
        return;
      }
      
      // Option+left mouse release
      if (e.button === 0 && cameraControlRef.current.source === 'option') {
        exitCameraMode();
        return;
      }
      
      // Right mouse release
      if (e.button === 2) {
        const wasCameraMode = rightClickRef.current.isCameraMode || cameraControlRef.current.source === 'right';
        
        if (cameraControlRef.current.source === 'right') {
          exitCameraMode();
        }
        
        // If we have a pending menu and didn't use camera mode, show it now
        if (rightClickRef.current.pendingMenu && !wasCameraMode) {
          const { clientX, clientY } = rightClickRef.current.pendingMenu;
          showContextMenuAt(clientX, clientY);
        }
        
        // Reset
        rightClickRef.current.isCameraMode = false;
        rightClickRef.current.pendingMenu = null;
      }
    };
    
    // Helper to show context menu at given coordinates
    const showContextMenuAt = (clientX, clientY) => {
      try {
        const rect = container.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const currentMode = eventStateRef.current.activeMode;

        // If currently drawing, cancel the drawing and return to view mode
        if (currentMode !== 'view' && currentMode !== 'modify') {
          setActiveMode('view');
          setSelectedFeatureIndexes([]);
          return;
        }

        // Check if right-clicked on a feature
        const featureIdx = pickFeatureAt(x, y);
        const lngLat = map.unproject([x, y]);

        if (featureIdx !== null) {
          // Right-clicked on a feature - show feature context menu
          setSelectedFeatureIndexes([featureIdx]);
          setMissionMenu({ 
            visible: true, 
            x: clientX, 
            y: clientY, 
            lngLat: [lngLat.lng, lngLat.lat],
            featureIndex: featureIdx 
          });
        } else {
          // Right-clicked on empty space - show add element menu
          if (currentMode === 'modify') {
            setActiveMode('view');
            setSelectedFeatureIndexes([]);
          }
          setMissionMenu({ 
            visible: true, 
            x: clientX, 
            y: clientY, 
            lngLat: [lngLat.lng, lngLat.lat],
            featureIndex: null 
          });
        }
      } catch (err) {
        console.error('Context menu error:', err);
      }
    };

    // ── Right-click: suppress native menu, handle our own logic ──
    const handleContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      const now = Date.now();
      const elapsed = now - rightClickRef.current.startTime;
      
      // If right button is still held, defer menu decision to mouseup
      if (e.buttons & 2) {
        rightClickRef.current.pendingMenu = { clientX: e.clientX, clientY: e.clientY };
        return;
      }
      
      const wasCameraMode = rightClickRef.current.isCameraMode || cameraControlRef.current.source === 'right';
      
      // If startTime is stale (>1 second ago), this is likely a trackpad tap
      // which fires contextmenu without mousedown - always show menu
      const isTrackpadTap = elapsed > 1000;
      
      // If we held long enough (but not a stale/trackpad tap) or were in camera mode, suppress menu
      if (!isTrackpadTap && (elapsed > HOLD_THRESHOLD || wasCameraMode)) {
        rightClickRef.current.isCameraMode = false;
        exitCameraMode();
        return;
      }
      
      // Reset for next click
      rightClickRef.current.isCameraMode = false;
      
      // Show the menu
      showContextMenuAt(e.clientX, e.clientY);
    };

    // Handle single click: select feature or deselect
    const handleClick = (e) => {
      // Ignore clicks with Option/Alt held (used for camera control)
      if (e.altKey) return;
      
      // Close menu if visible
      if (eventStateRef.current.missionMenuVisible) {
        setMissionMenu(prev => ({ ...prev, visible: false }));
        return;
      }

      // Only handle clicks when in view mode (not drawing or modifying)
      if (eventStateRef.current.activeMode !== 'view') return;

      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const featureIdx = pickFeatureAt(x, y);
      if (featureIdx !== null) {
        // Single-click on feature: select it (but don't enter modify mode)
        setSelectedFeatureIndexes([featureIdx]);
        setShowMissionFlyout(true);
      } else {
        // Single-click on empty space: deselect
        if (eventStateRef.current.selectedFeatureIndexes.length > 0) {
          setSelectedFeatureIndexes([]);
        }
      }
    };

    const handleKeyDown = (e) => {
      const state = eventStateRef.current;
      if (e.key === 'Escape') {
        // Close help overlay first if open
        if (state.showHelpOverlay) {
          setShowHelpOverlay(false);
          return;
        }
        setMissionMenu((prev) => ({ ...prev, visible: false }));
        if (state.activeMode !== 'view') {
          setActiveMode('view');
          setSelectedFeatureIndexes([]);
        } else if (state.showMissionFlyout) {
          setShowMissionFlyout(false);
        }
        drawJustFinishedRef.current = false; // Reset so double-click works again
      }
      if (e.key === 'Enter') {
        if (state.activeMode === 'modify') {
          setActiveMode('view');
          setSelectedFeatureIndexes([]);
        }
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && state.selectedFeatureIndexes.length > 0) {
        e.preventDefault();
        setGeoJson((prev) => ({
          ...prev,
          features: prev.features.filter((_, i) => !state.selectedFeatureIndexes.includes(i))
        }));
        setSelectedFeatureIndexes([]);
        setActiveMode('view');
      }
    };

    // Clean up on mouse leave
    const handleMouseLeave = () => {
      rightClickRef.current.isCameraMode = false;
      rightClickRef.current.pendingMenu = null;
      exitCameraMode();
    };

    // WHY: We bind to the native DOM element to ensure we catch events
    // before the MapLibre canvas or WebGL context has a chance to call stopPropagation()
    container.addEventListener('dblclick', handleDblClick);
    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('mouseleave', handleMouseLeave);
    container.addEventListener('contextmenu', handleContextMenu);
    container.addEventListener('click', handleClick);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      container.removeEventListener('dblclick', handleDblClick);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.removeEventListener('contextmenu', handleContextMenu);
      container.removeEventListener('click', handleClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []); // Empty dep array - bind once, read state from eventStateRef

  // ── 3.5 Async Terrain Sampling ──
  // WHY: Move terrain elevation queries off the render path.
  // Only recalculate when geometry changes or terrain tiles update.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Compute hash of current 2D geometry
    const currentHash = computeGeometryHash(geoJson);
    
    // Skip if geometry hasn't changed and we already have elevated data
    const geometryChanged = currentHash !== lastGeometryHashRef.current;
    const needsResampling = geometryChanged || (terrainEnabled && !elevatedGeoJson);
    
    // WHY: When geometry hasn't changed but properties have (e.g., altitude edit),
    // merge the new properties into the cached elevated features without resampling.
    if (!needsResampling && elevatedGeoJson && terrainEnabled) {
      // Check if properties have changed by comparing feature count and properties
      const propsNeedUpdate = geoJson.features.some((f, i) => {
        const elevatedFeature = elevatedGeoJson.features[i];
        if (!elevatedFeature) return true;
        // Compare stringified properties (quick shallow comparison)
        return JSON.stringify(f.properties) !== JSON.stringify(elevatedFeature.properties);
      }) || geoJson.features.length !== elevatedGeoJson.features.length;
      
      if (propsNeedUpdate) {
        // Merge new properties into elevated features without resampling coordinates
        setElevatedGeoJson(prev => ({
          ...prev,
          features: prev.features.map((elevatedFeat, i) => {
            const sourceFeat = geoJson.features[i];
            if (!sourceFeat) return elevatedFeat;
            return {
              ...elevatedFeat,
              properties: { ...sourceFeat.properties }
            };
          })
        }));
        // Also update ground route paths with new properties
        setGroundRoutePathsCache(prev => prev.map(item => {
          const sourceFeature = geoJson.features.find(
            f => f.properties?.featureType === 'groundRoute' && 
            JSON.stringify(f.geometry?.coordinates) === JSON.stringify(item.feature.geometry?.coordinates)
          );
          if (sourceFeature) {
            return { ...item, feature: { ...item.feature, properties: { ...sourceFeature.properties } } };
          }
          return item;
        }));
      }
      return;
    }

    // Prevent concurrent sampling operations
    if (terrainSamplingInProgressRef.current) {
      return;
    }

    // Clear cache when terrain is disabled
    if (!terrainEnabled) {
      clearTerrainCache();
      setElevatedGeoJson(null);
      setGroundRoutePathsCache([]);
      lastGeometryHashRef.current = null;
      return;
    }

    // Start async terrain sampling
    terrainSamplingInProgressRef.current = true;
    
    sampleTerrainAsync(geoJson, map, terrainEnabled)
      .then(({ elevatedFeatures, groundRoutePaths }) => {
        setElevatedGeoJson({
          type: 'FeatureCollection',
          features: elevatedFeatures
        });
        setGroundRoutePathsCache(groundRoutePaths);
        lastGeometryHashRef.current = currentHash;
      })
      .catch(err => {
        console.warn('Terrain sampling failed:', err);
      })
      .finally(() => {
        terrainSamplingInProgressRef.current = false;
      });
  }, [geoJson, terrainEnabled]);

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

    // WHY: Use pre-computed elevated geometry from async terrain sampling.
    // This keeps terrain queries off the render path for better performance.
    // Fall back to original geoJson if elevated data isn't ready yet.
    const dataWithElevation = (terrainEnabled && elevatedGeoJson) ? elevatedGeoJson : geoJson;

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
      getLineWidth: 2,  // 2 pixels - constant screen-space thickness
      lineWidthUnits: 'pixels',  // WHY: Ensures all shape borders stay same thickness at all zoom levels
      getPointRadius: 6,
      pointRadiusMinPixels: 4,

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

    // ── Unified 3D Zoned Layers (Geofence, NFZ, SearchZone) ──
    const zonedFeatures = dataWithElevation.features.filter(f => 
      ['geofence', 'nfz', 'searchZone'].includes(f.properties?.featureType)
    );

    const zonedIndexMap = new Map();
    dataWithElevation.features.forEach((f, idx) => {
      if (['geofence', 'nfz', 'searchZone'].includes(f.properties?.featureType)) {
        zonedIndexMap.set(f, idx);
      }
    });

    // Color definitions per feature type [R, G, B, A]
    // Wall opacity matches original fill colors for consistent appearance
    const STYLE_MAP = {
      geofence:   { wall: [255, 165, 0, 100], border: [255, 165, 0, 255], cap: null }, // No top cap
      nfz:        { wall: [220, 53, 69, 90],  border: [220, 53, 69, 255], cap: [220, 53, 69, 60] },
      searchZone: { wall: [59, 130, 246, 80], border: [59, 130, 246, 255], cap: [59, 130, 246, 50] }
    };

    const wallSegments = [];
    const borderData = [];
    const ceilingData = [];

    zonedFeatures.forEach(feature => {
      const coords = feature.geometry.coordinates[0] || feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;

      const type = feature.properties?.featureType;
      const featureIndex = zonedIndexMap.get(feature);
      const style = STYLE_MAP[type];

      // Determine elevation profile
      let baseOffset = 0;
      let topOffset = feature.properties?.altitude || (type === 'geofence' ? 150 : 100);
      if (type === 'nfz') {
        baseOffset = feature.properties?.floor || 0;
        topOffset = feature.properties?.ceiling || 400;
      }

      // 1. Build Border Path (Top edge)
      borderData.push({
        featureIndex,
        color: style.border,
        path: coords.map(c => [c[0], c[1], (c[2] || 0) + topOffset])
      });

      // 2. Build Top Cap / Ceiling (If applicable)
      if (style.cap) {
        ceilingData.push({
          featureIndex,
          color: style.cap,
          polygon: coords.map(c => [c[0], c[1], (c[2] || 0) + topOffset])
        });
      }

      // 3. Build Wall Quads
      const isClosed = coords[0][0] === coords[coords.length - 1][0] && 
                       coords[0][1] === coords[coords.length - 1][1];
      const loopCount = isClosed ? coords.length - 1 : coords.length;

      for (let i = 0; i < loopCount; i++) {
        const p1 = coords[i];
        const p2 = coords[(i + 1) % coords.length];
        const baseZ1 = (p1[2] || 0) + baseOffset;
        const baseZ2 = (p2[2] || 0) + baseOffset;
        const topZ1 = (p1[2] || 0) + topOffset;
        const topZ2 = (p2[2] || 0) + topOffset;

        wallSegments.push({
          featureIndex,
          color: style.wall,
          polygon: [
            [p1[0], p1[1], baseZ1],
            [p2[0], p2[1], baseZ2],
            [p2[0], p2[1], topZ2],
            [p1[0], p1[1], topZ1]
          ]
        });
      }
    });

    // ── Instantiate Unified Layers ──
    const unifiedWallLayer = new SolidPolygonLayer({
      id: 'unified-walls',
      data: wallSegments,
      _full3d: true,
      getPolygon: d => d.polygon,
      getFillColor: d => d.color,
      pickable: true,
      parameters: { depthWriteEnabled: true, depthCompare: 'less-equal', cull: false }
    });

    const unifiedBorderLayer = new PathLayer({
      id: 'unified-borders',
      data: borderData,
      getPath: d => d.path,
      getColor: d => d.color,
      getWidth: 3,
      widthUnits: 'pixels',
      pickable: true,
      pickingRadius: 15,
      parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' }
    });

    const unifiedCeilingLayer = new SolidPolygonLayer({
      id: 'unified-ceilings',
      data: ceilingData,
      getPolygon: d => d.polygon,
      getFillColor: d => d.color,
      pickable: true,
      parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' }
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
      getWidth: 4,  // 4 pixels - constant screen-space thickness
      widthUnits: 'pixels',  // WHY: Ensures line stays same thickness at all zoom levels
      pickable: true,
      parameters: {
        depthWriteEnabled: true,
        depthCompare: 'less-equal'
      }
    });

    // Ground Route layer (follows terrain using PathLayer with dense terrain sampling)
    // WHY: Use pre-computed dense paths from async terrain sampling.
    // The paths are sampled at many points along the route for smooth elevation following.
    const groundRouteData = (terrainEnabled && groundRoutePathsCache.length > 0)
      ? groundRoutePathsCache
      : geoJson.features
          .filter(f => f.properties?.featureType === 'groundRoute')
          .map((feature, idx) => {
            const coords = feature.geometry?.coordinates || [];
            // Flat fallback - no terrain elevation
            const flatPath = coords.map(c => [c[0], c[1], 0]);
            return { feature, featureIndex: idx, densePath: flatPath };
          });

    const groundRouteLayer = new PathLayer({
      id: 'groundRoute-path',
      data: groundRouteData,
      getPath: d => d.densePath,
      getColor: [139, 90, 43, 255],  // Brown/tan for ground
      getWidth: 4,  // 4 pixels - constant screen-space thickness
      widthUnits: 'pixels',  // WHY: Ensures line stays same thickness at all zoom levels
      pickable: true,
      // WHY: depthCompare 'always' renders on top of terrain like a painted overlay
      parameters: {
        depthWriteEnabled: false,
        depthCompare: 'always'
      }
    });

    overlay.setProps({
      layers: [
        unifiedWallLayer, 
        unifiedBorderLayer, 
        unifiedCeilingLayer, 
        airRouteElevatedLayer, 
        groundRouteLayer, 
        editableLayer
      ],
      // WHY: Sync internal deck.gl cursor state with our active mode
      getCursor: () => (activeMode !== 'view' ? (activeMode === 'modify' ? 'grab' : 'crosshair') : 'auto')
    });
  }, [geoJson, activeMode, selectedFeatureIndexes, terrainEnabled, elevatedGeoJson, groundRoutePathsCache]);


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

  // ── UI Styles ──
  const HEADER_HEIGHT = '44px';
  
  const frameStyle = {
    position: 'relative',
    width: '100%',
    height: '100%',
    backgroundColor: SURFACE_BG,
    padding: `${HEADER_HEIGHT} ${FRAME_WIDTH} ${FRAME_WIDTH} ${FRAME_WIDTH}`,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: SYSTEM_FONT
  };

  const mapViewportStyle = {
    position: 'relative',
    flex: 1,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    border: '1px solid #3a3a3c'
  };

  const toolbarBtnStyle = (active, color = ACCENT_PRIMARY) => ({
    width: '34px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: active ? color : 'rgba(255,255,255,0.06)',
    border: 'none',
    color: active ? '#fff' : '#98989d',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 500,
    fontFamily: SYSTEM_FONT,
    borderRadius: '4px',
    transition: 'all 0.15s ease'
  });

  const bottomBarStyle = {
    position: 'absolute',
    bottom: '1px',
    left: FRAME_WIDTH,
    right: FRAME_WIDTH,
    height: '18px',
    fontSize: '11px',
    color: '#636366',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 10px',
    fontFamily: SYSTEM_FONT,
    letterSpacing: '0'
  };

  // Mode border color for active drawing states
  const getModeAccent = () => {
    if (activeMode === 'nfz') return 'rgba(220, 83, 96, 0.5)';
    if (activeMode === 'geofence') return 'rgba(255, 180, 70, 0.5)';
    if (activeMode === 'searchZone') return 'rgba(100, 149, 237, 0.5)';
    if (activeMode === 'airRoute' || activeMode === 'groundRoute') return 'rgba(72, 187, 143, 0.5)';
    if (activeMode === 'modify') return 'rgba(255, 255, 255, 0.2)';
    return '#3a3a3c';
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
        padding: '0 20px',
        fontFamily: SYSTEM_FONT,
        borderBottom: '1px solid #2c2c2e',
        zIndex: 2
      } 
    },
      // Left side - title
      React.createElement('div', { 
        style: { display: 'flex', alignItems: 'center', gap: '10px' } 
      },
        React.createElement('span', { 
          style: { color: '#f5f5f7', fontWeight: 600, fontSize: '14px', letterSpacing: '0.3px' } 
        }, 'OpenC2'),
        React.createElement('span', { 
          style: { color: '#636366', fontSize: '12px' } 
        }, 'Command & Control')
      ),
      // Right side - toolbar buttons
      React.createElement('div', { 
        style: { display: 'flex', alignItems: 'center', gap: '6px' } 
      },
        // Terrain Toggle
        React.createElement('button', {
          style: toolbarBtnStyle(terrainEnabled, ACCENT_PRIMARY),
          onClick: () => setTerrainEnabled(!terrainEnabled),
          title: terrainEnabled ? 'Disable 3D Terrain' : 'Enable 3D Terrain'
        }, terrainEnabled ? '3D' : '2D'),
        // Satellite Toggle
        React.createElement('button', {
          style: toolbarBtnStyle(satelliteEnabled, ACCENT_SECONDARY),
          onClick: () => setSatelliteEnabled(!satelliteEnabled),
          title: satelliteEnabled ? 'Switch to Street Map' : 'Switch to Satellite'
        }, 'Sat'),
        // Mission Flyout Toggle
        React.createElement('button', {
          style: toolbarBtnStyle(showMissionFlyout, ACCENT_PRIMARY),
          onClick: () => setShowMissionFlyout(!showMissionFlyout),
          title: 'Mission Elements'
        }, '\u2630')
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
          background: 'rgba(28, 28, 30, 0.96)',
          borderLeft: '1px solid #3a3a3c',
          zIndex: 5,
          padding: '16px',
          backdropFilter: 'blur(20px)',
          fontFamily: SYSTEM_FONT,
          overflowY: 'auto',
          transform: showMissionFlyout ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 200ms ease-out',
          boxShadow: showMissionFlyout ? '-4px 0 24px rgba(0,0,0,0.3)' : 'none'
        },
        onClick: (e) => e.stopPropagation()
      },
        React.createElement('div', {
          style: { color: '#f5f5f7', marginBottom: '14px', fontWeight: 600, fontSize: '13px' }
        }, 'Mission Elements'),
        
        // Drawing mode indicator
        activeMode !== 'view' && activeMode !== 'modify' && React.createElement('div', {
          style: {
            padding: '10px 12px',
            marginBottom: '12px',
            background: 'rgba(100, 116, 139, 0.15)',
            border: '1px solid rgba(100, 116, 139, 0.3)',
            borderRadius: '4px',
            fontSize: '11px',
            color: '#f5f5f7',
            textAlign: 'center'
          }
        }, `Drawing: ${activeMode.charAt(0).toUpperCase() + activeMode.slice(1)}`),
        
        geoJson.features.length === 0
          ? React.createElement('div', {
              style: { color: '#555', fontSize: '11px', padding: '8px 0' }
            }, 'No elements. Right-click map to add.')
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
              const featureColor = typeColors[featureType] || '#64748b';
              
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
                padding: '5px 8px',
                borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(0,0,0,0.2)',
                color: '#f5f5f7',
                fontSize: '11px',
                textAlign: 'center',
                fontFamily: SYSTEM_FONT
              };
              
              return React.createElement('div', { key: i },
                // Element row
                React.createElement('div', {
                  style: {
                    padding: '10px 12px',
                    marginBottom: isSelected ? '0' : '4px',
                    background: isSelected ? 'rgba(100, 116, 139, 0.2)' : 'transparent',
                    borderLeft: `3px solid ${featureColor}`,
                    fontSize: '12px',
                    color: isSelected ? '#f5f5f7' : '#98989d',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  },
                  onMouseEnter: (e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; },
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
                    padding: '12px 12px',
                    marginBottom: '4px',
                    borderLeft: `3px solid ${featureColor}`,
                    background: 'rgba(0, 0, 0, 0.2)',
                    fontSize: '11px'
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
                      borderRadius: '4px',
                      border: '1px solid rgba(220, 83, 96, 0.4)',
                      background: 'transparent',
                      color: '#e05561',
                      fontSize: '11px',
                      fontWeight: 500,
                      fontFamily: SYSTEM_FONT,
                      cursor: 'pointer',
                      transition: 'all 0.15s'
                    },
                    onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(220, 83, 96, 0.15)'; },
                    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                    onClick: () => {
                      setGeoJson(prev => ({
                        ...prev,
                        features: prev.features.filter((_, idx) => idx !== i)
                      }));
                      setSelectedFeatureIndexes([]);
                      setActiveMode('view');
                    }
                  }, 'Delete')
                ),
                
                // For elements without altitude (groundRoute, searchPoint), show just delete
                isSelected && !['geofence', 'nfz', 'searchZone', 'airRoute'].includes(featureType) && React.createElement('div', {
                  style: {
                    padding: '10px 12px',
                    marginBottom: '4px',
                    borderLeft: `3px solid ${featureColor}`,
                    background: 'rgba(0, 0, 0, 0.2)'
                  },
                  onClick: (e) => e.stopPropagation()
                },
                  React.createElement('button', {
                    style: {
                      width: '100%',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      border: '1px solid rgba(220, 83, 96, 0.4)',
                      background: 'transparent',
                      color: '#e05561',
                      fontSize: '11px',
                      fontWeight: 500,
                      fontFamily: SYSTEM_FONT,
                      cursor: 'pointer',
                      transition: 'all 0.15s'
                    },
                    onMouseEnter: (e) => { e.currentTarget.style.background = 'rgba(220, 83, 96, 0.15)'; },
                    onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
                    onClick: () => {
                      setGeoJson(prev => ({
                        ...prev,
                        features: prev.features.filter((_, idx) => idx !== i)
                      }));
                      setSelectedFeatureIndexes([]);
                      setActiveMode('view');
                    }
                  }, 'Delete')
                )
              );
            })
      ),
    
    // Context menu (right-click)
    missionMenu.visible && React.createElement('div', {
      style: {
        position: 'fixed',
        top: missionMenu.y,
        left: missionMenu.x,
        zIndex: 10,
        background: 'rgba(28, 28, 30, 0.96)',
        border: '1px solid #48484a',
        borderRadius: '6px',
        padding: '6px 0',
        minWidth: '180px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(20px)',
        fontFamily: SYSTEM_FONT,
        fontSize: '13px'
      },
      onClick: (e) => e.stopPropagation()
    },
      // Feature context menu (when right-clicking on a feature)
      missionMenu.featureIndex !== null ? React.createElement(React.Fragment, null,
        React.createElement('div', {
          style: { padding: '8px 14px', color: '#98989d', fontSize: '11px', fontWeight: 500 }
        }, `Element [${String(missionMenu.featureIndex).padStart(2, '0')}]`),
        // Edit option
        React.createElement('div', {
          style: {
            padding: '8px 14px',
            color: '#ccc',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            transition: 'all 0.15s',
            borderLeft: '2px solid transparent',
            fontFamily: SYSTEM_FONT
          },
          onMouseEnter: (e) => { 
            e.currentTarget.style.background = 'rgba(100, 116, 139, 0.2)';
            e.currentTarget.style.borderLeftColor = '#64748b';
            e.currentTarget.style.color = '#fff';
          },
          onMouseLeave: (e) => { 
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderLeftColor = 'transparent';
            e.currentTarget.style.color = '#ccc';
          },
          onClick: () => {
            const idx = missionMenu.featureIndex;
            setMissionMenu({ visible: false, x: 0, y: 0, lngLat: null, featureIndex: null });
            setSelectedFeatureIndexes([idx]);
            setActiveMode('modify');
            setShowMissionFlyout(true);
          }
        }, '\u270F\uFE0F Edit Shape'),
        // Properties option
        React.createElement('div', {
          style: {
            padding: '8px 14px',
            color: '#ccc',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            transition: 'all 0.15s',
            borderLeft: '2px solid transparent',
            fontFamily: SYSTEM_FONT
          },
          onMouseEnter: (e) => { 
            e.currentTarget.style.background = 'rgba(100, 116, 139, 0.2)';
            e.currentTarget.style.borderLeftColor = '#3b82f6';
            e.currentTarget.style.color = '#fff';
          },
          onMouseLeave: (e) => { 
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderLeftColor = 'transparent';
            e.currentTarget.style.color = '#ccc';
          },
          onClick: () => {
            const idx = missionMenu.featureIndex;
            setMissionMenu({ visible: false, x: 0, y: 0, lngLat: null, featureIndex: null });
            setSelectedFeatureIndexes([idx]);
            setShowMissionFlyout(true);
          }
        }, '\u2699\uFE0F Properties'),
        // Divider
        React.createElement('div', {
          style: { height: '1px', background: '#48484a', margin: '4px 0' }
        }),
        // Delete option
        React.createElement('div', {
          style: {
            padding: '8px 14px',
            color: '#e05561',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            transition: 'all 0.15s',
            borderLeft: '2px solid transparent',
            fontFamily: SYSTEM_FONT
          },
          onMouseEnter: (e) => { 
            e.currentTarget.style.background = 'rgba(220, 83, 96, 0.15)';
            e.currentTarget.style.borderLeftColor = '#dc3545';
          },
          onMouseLeave: (e) => { 
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderLeftColor = 'transparent';
          },
          onClick: () => {
            const idx = missionMenu.featureIndex;
            setMissionMenu({ visible: false, x: 0, y: 0, lngLat: null, featureIndex: null });
            setGeoJson(prev => ({
              ...prev,
              features: prev.features.filter((_, i) => i !== idx)
            }));
            setSelectedFeatureIndexes([]);
            setActiveMode('view');
          }
        }, '\u{1F5D1}\uFE0F Delete'),
        // Divider
        React.createElement('div', {
          style: { height: '1px', background: '#48484a', margin: '4px 0' }
        }),
        // Copy Coordinates option
        React.createElement('div', {
          style: {
            padding: '8px 14px',
            color: '#ccc',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            transition: 'all 0.15s',
            borderLeft: '2px solid transparent',
            fontFamily: SYSTEM_FONT
          },
          onMouseEnter: (e) => { 
            e.currentTarget.style.background = 'rgba(100, 116, 139, 0.2)';
            e.currentTarget.style.borderLeftColor = '#64748b';
            e.currentTarget.style.color = '#fff';
          },
          onMouseLeave: (e) => { 
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderLeftColor = 'transparent';
            e.currentTarget.style.color = '#ccc';
          },
          onClick: () => {
            const coords = missionMenu.lngLat;
            if (coords) {
              navigator.clipboard.writeText(`${coords[1].toFixed(6)},${coords[0].toFixed(6)}`);
            }
            setMissionMenu({ visible: false, x: 0, y: 0, lngLat: null, featureIndex: null });
          }
        }, '\u{1F4CB} Copy Coordinates')
      ) :
      // Add element menu (when right-clicking on empty space)
      React.createElement(React.Fragment, null,
        React.createElement('div', {
          style: { padding: '8px 14px', color: '#98989d', fontSize: '11px', fontWeight: 500 }
        }, 'Add Element'),
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
              transition: 'all 0.15s',
              borderLeft: '2px solid transparent',
              fontFamily: SYSTEM_FONT
            },
            onMouseEnter: (e) => { 
              e.currentTarget.style.background = 'rgba(100, 116, 139, 0.2)'; 
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
              setMissionMenu({ visible: false, x: 0, y: 0, lngLat: null, featureIndex: null });

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
        }),
        // Divider
        React.createElement('div', {
          style: { height: '1px', background: '#48484a', margin: '4px 0' }
        }),
        // Copy Coordinates option
        React.createElement('div', {
          style: {
            padding: '8px 14px',
            color: '#ccc',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            transition: 'all 0.15s',
            borderLeft: '2px solid transparent',
            fontFamily: SYSTEM_FONT
          },
          onMouseEnter: (e) => { 
            e.currentTarget.style.background = 'rgba(100, 116, 139, 0.2)';
            e.currentTarget.style.borderLeftColor = '#64748b';
            e.currentTarget.style.color = '#fff';
          },
          onMouseLeave: (e) => { 
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderLeftColor = 'transparent';
            e.currentTarget.style.color = '#ccc';
          },
          onClick: () => {
            const coords = missionMenu.lngLat;
            if (coords) {
              navigator.clipboard.writeText(`${coords[1].toFixed(6)},${coords[0].toFixed(6)}`);
            }
            setMissionMenu({ visible: false, x: 0, y: 0, lngLat: null, featureIndex: null });
          }
        }, '\u{1F4CB} Copy Coordinates')
      )
    ),

    // ── HELP OVERLAY MODAL ──
    showHelpOverlay && React.createElement('div', {
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      },
      onClick: () => setShowHelpOverlay(false)
    },
      React.createElement('div', {
        style: {
          background: '#1c1c1e',
          border: '1px solid #3a3a3c',
          borderRadius: '12px',
          padding: '24px',
          maxWidth: '480px',
          width: '90%',
          maxHeight: '80%',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          fontFamily: SYSTEM_FONT
        },
        onClick: (e) => e.stopPropagation()
      },
        // Header
        React.createElement('div', {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '20px',
            paddingBottom: '12px',
            borderBottom: '1px solid #3a3a3c'
          }
        },
          React.createElement('h2', {
            style: { margin: 0, color: '#f5f5f7', fontSize: '18px', fontWeight: 600 }
          }, 'Controls & Usage'),
          React.createElement('button', {
            style: {
              background: 'none',
              border: 'none',
              color: '#8e8e93',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '4px 8px',
              lineHeight: 1
            },
            onClick: () => setShowHelpOverlay(false)
          }, '\u00D7')
        ),

        // Controls section
        React.createElement('div', { style: { marginBottom: '20px' } },
          React.createElement('h3', {
            style: { color: '#f5f5f7', fontSize: '13px', fontWeight: 600, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }
          }, 'Navigation'),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Pan'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Left-click + drag')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Zoom'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Scroll wheel')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Orbit / Tilt (3D)'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Option + drag / Middle-click drag')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Orbit (Mouse)'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Right-click hold + drag')
            )
          )
        ),

        // Interaction section
        React.createElement('div', { style: { marginBottom: '20px' } },
          React.createElement('h3', {
            style: { color: '#f5f5f7', fontSize: '13px', fontWeight: 600, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }
          }, 'Interaction'),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Select / Edit element'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Click on element')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Context menu'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Right-click (quick tap)')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Delete element'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Select + Delete/Backspace')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Cancel / Deselect'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Escape')
            )
          )
        ),

        // Drawing section
        React.createElement('div', null,
          React.createElement('h3', {
            style: { color: '#f5f5f7', fontSize: '13px', fontWeight: 600, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }
          }, 'Drawing'),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Add element'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Right-click on empty space')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Place points'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Click to add vertices')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Finish shape'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Double-click / Enter')
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', color: '#ccc', fontSize: '13px' } },
              React.createElement('span', null, 'Cancel drawing'),
              React.createElement('span', { style: { color: '#8e8e93' } }, 'Escape / Right-click')
            )
          )
        ),

        // Tip
        React.createElement('div', {
          style: {
            marginTop: '20px',
            padding: '12px',
            background: 'rgba(100, 116, 139, 0.15)',
            borderRadius: '8px',
            border: '1px solid rgba(100, 116, 139, 0.3)'
          }
        },
          React.createElement('span', { style: { color: '#8e8e93', fontSize: '12px' } },
            '\u{1F4A1} Tip: Click the "2D" button in the toolbar to switch to 3D mode, enabling camera orbit and tilt.'
          )
        )
      )
    )
    ), // End mapViewportStyle div

    // ── BOTTOM STATUS BAR ──
    React.createElement('div', { style: bottomBarStyle },
      // Left side - help button and status
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        React.createElement('button', {
          style: {
            width: '16px',
            height: '16px',
            borderRadius: '50%',
            border: '1px solid #636366',
            background: 'transparent',
            color: '#636366',
            fontSize: '10px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            lineHeight: 1,
            transition: 'all 0.15s ease'
          },
          onMouseEnter: (e) => {
            e.currentTarget.style.borderColor = '#8e8e93';
            e.currentTarget.style.color = '#8e8e93';
          },
          onMouseLeave: (e) => {
            e.currentTarget.style.borderColor = '#636366';
            e.currentTarget.style.color = '#636366';
          },
          onClick: () => setShowHelpOverlay(true),
          title: 'Help & Controls'
        }, '?'),
        React.createElement('span', null, `${activeMode.charAt(0).toUpperCase() + activeMode.slice(1)} mode`)
      ),
      // Right side - coordinates
      React.createElement('span', { 
        ref: coordsSpanRef,
        style: { color: '#8e8e93', fontVariantNumeric: 'tabular-nums' } 
      }, '—')
    )
  );
}

function App() {
  return React.createElement('div', { 
    style: { 
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif",
      background: '#1c1c1e',
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