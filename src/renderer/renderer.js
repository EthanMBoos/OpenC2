// basic React app without JSX so no build step required
const React = require('react');
const ReactDOM = require('react-dom');

// simple map component using MapLibre GL
function MapComponent() {
  const mapContainerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const terrainEnabledRef = React.useRef(false);
  const [terrainEnabled, setTerrainEnabled] = React.useState(false);

  React.useEffect(() => {
    // require so we don't need a bundler; it returns the Map class
    const maplibregl = require('maplibre-gl');
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty', // public URL for initial testing
      center: [13.388, 52.517],
      zoom: 9.5,
      pitch: 0,
      bearing: 0,
      maxPitch: 0,             // start in 2D – no pitch allowed
      dragRotate: false        // we replace with a dampened version below
    });
    mapRef.current = map;

    // ── Dampened right-click drag rotation ──
    // Lower sensitivity = harder to spin the camera wildly.
    // Adjust BEARING_SENSITIVITY and PITCH_SENSITIVITY (0-1) to taste.
    const BEARING_SENSITIVITY = 0.25;
    const PITCH_SENSITIVITY   = 0.25;

    let isRightDragging = false;
    let lastX = 0;
    let lastY = 0;
    const canvas = map.getCanvas();

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) {          // right-click
        isRightDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!isRightDragging) return;
      // In 2D mode, block all rotation
      if (!terrainEnabledRef.current) return;

      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;

      map.setBearing(map.getBearing() + dx * BEARING_SENSITIVITY);
      map.setPitch(
        Math.max(0, Math.min(75, map.getPitch() - dy * PITCH_SENSITIVITY))
      );

      lastX = e.clientX;
      lastY = e.clientY;
    });

    const stopDrag = (e) => {
      if (e.button === 2) isRightDragging = false;
    };
    canvas.addEventListener('mouseup', stopDrag);
    canvas.addEventListener('mouseleave', () => { isRightDragging = false; });

    // cleanup on unmount
    return () => {
      canvas.removeEventListener('mouseup', stopDrag);
      map.remove();
    };
  }, []);

  // Toggle terrain on/off when state changes
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    terrainEnabledRef.current = terrainEnabled;

    function applyTerrain() {
      if (terrainEnabled) {
        // Switch to 3D: allow pitch & rotation
        map.setMaxPitch(75);
        // Add Mapterhorn raster-dem source if not already present
        if (!map.getSource('mapterhorn-dem')) {
          map.addSource('mapterhorn-dem', {
            type: 'raster-dem',
            tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
            encoding: 'terrarium',
            tileSize: 512
          });
        }
        // Add hillshade layer if not already present
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
        // Enable 3D terrain
        map.setTerrain({ source: 'mapterhorn-dem', exaggeration: 1.5 });
      } else {
        // Switch to 2D: reset camera to flat top-down
        map.setTerrain(null);
        map.setPitch(0);
        map.setBearing(0);
        map.setMaxPitch(0);    // lock out pitch completely in 2D
        // Remove hillshade layer and DEM source
        if (map.getLayer('mapterhorn-hillshade')) {
          map.removeLayer('mapterhorn-hillshade');
        }
        if (map.getSource('mapterhorn-dem')) {
          map.removeSource('mapterhorn-dem');
        }
      }
    }

    // If the map style is already loaded apply immediately, otherwise wait
    if (map.isStyleLoaded()) {
      applyTerrain();
    } else {
      map.once('style.load', applyTerrain);
    }
  }, [terrainEnabled]);

  const toggleBtnStyle = {
    position: 'absolute',
    top: '10px',
    right: '10px',
    zIndex: 1,
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
    React.createElement('div', {
      id: 'map',
      ref: mapContainerRef,
      style: { width: '100%', height: '100%' }
    }),
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
