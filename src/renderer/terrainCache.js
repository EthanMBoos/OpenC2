// ── Terrain Elevation Cache ──
// WHY: Cache terrain elevations to avoid redundant synchronous queries.
// Only recalculate when geometry actually changes, not on every render.
//
// DEVNOTE: ARCHITECTURE OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────
// This module provides two things:
// 1. computeGeometryHash() - Generates a hash of all 2D coordinates to detect changes
// 2. TerrainCache class - Stores computed 3D coordinates with automatic TTL expiration
//
// The hash comparison happens in renderer.js (section 3.5 Async Terrain Sampling).
// When the hash changes, it triggers a full terrain resample via terrainSampler.js.
// When only properties change (e.g., altitude edit), renderer.js merges props without resampling.
//
// DEVNOTE: WHEN TO MODIFY THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
// - Change maxAge (default 30s) if terrain tiles update more/less frequently
// - Modify hash algorithm if coordinate comparison needs to be more/less sensitive
// - Add feature-type-specific caching if different features need different TTLs
//
// DEVNOTE: THIS FILE IS STABLE
// Normal feature additions or UI changes won't require edits here.
// ─────────────────────────────────────────────────────────────────────────────

export function computeGeometryHash(geoJson) {
  if (!geoJson?.features?.length) return 'empty';
  
  // Build a string representation of all coordinates
  const coordStrings = geoJson.features.map(f => {
    if (!f.geometry?.coordinates) return '';
    return JSON.stringify(f.geometry.coordinates);
  });
  
  // Simple hash: djb2 algorithm
  const str = coordStrings.join('|');
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

class TerrainCache {
  constructor(maxAge = 30000) { // 30 second TTL
    this.cache = new Map();
    this.maxAge = maxAge;
  }

  _makeKey(featureIndex, coords2D) {
    const coordHash = JSON.stringify(coords2D);
    let hash = 5381;
    for (let i = 0; i < coordHash.length; i++) {
      hash = ((hash << 5) + hash) + coordHash.charCodeAt(i);
      hash = hash & hash;
    }
    return `${featureIndex}_${hash.toString(16)}`;
  }

  get(featureIndex, coords2D) {
    const key = this._makeKey(featureIndex, coords2D);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    // Check if expired
    if (Date.now() - entry.timestamp > this.maxAge) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.coords3D;
  }

  set(featureIndex, coords2D, coords3D) {
    const key = this._makeKey(featureIndex, coords2D);
    this.cache.set(key, {
      coords3D,
      timestamp: Date.now()
    });
  }

  clear() {
    this.cache.clear();
  }

  pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.maxAge) {
        this.cache.delete(key);
      }
    }
  }
}

// Singleton instance
export const terrainCache = new TerrainCache();
