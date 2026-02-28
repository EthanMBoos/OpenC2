// ── Async Terrain Sampler ──
// WHY: Move terrain elevation sampling off the render path.
// This prevents synchronous queryTerrainElevation calls from blocking the frame.
//
// DEVNOTE: ARCHITECTURE OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────
// This module handles async terrain elevation queries for all features.
//
// Flow:
// 1. renderer.js detects geometry change via hash comparison
// 2. Calls sampleTerrainAsync() from this file
// 3. Features are processed in batches using requestIdleCallback (non-blocking)
// 4. Ground routes get dense interpolation (INTERPOLATION_POINTS per segment)
// 5. Results are cached and stored in React state (elevatedGeoJson, groundRoutePathsCache)
// 6. Render effect uses pre-computed data instead of querying terrain
//
// DEVNOTE: WHEN TO MODIFY THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
// - Change TERRAIN_OFFSET (default 10m) to prevent z-fighting (visual flickering when
//   geometry renders at exact same depth as terrain). This offset is imperceptible but
//   ensures clean rendering. Does NOT affect stored coordinate accuracy.
// - Change INTERPOLATION_POINTS (default 15) for smoother/rougher ground route terrain following
// - Add new feature type handling if it needs special terrain sampling logic
// - Modify BATCH_SIZE (default 5) if processing needs to be more/less chunked
// ─────────────────────────────────────────────────────────────────────────────

import { terrainCache } from './terrainCache.js';

const TERRAIN_OFFSET = 10; // meters - prevents z-fighting, visually imperceptible
const INTERPOLATION_POINTS = 15; // points per ground route segment

function queryElevation(map, coord) {
  try {
    const elev = map.queryTerrainElevation({ lng: coord[0], lat: coord[1] });
    return (elev || 0) + TERRAIN_OFFSET;
  } catch {
    return TERRAIN_OFFSET;
  }
}

function addElevationToCoord(map, coord) {
  return [coord[0], coord[1], queryElevation(map, coord)];
}

function addElevationToCoords(map, coords) {
  if (!Array.isArray(coords)) return coords;
  
  if (typeof coords[0] === 'number') {
    // Single coordinate [lng, lat] or [lng, lat, z]
    return addElevationToCoord(map, coords);
  }
  
  // Nested array - recurse
  return coords.map(c => addElevationToCoords(map, c));
}

function interpolateSegment(p1, p2, numPoints) {
  const points = [];
  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    points.push([
      p1[0] + (p2[0] - p1[0]) * t,
      p1[1] + (p2[1] - p1[1]) * t
    ]);
  }
  return points;
}

function buildDenseGroundRoutePath(map, coords) {
  if (!Array.isArray(coords) || coords.length < 2) {
    return [];
  }
  
  const densePoints = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const segmentPoints = interpolateSegment(coords[i], coords[i + 1], INTERPOLATION_POINTS);
    // Avoid duplicating points at segment boundaries
    if (i > 0) segmentPoints.shift();
    
    segmentPoints.forEach(p => {
      const elev = queryElevation(map, p);
      densePoints.push([p[0], p[1], elev]);
    });
  }
  
  return densePoints;
}

function scheduleIdleWork(workFn) {
  return new Promise(resolve => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => {
        resolve(workFn());
      }, { timeout: 100 });
    } else {
      setTimeout(() => {
        resolve(workFn());
      }, 0);
    }
  });
}

export async function sampleTerrainAsync(geoJson, map, terrainEnabled) {
  if (!terrainEnabled || !map || !map.getTerrain()) {
    // No terrain - return original data
    return {
      elevatedFeatures: geoJson.features,
      groundRoutePaths: buildGroundRouteDataWithoutTerrain(geoJson)
    };
  }

  const features = geoJson.features;
  const elevatedFeatures = [];
  const groundRoutePaths = [];
  
  // Build index map for ground routes
  const groundRouteIndexMap = new Map();
  features.forEach((f, idx) => {
    if (f.properties?.featureType === 'groundRoute') {
      groundRouteIndexMap.set(f, idx);
    }
  });

  // Process features in small batches
  const BATCH_SIZE = 5;
  
  for (let i = 0; i < features.length; i += BATCH_SIZE) {
    const batch = features.slice(i, i + BATCH_SIZE);
    
    // Process batch asynchronously
    const batchResults = await scheduleIdleWork(() => {
      return batch.map((feature, batchIdx) => {
        const featureIndex = i + batchIdx;
        const coords2D = feature.geometry?.coordinates;
        
        // Check cache first
        const cached = terrainCache.get(featureIndex, coords2D);
        if (cached) {
          return {
            feature: {
              ...feature,
              geometry: { ...feature.geometry, coordinates: cached }
            },
            fromCache: true
          };
        }
        
        // Sample terrain for this feature
        const coords3D = addElevationToCoords(map, coords2D);
        
        // Cache the result
        terrainCache.set(featureIndex, coords2D, coords3D);
        
        return {
          feature: {
            ...feature,
            geometry: { ...feature.geometry, coordinates: coords3D }
          },
          fromCache: false
        };
      });
    });
    
    batchResults.forEach(result => {
      elevatedFeatures.push(result.feature);
    });
  }

  // Process ground routes separately for dense interpolation
  const groundRouteFeatures = features.filter(f => f.properties?.featureType === 'groundRoute');
  
  for (const feature of groundRouteFeatures) {
    const featureIndex = groundRouteIndexMap.get(feature);
    const coords = feature.geometry?.coordinates;
    
    // Build dense path with terrain
    const densePath = await scheduleIdleWork(() => {
      return buildDenseGroundRoutePath(map, coords);
    });
    
    groundRoutePaths.push({
      feature,
      featureIndex,
      densePath
    });
  }

  return { elevatedFeatures, groundRoutePaths };
}

function buildGroundRouteDataWithoutTerrain(geoJson) {
  const groundRouteFeatures = geoJson.features.filter(f => f.properties?.featureType === 'groundRoute');
  const groundRouteIndexMap = new Map();
  
  geoJson.features.forEach((f, idx) => {
    if (f.properties?.featureType === 'groundRoute') {
      groundRouteIndexMap.set(f, idx);
    }
  });

  return groundRouteFeatures.map(feature => {
    const coords = feature.geometry?.coordinates || [];
    // Return coords as-is (no elevation), with z=0
    const flatPath = coords.map(c => [c[0], c[1], 0]);
    return {
      feature,
      featureIndex: groundRouteIndexMap.get(feature),
      densePath: flatPath
    };
  });
}

export function clearTerrainCache() {
  terrainCache.clear();
}

export function pruneTerrainCache() {
  terrainCache.pruneExpired();
}
