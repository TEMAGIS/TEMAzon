// ---------------------------------------------------------------------------
// Import CSV: edit the item list in a spreadsheet, bring it back in.
//
//   * Rows are matched by Item ID. A blank Item ID = a NEW item.
//   * Only the item details are imported (category, description, vendor, cost,
//     reorder level, visibility, status, links, notes).
//   * Qty on hand is NEVER changed by an import, so the ledger stays accurate
//     (use Count mode / Receive / Issue / Adjust). The one exception: a NEW
//     item may carry a starting quantity, which is recorded as an INITIAL entry.
//   * A column that is present in the file is applied to every row (a blank
//     cell clears an optional field). A column that is missing is left alone.
//   * Nothing is written until you have seen the preview and click Apply.
// ---------------------------------------------------------------------------

import { queryAll, applyEdits, applyServiceEdits } from "../shared/esri-client.js";
import { CONFIG } from "../shared/config.js";
import { esc, parseCSV, safeUrl, newTxnId } from "../shared/util.js";
import { openModal, toast } from "../shared/ui.js";
import { S, URLS, reindexItems, isRestricted } from "./state.js";
import { nextItemId } from "./stock.js";

const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// field -> { header names we accept, type, max length, required }
const FIELDS = [
  { f: "item_id", names: ["itemid", "id"] },
  { f: "category", names: ["category"], type: "text", max: 60, required: true },
  { f: "description", names: ["description", "item"], type: "text", max: 255, required: true },
  { f: "vendor", names: ["vendor"], type: "upper", max: 40 },
  { f: "vendor_item_no", names: ["vendoritem", "vendoritemno", "vendoritemnumber"], type: "text", max: 40 },
  { f: "unit_cost", names: ["unitcost", "cost", "price"], type: "money" },
  { f: "reorder_level", names: ["reorderlevel", "reorder"], type: "int" },
  { f: "restricted", names: ["restricted"], type: "yesno", required: true },
  { f: "active", names: ["active"], type: "yesno", required: true },
  { f: "product_url", names: ["link", "producturl", "url"], type: "url", max: 1000 },
  { f: "product_title", names: ["producttitle"], type: "text", max: 500 },
  { f: "device_used_on", names: ["deviceusedon", "device"], type: "text", max: 255 },
  { f: "notes", names: ["notes"], type: "text", max: 500 },
];
const QTY_NAMES = ["qtyonhand", "quantityonhand", "qty", "quantity"];
const LABELS = {
  category: "Category", description: "Description", vendor: "Vendor", vendor_item_no: "Vendor item #", unit_cost: "Unit cost",
  reorder_level: "Reorder level", restricted: "Restricted", active: "Active", product_url: "Link", product_title: "Product title",
  device_used_on: "Device used on", notes: "Notes",
};

/** Turns one raw cell into a clean value, or throws a message. */
function cleanCell(def, raw) {
  const v = String(raw ?? "").trim();
  switch (def.type) {
    case "text":
    case "upper": {
      if (def.required && !v) throw new Error(`${LABELS[def.f]} can't be blank`);
      if (v.length > def.max) throw new Error(`${LABELS[def.f]} is longer than ${def.max} characters`);
      return def.type === "upper" ? v.toUpperCase() : v;
    }
    case "money": {
      if (v === "") return null;
      const n = Number(v.replace(/^\$/, "").replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) throw new Error(`Unit cost "${v}" isn't a valid amount`);
      return Math.round(n * 100) / 100;
    }
    case "int": {
      if (v === "") return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new Error(`Reorder level "${v}" must be a whole number, 0 or more`);
      return n;
    }
    case "yesno": {
      const l = v.toLowerCase();
      if (["yes", "y", "true"].includes(l)) return "yes";
      if (["no", "n", "false"].includes(l)) return "no";
      throw new Error(`${LABELS[def.f]} must be yes or no (got "${v}")`);
    }
    case "url": {
      if (v === "") return "";
      if (!safeUrl(v)) throw new Error(`Link must start with http:// or https://`);
      if (v.length > def.max) throw new Error(`Link is too long`);
      return v;
    }
    default:
      return v;
  }
}

const same = (a, b) => (a === null || a === undefined || a === "" ? b === null || b === undefined || b === "" : a === b);
const current = (item, f) => (f === "restricted" ? (isRestricted(item) ? "yes" : "no") : f === "active" ? (item.active === "no" ? "no" : "yes") : item[f]);
const show = (v) => (v === null || v === undefined || v === "" ? "(blank)" : String(v));

function buildPlan(text) {
  const grid = parseCSV(text);
  if (grid.length < 2) throw new Error("That file has no data rows.");
  const header = grid[0].map(norm);
  const colOf = {};
  FIELDS.forEach((d) => {
    const idx = header.findIndex((h) => d.names.includes(h));
    if (idx >= 0) colOf[d.f] = idx;
  });
  const qtyCol = header.findIndex((h) => QTY_NAMES.includes(h));
  if (colOf.item_id === undefined) throw new Error('The file needs an "Item ID" column (leave a cell blank to add a new item).');

  const plan = { updates: [], adds: [], unchanged: 0, errors: [], qtyDiffs: 0, missingRestricted: false, notes: [] };
  const seen = new Set();
  const issued = {}; // prefix -> highest number handed out in this file
  const newId = (category) => {
    const base = nextItemId(category);
    const k = base.lastIndexOf("-");
    const prefix = base.slice(0, k);
    const n = Math.max(Number(base.slice(k + 1)), (issued[prefix] || 0) + 1);
    issued[prefix] = n;
    return `${prefix}-${String(n).padStart(3, "0")}`;
  };
  if (colOf.restricted === undefined) plan.missingRestricted = true;
  const ignoredCols = FIELDS.filter((d) => d.f !== "item_id" && colOf[d.f] === undefined).map((d) => LABELS[d.f]);
  if (ignoredCols.length) plan.notes.push(`Columns not in the file, so left unchanged: ${ignoredCols.join(", ")}.`);

  for (let r = 1; r < grid.length; r++) {
    const rowNo = r + 1;
    const cells = grid[r];
    const id = String(cells[colOf.item_id] ?? "").trim();
    const attrs = {};
    const problems = [];
    const item = id ? S.itemsById.get(id) : null;
    for (const d of FIELDS) {
      if (d.f === "item_id" || colOf[d.f] === undefined) continue;
      // a blank Restricted/Active on a NEW row just takes the safe default (hidden / active)
      if (!item && d.type === "yesno" && String(cells[colOf[d.f]] ?? "").trim() === "") continue;
      try {
        attrs[d.f] = cleanCell(d, cells[colOf[d.f]]);
      } catch (e) {
        problems.push(e.message);
      }
    }
    if (id) {
      if (seen.has(id)) problems.push(`Item ID ${id} appears more than once in the file`);
      seen.add(id);
    }
    if (id && !item) problems.push(`Item ID "${id}" doesn't exist (leave it blank to add a new item)`);
    if (problems.length) {
      plan.errors.push({ rowNo, id, msg: problems.join("; ") });
      continue;
    }

    if (item) {
      const changes = [];
      for (const [f, v] of Object.entries(attrs)) {
        const old = current(item, f);
        if (!same(old, v)) changes.push({ f, old, v });
      }
      if (qtyCol >= 0) {
        const q = String(cells[qtyCol] ?? "").trim();
        if (q !== "" && Number(q) !== (Number(item.qty_on_hand) || 0)) plan.qtyDiffs++;
      }
      if (changes.length) plan.updates.push({ item, changes });
      else plan.unchanged++;
    } else {
      // brand-new item
      const missing = ["category", "description"].filter((f) => !attrs[f]);
      if (missing.length) {
        plan.errors.push({ rowNo, id: "(new)", msg: `New item needs ${missing.join(" and ")}` });
        continue;
      }
      const full = { vendor: "", vendor_item_no: "", unit_cost: null, reorder_level: null, product_url: "", product_title: "", device_used_on: "", notes: "", active: "yes", ...attrs };
      // safest default for a new row: hidden from employees until you say otherwise
      if (!attrs.restricted) {
        full.restricted = "yes";
        plan.missingRestricted = true;
      }
      let start = 0;
      if (qtyCol >= 0) {
        const q = String(cells[qtyCol] ?? "").trim();
        if (q !== "") {
          const n = Number(q);
          if (!Number.isInteger(n) || n < 0) {
            plan.errors.push({ rowNo, id: "(new)", msg: `Qty on hand "${q}" must be a whole number` });
            continue;
          }
          start = n;
        }
      }
      full.item_id = id || newId(full.category);
      plan.adds.push({ attrs: full, start });
    }
  }
  return plan;
}

function previewHtml(plan, fileName) {
  const tag = (t, cls) => `<span class="tag ${cls || ""}">${esc(t)}</span>`;
  const MAX = 200;
  const chg = plan.updates.slice(0, MAX).map(({ item, changes }) => {
    const parts = changes
      .map(({ f, old, v }) => {
        let extra = "";
        if (f === "restricted") extra = v === "yes" ? " " + tag("will be HIDDEN from employees", "bad") : " " + tag("will be VISIBLE to employees", "warn");
        return `<div><b>${esc(LABELS[f])}:</b> ${esc(show(old))} &rarr; ${esc(show(v))}${extra}</div>`;
      })
      .join("");
    return `<tr><td class="mono">${esc(item.item_id)}</td><td>${esc(item.description)}</td><td>${parts}</td></tr>`;
  });
  const adds = plan.adds.slice(0, MAX).map(
    ({ attrs, start }) =>
      `<tr><td class="mono">${esc(attrs.item_id)}</td><td>${esc(attrs.description)}</td><td>${esc(attrs.category)} · ${attrs.restricted === "yes" ? tag("hidden from employees", "bad") : tag("visible to employees", "warn")}${start ? ` · starting qty ${start}` : ""}</td></tr>`
  );
  const errs = plan.errors.slice(0, 60).map((e) => `<li>Row ${e.rowNo}${e.id ? ` (${esc(e.id)})` : ""}: ${esc(e.msg)}</li>`);
  return `
    <p class="sub">File: <b>${esc(fileName)}</b></p>
    <div class="banner ${plan.errors.length ? "banner-warn" : "banner-ok"}">
      <b>${plan.updates.length}</b> item${plan.updates.length === 1 ? "" : "s"} to update ·
      <b>${plan.adds.length}</b> new · ${plan.unchanged} unchanged · <b>${plan.errors.length}</b> with problems
    </div>
    ${plan.errors.length ? `<div class="banner banner-warn" style="display:block"><b>Fix these in the file and import again — nothing has been saved:</b><ul>${errs.join("")}</ul>${plan.errors.length > 60 ? `<div class="sub">…and ${plan.errors.length - 60} more.</div>` : ""}</div>` : ""}
    ${plan.qtyDiffs ? `<p class="sub">${plan.qtyDiffs} row${plan.qtyDiffs === 1 ? " has" : "s have"} a different Qty on hand in the file. <b>Quantities are not changed by an import</b> — use Count mode so the ledger stays accurate.</p>` : ""}
    ${plan.missingRestricted && plan.adds.length ? `<p class="sub">New items with no Restricted value start <b>hidden from employees</b> until you change them.</p>` : ""}
    ${plan.notes.map((n) => `<p class="sub">${esc(n)}</p>`).join("")}
    ${plan.updates.length ? `<h3>Changes</h3><div class="table-wrap"><table class="grid"><thead><tr><th>ID</th><th>Item</th><th>What changes</th></tr></thead><tbody>${chg.join("")}</tbody></table></div>${plan.updates.length > MAX ? `<p class="sub">Showing the first ${MAX} of ${plan.updates.length}. All will be applied.</p>` : ""}` : ""}
    ${plan.adds.length ? `<h3>New items</h3><div class="table-wrap"><table class="grid"><thead><tr><th>ID</th><th>Item</th><th>Details</th></tr></thead><tbody>${adds.join("")}</tbody></table></div>` : ""}
    ${!plan.updates.length && !plan.adds.length && !plan.errors.length ? "<p>Nothing to change — the file matches what's already in the inventory.</p>" : ""}`;
}

async function apply(plan, onDone) {
  let done = 0;
  try {
    // 1) updates to existing items (only the fields that changed; qty_on_hand is never touched)
    for (let i = 0; i < plan.updates.length; i += 100) {
      const batch = plan.updates.slice(i, i + 100);
      await applyEdits(URLS.items, {
        updates: batch.map(({ item, changes }) => ({
          attributes: { [S.oid.items]: item._oid, ...Object.fromEntries(changes.map((c) => [c.f, c.v])) },
        })),
      });
      for (const { item, changes } of batch) for (const c of changes) item[c.f] = c.v;
      done += batch.length;
    }
    // 2) new items (+ an INITIAL ledger entry when a starting quantity was given), item and ledger in one transaction
    for (let i = 0; i < plan.adds.length; i += 50) {
      const batch = plan.adds.slice(i, i + 50);
      const itemAdds = [];
      const txnAdds = [];
      for (const { attrs, start } of batch) {
        itemAdds.push({ attributes: { ...attrs, qty_on_hand: start } });
        if (start > 0) {
          txnAdds.push({
            attributes: {
              txn_id: newTxnId(), item_id: attrs.item_id, item_description: attrs.description.slice(0, 255), category: attrs.category,
              txn_type: "INITIAL", qty_change: start, qty_after: start, unit_cost: attrs.unit_cost, request_id: "", entity_name: "",
              entity_email: "", entity_section: "", entity_region: "", performed_by: S.me.name,
              performed_by_email: (S.me.email || "").toLowerCase(), txn_date: Date.now() + txnAdds.length, note: "Starting quantity (CSV import)",
            },
          });
        }
      }
      const edits = [{ id: CONFIG.ITEMS_TABLE_ID, adds: itemAdds }];
      if (txnAdds.length) edits.push({ id: CONFIG.TXN_TABLE_ID, adds: txnAdds });
      const res = await applyServiceEdits(URLS.invService, edits);
      const itemRes = (res.find((r) => r.id === CONFIG.ITEMS_TABLE_ID) || {}).addResults || [];
      const txnRes = (res.find((r) => r.id === CONFIG.TXN_TABLE_ID) || {}).addResults || [];
      itemAdds.forEach((a, k) => S.items.push({ ...a.attributes, _oid: itemRes[k]?.objectId ?? null }));
      txnAdds.forEach((a, k) => S.txns.push({ ...a.attributes, _oid: txnRes[k]?.objectId ?? null }));
      done += batch.length;
    }
  } catch (err) {
    reindexItems();
    if (onDone) onDone();
    throw new Error(`Stopped after saving ${done} of ${plan.updates.length + plan.adds.length} items: ${err.message}. Reload the data and import the same file again — items already saved will show as unchanged.`);
  }
  reindexItems();
  toast(`Import complete: ${plan.updates.length} updated, ${plan.adds.length} added.`, "success", 6000);
  if (onDone) onDone();
}

export async function startImport(file, { onDone } = {}) {
  if (file.size > 5 * 1024 * 1024) throw new Error("That file is too large for an item import (limit 5 MB).");
  const text = await file.text();
  // Compare against what is in the service right now, not what was loaded earlier.
  S.items = await queryAll(URLS.items, { pageSize: CONFIG.FETCH_PAGE_SIZE });
  reindexItems();
  const plan = buildPlan(text);
  const total = plan.updates.length + plan.adds.length;
  openModal({
    title: "Import items from CSV",
    wide: true,
    body: previewHtml(plan, file.name),
    buttons: [
      { label: plan.errors.length || !total ? "Close" : "Cancel" },
      ...(total && !plan.errors.length
        ? [{ label: `Apply ${total} change${total === 1 ? "" : "s"}`, kind: "primary", action: () => apply(plan, onDone) }]
        : []),
    ],
  });
}
