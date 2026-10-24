// ---------------------------------------------------------------------------
// Everything that changes stock or item records. Rule: the Transactions table
// is the ledger; Items.qty_on_hand is a cached running total that is updated
// in the SAME transaction as the ledger rows (one service-level applyEdits).
// Quantities are re-read from the service immediately before writing so two
// people working at once can't overwrite each other's counts.
// ---------------------------------------------------------------------------

import { CONFIG, TXN_TYPES } from "../shared/config.js";
import { queryAll, applyServiceEdits, applyEdits } from "../shared/esri-client.js";
import { esc, newTxnId, unique, clampInt } from "../shared/util.js";
import { openModal, toast } from "../shared/ui.js";
import { S, URLS, reindexItems, isRestricted, people } from "./state.js";

/**
 * @param {Array<{item:object, type:string, change?:number, setTo?:number, entity?:object, requestId?:string, note?:string}>} moves
 * @returns {Promise<object[]>} the ledger rows that were written
 */
export async function postStockMoves(moves, { allowNegative = false } = {}) {
  if (!moves.length) throw new Error("Nothing to save.");
  const oids = unique(moves.map((m) => m.item._oid));
  const fresh = await queryAll(URLS.items, { where: `${S.oid.items} IN (${oids.join(",")})`, pageSize: CONFIG.FETCH_PAGE_SIZE });
  const running = new Map(fresh.map((r) => [r._oid, Number(r.qty_on_hand) || 0]));
  const now = Date.now();
  const adds = [];

  for (const m of moves) {
    if (!running.has(m.item._oid)) throw new Error(`“${m.item.description}” no longer exists in the Items table.`);
    const before = running.get(m.item._oid);
    const change = m.setTo !== undefined ? m.setTo - before : m.change;
    if (!Number.isInteger(change)) throw new Error("Quantities must be whole numbers.");
    if (change === 0) continue;
    const after = before + change;
    if (after < 0 && !allowNegative) {
      throw new Error(`“${m.item.description}” would go to ${after} (only ${before} on hand). Reduce the quantity or receive stock first.`);
    }
    running.set(m.item._oid, after);
    const e = m.entity || {};
    adds.push({
      attributes: {
        txn_id: newTxnId(),
        item_id: m.item.item_id,
        item_description: String(m.item.description || "").slice(0, 255),
        category: m.item.category || "",
        txn_type: m.type,
        qty_change: change,
        qty_after: after,
        unit_cost: m.item.unit_cost != null ? Number(m.item.unit_cost) : null,
        request_id: m.requestId || "",
        entity_name: e.name || "",
        entity_email: (e.email || "").toLowerCase(),
        entity_section: e.section || "",
        entity_region: e.region || "",
        performed_by: S.me.name,
        performed_by_email: (S.me.email || "").toLowerCase(),
        txn_date: now,
        note: (m.note || "").slice(0, 500),
      },
    });
  }
  if (!adds.length) throw new Error("No quantities changed.");

  const touched = unique(adds.map((a) => a.attributes.item_id));
  const updates = touched.map((id) => {
    const it = S.itemsById.get(id);
    return { attributes: { [S.oid.items]: it._oid, qty_on_hand: running.get(it._oid) } };
  });

  const res = await applyServiceEdits(URLS.invService, [
    { id: CONFIG.ITEMS_TABLE_ID, updates },
    { id: CONFIG.TXN_TABLE_ID, adds },
  ]);

  // Update local state from what was just written.
  for (const id of touched) {
    const it = S.itemsById.get(id);
    it.qty_on_hand = running.get(it._oid);
  }
  const txnRes = res.find((r) => r.id === CONFIG.TXN_TABLE_ID) || {};
  const rows = adds.map((a, i) => ({ ...a.attributes, _oid: txnRes.addResults && txnRes.addResults[i] ? txnRes.addResults[i].objectId : null }));
  S.txns.push(...rows);
  return rows;
}

// ───────────────────────── entity picker (who received it) ─────────────────────────
export function entityFieldsHtml(prefix = "ent") {
  return `
    <fieldset class="entity-fields"><legend>Issued to</legend>
      <div class="two-col">
        <label>Person
          <input id="${prefix}-name" list="users-dl" autocomplete="off" placeholder="Start typing a name…" />
        </label>
        <label>Their email <span class="hint">(optional — keeps their history together)</span>
          <input id="${prefix}-email" type="email" autocomplete="off" />
        </label>
      </div>
      <div class="two-col">
        <label>Section
          <select id="${prefix}-section"><option value="">—</option>${CONFIG.SECTIONS.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
        </label>
        <label>Region / office
          <select id="${prefix}-region"><option value="">—</option>${CONFIG.REGIONS.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
        </label>
      </div>
    </fieldset>`;
}
export function wireEntityFields(root, prefix = "ent") {
  const name = root.querySelector(`#${prefix}-name`);
  const dl = document.getElementById("users-dl");
  if (dl) dl.innerHTML = people().map((p) => `<option value="${esc(p.name)}"></option>`).join("");
  name.addEventListener("change", () => {
    const u = people().find((x) => x.name.toLowerCase() === name.value.trim().toLowerCase());
    if (u) {
      if (u.section) root.querySelector(`#${prefix}-section`).value = CONFIG.SECTIONS.includes(u.section) ? u.section : "";
      name.dataset.email = u.email;
      const em = root.querySelector(`#${prefix}-email`);
      if (!em.value.trim()) em.value = u.email || "";
    } else {
      name.dataset.email = "";
    }
  });
}
export function readEntityFields(root, prefix = "ent") {
  const name = root.querySelector(`#${prefix}-name`);
  const typed = name.value.trim();
  const u = people().find((x) => x.name.toLowerCase() === typed.toLowerCase());
  return {
    name: typed,
    email: root.querySelector(`#${prefix}-email`).value.trim() || (u ? u.email : name.dataset.email || ""),
    section: root.querySelector(`#${prefix}-section`).value,
    region: root.querySelector(`#${prefix}-region`).value,
  };
}

// ───────────────────────── stock dialog ─────────────────────────
const MODES = {
  receive: { title: "Receive stock", qtyLabel: "Quantity received", type: "RECEIVE", sign: +1 },
  issue: { title: "Issue stock", qtyLabel: "Quantity issued", type: "ISSUE", sign: -1 },
  return: { title: "Return to stock", qtyLabel: "Quantity returned", type: "RETURN", sign: +1 },
  adjust: { title: "Set / correct count", qtyLabel: "Counted quantity (new on-hand)", type: "ADJUST", sign: 0 },
};

export function openStockDialog(item, mode, { onDone } = {}) {
  const m = MODES[mode];
  const hasLedger = S.txns.some((t) => t.item_id === item.item_id);
  const type = mode === "adjust" && !hasLedger ? "INITIAL" : m.type;
  const body = `
    <p class="dlg-item"><b>${esc(item.description)}</b><br><span class="sub">${esc(item.item_id)} · ${esc(item.vendor || "")} ${esc(item.vendor_item_no || "")} · On hand now: <b>${Number(item.qty_on_hand) || 0}</b></span></p>
    <label>${esc(m.qtyLabel)}
      <input id="sd-qty" type="number" min="0" step="1" inputmode="numeric" value="${mode === "adjust" ? Number(item.qty_on_hand) || 0 : ""}" />
    </label>
    ${mode === "issue" || mode === "return" ? entityFieldsHtml() : ""}
    <label>Note ${mode === "adjust" ? "(reason — required)" : "(optional)"}
      <input id="sd-note" type="text" maxlength="400" placeholder="${mode === "receive" ? "PO #, invoice, vendor…" : mode === "adjust" ? "e.g. annual count, damaged, found extra" : ""}" />
    </label>
    ${mode === "issue" ? `<label class="check"><input id="sd-neg" type="checkbox" /> Allow stock to go negative (backorder)</label>` : ""}`;
  const dlg = openModal({
    title: `${m.title}${type === "INITIAL" ? " — initial count" : ""}`,
    body,
    buttons: [
      { label: "Cancel" },
      {
        label: "Save",
        kind: "primary",
        action: async (api) => {
          const root = api.el;
          const raw = root.querySelector("#sd-qty").value;
          if (raw === "" || !Number.isFinite(Number(raw))) throw new Error("Enter a quantity.");
          const qty = Number(raw);
          if (!Number.isInteger(qty) || qty < 0) throw new Error("Quantity must be a whole number, zero or more.");
          if (mode !== "adjust" && qty < 1) throw new Error("Quantity must be at least 1.");
          const note = root.querySelector("#sd-note").value.trim();
          if (mode === "adjust" && !note && type !== "INITIAL") throw new Error("Add a reason for the adjustment.");
          let entity = {};
          if (mode === "issue" || mode === "return") {
            entity = readEntityFields(root);
            if (mode === "issue" && !entity.name && !entity.section && !entity.region)
              throw new Error("Say who it was issued to (person, section or region) so burn rates stay accurate.");
          }
          const move = { item, type, entity, note };
          if (mode === "adjust") move.setTo = qty;
          else move.change = m.sign * qty;
          await postStockMoves([move], { allowNegative: !!root.querySelector("#sd-neg")?.checked });
          toast(`${m.title}: ${item.description}`, "success");
          if (onDone) onDone();
        },
      },
    ],
  });
  if (mode === "issue" || mode === "return") wireEntityFields(dlg.el);
  return dlg;
}

// ───────────────────────── item add / edit ─────────────────────────
const PREFIX = { "Office Supplies": "OFF", Machines: "MCH", "Office Organizer": "ORG", Toner: "TNR", "Cleaning Supplies": "CLN" };

export function nextItemId(category) {
  const prefix = PREFIX[category] || (category.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "ITM");
  let max = 0;
  for (const i of S.items) {
    const m = String(i.item_id).match(new RegExp(`^${prefix}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

export function openItemDialog(item, { onDone } = {}) {
  const isNew = !item;
  const it = item || { category: "", vendor: "", restricted: "no", active: "yes", qty_on_hand: 0 };
  const cats = unique(S.items.map((i) => i.category)).sort();
  const val = (k) => esc(it[k] ?? "");
  const body = `
    <datalist id="cat-dl">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
    <div class="two-col">
      <label>Category <input id="it-category" list="cat-dl" value="${val("category")}" maxlength="60" /></label>
      <label>Item ID <input id="it-item_id" value="${isNew ? "" : val("item_id")}" ${isNew ? 'placeholder="auto"' : "readonly"} maxlength="40" /></label>
    </div>
    <label>Description <input id="it-description" value="${val("description")}" maxlength="255" /></label>
    <div class="two-col">
      <label>Vendor <input id="it-vendor" value="${val("vendor")}" maxlength="40" /></label>
      <label>Vendor item # <input id="it-vendor_item_no" value="${val("vendor_item_no")}" maxlength="40" /></label>
    </div>
    <div class="two-col">
      <label>Unit cost ($) <input id="it-unit_cost" type="number" min="0" step="0.01" value="${it.unit_cost ?? ""}" /></label>
      <label>Reorder level <input id="it-reorder_level" type="number" min="0" step="1" value="${it.reorder_level ?? ""}" /></label>
    </div>
    <label>Product link (URL) <input id="it-product_url" value="${val("product_url")}" maxlength="1000" /></label>
    <label>Product title <input id="it-product_title" value="${val("product_title")}" maxlength="500" /></label>
    <label>Device used on <input id="it-device_used_on" value="${val("device_used_on")}" maxlength="255" /></label>
    <label>Notes <input id="it-notes" value="${val("notes")}" maxlength="500" /></label>
    <div class="two-col">
      <label>Visible to employees?
        <select id="it-restricted">
          <option value="no" ${isRestricted(it) ? "" : "selected"}>Yes — employees can request it</option>
          <option value="yes" ${isRestricted(it) ? "selected" : ""}>No — restricted (tracked by Property Office only)</option>
        </select>
      </label>
      <label>Status
        <select id="it-active"><option value="yes" ${it.active === "no" ? "" : "selected"}>Active</option><option value="no" ${it.active === "no" ? "selected" : ""}>Discontinued (hidden)</option></select>
      </label>
    </div>
    ${isNew ? `<label>Starting quantity on hand <input id="it-start" type="number" min="0" step="1" value="0" /></label>` : `<p class="sub">Quantity on hand changes only through Receive / Issue / Adjust, so the ledger stays accurate.</p>`}`;
  openModal({
    title: isNew ? "Add item" : `Edit ${it.item_id}`,
    wide: true,
    body,
    buttons: [
      { label: "Cancel" },
      {
        label: isNew ? "Add item" : "Save changes",
        kind: "primary",
        action: async (api) => {
          const g = (id) => api.el.querySelector(`#it-${id}`).value.trim();
          const category = g("category");
          const description = g("description");
          if (!category) throw new Error("Category is required.");
          if (!description) throw new Error("Description is required.");
          const costRaw = g("unit_cost");
          const reorderRaw = g("reorder_level");
          const attrs = {
            category,
            description,
            vendor: g("vendor").toUpperCase(),
            vendor_item_no: g("vendor_item_no"),
            unit_cost: costRaw === "" ? null : Number(costRaw),
            reorder_level: reorderRaw === "" ? null : clampInt(reorderRaw, 0, 1e9),
            product_url: g("product_url"),
            product_title: g("product_title"),
            device_used_on: g("device_used_on"),
            notes: g("notes"),
            restricted: g("restricted"),
            active: g("active"),
          };
          if (attrs.unit_cost !== null && !(attrs.unit_cost >= 0)) throw new Error("Unit cost must be a positive number.");
          if (isNew) {
            const id = g("item_id") || nextItemId(category);
            if (S.itemsById.has(id)) throw new Error(`Item ID ${id} already exists.`);
            const start = clampInt(g("start") || 0, 0, 1e9);
            attrs.item_id = id;
            attrs.qty_on_hand = start;
            const edits = [{ id: CONFIG.ITEMS_TABLE_ID, adds: [{ attributes: attrs }] }];
            let txn = null;
            if (start > 0) {
              txn = {
                txn_id: newTxnId(), item_id: id, item_description: description.slice(0, 255), category, txn_type: "INITIAL",
                qty_change: start, qty_after: start, unit_cost: attrs.unit_cost, request_id: "", entity_name: "", entity_email: "",
                entity_section: "", entity_region: "", performed_by: S.me.name, performed_by_email: (S.me.email || "").toLowerCase(),
                txn_date: Date.now(), note: "Starting quantity",
              };
              edits.push({ id: CONFIG.TXN_TABLE_ID, adds: [{ attributes: txn }] });
            }
            const res = await applyServiceEdits(URLS.invService, edits);
            const itemsRes = res.find((r) => r.id === CONFIG.ITEMS_TABLE_ID) || {};
            S.items.push({ ...attrs, _oid: itemsRes.addResults?.[0]?.objectId ?? null });
            const txnRes = res.find((r) => r.id === CONFIG.TXN_TABLE_ID) || {};
            if (txn) S.txns.push({ ...txn, _oid: txnRes.addResults?.[0]?.objectId ?? null });
          } else {
            await applyEdits(URLS.items, { updates: [{ attributes: { [S.oid.items]: it._oid, ...attrs } }] });
            Object.assign(it, attrs);
          }
          reindexItems();
          toast(isNew ? "Item added." : "Item saved.", "success");
          if (onDone) onDone();
        },
      },
    ],
  });
}
