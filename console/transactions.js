// Transactions tab: the full ledger of adds and removes, filters, CSV export,
// and a reconcile check (ledger total vs cached qty_on_hand).
import { TXN_TYPES } from "../shared/config.js";
import { applyEdits } from "../shared/esri-client.js";
import { $, esc, fmtDateTime, matchesSearch, toCSV, downloadText, debounce, DAY_MS } from "../shared/util.js";
import { openModal, toast } from "../shared/ui.js";
import { S, URLS } from "./state.js";
import { ledgerTotals } from "./burn.js";

const F = { q: "", type: "", from: "", to: "", item: "" };
const MAX_ROWS = 500;

function filtered() {
  const from = F.from ? new Date(F.from + "T00:00:00").getTime() : 0;
  const to = F.to ? new Date(F.to + "T00:00:00").getTime() + DAY_MS : Infinity;
  return S.txns
    .filter(
      (t) =>
        (!F.type || t.txn_type === F.type) &&
        (!F.item || t.item_id === F.item) &&
        (t.txn_date || 0) >= from &&
        (t.txn_date || 0) < to &&
        matchesSearch([t.item_id, t.item_description, t.entity_name, t.entity_section, t.entity_region, t.request_id, t.note, t.performed_by, t.txn_id], F.q)
    )
    .sort((a, b) => (b.txn_date || 0) - (a.txn_date || 0));
}

export function renderTransactions() {
  const all = filtered();
  const rows = all.slice(0, MAX_ROWS);
  $("#txn-count").textContent = all.length > MAX_ROWS ? `Showing newest ${MAX_ROWS} of ${all.length} — export CSV for everything` : `${all.length} transaction${all.length === 1 ? "" : "s"}`;
  const chip = $("#txn-item-chip");
  chip.hidden = !F.item;
  chip.innerHTML = F.item ? `Item: <b>${esc(F.item)}</b> <button type="button" class="icon-btn" data-clear-item aria-label="Clear item filter">&times;</button>` : "";
  $("#txn-body").innerHTML =
    rows
      .map((t) => {
        const who = [t.entity_name, t.entity_section, t.entity_region].filter(Boolean).join(" · ");
        return `<tr>
          <td>${fmtDateTime(t.txn_date)}</td>
          <td><div class="t">${esc(t.item_description)}</div><div class="sub mono">${esc(t.item_id)}</div></td>
          <td><span class="txn-type txn-${esc(String(t.txn_type).toLowerCase())}">${esc(TXN_TYPES[t.txn_type]?.label || t.txn_type)}</span></td>
          <td class="num ${t.qty_change > 0 ? "pos" : "neg"}"><b>${t.qty_change > 0 ? "+" : ""}${t.qty_change}</b></td>
          <td class="num">${t.qty_after ?? ""}</td>
          <td>${esc(who) || "—"}</td>
          <td class="mono">${t.request_id ? `<a href="#" data-req="${esc(t.request_id)}">${esc(t.request_id)}</a>` : ""}</td>
          <td>${esc(t.performed_by || "")}</td>
          <td>${esc(t.note || "")}</td>
        </tr>`;
      })
      .join("") || `<tr><td colspan="9" class="empty">No transactions match.</td></tr>`;
}

function exportCSV() {
  downloadText(
    `temazon-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
    toCSV(filtered(), [
      { label: "Date", get: (t) => (t.txn_date ? new Date(t.txn_date).toISOString() : "") },
      { key: "txn_id", label: "Transaction ID" },
      { key: "item_id", label: "Item ID" },
      { key: "item_description", label: "Item" },
      { key: "category", label: "Category" },
      { key: "txn_type", label: "Type" },
      { key: "qty_change", label: "Qty change" },
      { key: "qty_after", label: "Qty after" },
      { key: "unit_cost", label: "Unit cost" },
      { key: "request_id", label: "Request" },
      { key: "entity_name", label: "Person" },
      { key: "entity_section", label: "Section" },
      { key: "entity_region", label: "Region" },
      { key: "performed_by", label: "Performed by" },
      { key: "note", label: "Note" },
    ])
  );
}

function openReconcile() {
  const totals = ledgerTotals(S.txns);
  const diffs = S.items
    .map((i) => ({ i, ledger: totals.get(i.item_id) || 0, cached: Number(i.qty_on_hand) || 0 }))
    .filter((d) => d.ledger !== d.cached);
  if (!diffs.length) {
    openModal({ title: "Reconcile", body: `<p>✔ Every item's on-hand quantity matches the sum of its ledger (${S.items.length} items, ${S.txns.length} transactions).</p>`, buttons: [{ label: "Close" }] });
    return;
  }
  openModal({
    title: "Reconcile — differences found",
    wide: true,
    body: `<p>These items' stored on-hand quantity doesn't equal the sum of their ledger. “Fix” sets on-hand to the ledger total (the ledger is the source of truth). It does not add ledger rows.</p>
      <table class="grid"><thead><tr><th>Item</th><th class="num">On hand (stored)</th><th class="num">Ledger total</th></tr></thead>
      <tbody>${diffs.map((d) => `<tr><td>${esc(d.i.description)}<div class="sub">${esc(d.i.item_id)}</div></td><td class="num">${d.cached}</td><td class="num"><b>${d.ledger}</b></td></tr>`).join("")}</tbody></table>`,
    buttons: [
      { label: "Close" },
      {
        label: `Fix ${diffs.length} item${diffs.length === 1 ? "" : "s"}`,
        kind: "primary",
        action: async () => {
          await applyEdits(URLS.items, { updates: diffs.map((d) => ({ attributes: { [S.oid.items]: d.i._oid, qty_on_hand: d.ledger } })) });
          diffs.forEach((d) => (d.i.qty_on_hand = d.ledger));
          toast("On-hand quantities reconciled.", "success");
          S.render.inv && S.render.inv();
        },
      },
    ],
  });
}

export function showHistory(itemId) {
  F.item = itemId;
  F.q = F.type = F.from = F.to = "";
  $("#txn-search").value = $("#txn-type").value = $("#txn-from").value = $("#txn-to").value = "";
  S.actions.switchTab("txn");
}

export function initTransactions() {
  S.render.txn = renderTransactions;
  S.actions.showHistory = showHistory;
  $("#txn-type").innerHTML = `<option value="">All types</option>` + Object.entries(TXN_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  $("#txn-search").addEventListener("input", debounce((e) => { F.q = e.target.value; renderTransactions(); }, 120));
  $("#txn-type").addEventListener("change", (e) => { F.type = e.target.value; renderTransactions(); });
  $("#txn-from").addEventListener("change", (e) => { F.from = e.target.value; renderTransactions(); });
  $("#txn-to").addEventListener("change", (e) => { F.to = e.target.value; renderTransactions(); });
  $("#txn-export").addEventListener("click", exportCSV);
  $("#txn-reconcile").addEventListener("click", openReconcile);
  $("#txn-item-chip").addEventListener("click", (e) => {
    if (e.target.closest("[data-clear-item]")) { F.item = ""; renderTransactions(); }
  });
  $("#txn-body").addEventListener("click", (e) => {
    const a = e.target.closest("[data-req]");
    if (a) { e.preventDefault(); S.actions.openRequest(a.dataset.req); }
  });
}
