// ---------------------------------------------------------------------------
// Burn-rate maths (pure functions — no DOM, no network).
//
// "Burn rate" = how fast an entity (a person, a section or a region) has been
// consuming an item, taken from the Transactions ledger: ISSUE rows count as
// consumption, RETURN rows give some back.
// ---------------------------------------------------------------------------

import { MONTH_MS } from "../shared/util.js";

export const ENTITY_TYPES = ["person", "section", "region"];

/** The comparison key a ledger row / request has for the given entity type ('' = none). */
export function entityKey(row, type) {
  if (type === "person") {
    // ledger rows: entity_*; request rows: requester_*
    return String(row.entity_email || row.requester_email || row.entity_name || row.requester_name || "").trim().toLowerCase();
  }
  if (type === "section") return String(row.entity_section ?? row.section ?? "").trim().toLowerCase();
  if (type === "region") return String(row.entity_region ?? row.region ?? "").trim().toLowerCase();
  return "";
}

const isUse = (t) => t.txn_type === "ISSUE" || t.txn_type === "RETURN";
/** Units consumed by one ledger row (+ for ISSUE, − for RETURN). */
const used = (t) => -(Number(t.qty_change) || 0);

const spanMonths = (firstTs, now, windowMonths) => {
  const since = firstTs ? (now - firstTs) / MONTH_MS : 1;
  const cap = windowMonths || Infinity;
  return Math.max(1, Math.min(cap, since));
};

/**
 * Per-item usage for ONE entity plus the peer average, over a trailing window.
 * @param {object[]} txns       full ledger
 * @param {{type:string,key:string,months:number|null,now?:number}} o   months=null → all time
 * @returns {Map<string,{qty:number,issues:number,last:number|null,monthly:number,peerMonthly:number,peers:number,orgQty:number}>}
 */
export function computeBurn(txns, { type, key, months, now = Date.now() }) {
  const cutoff = months ? now - months * MONTH_MS : 0;
  const all = txns.filter(isUse);
  const win = all.filter((t) => (t.txn_date || 0) >= cutoff);

  const mineAll = all.filter((t) => entityKey(t, type) === key);
  const firstMine = mineAll.reduce((m, t) => (t.txn_date && (!m || t.txn_date < m) ? t.txn_date : m), 0);
  const mySpan = spanMonths(firstMine, now, months);

  const firstOrg = all.reduce((m, t) => (t.txn_date && (!m || t.txn_date < m) ? t.txn_date : m), 0);
  const orgSpan = spanMonths(firstOrg, now, months);

  const out = new Map();
  const slot = (id) => {
    if (!out.has(id)) out.set(id, { qty: 0, issues: 0, last: null, monthly: 0, peerMonthly: 0, peers: 0, orgQty: 0 });
    return out.get(id);
  };
  const peerSets = new Map();
  for (const t of win) {
    const s = slot(t.item_id);
    const k = entityKey(t, type);
    s.orgQty += used(t);
    if (k) {
      if (!peerSets.has(t.item_id)) peerSets.set(t.item_id, new Set());
      peerSets.get(t.item_id).add(k);
    }
    if (k === key) {
      s.qty += used(t);
      if (t.txn_type === "ISSUE") {
        s.issues += 1;
        if (!s.last || t.txn_date > s.last) s.last = t.txn_date;
      }
    }
  }
  for (const [id, s] of out) {
    s.monthly = s.qty / mySpan;
    const peers = peerSets.get(id);
    s.peers = peers ? peers.size : 0;
    s.peerMonthly = s.peers ? s.orgQty / s.peers / orgSpan : 0;
  }
  return out;
}

/** Months the quantity would last at the entity's monthly rate (null = no history). */
export function monthsOfSupply(qty, monthly) {
  if (!(monthly > 0)) return null;
  return qty / monthly;
}

/** 'none' | 'ok' | 'warn' | 'alert' for the review flag. */
export function supplyFlag(months, warnAt, alertAt) {
  if (months === null) return "none";
  if (months > alertAt) return "alert";
  if (months > warnAt) return "warn";
  return "ok";
}

/** Net units + cost issued to an entity over a window (for the summary tiles). */
export function totalsFor(txns, { type, key, months, now = Date.now() }) {
  const cutoff = months ? now - months * MONTH_MS : 0;
  let units = 0,
    cost = 0,
    last = null;
  for (const t of txns) {
    if (!isUse(t) || (t.txn_date || 0) < cutoff || entityKey(t, type) !== key) continue;
    units += used(t);
    cost += used(t) * (Number(t.unit_cost) || 0);
    if (t.txn_type === "ISSUE" && (!last || t.txn_date > last)) last = t.txn_date;
  }
  return { units, cost, last };
}

/** Sum of the ledger per item — used to reconcile cached qty_on_hand. */
export function ledgerTotals(txns) {
  const m = new Map();
  for (const t of txns) m.set(t.item_id, (m.get(t.item_id) || 0) + (Number(t.qty_change) || 0));
  return m;
}
