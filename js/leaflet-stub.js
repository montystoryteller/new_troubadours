// Minimal Leaflet stand-in that records what the page asks for.
window.__markers = [];
window.__lines = [];
(function () {
  const noop = function () { return this; };
  class Layer { constructor(){ this.opts={}; this.handlers={}; } addTo(){ return this; } remove(){ return this; } on(ev,fn){ this.handlers[ev]=fn; return this; }
    bindTooltip(t){ this.tip = t; return this; } bindPopup(c){ this.popup = c; return this; } clearLayers(){ return this; } getLatLng(){ return this.ll; } openPopup(){ window.__opened = this; return this; } }
  const container = document.createElement('div');
  const map = { setView: noop, invalidateSize: noop, fitBounds(b,o){ window.__fit=b; return this; }, flyTo(ll,z){ window.__fly=[ll,z]; return this; }, setMaxBounds: noop, setMinZoom: noop, on: noop, off: noop,
    getContainer(){ return container; }, dragging: { enable: noop, disable: noop }, scrollWheelZoom: { enable: noop, disable: noop },
    addLayer: noop, removeLayer: noop, getZoom(){ return 6; } };
  window.L = {
    map: () => map,
    tileLayer: () => new Layer(),
    layerGroup: () => new Layer(),
    divIcon: (o) => o,
    marker: (ll, o) => { const m = new Layer(); m.ll = ll; m.icon = o.icon; window.__markers.push(m); return m; },
    circleMarker: (ll, o) => { const m = new Layer(); m.ll = ll; m.opts = o; window.__dots = window.__dots || []; window.__dots.push(m); return m; },
    circle: (ll, o) => { const m = new Layer(); m.ll = ll; m.opts = o; window.__circles = (window.__circles||[]); window.__circles.push(m); return m; },
    polyline: (pts, o) => { const l = new Layer(); l.pts = pts; l.opts = o || {}; window.__lines.push(l); return l; },
    latLngBounds: (pts) => ({ pts, pad(){ return this; } }),
    control: { zoom: () => new Layer() }, DomEvent: { on: noop, stopPropagation: noop },
    Control: { extend: () => function(){ return new Layer(); } }, Browser: { mobile: false, touch: false },
    point: (x,y)=>({x,y}),
  };
})();
