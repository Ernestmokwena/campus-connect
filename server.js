const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));

// Helper function: Haversine distance calculation
function haversineDistance(point1, point2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const φ1 = point1.lat * toRad;
    const φ2 = point2.lat * toRad;
    const Δφ = (point2.lat - point1.lat) * toRad;
    const Δλ = (point2.lng - point1.lng) * toRad;
    
    const a = Math.sin(Δφ / 2) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    
    return R * c;
}

// Helper function: Find closest node in graph
function findClosestNode(nodes, point) {
    let closestKey = null;
    let minDist = Infinity;
    
    for (let [key, node] of nodes) {
        const dist = haversineDistance(point, { lat: node.lat, lng: node.lng });
        if (dist < minDist) {
            minDist = dist;
            closestKey = key;
        }
    }
    
    return { key: closestKey, distance: minDist };
}

// Build graph from GeoJSON
function buildGraphFromGeoJson(geojson) {
    const graph = new Map();
    const nodes = new Map();
    const nodeKeysList = [];
    
    function pointKey(lat, lng, precision = 8) {
        return `${lat.toFixed(precision)},${lng.toFixed(precision)}`;
    }
    
    function addNode(lat, lng) {
        const key = pointKey(lat, lng);
        if (!nodes.has(key)) {
            nodes.set(key, { lat, lng, key });
            nodeKeysList.push(key);
            graph.set(key, []);
        }
        return key;
    }
    
    function addBidirectionalEdge(key1, key2) {
        if (key1 === key2) return;
        const node1 = nodes.get(key1);
        const node2 = nodes.get(key2);
        if (!node1 || !node2) return;
        
        const dist = haversineDistance(
            { lat: node1.lat, lng: node1.lng },
            { lat: node2.lat, lng: node2.lng }
        );
        
        const edges1 = graph.get(key1);
        const edges2 = graph.get(key2);
        
        if (!edges1.some(e => e.node === key2)) {
            edges1.push({ node: key2, distance: dist });
        }
        if (!edges2.some(e => e.node === key1)) {
            edges2.push({ node: key1, distance: dist });
        }
    }
    
    if (geojson && geojson.features) {
        geojson.features.forEach(feature => {
            const geom = feature.geometry;
            if (geom && geom.type === 'LineString') {
                const coords = geom.coordinates;
                let previousKey = null;
                for (let i = 0; i < coords.length; i++) {
                    const c = coords[i];
                    const nodeKey = addNode(c[1], c[0]);
                    if (previousKey !== null) {
                        addBidirectionalEdge(previousKey, nodeKey);
                    }
                    previousKey = nodeKey;
                }
            }
        });
    }
    
    return { graph, nodes, nodeKeysList };
}

// Dijkstra algorithm for shortest path
function dijkstra(graph, nodes, nodeKeysList, startKey, goalKey) {
    const dist = new Map();
    const prev = new Map();
    const unvisited = new Set();
    
    for (let key of nodeKeysList) {
        dist.set(key, Infinity);
        unvisited.add(key);
    }
    dist.set(startKey, 0);
    
    while (unvisited.size > 0) {
        let current = null;
        let minDist = Infinity;
        for (let key of unvisited) {
            const d = dist.get(key);
            if (d < minDist) {
                minDist = d;
                current = key;
            }
        }
        
        if (current === null || current === goalKey) break;
        unvisited.delete(current);
        
        const neighbors = graph.get(current) || [];
        for (let neighbor of neighbors) {
            const alt = dist.get(current) + neighbor.distance;
            if (alt < dist.get(neighbor.node)) {
                dist.set(neighbor.node, alt);
                prev.set(neighbor.node, current);
            }
        }
    }
    
    if (dist.get(goalKey) === Infinity) return null;
    
    const pathKeys = [];
    let current = goalKey;
    while (current && current !== startKey) {
        pathKeys.unshift(current);
        current = prev.get(current);
    }
    pathKeys.unshift(startKey);
    
    return { keys: pathKeys, distance: dist.get(goalKey) };
}

// Cache for graph data
let cachedGraph = null;
let cachedNodes = null;
let cachedNodeKeysList = null;

// Load and cache the GeoJSON
function loadAndCacheGraph() {
    const geojsonPath = path.join(__dirname, 'files', 'main.geojson');
    
    try {
        if (fs.existsSync(geojsonPath)) {
            const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
            const { graph, nodes, nodeKeysList } = buildGraphFromGeoJson(geojson);
            cachedGraph = graph;
            cachedNodes = nodes;
            cachedNodeKeysList = nodeKeysList;
            console.log(`✅ Loaded GeoJSON: ${nodes.size} nodes, ${graph.size} edges`);
            return true;
        } else {
            console.log(`⚠️ GeoJSON file not found at: ${geojsonPath}`);
            console.log(`📁 Please place your main.geojson in the "files" folder`);
            return false;
        }
    } catch (err) {
        console.error(`❌ Error loading GeoJSON:`, err.message);
        return false;
    }
}

// API: Get the network data (hidden endpoint)
app.get('/api/network-data', (req, res) => {
    const geojsonPath = path.join(__dirname, 'files', 'main.geojson');
    
    try {
        if (fs.existsSync(geojsonPath)) {
            const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
            res.json(geojson);
        } else {
            res.json({ type: "FeatureCollection", features: [] });
        }
    } catch (err) {
        res.status(500).json({ error: "Failed to load network data" });
    }
});

// API: Calculate route
app.get('/api/route', (req, res) => {
    const { startLat, startLng, endLat, endLng, mode = 'walk' } = req.query;
    
    if (!startLat || !startLng || !endLat || !endLng) {
        return res.status(400).json({ error: 'Missing coordinates' });
    }
    
    const start = { lat: parseFloat(startLat), lng: parseFloat(startLng) };
    const end = { lat: parseFloat(endLat), lng: parseFloat(endLng) };
    
    // If graph isn't loaded, return direct route
    if (!cachedGraph || cachedNodes.size === 0) {
        const directDistance = haversineDistance(start, end);
        const speed = mode === 'walk' ? 1.4 : 8;
        const timeMinutes = Math.ceil(directDistance / (speed * 60));
        
        return res.json({
            status: 'success',
            distance: directDistance,
            duration: timeMinutes,
            path: [[start.lat, start.lng], [end.lat, end.lng]],
            mode: mode,
            usedNetwork: false
        });
    }
    
    // Find closest nodes on network
    const closestStart = findClosestNode(cachedNodes, start);
    const closestEnd = findClosestNode(cachedNodes, end);
    
    if (!closestStart.key || !closestEnd.key) {
        const directDistance = haversineDistance(start, end);
        const speed = mode === 'walk' ? 1.4 : 8;
        const timeMinutes = Math.ceil(directDistance / (speed * 60));
        
        return res.json({
            status: 'success',
            distance: directDistance,
            duration: timeMinutes,
            path: [[start.lat, start.lng], [end.lat, end.lng]],
            mode: mode,
            usedNetwork: false
        });
    }
    
    // Find network path
    const networkPathResult = dijkstra(cachedGraph, cachedNodes, cachedNodeKeysList, closestStart.key, closestEnd.key);
    
    if (!networkPathResult) {
        const directDistance = haversineDistance(start, end);
        const speed = mode === 'walk' ? 1.4 : 8;
        const timeMinutes = Math.ceil(directDistance / (speed * 60));
        
        return res.json({
            status: 'success',
            distance: directDistance,
            duration: timeMinutes,
            path: [[start.lat, start.lng], [end.lat, end.lng]],
            mode: mode,
            usedNetwork: false
        });
    }
    
    // Build full path with connection points
    const path = [
        [start.lat, start.lng],
        [cachedNodes.get(closestStart.key).lat, cachedNodes.get(closestStart.key).lng],
        ...networkPathResult.keys.map(key => [cachedNodes.get(key).lat, cachedNodes.get(key).lng]),
        [end.lat, end.lng]
    ];
    
    const totalDistance = closestStart.distance + networkPathResult.distance + closestEnd.distance;
    const speed = mode === 'walk' ? 1.4 : 8;
    const timeMinutes = Math.ceil(totalDistance / (speed * 60));
    
    res.json({
        status: 'success',
        distance: totalDistance,
        duration: timeMinutes,
        path: path,
        mode: mode,
        usedNetwork: true,
        nodesUsed: networkPathResult.keys.length
    });
});

// API: Get graph statistics
app.get('/api/stats', (req, res) => {
    res.json({
        loaded: cachedGraph !== null,
        nodeCount: cachedNodes ? cachedNodes.size : 0,
        edgeCount: cachedGraph ? cachedGraph.size : 0
    });
});

// Serve your HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════╗
║     Campus Navigator Server Ready      ║
╠════════════════════════════════════════╣
║  Port: ${PORT}                              ║
║  URL:  http://localhost:${PORT}          ║
╠════════════════════════════════════════╣
    `);
    
    // Load GeoJSON on startup
    loadAndCacheGraph();
});