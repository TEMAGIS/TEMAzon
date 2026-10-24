// Shared in-memory state + URL helpers for the console modules.
import { CONFIG } from "../shared/config.js";
import { tableUrl } from "../shared/esri-client.js";

export const URLS = {
  invService: CONFIG.INVENTORY_SERVICE_URL,
  reqService: CONFIG.REQUESTS_SERVICE_URL,
  items: CONFIG.INVENTORY_SERVICE_URL ? tableUrl(CONFIG.INVENTORY_SERVICE_URL, CONFIG.ITEMS_TABLE_ID) : "",
  txns: CONFIG.INVENTORY_SERVICE_URL ? tableUrl(CONFIG.INVENTORY_SERVICE_URL, CONFIG.TXN_TABLE_ID) : "",
  reqs: CONFIG.REQUESTS_SERVICE_URL ? tableUrl(CONFIG.REQUESTS_SERVICE_URL, CONFIG.REQ_TABLE_ID) : "",
  lines: CONFIG.REQUESTS_SERVICE_URL ? tableUrl(CONFIG.REQUESTS_SERVICE_URL, CONFIG.LINES_TABLE_ID) : "",
};

export const S = {
  me: null,
  items: [],
  itemsById: new Map(),
  txns: [],
  reqs: [],
  lines: [],
  oid: { items: "OBJECTID", txns: "OBJECTID", reqs: "OBJECTID", lines: "OBJECTID" },
  tab: "inv",
  actions: {}, // cross-module callbacks, filled in by app.js
  render: {}, // per-tab render functions, filled in by each module
};

export function reindexItems() {
  S.itemsById = new Map(S.items.map((i) => [i.item_id, i]));
}

export const linesFor = (requestId) => S.lines.filter((l) => l.request_id === requestId).sort((a, b) => (a.line_no || 0) - (b.line_no || 0));

export const isRestricted = (item) => String(item.restricted || "").toLowerCase() !== "no";

export function stockState(item) {
  const q = Number(item.qty_on_hand) || 0;
  const low = item.reorder_level !== null && item.reorder_level !== undefined && item.reorder_level !== "" ? Number(item.reorder_level) : null;
  if (q <= 0) return "out";
  if (low !== null && q <= low) return "low";
  return "ok";
}

/** People we know about, built from requests and the ledger: [{name,email,section}]. */
export function people() {
  const m = new Map();
  const add = (name, email, section) => {
    const key = String(email || name || "").trim().toLowerCase();
    if (!key) return;
    const cur = m.get(key) || { name: "", email: "", section: "" };
    m.set(key, { name: cur.name || name || "", email: cur.email || email || "", section: cur.section || section || "" });
  };
  for (const r of S.reqs) add(r.requester_name, r.requester_email, r.section);
  for (const t of S.txns) add(t.entity_name, t.entity_email, t.entity_section);
  return Array.from(m.values()).filter((p) => p.name).sort((a, b) => a.name.localeCompare(b.name));
}
