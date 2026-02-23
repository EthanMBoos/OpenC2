// this file is optional but can hold map logic if you prefer splitting components
const React = require('react');

function MapComponent() {
  const mapContainerRef = React.useRef(null);

  React.useEffect(() => {
    const maplibregl = require('maplibre-gl');
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [13.388, 52.517],
      zoom: 9.5
    });
    return () => map.remove();
  }, []);

  return React.createElement('div', {
    id: 'map',
    ref: mapContainerRef,
    style: { width: '100%', height: '600px' }
  });
}

module.exports = MapComponent;
