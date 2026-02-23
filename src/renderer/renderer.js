// basic React app without JSX so no build step required
const React = require('react');
const ReactDOM = require('react-dom');

// simple map component using MapLibre GL
function MapComponent() {
  const mapContainerRef = React.useRef(null);

  React.useEffect(() => {
    // require so we don't need a bundler; it returns the Map class
    const maplibregl = require('maplibre-gl');
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty', // public URL for initial testing
      center: [13.388, 52.517],
      zoom: 9.5
    });

    // cleanup on unmount
    return () => map.remove();
  }, []);

  return React.createElement('div', {
    id: 'map',
    ref: mapContainerRef,
    style: { width: '100%', height: '600px', marginTop: '1rem' }
  });
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
