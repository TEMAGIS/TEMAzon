// ---------------------------------------------------------------------------
// Section / Region dropdown lists, stored in a small "Lists" table inside the
// Requests service (employees can already read that service). The table is
// found BY NAME, so no table id has to be added to config.js.
//
// If the table doesn't exist yet, is empty for a list, or can't be read, the
// lists in config.js (CONFIG.SECTIONS / CONFIG.REGIONS) are used instead, so
// the request form never breaks.
// ---------------------------------------------------------------------------

import { CONFIG } from "./config.js";
import { esriRequest, queryAll, tableUrl } from "./esri-client.js";
import { LISTS_TABLE, toTableDefinition } from "./schema.js";

export const LIST_KEYS = { section: "SECTIONS", region: "REGIONS" };
export const LIST_MAX = { section: 80, region: 40 };

const DEFAULTS = { SECTIONS: [...CONFIG.SECTIONS], REGIONS: [...CONFIG.REGIONS] };
export const defaultValues = (name) => [...DEFAULTS[LIST_KEYS[name]]];

/** Finds the Lists table in the Requests service. Returns its layer URL, or "" if there isn't one. */
export async function findListsTableUrl() {
  const svc = CONFIG.REQUESTS_SERVICE_URL;
  if (!svc) return "";
  const info = await esriRequest(svc, {}, { method: "GET" });
  const t = (info.tables || []).find((x) => String(x.name).toLowerCase() === LISTS_TABLE.name.toLowerCase());
  return t ? tableUrl(svc, t.id) : "";
}

/**
 * Loads the lists and applies them to CONFIG.SECTIONS / CONFIG.REGIONS, so every
 * screen that reads CONFIG sees the stored values.
 * Returns { url, rows, stored: {section:boolean, region:boolean}, error }.
 */
export async function loadLists() {
  const out = { url: "", rows: [], stored: { section: false, region: false }, error: "" };
  try {
    out.url = await findListsTableUrl();
    if (out.url) out.rows = await queryAll(out.url, { pageSize: CONFIG.FETCH_PAGE_SIZE });
  } catch (err) {
    out.error = err.message;
    console.warn("[TEMAzon] Lists table could not be read — using the lists in config.js:", err);
  }
  for (const [name, key] of Object.entries(LIST_KEYS)) {
    const vals = out.rows
      .filter((r) => r.list_name === name && String(r.value || "").trim())
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.value).localeCompare(String(b.value)))
      .map((r) => String(r.value).trim());
    if (vals.length) {
      CONFIG[key] = vals;
      out.stored[name] = true;
    } else {
      CONFIG[key] = [...DEFAULTS[key]];
    }
  }
  return out;
}

/** Creates the Lists table in the Requests service (needs the service owner / an admin). Returns its layer URL. */
export async function createListsTable() {
  const svc = CONFIG.REQUESTS_SERVICE_URL;
  if (!svc) throw new Error("REQUESTS_SERVICE_URL isn't set in config.js.");
  const existing = await findListsTableUrl();
  if (existing) return existing;
  const adminUrl = svc.replace(/\/+$/, "").replace("/rest/services/", "/rest/admin/services/");
  try {
    await esriRequest(`${adminUrl}/addToDefinition`, { addToDefinition: JSON.stringify({ tables: [toTableDefinition(LISTS_TABLE)] }) });
  } catch (err) {
    throw new Error(`Couldn't create the Lists table (${err.message}). Only the owner of the Requests service, or an organization administrator, can add a table — ask them to open this Settings tab, or add a table named "Lists" by hand (README).`);
  }
  const url = await findListsTableUrl();
  if (!url) throw new Error("The Lists table was created but couldn't be found afterwards. Reload the page.");
  return url;
}
