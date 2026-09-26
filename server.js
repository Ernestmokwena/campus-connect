const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CAMPUS_API_KEY || 'campus-local-dev-key';

function requireApiKey(req, res, next) {
    const providedKey = req.headers['x-api-key'] || req.query.api_key;
    if (providedKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
}

app.use((req, res, next) => {
    const requestPath = (req.path || '').replace(/\\/g, '/');
    if (requestPath === '/etc' || requestPath.startsWith('/etc/')) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
});

app.use('/api', requireApiKey);
app.use(express.static(__dirname));

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

function findNodesWithinRadius(nodes, point, radius) {
    const candidates = [];
    for (let [key, node] of nodes) {
        const distance = haversineDistance(point, { lat: node.lat, lng: node.lng });
        if (distance <= radius) {
            candidates.push({ key, node, distance });
        }
    }
    return candidates;
}

function findBestSnapNode(nodes, point, targetPoint, radius = 20) {
    const candidates = findNodesWithinRadius(nodes, point, radius);
    if (candidates.length > 0) {
        return candidates.sort((a, b) => {
            const aScore = a.distance + haversineDistance(a.node, targetPoint);
            const bScore = b.distance + haversineDistance(b.node, targetPoint);
            return aScore - bScore;
        })[0];
    }
    return findClosestNode(nodes, point);
}

function findTopSnapCandidates(nodes, point, targetPoint, radius = 20, maxCandidates = 3) {
    const candidates = findNodesWithinRadius(nodes, point, radius);
    if (candidates.length === 0) {
        const closest = findClosestNode(nodes, point);
        return closest.key ? [closest] : [];
    }
    return candidates
        .sort((a, b) => {
            const aScore = a.distance + haversineDistance(a.node, targetPoint);
            const bScore = b.distance + haversineDistance(b.node, targetPoint);
            return aScore - bScore;
        })
        .slice(0, maxCandidates);
}

function findReachablePathToClosestPoint(graph, nodes, startKey, targetPoint) {
    const dist = new Map();
    const prev = new Map();
    const unvisited = new Set();

    for (const key of graph.keys()) {
        dist.set(key, Infinity);
        unvisited.add(key);
    }
    dist.set(startKey, 0);

    let bestKey = startKey;
    let bestTargetDist = haversineDistance(nodes.get(startKey), targetPoint);

    while (unvisited.size > 0) {
        let current = null;
        let minDist = Infinity;
        for (const key of unvisited) {
            const d = dist.get(key);
            if (d < minDist) {
                minDist = d;
                current = key;
            }
        }

        if (current === null) break;
        unvisited.delete(current);

        const currentNode = nodes.get(current);
        if (currentNode) {
            const currentTargetDist = haversineDistance(currentNode, targetPoint);
            if (currentTargetDist < bestTargetDist) {
                bestTargetDist = currentTargetDist;
                bestKey = current;
            }
        }

        const neighbors = graph.get(current) || [];
        for (const neighbor of neighbors) {
            const alt = dist.get(current) + neighbor.distance;
            if (alt < dist.get(neighbor.node)) {
                dist.set(neighbor.node, alt);
                prev.set(neighbor.node, current);
            }
        }
    }

    const pathKeys = [];
    let current = bestKey;
    while (current && current !== startKey) {
        pathKeys.unshift(current);
        current = prev.get(current);
    }
    pathKeys.unshift(startKey);

    return { keys: pathKeys, distance: dist.get(bestKey), targetDistance: bestTargetDist };
}

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

// haversine A* <--- on becnhmark it was slower than euclid. 
// function heuristic(nodeA, nodeB) {
//     if (!nodeA || !nodeB) return 0;
//     return haversineDistance(nodeA, nodeB);
// }

function heuristic(nodeA, nodeB) {
    if (!nodeA || !nodeB) return 0;
    
    const latDiff = (nodeA.lat - nodeB.lat) * 111000;
    const lngDiff = (nodeA.lng - nodeB.lng) * 111000;
    return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
}

function aStar(graph, nodes, startKey, goalKey) {
    const openSet = new Set([startKey]);
    const cameFrom = new Map();
    const gScore = new Map();
    const fScore = new Map();

    for (const key of graph.keys()) {
        gScore.set(key, Infinity);
        fScore.set(key, Infinity);
    }

    gScore.set(startKey, 0);
    fScore.set(startKey, heuristic(nodes.get(startKey), nodes.get(goalKey)));

    while (openSet.size > 0) {
        let current = null;
        let bestF = Infinity;
        for (const key of openSet) {
            const score = fScore.get(key);
            if (score < bestF) {
                bestF = score;
                current = key;
            }
        }

        if (current === goalKey) {
            const pathKeys = [];
            let temp = current;
            while (temp) {
                pathKeys.unshift(temp);
                temp = cameFrom.get(temp);
            }
            return { keys: pathKeys, distance: gScore.get(goalKey) };
        }

        openSet.delete(current);
        const neighbors = graph.get(current) || [];

        for (const neighbor of neighbors) {
            const tentative = gScore.get(current) + neighbor.distance;
            if (tentative < gScore.get(neighbor.node)) {
                cameFrom.set(neighbor.node, current);
                gScore.set(neighbor.node, tentative);
                fScore.set(neighbor.node, tentative + heuristic(nodes.get(neighbor.node), nodes.get(goalKey)));
                if (!openSet.has(neighbor.node)) {
                    openSet.add(neighbor.node);
                }
            }
        }
    }

    return null;
}

// Find the first intersection between direct ray and network
function findFirstRayNetworkIntersection(graph, nodes, start, end) {
    let firstIntersection = null;
    let minDistanceFromStart = Infinity;
    const checkedEdges = new Set();
    
    for (let [key1, edges] of graph) {
        const node1 = nodes.get(key1);
        if (!node1) continue;
        for (let edge of edges) {
            const edgeId = `${key1}|${edge.node}`;
            if (checkedEdges.has(edgeId)) continue;
            checkedEdges.add(edgeId);
            const node2 = nodes.get(edge.node);
            if (!node2) continue;
            
            // Check if ray from start to end intersects this edge
            const rayStart = { x: start.lng, y: start.lat };
            const rayEnd = { x: end.lng, y: end.lat };
            const edgeStart = { x: node1.lng, y: node1.lat };
            const edgeEnd = { x: node2.lng, y: node2.lat };
            
            const intersection = lineIntersection(rayStart, rayEnd, edgeStart, edgeEnd);
            if (intersection) {
                const intersectPoint = { lat: intersection.y, lng: intersection.x };
                const distFromStart = haversineDistance(start, intersectPoint);
                if (distFromStart < minDistanceFromStart && distFromStart > 1) {
                    minDistanceFromStart = distFromStart;
                    firstIntersection = intersectPoint;
                }
            }
        }
    }
    return { intersection: firstIntersection, distance: minDistanceFromStart };
}

function lineIntersection(p1, p2, p3, p4) {
    const denominator = ((p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y));
    if (denominator === 0) return null;
    
    const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / denominator;
    const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / denominator;
    
    if (ua < 0 || ua > 1 || ub < 0 || ub > 1) return null;
    
    return {
        x: p1.x + ua * (p2.x - p1.x),
        y: p1.y + ua * (p2.y - p1.y)
    };
}

// Cache for graph data
let cachedGraph = null;
let cachedNodes = null;
let cachedNodeKeysList = null;
let cachedGeojson = null;

function loadAndCacheGraph() {
    const geojsonPath = '/etc/secrets/main.geojson';
    
    try {
        if (fs.existsSync(geojsonPath)) {
            const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
            cachedGeojson = geojson;
            const { graph, nodes, nodeKeysList } = buildGraphFromGeoJson(geojson);
            cachedGraph = graph;
            cachedNodes = nodes;
            cachedNodeKeysList = nodeKeysList;
            console.log(`Loaded GeoJSON: ${nodes.size} nodes, ${graph.size} edges`);
            return true;
        } else {
            console.log(`GeoJSON file not found at: ${geojsonPath}`);
            return false;
        }
    } catch (err) {
        console.error(`Error loading GeoJSON:`, err.message);
        return false;
    }
}

// Route endpoint using A* and road snapping
app.get('/api/route', (req, res) => {
    const { startLat, startLng, endLat, endLng, mode = 'walk' } = req.query;
    
    if (!startLat || !startLng || !endLat || !endLng) {
        return res.status(400).json({ error: 'Missing coordinates' });
    }
    
    const start = { lat: parseFloat(startLat), lng: parseFloat(startLng) };
    const end = { lat: parseFloat(endLat), lng: parseFloat(endLng) };
    
    if (!cachedGraph || !cachedNodes || cachedNodes.size === 0) {
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

    const startSnaps = findTopSnapCandidates(cachedNodes, start, end, 20, 3);
    const endSnaps = findTopSnapCandidates(cachedNodes, end, start, 20, 3);

    if (startSnaps.length === 0 || endSnaps.length === 0) {
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

    let bestResult = null;

    function evaluateRoute(startSnap, endSnap) {
        if (startSnap.key === endSnap.key) {
            return {
                pathKeys: [startSnap.key],
                totalDistance: startSnap.distance + endSnap.distance,
                usedNetwork: true,
                destinationReached: true,
                startSnap,
                endSnap
            };
        }

        const networkPath = aStar(cachedGraph, cachedNodes, startSnap.key, endSnap.key);
        if (networkPath && networkPath.keys && networkPath.keys.length > 0) {
            return {
                pathKeys: networkPath.keys,
                totalDistance: startSnap.distance + networkPath.distance + endSnap.distance,
                usedNetwork: true,
                destinationReached: true,
                startSnap,
                endSnap
            };
        }

        const fallbackPath = findReachablePathToClosestPoint(cachedGraph, cachedNodes, startSnap.key, end);
        if (fallbackPath && fallbackPath.keys && fallbackPath.keys.length > 0) {
            const lastKey = fallbackPath.keys[fallbackPath.keys.length - 1];
            const lastNode = cachedNodes.get(lastKey);
            const fallbackEndSnap = lastNode ? { key: lastKey, node: lastNode, distance: fallbackPath.targetDistance } : endSnap;
            return {
                pathKeys: fallbackPath.keys,
                totalDistance: startSnap.distance + fallbackPath.distance,
                usedNetwork: true,
                destinationReached: false,
                startSnap,
                endSnap: fallbackEndSnap
            };
        }

        return {
            pathKeys: [startSnap.key],
            totalDistance: startSnap.distance,
            usedNetwork: true,
            destinationReached: false,
            startSnap,
            endSnap: { key: startSnap.key, node: cachedNodes.get(startSnap.key), distance: 0 }
        };
    }

    for (const startSnap of startSnaps) {
        for (const endSnap of endSnaps) {
            const result = evaluateRoute(startSnap, endSnap);
            if (!bestResult || result.totalDistance < bestResult.totalDistance) {
                bestResult = result;
            }
        }
    }

    if (!bestResult) {
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

    const validPathKeys = (bestResult.pathKeys || []).filter(key => key && cachedNodes.has(key));
    const nodePath = validPathKeys.map(key => {
        const node = cachedNodes.get(key);
        return [node.lat, node.lng];
    });

    const path = [
        [start.lat, start.lng],
        ...nodePath
    ];

    if (bestResult.destinationReached) {
        path.push([end.lat, end.lng]);
    }

    const startSnapNode = cachedNodes.get(bestResult.startSnap?.key || '');
    const endSnapNode = bestResult.endSnap?.node || (bestResult.endSnap?.key ? cachedNodes.get(bestResult.endSnap.key) : null);
    const speed = mode === 'walk' ? 1.4 : 8;
    const timeMinutes = Math.ceil(bestResult.totalDistance / (speed * 60));

    return res.json({
        status: 'success',
        distance: bestResult.totalDistance,
        duration: timeMinutes,
        path: path.length > 1 ? path : [[start.lat, start.lng], [end.lat, end.lng]],
        mode: mode,
        usedNetwork: bestResult.usedNetwork,
        startSnap: startSnapNode ? [startSnapNode.lat, startSnapNode.lng] : [start.lat, start.lng],
        endSnap: endSnapNode ? [endSnapNode.lat, endSnapNode.lng] : [end.lat, end.lng]
    });
});

app.get('/api/network-data', (req, res) => {
    const geojsonPath = '/etc/secrets/main.geojson';
    try {
        if (!fs.existsSync(geojsonPath)) {
            return res.status(404).json({ error: 'Network file not found' });
        }
        const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
        res.json(geojson);
    } catch (err) {
        console.error('Error reading network data:', err.message);
        res.status(500).json({ error: 'Unable to load network data' });
    }
});

app.get('/api/boundary-data', (req, res) => {
    const geojsonPath = 'etc/secrets/ul.geojson';
    try {
        if (!fs.existsSync(geojsonPath)) {
            return res.status(404).json({ error: 'Boundary file not found' });
        }
        const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
        res.json(geojson);
    } catch (err) {
        console.error('Error reading boundary data:', err.message);
        res.status(500).json({ error: 'Unable to load boundary data' });
    }
});

app.get('/api/stats', (req, res) => {
    res.json({
        loaded: cachedGraph !== null,
        nodeCount: cachedNodes ? cachedNodes.size : 0,
        edgeCount: cachedGraph ? cachedGraph.size : 0
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`
------------------------------------------||
||     Campus Navigator Server Ready      ||
||----------------------------------------||
||  Port: ${PORT}                         ||
||  URL:  http://localhost:${PORT}        ||
||----------------------------------------||
    `);
    
    loadAndCacheGraph();
});
