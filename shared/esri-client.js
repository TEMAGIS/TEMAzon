// ---------------------------------------------------------------------------
// Thin helper around the ArcGIS REST API for hosted feature layers/tables:
// paginated query, applyEdits (single layer or whole service in ONE
// transaction), and a field-name schema check. Hosted feature services send
// proper CORS headers, so the browser calls them directly with the signed-in
// user's token — no relay needed.
// ---------------------------------------------------------------------------

import { ensureFreshToken, getToken } from "./arcgis-auth.js";

export class EsriError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Authenticated form-encoded request. Always POST for edits; GET for small reads. */
export async function esriRequest(url, params = {}, { method = "POST" } = {}) {
  await ensureFreshToken();
  const body = new URLSearchParams({ ...params, f: "json", token: getToken() });
  let res;
  if (method === "GET") {
    res = await fetch(`${url}?${body.toString()}`);
  } else {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }
  const data = await res.json();
  throwIfEsriError(data, "Request failed");
  return data;
}

export function throwIfEsriError(data, context) {
  if (data && data.error) {
    const detail = (data.error.details && data.error.details[0]) || "";
    const msg = [data.error.message, detail].filter(Boolean).join(" — ");
    throw new EsriError(`${context}: ${msg || JSON.stringify(data.error)}`, data.error.code);
  }
}

/** SQL string literal with quotes escaped. */
export const sqlStr = (s) => `'${String(s ?? "").replace(/'/g, "''")}'`;

export const tableUrl = (serviceUrl, id) => `${serviceUrl.replace(/\/+$/, "")}/${id}`;

/** Layer/table metadata: fields + the real object-id field name. */
export async function getLayerInfo(layerUrl) {
  const data = await esriRequest(layerUrl, {}, { method: "GET" });
  return { fields: data.fields || [], objectIdField: data.objectIdField || "OBJECTID", raw: data };
}

/**
 * Fetches every row, paginated via resultOffset. Returns plain objects:
 * the attributes, plus `_oid` (the object id) — ready for in-memory use.
 */
export async function queryAll(layerUrl, opts = {}) {
  const { where = "1=1", outFields = "*", orderByFields = "", pageSize = 1000, onPage = null, oidField = "OBJECTID" } = opts;
  const rows = [];
  let offset = 0;
  for (;;) {
    const data = await esriRequest(`${layerUrl}/query`, {
      where,
      outFields,
      orderByFields,
      returnGeometry: "false",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
    });
    const feats = data.features || [];
    const oid = data.objectIdFieldName || oidField;
    for (const f of feats) rows.push({ ...f.attributes, _oid: f.attributes[oid] });
    if (onPage) onPage(rows);
    if (!data.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
  }
  return rows;
}

function checkResults(data) {
  for (const key of ["addResults", "updateResults", "deleteResults"]) {
    for (const r of data[key] || []) {
      if (r.success === false) {
        throw new EsriError(`Save failed: ${(r.error && (r.error.description || r.error.message)) || "unknown error"}`, r.error && r.error.code);
      }
    }
  }
}

/** applyEdits on ONE layer/table. Each add/update is `{attributes}`; deletes are object ids. */
export async function applyEdits(layerUrl, { adds = [], updates = [], deletes = [] }) {
  const data = await esriRequest(`${layerUrl}/applyEdits`, {
    adds: JSON.stringify(adds),
    updates: JSON.stringify(updates),
    deletes: JSON.stringify(deletes),
    rollbackOnFailure: "true",
  });
  checkResults(data);
  return data;
}

/**
 * applyEdits across SEVERAL layers/tables of one service in a single
 * transaction (all succeed or none do).
 * @param {string} serviceUrl  …/FeatureServer
 * @param {Array<{id:number, adds?:object[], updates?:object[], deletes?:any[]}>} edits
 */
export async function applyServiceEdits(serviceUrl, edits) {
  const data = await esriRequest(`${serviceUrl.replace(/\/+$/, "")}/applyEdits`, {
    edits: JSON.stringify(edits.map((e) => ({ id: e.id, adds: e.adds || [], updates: e.updates || [], deletes: e.deletes || [] }))),
    rollbackOnFailure: "true",
  });
  // Service-level response is an array of per-layer result objects.
  const arr = Array.isArray(data) ? data : data.layers || data.results || [];
  for (const r of arr) checkResults(r);
  return arr;
}

/** Logs a console warning for every expected field name missing on the live layer. */
export async function checkFieldNames(layerUrl, label, expected) {
  try {
    const info = await getLayerInfo(layerUrl);
    const live = new Set(info.fields.map((f) => f.name));
    const missing = expected.filter((n) => !live.has(n));
    if (missing.length) console.warn(`[schema check] ${label}: fields NOT found on the live layer: ${missing.join(", ")}`);
    else console.info(`[schema check] ${label}: all expected fields found ✓`);
    return { ...info, missing };
  } catch (err) {
    console.warn(`[schema check] ${label}: could not verify — ${err.message}`);
    return { fields: [], objectIdField: "OBJECTID", missing: [] };
  }
}
