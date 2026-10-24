// Inventory tab: current stock (from the ledger-backed qty_on_hand), filters,
// stock actions, count mode, CSV export.
import { CONFIG } from "../shared/config.js";
import { $, $$, esc, money, matchesSearch, toCSV, downloadText, unique, debounce, clampInt } from "../shared/util.js";
import { toast, confirmDialog } from "../shared/ui.js";
import { S, isRestricted, stockState } from "./state.js";
import { postStockMoves, openStockDialog, openItemDialog } from "./stock.js";

const F = { q: "", cat: "", vis: "all", stock: "all", count: false };

function filtered() {
  return S.items
    .filter((i) => {
      if (F.cat && i.category !== F.cat) return false;
      if (F.vis === "visible" && isRestricted(i)) return false;
      if (F.vis === "restricted" && !isRestricted(i)) return false;
      if (F.vis === "inactive" && i.active !== "no") return false;
      const st = stockState(i);
      if (F.stock === "low" && st !== "low") return false;
      if (F.stock === "out" && st !== "out") return false;
      if (F.stock === "instock" && st === "out") return false;
      return matchesSearch([i.item_id, i.description, i.vendor, i.vendor_item_no, i.category, i.device_used_on, i.product_title], F.q);
    })
    .sort((a, b) => (a.category || "").localeCompare(b.category || "") || (a.description || "").localeCompare(b.description || ""));
}

function tiles() {
  const active = S.items.filter((i) => i.active !== "no");
  const value = active.reduce((s, i) => s + (Number(i.qty_on_hand) || 0) * (Number(i.unit_cost) || 0), 0);
  const low = active.filter((i) => stockState(i) === "low").length;
  const out = active.filter((i) => stockState(i) === "out").length;
  const restricted = active.filter(isRestricted).length;
  const pending = S.reqs.filter((r) => r.status === "Pending").length;
  return `
    <div class="tile"><div class="tile-n">${active.length}</div><div class="tile-l">Active items</div></div>
    <div class="tile"><div class="tile-n">${money(value)}</div><div class="tile-l">Value on hand</div></div>
    <div class="tile ${low ? "tile-warn" : ""}"><div class="tile-n">${low}</div><div class="tile-l">Low stock</div></div>
    <div class="tile ${out ? "tile-bad" : ""}"><div class="tile-n">${out}</div><div class="tile-l">Out of stock</div></div>
    <div class="tile tile-restricted"><div class="tile-n">${restricted}</div><div class="tile-l">Restricted (hidden)</div></div>
    <div class="tile ${pending ? "tile-info" : ""}" data-goto="req"><div class="tile-n">${pending}</div><div class="tile-l">Pending requests</div></div>`;
}

export function renderInventory() {
  $("#inv-tiles").innerHTML = tiles();
  const cats = unique(S.items.map((i) => i.category)).sort();
  const sel = $("#inv-cat");
  const cur = sel.value;
  sel.innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option ${c === cur ? "selected" : ""}>${esc(c)}</option>`).join("");

  const rows = filtered();
  $("#inv-count").textContent = `${rows.length} of ${S.items.length} items`;
  $("#inv-table").classList.toggle("count-mode", F.count);
  $("#count-bar").hidden = !F.count;
  $("#inv-body").innerHTML =
    rows
      .map((i) => {
        const st = stockState(i);
        const qty = Number(i.qty_on_hand) || 0;
        const value = qty * (Number(i.unit_cost) || 0);
        const r = isRestricted(i);
        return `<tr data-id="${esc(i.item_id)}" class="${r ? "row-restricted" : ""}${i.active === "no" ? " row-inactive" : ""}">
          <td class="mono">${esc(i.item_id)}</td>
          <td class="item-cell"><div class="t">${i.product_url ? `<a href="${esc(i.product_url)}" target="_blank" rel="noopener noreferrer">${esc(i.description)}</a>` : esc(i.description)}</div>
            <div class="sub">${esc([i.vendor, i.vendor_item_no].filter(Boolean).join(" · "))}${i.device_used_on ? " · for " + esc(i.device_used_on) : ""}</div></td>
          <td>${esc(i.category)}</td>
          <td class="num qty-cell stock-${st}">${F.count ? `<input type="number" min="0" step="1" class="count-input" data-count value="${qty}" data-orig="${qty}" aria-label="Count for ${esc(i.description)}" />` : `<b>${qty}</b>`}</td>
          <td class="num">${i.reorder_level ?? "—"}</td>
          <td class="num">${money(i.unit_cost)}</td>
          <td class="num">${money(value)}</td>
          <td>${r ? `<span class="tag tag-restricted" title="Hidden from the employee request form">Restricted</span>` : `<span class="tag">Employees</span>`}${i.active === "no" ? ` <span class="tag tag-muted">Discontinued</span>` : ""}</td>
          <td class="row-actions">
            <button type="button" data-act="receive" title="Receive stock">+ Add</button>
            <button type="button" data-act="issue" title="Issue stock">− Issue</button>
            <button type="button" data-act="adjust" title="Set / correct count">Count</button>
            <button type="button" data-act="history" title="Ledger history">History</button>
            <button type="button" data-act="edit" title="Edit item">Edit</button>
          </td>
        </tr>`;
      })
      .join("") || `<tr><td colspan="9" class="empty">No items match these filters.</td></tr>`;
}

async function saveCounts() {
  const moves = [];
  for (const input of $$(".count-input", $("#inv-body"))) {
    const raw = input.value.trim();
    if (raw === "" || raw === input.dataset.orig) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      input.focus();
      throw new Error("Counts must be whole numbers, zero or more.");
    }
    const item = S.itemsById.get(input.closest("tr").dataset.id);
    const hasLedger = S.txns.some((t) => t.item_id === item.item_id);
    moves.push({ item, type: hasLedger ? "ADJUST" : "INITIAL", setTo: n, note: hasLedger ? "Inventory count" : "Initial count" });
  }
  if (!moves.length) {
    toast("No counts changed.", "info");
    return;
  }
  if (!(await confirmDialog({ title: "Save counts?", message: `Record ${moves.length} count change${moves.length === 1 ? "" : "s"} in the ledger?`, confirmLabel: "Save counts" }))) return;
  // Write in batches so one service call never gets enormous.
  for (let i = 0; i < moves.length; i += 100) await postStockMoves(moves.slice(i, i + 100));
  toast(`Saved ${moves.length} count${moves.length === 1 ? "" : "s"}.`, "success");
  F.count = false;
  $("#count-toggle").classList.remove("active");
  renderInventory();
}

export function exportInventoryCSV() {
  const rows = filtered();
  downloadText(
    `temazon-inventory-${new Date().toISOString().slice(0, 10)}.csv`,
    toCSV(rows, [
      { key: "item_id", label: "Item ID" },
      { key: "category", label: "Category" },
      { key: "description", label: "Description" },
      { key: "vendor", label: "Vendor" },
      { key: "vendor_item_no", label: "Vendor item #" },
      { key: "qty_on_hand", label: "Qty on hand" },
      { key: "reorder_level", label: "Reorder level" },
      { key: "unit_cost", label: "Unit cost" },
      { label: "Value on hand", get: (i) => ((Number(i.qty_on_hand) || 0) * (Number(i.unit_cost) || 0)).toFixed(2) },
      { label: "Restricted", get: (i) => (isRestricted(i) ? "yes" : "no") },
      { key: "active", label: "Active" },
      { key: "product_url", label: "Link" },
    ])
  );
}

export function initInventory() {
  S.render.inv = renderInventory;
  const rerender = () => renderInventory();
  $("#inv-search").addEventListener("input", debounce((e) => { F.q = e.target.value; rerender(); }, 120));
  $("#inv-cat").addEventListener("change", (e) => { F.cat = e.target.value; rerender(); });
  $("#inv-vis").addEventListener("change", (e) => { F.vis = e.target.value; rerender(); });
  $("#inv-stock").addEventListener("change", (e) => { F.stock = e.target.value; rerender(); });
  $("#inv-add").addEventListener("click", () => openItemDialog(null, { onDone: rerender }));
  $("#inv-export").addEventListener("click", exportInventoryCSV);
  $("#count-toggle").addEventListener("click", (e) => {
    F.count = !F.count;
    e.currentTarget.classList.toggle("active", F.count);
    rerender();
  });
  $("#count-cancel").addEventListener("click", () => {
    F.count = false;
    $("#count-toggle").classList.remove("active");
    rerender();
  });
  $("#count-save").addEventListener("click", async () => {
    const btn = $("#count-save");
    btn.disabled = true;
    try {
      await saveCounts();
    } catch (err) {
      toast(err.message, "error", 8000);
    } finally {
      btn.disabled = false;
    }
  });
  $("#inv-tiles").addEventListener("click", (e) => {
    if (e.target.closest("[data-goto]")) S.actions.switchTab("req");
  });
  $("#inv-body").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const item = S.itemsById.get(btn.closest("tr").dataset.id);
    const act = btn.dataset.act;
    if (act === "edit") openItemDialog(item, { onDone: rerender });
    else if (act === "history") S.actions.showHistory(item.item_id);
    else openStockDialog(item, act, { onDone: rerender });
  });
}
