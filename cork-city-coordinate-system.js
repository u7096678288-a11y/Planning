"use strict";

(function installCorkCityCoordinateSystem() {
  const RESOURCE_ID = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
  const API_PATH = "/api/3/action/datastore_search_sql";
  const CORK_BOUNDS = { west: -8.95, south: 51.65, east: -8.05, north: 52.15 };
  const IRELAND_BOUNDS = { west: -11.5, south: 51.0, east: -5.0, north: 56.2 };
  const ITM = "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +units=m +no_defs";
  const IRISH_GRID = "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=1.000035 +x_0=200000 +y_0=250000 +a=6377340.189 +b=6356034.447938534 +towgs84=482.530,-130.596,564.557,-1.042,-0.214,-0.631,8.15 +units=m +no_defs";
  let apiPatched = false;

  const finite = value => Number.isFinite(Number(value));
  const within = (coordinate, bounds) => Boolean(coordinate)
    && coordinate[0] >= bounds.west && coordinate[0] <= bounds.east
    && coordinate[1] >= bounds.south && coordinate[1] <= bounds.north;

  function defineProjections() {
    if (typeof window.proj4 !== "function") return false;
    window.proj4.defs("EPSG:2157", ITM);
    window.proj4.defs("EPSG:29903", IRISH_GRID);
    return true;
  }

  function project(source, x, y) {
    if (!defineProjections() || !finite(x) || !finite(y)) return null;
    try {
      const output = window.proj4(source, "EPSG:4326", [Number(x), Number(y)]);
      return output.every(Number.isFinite) ? output : null;
    } catch {
      return null;
    }
  }

  function coordinateFromRaw(xValue, yValue) {
    const x = Number(xValue);
    const y = Number(yValue);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    const direct = [x, y];
    if (within(direct, CORK_BOUNDS)) return { coordinate: direct, system: "WGS84" };

    const swapped = [y, x];
    if (within(swapped, CORK_BOUNDS)) return { coordinate: swapped, system: "WGS84 — corrected axis order" };

    const signed = [-Math.abs(x), y];
    if (within(signed, CORK_BOUNDS)) return { coordinate: signed, system: "WGS84 — corrected longitude sign" };

    const candidates = [
      { coordinate: project("EPSG:2157", x, y), system: "Irish Transverse Mercator (EPSG:2157)" },
      { coordinate: project("EPSG:2157", y, x), system: "Irish Transverse Mercator — corrected axis order" },
      { coordinate: project("EPSG:29903", x, y), system: "Irish Grid (EPSG:29903)" },
      { coordinate: project("EPSG:29903", y, x), system: "Irish Grid — corrected axis order" }
    ];
    return candidates.find(candidate => within(candidate.coordinate, CORK_BOUNDS)) || null;
  }

  function transformEnvelope(sql) {
    if (!sql.includes(RESOURCE_ID) || !sql.includes('"Longitude" BETWEEN')) return sql;
    const pattern = /"Longitude"\s+BETWEEN\s+(-?\d+(?:\.\d+)?)\s+AND\s+(-?\d+(?:\.\d+)?)\s+AND\s+"Latitude"\s+BETWEEN\s+(-?\d+(?:\.\d+)?)\s+AND\s+(-?\d+(?:\.\d+)?)/i;
    const match = sql.match(pattern);
    if (!match || !defineProjections()) return sql;

    const west = Number(match[1]);
    const east = Number(match[2]);
    const south = Number(match[3]);
    const north = Number(match[4]);
    if (![west, east, south, north].every(Number.isFinite)) return sql;

    try {
      const corners = [
        [west, south], [west, north], [east, south], [east, north]
      ].map(coordinate => window.proj4("EPSG:4326", "EPSG:2157", coordinate));
      const eastings = corners.map(coordinate => coordinate[0]).filter(Number.isFinite);
      const northings = corners.map(coordinate => coordinate[1]).filter(Number.isFinite);
      if (eastings.length !== 4 || northings.length !== 4) return sql;

      const eMin = Math.min(...eastings) - 25;
      const eMax = Math.max(...eastings) + 25;
      const nMin = Math.min(...northings) - 25;
      const nMax = Math.max(...northings) + 25;
      const replacement = `(("Longitude" BETWEEN ${eMin.toFixed(3)} AND ${eMax.toFixed(3)} AND "Latitude" BETWEEN ${nMin.toFixed(3)} AND ${nMax.toFixed(3)}) OR ("Longitude" BETWEEN ${west} AND ${east} AND "Latitude" BETWEEN ${south} AND ${north}))`;
      return sql.replace(pattern, replacement);
    } catch (error) {
      console.warn("Cork City map-envelope conversion failed", error);
      return sql;
    }
  }

  function patchJsonpRequests() {
    if (window.__radharcCorkCoordinateJsonpPatch) return;
    window.__radharcCorkCoordinateJsonpPatch = true;
    const originalAppend = HTMLHeadElement.prototype.append;
    HTMLHeadElement.prototype.append = function patchedHeadAppend(...nodes) {
      nodes.forEach(node => {
        if (!(node instanceof HTMLScriptElement) || !node.src) return;
        try {
          const url = new URL(node.src, document.baseURI);
          if (!url.pathname.endsWith(API_PATH)) return;
          const sql = url.searchParams.get("sql");
          if (!sql || !sql.includes(RESOURCE_ID)) return;
          const corrected = transformEnvelope(sql);
          if (corrected !== sql) {
            url.searchParams.set("sql", corrected);
            node.src = url.toString();
          }
        } catch (error) {
          console.warn("Cork City CKAN request could not be inspected", error);
        }
      });
      return originalAppend.apply(this, nodes);
    };
  }

  function correctedFeature(feature) {
    if (!feature || feature.type !== "Feature" || feature.properties?.DirectSource !== "Cork City Council CKAN") return feature;
    if (feature.geometry?.type !== "Point" || !Array.isArray(feature.geometry.coordinates)) return null;
    const [x, y] = feature.geometry.coordinates;
    const resolved = coordinateFromRaw(x, y);
    if (!resolved || !within(resolved.coordinate, IRELAND_BOUNDS)) {
      console.warn("Cork City point omitted because its coordinates could not be resolved", feature.properties?.ApplicationNumber, x, y);
      return null;
    }
    return {
      ...feature,
      geometry: { ...feature.geometry, coordinates: resolved.coordinate },
      properties: {
        ...feature.properties,
        SourceLongitude: x,
        SourceLatitude: y,
        CoordinateSystem: resolved.system,
        Longitude: resolved.coordinate[0],
        Latitude: resolved.coordinate[1]
      }
    };
  }

  function correctedData(data) {
    if (!data) return data;
    if (Array.isArray(data)) return data.map(correctedData).filter(Boolean);
    if (data.type === "FeatureCollection") {
      return { ...data, features: (data.features || []).map(correctedFeature).filter(Boolean) };
    }
    if (data.type === "Feature") return correctedFeature(data);
    return data;
  }

  function patchLeafletGeoJson() {
    if (!window.L?.geoJSON || window.L.__radharcCorkCoordinateGeoJsonPatch) return;
    window.L.__radharcCorkCoordinateGeoJsonPatch = true;
    const originalGeoJson = window.L.geoJSON;
    window.L.geoJSON = function correctedGeoJson(data, options) {
      const layer = originalGeoJson.call(this, null, options);
      const originalAddData = layer.addData;
      layer.addData = function addCorrectedCorkData(input) {
        const corrected = correctedData(input);
        if (!corrected) return this;
        return originalAddData.call(this, corrected);
      };
      if (data) layer.addData(data);
      return layer;
    };
    Object.assign(window.L.geoJSON, originalGeoJson);
  }

  function patchPublicApi(attempt = 0) {
    const api = window.CorkCityCKAN;
    if (!api) {
      if (attempt < 200) setTimeout(() => patchPublicApi(attempt + 1), 50);
      return;
    }
    if (apiPatched) return;
    apiPatched = true;
    const originalFeatures = api.features?.bind(api);
    if (originalFeatures) {
      api.features = () => correctedData({ type: "FeatureCollection", features: originalFeatures() }).features;
    }
    api.coordinateFromRaw = coordinateFromRaw;
    api.coordinateBounds = { ...CORK_BOUNDS };
  }

  function initialise() {
    if (!defineProjections()) {
      console.error("Cork City coordinate correction requires proj4");
      return;
    }
    patchJsonpRequests();
    patchLeafletGeoJson();
    patchPublicApi();
  }

  initialise();
})();