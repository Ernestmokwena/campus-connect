let map;
let currentLocation = null;
let currentDestination = null;
let currentHeading = null;
let userMarker = null;
let destMarker = null;
let watchId = null;
let gpsRefreshTimer = null;
let hasLockedGps = false;
let isNavigating = false;
let currentMode = "walk";
let followMode = false;
let routeSource = null;
let routeLayer = null;
let networkSource = null;
let networkLayer = null;
let manualOrigin = false;

let isFetchingRoute = false;
let currentRouteRequestId = 0;
let offRouteCounter = 0;
let isOffRouteFlag = false;

const statusDiv = document.getElementById('gpsText');
const sheet = document.getElementById('navSheet');
const searchInput = document.getElementById('searchInput');
const suggestionsDropdown = document.getElementById('suggestionsDropdown');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const followBtn = document.getElementById('followMeBtn');
const offRouteBadge = document.getElementById('offRouteBadge');
const stopNavBtn = document.getElementById('stopNavBtn');

function getApiHeaders(extraHeaders = {}) {
    return {
        ...extraHeaders,
        'X-API-Key': window.APP_API_KEY || 'campus-local-dev-key'
    };
}
const rotationIndicator = document.getElementById('rotationIndicator');
const rotationNeedle = document.getElementById('rotationNeedle');
const rotationLabel = document.getElementById('rotationLabel');
let isDraggingCompass = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartBearing = 0;
let currentBearing = 0;
let targetBearing = 0;

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const φ1 = lat1 * toRad, φ2 = lat2 * toRad;
    const Δφ = (lat2 - lat1) * toRad;
    const Δλ = (lon2 - lon1) * toRad;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeBearing(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const toDeg = 180 / Math.PI;
    const φ1 = lat1 * toRad;
    const φ2 = lat2 * toRad;
    const Δλ = (lon2 - lon1) * toRad;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (toDeg * Math.atan2(y, x) + 360) % 360;
}

function getActiveBearing() {
    if (typeof currentHeading === 'number' && !isNaN(currentHeading)) {
        return currentHeading;
    }
    if (currentDestination && currentLocation) {
        return computeBearing(currentLocation.lat, currentLocation.lng, currentDestination.lat, currentDestination.lng);
    }
    return null;
}

// Create custom user marker using HTML element
function createUserMarkerElement(bearing) {
    const el = document.createElement('div');
    el.className = 'user-marker';
    const rotation = typeof bearing === 'number' ? bearing : 0;
    el.innerHTML = `
        <div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;position:relative;">
            <div style="width:18px;height:18px;background:#C8F135;border:2px solid #111D00;border-radius:50%;box-shadow:0 0 0 5px rgba(200,241,53,0.35);"></div>
            <div style="position:absolute;top:3px;left:50%;transform:translateX(-50%) rotate(${rotation}deg);transform-origin:50% 100%;">
                <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:14px solid #111D00;"></div>
            </div>
        </div>
    `;
    return el;
}

function updateBearingMarker() {
    if (!userMarker) return;
    const bearing = getActiveBearing();
    const el = createUserMarkerElement(bearing);
    userMarker.getElement().innerHTML = el.innerHTML;

    const displayBearing = typeof bearing === 'number' ? bearing : 0;
    updateCompass(displayBearing);

    // Auto-rotate map when following
    if (followMode && typeof currentHeading === 'number' && !isNaN(currentHeading)) {
        map.easeTo({ bearing: currentHeading, duration: 300 });
        updateCompass(currentHeading);
    }
}

function handleDeviceOrientation(event) {
    let heading = null;
    if (typeof event.webkitCompassHeading === 'number') {
        heading = event.webkitCompassHeading;
    } else if (typeof event.alpha === 'number') {
        const screenAngle = window.screen.orientation?.angle || window.orientation || 0;
        heading = 360 - event.alpha;
        heading = (heading + screenAngle) % 360;
    }
    if (typeof heading === 'number' && !isNaN(heading)) {
        currentHeading = heading;
        updateBearingMarker();
    }
}

function initHeadingSensors() {
    if (typeof DeviceOrientationEvent === 'undefined') return;
    const eventName = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    const addListener = () => window.addEventListener(eventName, handleDeviceOrientation, true);
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission()
            .then(permission => {
                if (permission === 'granted') addListener();
            })
            .catch(() => { });
    } else {
        addListener();
    }
}

function clearRouteLayer() {
    // Remove Solid
    if (map.getLayer('route-solid')) map.removeLayer('route-solid');
    if (map.getSource('route-solid')) map.removeSource('route-solid');
    
    // Remove all Dashed layers
    const layers = map.getStyle().layers;
    layers.forEach(layer => {
        if (layer.id && layer.id.startsWith('route-dashed-')) {
            map.removeLayer(layer.id);
            if (map.getSource(layer.id)) map.removeSource(layer.id);
        }
    });
}

function updateMetrics(distance) {
    if (!distance && distance !== 0) return;
    const time = currentMode === "walk" ? distance / (1.4 * 60) : distance / (8 * 60);
    const distText = distance < 1000 ? `${Math.round(distance)}m` : `${(distance / 1000).toFixed(1)}km`;
    document.getElementById('distanceVal').innerHTML = distText;
    document.getElementById('timeVal').innerHTML = `${Math.ceil(time)} min`;
    document.getElementById('compactDistance').innerHTML = distText;
}

function parseCoordinates(value) {
    if (!value) return null;
    const parts = value.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length !== 2) return null;
    const lat = parseFloat(parts[0].replace(/\s+/g, '').replace(',', '.'));
    const lng = parseFloat(parts[1].replace(/\s+/g, '').replace(',', '.'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

function updateDepartureDisplay() {
    const label = document.getElementById('departureLabelText');
    const input = document.getElementById('departureInput');
    if (input.dataset.editing === 'true') return;

    if (currentLocation) {
        label.textContent = `${currentLocation.lat.toFixed(5)}, ${currentLocation.lng.toFixed(5)}`;
    } else {
        label.textContent = 'Your location';
    }
}

function commitOriginInput() {
    const label = document.getElementById('departureLabelText');
    const input = document.getElementById('departureInput');
    const value = input.value.trim();
    const coords = parseCoordinates(value);

    input.dataset.editing = 'false';
    input.style.display = 'none';
    label.style.display = 'block';

    if (!coords) {
        statusDiv.innerHTML = 'Invalid origin format. Use lat, lng';
        updateDepartureDisplay();
        return;
    }

    manualOrigin = true;
    currentLocation = coords;
    document.getElementById('departureLabelText').textContent = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;

    if (userMarker) {
        userMarker.setLngLat([coords.lng, coords.lat]);
    }

    statusDiv.innerHTML = 'Origin set manually';
    if (currentDestination) {
        fetchRoute(false, currentLocation);
        const dist = haversine(currentLocation.lat, currentLocation.lng, currentDestination.lat, currentDestination.lng);
        updateMetrics(dist);
    }
}

function activateOriginInput() {
    const label = document.getElementById('departureLabelText');
    const input = document.getElementById('departureInput');
    input.value = currentLocation ? `${currentLocation.lat.toFixed(5)}, ${currentLocation.lng.toFixed(5)}` : '';
    label.style.display = 'none';
    input.style.display = 'block';
    input.dataset.editing = 'true';
    input.focus();
}

function setOriginFromGPS(lat, lng) {
    if (manualOrigin) return;
    currentLocation = { lat, lng };
    document.getElementById('departureLabelText').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

function enableGPSOrigin() {
    manualOrigin = false;
    if (currentLocation) updateDepartureDisplay();
}

function fetchRoute(forceReroute = false, startPoint = null) {
    if (!currentDestination) return;
    const routeStart = startPoint || currentLocation;
    if (!routeStart) return;
    if (isFetchingRoute) return;

    isFetchingRoute = true;
    const thisRequestId = ++currentRouteRequestId;

    //KILL MEMORY: Clear all route layers immediately to stop visual bleed
    clearRouteLayer();

    const url = `/api/route?startLat=${routeStart.lat}&startLng=${routeStart.lng}&endLat=${currentDestination.lat}&endLng=${currentDestination.lng}&mode=${currentMode}`;

    fetch(url, { headers: getApiHeaders() })
        .then(response => response.json())
        .then(data => {
            // Check Request ID: If this is not the latest request, ignore it
            if (thisRequestId !== currentRouteRequestId) {
                isFetchingRoute = false;
                return;
            }

            if (!data.path || data.path.length === 0) {
                isFetchingRoute = false;
                return;
            }

            const dashedSegments = window.DASHED_SEGMENTS || [];
            
            if (dashedSegments.length === 0) {
                drawSolidRoute(data.path, forceReroute, data.distance);
                isFetchingRoute = false;
                return;
            }

            // --- FETCH master ---
            fetch('/api/network-data', { headers: getApiHeaders() })
                .then(res => res.json())
                .then(geojson => {
                    // Double-check ID again in case of extreme lag
                    if (thisRequestId !== currentRouteRequestId) {
                        isFetchingRoute = false;
                        return;
                    }

                    // Build lookup map
                    const coordToPinMap = new Map();
                    geojson.features.forEach(f => {
                        const props = f.properties;
                        if (props && props.from) {
                            const startCoord = f.geometry.coordinates[0];
                            coordToPinMap.set(`${startCoord[1].toFixed(6)},${startCoord[0].toFixed(6)}`, props.from);
                        }
                        if (props && props.to) {
                            const endCoord = f.geometry.coordinates[f.geometry.coordinates.length - 1];
                            coordToPinMap.set(`${endCoord[1].toFixed(6)},${endCoord[0].toFixed(6)}`, props.to);
                        }
                    });

                    // Map route path to pins
                    const routePinNames = data.path.map(p => {
                        const key = `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
                        return coordToPinMap.get(key) || null;
                    });

                    // Find dash ranges
                    let dashRanges = [];
                    for (const [pinA, pinB] of dashedSegments) {
                        let idxA = -1, idxB = -1;
                        for (let i = 0; i < routePinNames.length; i++) {
                            if (routePinNames[i] === pinA) idxA = i;
                            if (routePinNames[i] === pinB) idxB = i;
                        }
                        if (idxA !== -1 && idxB !== -1) {
                            dashRanges.push({
                                start: Math.min(idxA, idxB),
                                end: Math.max(idxA, idxB)
                            });
                            console.log(`pass by ${pinA} <--> ${pinB}`);
                        }
                    }

                    const fullCoords = data.path.map(p => [p[1], p[0]]);

                    // DRAW SOLID (Use try/catch to prevent adding errors)
                    try {
                        if (fullCoords.length > 1) {
                            map.addSource('route-solid', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: fullCoords } } });
                            map.addLayer({ id: 'route-solid', type: 'line', source: 'route-solid', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': forceReroute ? '#F59E0B' : '#C8F135', 'line-width': 6, 'line-opacity': 0.95 } });
                        }
                    } catch(e) { console.warn("Solid route render issue:", e); }

                    // DRAW DASHED RANGES
// DRAW DASHED RANGES
dashRanges.forEach((range, index) => {
    const dashedCoords = fullCoords.slice(range.start, range.end + 1);
    if (dashedCoords.length > 1) {
        const sourceId = `route-dashed-${index}`;
        const layerId = `route-dashed-${index}`;
        try {
            map.addSource(sourceId, { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: dashedCoords } } });
            map.addLayer({ id: layerId, type: 'line', source: sourceId, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#f97316', 'line-width': 6, 'line-opacity': 0.95, 'line-dasharray': [15, 5] } });

            //Messages for dashed layers ! 
            // popup with your message and an icon
            const popup = new maplibregl.Popup({
                offset: 20,
                closeButton: false,
                closeOnClick: false,
                className: 'custom-dash-popup'
            }).setHTML(`
                <div style="display: flex; align-items: center; gap: 8px; font-family: 'DM Sans', sans-serif; font-size: 13px;">
                    <span style="font-size: 18px;"> <span class="material-symbols-outlined">turn_sharp_right</span> </span>
                    <span style="font-weight: 600;">Proceed to pass under this feature</span>
                </div>
            `);

            // Show popup on mouse enter
            map.on('mouseenter', layerId, (e) => {
                map.getCanvas().style.cursor = 'pointer';
                // Get the coordinates of the mouse position on the line
                const coordinates = e.lngLat;
                popup.setLngLat(coordinates).addTo(map);
            });

            //Hide popup on mouse leave
            map.on('mouseleave', layerId, () => {
                map.getCanvas().style.cursor = '';
                popup.remove();
            });

            // Keep popup open on click
            map.on('click', layerId, (e) => {
                const coordinates = e.lngLat;
                popup.setLngLat(coordinates).addTo(map);
            });

        } catch(e) { console.warn("Dashed route render issue:", e); }
    }
});

                    updateMetrics(data.distance);
                    isFetchingRoute = false;
                })
                .catch(err => {
                    if (thisRequestId === currentRouteRequestId) {
                        console.error("Error fetching network data:", err);
                        drawSolidRoute(data.path, forceReroute, data.distance);
                        isFetchingRoute = false;
                    }
                });
        })
        .catch(err => { 
            if (thisRequestId === currentRouteRequestId) {
                console.error("Route error:", err);
                isFetchingRoute = false;
            }
        });
}

function drawSolidRoute(path, forceReroute, distance) {
    const solidCoords = path.map(p => [p[1], p[0]]);
    if (solidCoords.length > 1) {
        map.addSource('route-solid', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: solidCoords } } });
        map.addLayer({ id: 'route-solid', type: 'line', source: 'route-solid', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': forceReroute ? '#F59E0B' : '#C8F135', 'line-width': 6, 'line-opacity': 0.95 } });
    }
    updateMetrics(distance);
}

// Helper function to draw solid path
function drawSolidRoute(path, forceReroute, distance) {
    console.log("Drawing solid route only.");
    const solidCoords = path.map(p => [p[1], p[0]]);
    if (solidCoords.length > 1) {
        map.addSource('route-solid', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: solidCoords } } });
        map.addLayer({ id: 'route-solid', type: 'line', source: 'route-solid', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': forceReroute ? '#F59E0B' : '#C8F135', 'line-width': 6, 'line-opacity': 0.95 } });
    }
    updateMetrics(distance);
}

// Helper function to draw solid path
function drawSolidRoute(path, forceReroute, distance) {
    console.log("Drawing solid route only.");
    const solidCoords = path.map(p => [p[1], p[0]]);
    if (solidCoords.length > 1) {
        map.addSource('route-solid', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: solidCoords } } });
        map.addLayer({ id: 'route-solid', type: 'line', source: 'route-solid', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': forceReroute ? '#F59E0B' : '#C8F135', 'line-width': 6, 'line-opacity': 0.95 } });
    }
    updateMetrics(distance);
}

// Load network overlay
async function loadNetworkOverlay() {
    try {
        const response = await fetch('/api/network-data', { headers: getApiHeaders() });
        const geojson = await response.json();

        if (geojson && geojson.features && geojson.features.length > 0) {
            map.addSource('network', {
                type: 'geojson',
                data: geojson
            });

            map.addLayer({
                id: 'network',
                type: 'line',
                source: 'network',
                layout: {
                    'visibility': 'none',
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#F2C94C',
                    'line-width': 3,
                    'line-opacity': 0.7
                }
            });

            statusDiv.classList.remove('loading');
            statusDiv.textContent = 'Ready';
        } else {
            statusDiv.classList.remove('loading');
            statusDiv.textContent = 'Ready';
        }
    } catch (err) {
        console.error('Failed to load network overlay:', err);
        statusDiv.classList.remove('loading');
        statusDiv.textContent = 'Ready';
    }
}

// async function loadNetworkOverlay() {
//     try {
//         const response = await fetch('/api/network-data');
//         const geojson = await response.json();

//         if (geojson && geojson.features && geojson.features.length > 0) {
            
//             // --- 1. Load your current dashed segments config ---
//             const dashedSegments = window.DASHED_SEGMENTS || [];
            
//             // Create a Set for fast lookup: "Pin A|Pin B" (sorted so direction doesn't matter)
//             const dashedLookup = new Set();
//             dashedSegments.forEach(([pinA, pinB]) => {
//                 // Sort the pins so "Pin 795|Pin 768" is the same as "Pin 768|Pin 795"
//                 const key = [pinA, pinB].sort().join('|');
//                 dashedLookup.add(key);
//             });

//             // --- 2. Separate features into "Normal" and "Dashed" ---
//             const normalFeatures = [];
//             const dashedFeatures = [];

//             geojson.features.forEach(feature => {
//                 const props = feature.properties;
//                 if (!props || !props.from || !props.to) {
//                     normalFeatures.push(feature);
//                     return;
//                 }

//                 // Check if this connection is in our dashed list
//                 const key = [props.from, props.to].sort().join('|');
//                 if (dashedLookup.has(key)) {
//                     dashedFeatures.push(feature);
//                 } else {
//                     normalFeatures.push(feature);
//                 }
//             });

//             // --- 3. Draw the NORMAL yellow lines ---
//             if (normalFeatures.length > 0) {
//                 map.addSource('network-normal', {
//                     type: 'geojson',
//                     data: {
//                         type: 'FeatureCollection',
//                         features: normalFeatures
//                     }
//                 });
//                 map.addLayer({
//                     id: 'network-normal',
//                     type: 'line',
//                     source: 'network-normal',
//                     layout: {
//                         'visibility': 'visible',
//                         'line-join': 'round',
//                         'line-cap': 'round'
//                     },
//                     paint: {
//                         'line-color': '#F2C94C',
//                         'line-width': 2.5,
//                         'line-opacity': 0.6
//                     }
//                 });
//             }

//             // --- 4. Draw the DASHED lines (Thick, Glowing, Orange) ---
//             if (dashedFeatures.length > 0) {
//                 map.addSource('network-dashed-preview', {
//                     type: 'geojson',
//                     data: {
//                         type: 'FeatureCollection',
//                         features: dashedFeatures
//                     }
//                 });

//                 // Glow layer
//                 map.addLayer({
//                     id: 'network-dashed-preview-glow',
//                     type: 'line',
//                     source: 'network-dashed-preview',
//                     layout: {
//                         'visibility': 'visible',
//                         'line-join': 'round',
//                         'line-cap': 'round'
//                     },
//                     paint: {
//                         'line-color': '#f97316',
//                         'line-width': 10,
//                         'line-blur': 8,
//                         'line-opacity': 0.4
//                     }
//                 });

//                 // Main thick line
//                 map.addLayer({
//                     id: 'network-dashed-preview-main',
//                     type: 'line',
//                     source: 'network-dashed-preview',
//                     layout: {
//                         'visibility': 'visible',
//                         'line-join': 'round',
//                         'line-cap': 'round'
//                     },
//                     paint: {
//                         'line-color': '#f97316',
//                         'line-width': 4,
//                         'line-opacity': 0.95,
//                         'line-dasharray': [12, 6]
//                     }
//                 });
//             }

//             // --- 5. Extract all unique Pins and their Coordinates (Same as before) ---
//             const pinMap = new Map(); 
//             geojson.features.forEach(feature => {
//                 const props = feature.properties;
//                 const coords = feature.geometry.coordinates;
//                 if (!props || !coords || coords.length === 0) return;
//                 if (props.from) pinMap.set(props.from, [coords[0][0], coords[0][1]]);
//                 if (props.to) {
//                     const lastCoord = coords[coords.length - 1];
//                     pinMap.set(props.to, [lastCoord[0], lastCoord[1]]);
//                 }
//             });

//             // --- 6. Draw Orange Circles for every Pin ---
//             pinMap.forEach((coords, pinName) => {
//                 const sourceId = `pin-${pinName.replace(/\s/g, '-')}`;
//                 map.addSource(sourceId, {
//                     type: 'geojson',
//                     data: {
//                         type: 'Feature',
//                         geometry: { type: 'Point', coordinates: coords },
//                         properties: { name: pinName }
//                     }
//                 });
//                 map.addLayer({
//                     id: sourceId,
//                     type: 'circle',
//                     source: sourceId,
//                     paint: {
//                         'circle-radius': 6,
//                         'circle-color': '#F2994A',
//                         'circle-stroke-width': 2,
//                         'circle-stroke-color': '#FFFFFF'
//                     }
//                 });

//                 const popup = new maplibregl.Popup({
//                     offset: 25,
//                     closeButton: false,
//                     closeOnClick: false
//                 }).setHTML(`<strong style="font-size:14px;">${pinName}</strong>`);

//                 map.on('mouseenter', sourceId, () => {
//                     map.getCanvas().style.cursor = 'pointer';
//                     popup.setLngLat(coords).addTo(map);
//                 });
//                 map.on('mouseleave', sourceId, () => {
//                     map.getCanvas().style.cursor = '';
//                     popup.remove();
//                 });
//             });

//             console.log(`✅ Network overlay loaded: ${pinMap.size} pins visible.`);
//             console.log(`📊 Dashed Preview: ${dashedFeatures.length} segments highlighted.`);
//             statusDiv.innerHTML = `Let's go! (${dashedFeatures.length} dashed segments highlighted)`;
//         } else {
//             statusDiv.innerHTML = "GPS ready · No network data";
//         }
//     } catch (err) {
//         console.error('Failed to load network overlay:', err);
//         statusDiv.innerHTML = "GPS ready";
//     }
// }

function addBoundaryLayers() {
    if (!map.getSource('boundary')) {
        map.addSource('boundary', {
            type: 'geojson',
            data: {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: []
                }
            }
        });
    }

    if (!map.getSource('mask')) {
        map.addSource('mask', {
            type: 'geojson',
            data: {
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: []
                }
            }
        });
    }

    if (!map.getLayer('mask-layer')) {
        map.addLayer({
            id: 'mask-layer',
            source: 'mask',
            type: 'fill',
            paint: {
                'fill-color': '#FAF2E5',
                'fill-opacity': 1,
                'fill-antialias': true
            }
        });
    }

    if (!map.getLayer('boundary-border')) {
        map.addLayer({
            id: 'boundary-border',
            source: 'boundary',
            type: 'line',
            paint: {
                'line-color': '#ffffff',
                'line-width': 5,
                'line-opacity': 0.9
            }
        });
    }

    if (!map.getLayer('boundary-glow')) {
        map.addLayer({
            id: 'boundary-glow',
            source: 'boundary',
            type: 'line',
            paint: {
                'line-color': '#F2C94C',
                'line-width': 12,
                'line-blur': 8,
                'line-opacity': 0.3
            }
        });
    }
}

async function loadBoundaryOverlay() {
    try {
        const response = await fetch('/api/boundary-data', { headers: getApiHeaders() });
        const boundaryData = await response.json();
        if (!boundaryData || !boundaryData.features) return;

        const allCoords = [];
        for (const feat of boundaryData.features) {
            if (feat.geometry && feat.geometry.type === 'LineString') {
                for (const c of feat.geometry.coordinates) {
                    allCoords.push(c);
                }
            }
        }

        if (allCoords.length < 4) return;

        const unique = [];
        for (let i = 0; i < allCoords.length; i++) {
            const curr = allCoords[i];
            const next = allCoords[(i + 1) % allCoords.length];
            if (curr[0] !== next[0] || curr[1] !== next[1]) {
                unique.push(curr);
            }
        }

        const first = unique[0];
        const last = unique[unique.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            unique.push([...first]);
        }

        const boundaryPolygonCoords = unique;
        const world = [
            [-180, -90],
            [180, -90],
            [180, 90],
            [-180, 90],
            [-180, -90]
        ];

        if (map.getSource('boundary')) {
            map.getSource('boundary').setData({
                type: 'Feature',
                geometry: {
                    type: 'Polygon',
                    coordinates: [boundaryPolygonCoords]
                }
            });
        }

        const maskFeature = {
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                coordinates: [world, boundaryPolygonCoords]
            }
        };

        if (map.getSource('mask')) {
            map.getSource('mask').setData(maskFeature);
        }
    } catch (err) {
        console.error('Failed to load boundary overlay:', err);
    }
}

function setDestination(dest) {
    clearRouteLayer();
    offRouteCounter = 0;
    isOffRouteFlag = false;

    currentDestination = dest;
    document.getElementById('destinationLabel').innerHTML = dest.name;
    document.getElementById('compactDest').innerHTML = dest.name;

    if (destMarker) destMarker.remove();

    // Create destination marker
    const el = document.createElement('div');
    el.innerHTML = `<div style="background:#C8F135; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; box-shadow:0 0 0 5px rgba(200,241,53,0.25), 0 2px 12px rgba(0,0,0,0.25); border:2px solid #111D00;"><span class="icon" style="color:#111D00; font-size:16px; font-family:'Material Symbols Outlined'; font-variation-settings:'FILL' 1;">location_on</span></div>`;

    destMarker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([dest.lng, dest.lat])
        .addTo(map);

    if (currentLocation) fetchRoute(false, currentLocation);
    updateBearingMarker();
    sheet.classList.remove('inactive');
    sheet.classList.add('expanded');
}

function syncTripButtons() {
    const startBtn = document.getElementById('startNavBtn');
    const stopBtn = document.getElementById('stopNavBtn');

    if (!startBtn || !stopBtn) return;

    const running = Boolean(isNavigating);
    startBtn.classList.toggle('hidden', running);
    startBtn.style.display = running ? 'none' : 'flex';
    stopBtn.classList.toggle('visible', running);
    stopBtn.style.display = running ? 'flex' : 'none';
}

function clearDestination() {
    clearRouteLayer();
    offRouteCounter = 0;
    isOffRouteFlag = false;

    currentDestination = null;

    if (destMarker) { destMarker.remove(); destMarker = null; }

    document.getElementById('destinationLabel').innerHTML = "Select destination";
    document.getElementById('compactDest').innerHTML = "Select destination";
    document.getElementById('distanceVal').innerHTML = "—";
    document.getElementById('timeVal').innerHTML = "—";
    document.getElementById('compactDistance').innerHTML = "—";
    sheet.classList.add('inactive');
    syncTripButtons();
}

function startNavigation() {
    if (!currentLocation) return;
    if (!currentDestination) {
        sheet.classList.add('expanded');
        searchInput.focus();
        return;
    }
    isNavigating = true;
    offRouteCounter = 0;
    isOffRouteFlag = false;
    syncTripButtons();

    fetchRoute(false, currentLocation);
    map.flyTo({
        center: [currentLocation.lng, currentLocation.lat],
        zoom: 18,
        duration: 1000
    });
    sheet.classList.remove('expanded');
    sheet.classList.add('collapsed');
}

function stopNavigation() {
    isNavigating = false;
    setFollowMode(false);
    clearDestination();
    offRouteBadge.style.display = 'none';
    syncTripButtons();
}

function setFollowMode(enabled) {
    followMode = enabled;
    if (followMode) {
        followBtn.classList.add('follow-active');
        if (currentLocation) {
            map.flyTo({
                center: [currentLocation.lng, currentLocation.lat],
                zoom: map.getZoom(),
                duration: 500
            });
        }
        rotationIndicator.style.background = 'rgba(16, 24, 39, 0.84)';
    } else {
        followBtn.classList.remove('follow-active');
        map.easeTo({ bearing: 0, duration: 500 });
        rotationIndicator.style.background = 'rgba(16, 24, 39, 0.84)';
    }
    updateBearingMarker();
}

function toggleFollowMode() { setFollowMode(!followMode); }

function resetNorth() {
    map.easeTo({ bearing: 0, duration: 500 });
    if (followMode) setFollowMode(false);
    updateCompass(0);
    map.setBearing(0);
}

function testRotation() {
    let rotationAngle = 0;
    const interval = setInterval(() => {
        rotationAngle = (rotationAngle + 45) % 360;
        map.easeTo({ bearing: rotationAngle, duration: 600 });
        updateCompass(rotationAngle);
        map.setBearing(rotationAngle);
        if (rotationAngle === 0) {
            clearInterval(interval);
            updateCompass(0);
            map.setBearing(0);
        }
    }, 800);
}

function normalizeSearchText(value) {
    return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function updateCompass(bearingDeg) {
    const normalized = ((bearingDeg % 360) + 360) % 360;
    if (rotationNeedle) {
        rotationNeedle.style.transform = `rotate(${normalized}deg)`;
    }
    if (rotationLabel) {
        rotationLabel.textContent = `${Math.round(normalized)}°`;
    }
}

function initCompass() {
    const initialBearing = map.getBearing();
    currentBearing = initialBearing;
    targetBearing = initialBearing;
    updateCompass(initialBearing);

    rotationIndicator.addEventListener('mousedown', onDragStart);
    rotationIndicator.addEventListener('touchstart', onDragStart, { passive: false });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('touchend', onDragEnd);
}

function onDragStart(event) {
    event.preventDefault();
    isDraggingCompass = true;
    const pos = getCompassEventPos(event);
    dragStartX = pos.x;
    dragStartY = pos.y;
    dragStartBearing = map.getBearing();
    rotationIndicator.style.cursor = 'grabbing';
}

function onDragMove(event) {
    if (!isDraggingCompass) return;
    event.preventDefault();
    const pos = getCompassEventPos(event);
    const dx = pos.x - dragStartX;
    const sensitivity = 0.5;
    const deltaBearing = dx * sensitivity;
    let newBearing = (dragStartBearing + deltaBearing) % 360;
    if (newBearing < 0) newBearing += 360;
    map.setBearing(newBearing);
    updateCompass(newBearing);
    targetBearing = newBearing;
    currentBearing = newBearing;
}

function onDragEnd(event) {
    if (isDraggingCompass) {
        isDraggingCompass = false;
        rotationIndicator.style.cursor = 'grab';
    }
}

function getCompassEventPos(event) {
    if (event.touches && event.touches.length > 0) {
        return { x: event.touches[0].clientX, y: event.touches[0].clientY };
    }
    if (event.changedTouches && event.changedTouches.length > 0) {
        return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
    }
    return { x: event.clientX, y: event.clientY };
}

function getSuggestions(query) {
    if (!query) return [];
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) return [];
    return campusBuildings.filter(b => normalizeSearchText(b.name).includes(normalizedQuery)).map(b => ({
        ...b,
        distance: currentLocation ? haversine(currentLocation.lat, currentLocation.lng, b.lat, b.lng) : null
    }));
}

function showSuggestions(suggestions) {
    if (suggestions.length === 0) { suggestionsDropdown.classList.remove('show'); return; }
    suggestionsDropdown.innerHTML = suggestions.map(b => `
        <div class="suggestion-item" data-lat="${b.lat}" data-lng="${b.lng}" data-name="${b.name.replace(/'/g, "\\'")}">
            <div class="sug-dot"></div>
            <div class="suggestion-name">${b.name}</div>
            ${b.distance ? `<span class="suggestion-dist">${b.distance < 1000 ? Math.round(b.distance) + 'm' : (b.distance / 1000).toFixed(1) + 'km'}</span>` : ''}
        </div>`).join('');
    suggestionsDropdown.classList.add('show');
    document.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
            setDestination({ lat: parseFloat(item.dataset.lat), lng: parseFloat(item.dataset.lng), name: item.dataset.name });
            searchInput.value = item.dataset.name;
            suggestionsDropdown.classList.remove('show');
        });
    });
}

function checkNetworkStatus() {
    statusDiv.classList.add('loading');
    fetch('/api/stats', { headers: getApiHeaders() })
        .then(response => response.json())
        .then(data => {
            if (data.loaded) {
                statusDiv.classList.remove('loading');
                statusDiv.textContent = 'Ready';
                document.getElementById('gpsLed').classList.add('live');
                if (currentLocation && currentDestination && !isNavigating) fetchRoute(false, currentLocation);
            } else {
                statusDiv.textContent = 'Loading campus data…';
                statusDiv.classList.add('loading');
                setTimeout(checkNetworkStatus, 2000);
            }
        })
        .catch(() => {
            statusDiv.textContent = 'Connecting…';
            statusDiv.classList.add('loading');
            setTimeout(checkNetworkStatus, 3000);
        });
}

function initMap() {
    map = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
            sources: {
                'raster-tiles': {
                    type: 'raster',
                    tiles: ['https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'],
                    tileSize: 256,
                    attribution: 'Google Satellite'
                }
            },
            layers: [{
                id: 'satellite',
                type: 'raster',
                source: 'raster-tiles',
                minzoom: 0,
                maxzoom: 22
            }]
        },
        center: [29.73942, -23.88674],
        zoom: 18,
        bearing: 0,
        pitch: 0,
        touchZoomRotate: true,
        dragRotate: true
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: false }), 'top-right');

    map.on('load', () => {
        addBoundaryLayers();
        loadBoundaryOverlay();
        loadNetworkOverlay();
    });

    initCompass();

    map.on('rotate', () => {
        if (isDraggingCompass) return;
        const bearing = map.getBearing();
        currentBearing = bearing;
        targetBearing = bearing;
        updateCompass(bearing);
        if (!followMode) {
            rotationIndicator.style.background = 'rgba(16, 24, 39, 0.84)';
        }
    });

    // Add user marker
    const userEl = createUserMarkerElement(0);
    userMarker = new maplibregl.Marker({ element: userEl, anchor: 'center' })
        .setLngLat([29.73942, -23.88674])
        .addTo(map);
}

function applyGpsUpdate(newLoc, heading) {
    if (manualOrigin) {
        if (typeof heading === 'number' && !isNaN(heading)) {
            currentHeading = heading;
        }
        return;
    }

    if (hasLockedGps && currentLocation) {
        currentLocation = newLoc;
        if (typeof heading === 'number' && !isNaN(heading)) {
            currentHeading = heading;
        }
        userMarker.setLngLat([newLoc.lng, newLoc.lat]);
        updateBearingMarker();

        if (currentDestination) {
            fetchRoute(false, currentLocation);
            const dist = haversine(
                currentLocation.lat, currentLocation.lng,
                currentDestination.lat, currentDestination.lng
            );
            updateMetrics(dist);
        }
        return;
    }

    hasLockedGps = true;
    currentLocation = newLoc;
    statusDiv.innerHTML = 'GPS active';

    if (typeof heading === 'number' && !isNaN(heading)) {
        currentHeading = heading;
    } else {
        currentHeading = null;
    }

    document.getElementById('departureLabelText').textContent = `${newLoc.lat.toFixed(5)}, ${newLoc.lng.toFixed(5)}`;
    userMarker.setLngLat([newLoc.lng, newLoc.lat]);

    if (statusDiv) {
        statusDiv.classList.remove('loading');
        statusDiv.textContent = 'Tracking location';
    }

    if (followMode && currentLocation) {
        map.flyTo({
            center: [currentLocation.lng, currentLocation.lat],
            duration: 500
        });
    }
    updateBearingMarker();

    if (currentDestination && !isNavigating) {
        fetchRoute(false, currentLocation);
        const dist = haversine(
            currentLocation.lat, currentLocation.lng,
            currentDestination.lat, currentDestination.lng
        );
        updateMetrics(dist);
        return;
    }

    if (currentDestination && isNavigating) {
        const remainingDist = haversine(
            currentLocation.lat, currentLocation.lng,
            currentDestination.lat, currentDestination.lng
        );
        updateMetrics(remainingDist);

        if (remainingDist < 20) {
            isNavigating = false;
            setFollowMode(false);
            stopNavBtn.classList.remove('visible');
            statusDiv.innerHTML = "Arrived!";
            if (window.navigator.vibrate) window.navigator.vibrate(200);
            sheet.classList.add('expanded');
            offRouteBadge.style.display = 'none';
        }
    }
}

function startGPS() {
    if (!navigator.geolocation) { statusDiv.classList.remove('loading'); statusDiv.textContent = "Location unavailable"; return; }
    const led = document.getElementById('gpsLed');

    if (gpsRefreshTimer) {
        clearInterval(gpsRefreshTimer);
    }

    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const newLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            const heading = typeof pos.coords.heading === 'number' && !isNaN(pos.coords.heading) ? pos.coords.heading : null;
            applyGpsUpdate(newLoc, heading);
            led.classList.add('live');
        },
        (error) => {
            led.classList.remove('live');
            statusDiv.classList.remove('loading');
            statusDiv.textContent = error.code === 1 ? "Location permission denied" : "Location unavailable";
        },
        { enableHighAccuracy: true, maximumAge: 6000, timeout: 10000 }
    );
}

// Event Listeners
document.getElementById('modeToggle').addEventListener('click', () => {
    currentMode = currentMode === "walk" ? "drive" : "walk";
    const isWalk = currentMode === "walk";
    document.getElementById('modeIcon').innerHTML = isWalk ? 'directions_walk' : 'directions_car';
    document.getElementById('modeText').innerHTML = isWalk ? 'Walk' : 'Drive';
    document.getElementById('sheetModeIcon').innerHTML = isWalk ? 'directions_walk' : 'directions_car';
    document.getElementById('compactMode').innerHTML = `<span class="icon icon-sm">${isWalk ? 'directions_walk' : 'directions_car'}</span>`;
    if (currentLocation && currentDestination) fetchRoute(false, currentLocation);
});

document.getElementById('zoomInBtn').addEventListener('click', () => map.zoomIn());
document.getElementById('zoomOutBtn').addEventListener('click', () => map.zoomOut());
document.getElementById('rotateTestBtn').addEventListener('click', testRotation);
document.getElementById('resetNorthBtn').addEventListener('click', resetNorth);
followBtn.addEventListener('click', toggleFollowMode);
document.getElementById('startNavBtn').addEventListener('click', startNavigation);
document.getElementById('stopNavBtn').addEventListener('click', stopNavigation);
document.getElementById('navTabBtn').addEventListener('click', () => {
    if (!sheet.classList.contains('inactive')) {
        sheet.classList.remove('collapsed');
        sheet.classList.add('expanded');
    }
});
document.getElementById('handleArea').addEventListener('click', () => {
    if (sheet.classList.contains('inactive')) return;
    if (sheet.classList.contains('expanded')) {
        sheet.classList.remove('expanded');
        sheet.classList.add('collapsed');
    } else {
        sheet.classList.remove('collapsed');
        sheet.classList.add('expanded');
    }
});
document.getElementById('compactInfo').addEventListener('click', () => {
    if (!sheet.classList.contains('inactive')) {
        sheet.classList.remove('collapsed');
        sheet.classList.add('expanded');
    }
});
document.getElementById('closeSheetBtn').addEventListener('click', () => {
    sheet.classList.remove('expanded');
    sheet.classList.add('collapsed');
});

let searchTimeout;
searchInput.addEventListener('input', (e) => {
    clearSearchBtn.style.display = e.target.value ? 'flex' : 'none';
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        showSuggestions(getSuggestions(e.target.value));
    }, 150);
});

clearSearchBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearSearchBtn.style.display = 'none';
    suggestionsDropdown.classList.remove('show');
    searchInput.focus();
});

const departureLabelText = document.getElementById('departureLabelText');
const departureInput = document.getElementById('departureInput');

departureLabelText.addEventListener('click', activateOriginInput);
departureInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        commitOriginInput();
    }
    if (e.key === 'Escape') {
        departureInput.dataset.editing = 'false';
        departureInput.style.display = 'none';
        departureLabelText.style.display = 'block';
        departureInput.value = '';
    }
});
departureInput.addEventListener('blur', () => {
    if (departureInput.dataset.editing === 'true') {
        commitOriginInput();
    }
});

document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !suggestionsDropdown.contains(e.target)) {
        suggestionsDropdown.classList.remove('show');
    }
});

window.addEventListener('load', () => {
    initMap();
    startGPS();
    initHeadingSensors();
    checkNetworkStatus();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => { });
    }
});

window.addEventListener('beforeunload', () => {
    if (watchId) navigator.geolocation.clearWatch(watchId);
    if (gpsRefreshTimer) clearInterval(gpsRefreshTimer);
});





// 
// 
// 
// Add this function to vanilla.js
function getPinCoordsFromGeoJSON(pinName) {
    // We use the route's tolerance (0.0001) to find the rounded coordinates
    // We fetch the network data  right from the browser's memory
    return fetch('/api/network-data')
        .then(res => res.json())
        .then(geojson => {
            // Loop through every feature in the network
            for (const feature of geojson.features) {
                const props = feature.properties;
                if (!props) continue;
                
                // Check if this line segment connects to our pin
                if (props.from === pinName || props.to === pinName) {
                    const coords = feature.geometry.coordinates;
                    
                    // The first coordinate is the "from" point
                    // The last coordinate is the "to" point
                    const fromPoint = coords[0];
                    const toPoint = coords[coords.length - 1];
                    
                    // If this line starts with our pin, return the rounded start coord
                    if (props.from === pinName) {
                        return { lat: Math.round(fromPoint[1] * 1000000) / 1000000, lng: Math.round(fromPoint[0] * 1000000) / 1000000 };
                    }
                    // If this line ends with our pin, return the rounded end coord
                    if (props.to === pinName) {
                        return { lat: Math.round(toPoint[1] * 1000000) / 1000000, lng: Math.round(toPoint[0] * 1000000) / 1000000 };
                    }
                }
            }
            return null; // Pin not found
        });
}