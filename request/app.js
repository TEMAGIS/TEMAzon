// ---------------------------------------------------------------------------
// TEMAzon — Supply Request form (employee-facing).
//   • reads the catalog from the EMPLOYEE VIEW of Items (restricted rows are
//     not in that view at all — see README), with a client-side filter as a
//     second line of defence
//   • writes Requests + RequestLines to the Requests service in ONE
//     transaction; never touches the Inventory service
// ---------------------------------------------------------------------------

import { CONFIG, REQUEST_STATUS } from "../shared/config.js";
import { startSession } from "../shared/session.js";
import { queryAll, applyEdits, applyServiceEdits, getLayerInfo, checkFieldNames, tableUrl, sqlStr } from "../shared/esri-client.js";
import { REQUESTS_TABLE, LINES_TABLE, fieldNames } from "../shared/schema.js";
import { $, $$, esc, safeUrl, money, fmtDate, newRequestId, matchesSearch, clampInt, debounce, unique } from "../shared/util.js";
import { toast, setStatus, confirmDialog } from "../shared/ui.js";
import { loadLists } from "../shared/lists.js";

const ITEMS_URL = CONFIG.ITEMS_VIEW_URL || (CONFIG.INVENTORY_SERVICE_URL ? tableUrl(CONFIG.INVENTORY_SERVICE_URL, CONFIG.ITEMS_TABLE_ID) : "");
const REQ_URL = CONFIG.REQUESTS_SERVICE_URL ? tableUrl(CONFIG.REQUESTS_SERVICE_URL, CONFIG.REQ_TABLE_ID) : "";
const LINES_URL = CONFIG.REQUESTS_SERVICE_URL ? tableUrl(CONFIG.REQUESTS_SERVICE_URL, CONFIG.LINES_TABLE_ID) : "";

const S = {
  me: null,
  items: [],
  byId: new Map(),
  cart: new Map(), // item_id -> { item, qty, note }
  cat: "All",
  q: "",
  tab: "new",
  mine: [],
  reqOid: "OBJECTID",
  submitting: false,
};

// ───────────────────────── helpers ─────────────────────────
function stockInfo(item) {
  const q = Number(item.qty_on_hand) || 0;
  const low = item.reorder_level != null && item.reorder_level !== "" ? Number(item.reorder_level) : null;
  const mode = CONFIG.STOCK_VISIBILITY || "full";
  if (mode === "hidden") return { cls: "", text: "" };
  const exact = mode === "full";
  if (q <= 0) return { cls: "stock-out", text: "Out of stock" };
  if (low != null && q <= low) return { cls: "stock-low", text: exact ? `Low — ${q} in stock` : "Low stock" };
  return { cls: "stock-ok", text: exact ? `${q} in stock` : "In stock" };
}

const parseHTML = (html) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

// ───────────────────────── catalog ─────────────────────────
function cardHtml(item) {
  const st = stockInfo(item);
  const inCart = S.cart.get(item.item_id);
  const meta = [item.vendor, item.vendor_item_no ? `#${item.vendor_item_no}` : ""].filter(Boolean).join(" ");
  const price = CONFIG.SHOW_PRICES_TO_EMPLOYEES && item.unit_cost != null ? `<span class="price">${money(item.unit_cost)}</span>` : "";
  const device = item.device_used_on ? `<div class="item-device">For: ${esc(item.device_used_on)}</div>` : "";
  const action = inCart
    ? `<div class="stepper" role="group" aria-label="Quantity">
         <button type="button" data-dec aria-label="Decrease quantity">−</button>
         <input type="number" min="1" max="${CONFIG.MAX_QTY_PER_LINE}" value="${inCart.qty}" data-qty aria-label="Quantity for ${esc(item.description)}" />
         <button type="button" data-inc aria-label="Increase quantity">+</button>
       </div>`
    : `<button type="button" class="btn-add" data-add>Add</button>`;
  return `<article class="item-card${inCart ? " in-cart" : ""}" data-id="${esc(item.item_id)}">
    <div class="item-main">
      <h3>${inCart ? `<span class="in-cart-badge" title="In your request">✓ In request</span>` : ""}${esc(item.description)}</h3>
      <div class="item-meta">${esc(meta)} <span class="dot">·</span> ${esc(item.category)}</div>
      ${device}
      ${safeUrl(item.product_url) ? `<a class="item-link" href="${esc(safeUrl(item.product_url))}" target="_blank" rel="noopener noreferrer">View product ↗</a>` : ""}
      ${st.text ? `<div class="item-stock ${st.cls}">${esc(st.text)}</div>` : ""}
    </div>
    <div class="item-actions">${price}${action}</div>
  </article>`;
}

function visibleItems() {
  return S.items.filter(
    (i) =>
      (S.cat === "All" || i.category === S.cat) &&
      matchesSearch([i.description, i.vendor, i.vendor_item_no, i.category, i.device_used_on, i.item_id, i.product_title], S.q)
  );
}

function renderPills() {
  const cats = ["All", ...unique(S.items.map((i) => i.category)).sort()];
  $("#cat-pills").innerHTML = cats
    .map((c) => `<button type="button" class="pill${c === S.cat ? " active" : ""}" data-cat="${esc(c)}" aria-pressed="${c === S.cat}">${esc(c)}</button>`)
    .join("");
}

function renderCatalog() {
  const list = visibleItems();
  $("#catalog-list").innerHTML = list.length
    ? list.map(cardHtml).join("")
    : `<div class="empty">No items match. Try a different search or category.</div>`;
}

function refreshCard(itemId) {
  const old = $(`.item-card[data-id="${CSS.escape(itemId)}"]`);
  const item = S.byId.get(itemId);
  if (old && item) old.replaceWith(parseHTML(cardHtml(item)));
}

// ───────────────────────── cart ─────────────────────────
function setQty(itemId, qty) {
  const item = S.byId.get(itemId);
  if (!item) return;
  qty = clampInt(qty, 0, CONFIG.MAX_QTY_PER_LINE);
  if (qty <= 0) S.cart.delete(itemId);
  else {
    const cur = S.cart.get(itemId) || { item, qty: 0, note: "" };
    cur.qty = qty;
    S.cart.set(itemId, cur);
  }
  refreshCard(itemId);
  renderCart();
}

function renderCart() {
  const lines = Array.from(S.cart.values());
  $("#cart-empty").hidden = lines.length > 0;
  $("#request-form").hidden = lines.length === 0;
  $("#cart-lines").innerHTML = lines
    .map(
      ({ item, qty, note }) => `<div class="cart-line" data-id="${esc(item.item_id)}">
        <div class="cart-line-main">
          <div class="cart-line-title">${safeUrl(item.product_url) ? `<a href="${esc(safeUrl(item.product_url))}" target="_blank" rel="noopener noreferrer" title="View product page">${esc(item.description)} ↗</a>` : esc(item.description)}</div>
          <div class="cart-line-sub">${esc([item.vendor, item.vendor_item_no && "#" + item.vendor_item_no].filter(Boolean).join(" "))}</div>
        </div>
        <div class="stepper" role="group" aria-label="Quantity">
          <button type="button" data-dec aria-label="Decrease">−</button>
          <input type="number" min="1" max="${CONFIG.MAX_QTY_PER_LINE}" value="${qty}" data-qty aria-label="Quantity" />
          <button type="button" data-inc aria-label="Increase">+</button>
        </div>
        <button type="button" class="icon-btn" data-remove aria-label="Remove ${esc(item.description)}">&times;</button>
      </div>`
    )
    .join("");
  const units = lines.reduce((s, l) => s + l.qty, 0);
  const est = lines.reduce((s, l) => s + l.qty * (Number(l.item.unit_cost) || 0), 0);
  $("#cart-summary").textContent =
    `${lines.length} item${lines.length === 1 ? "" : "s"} · ${units} unit${units === 1 ? "" : "s"}` +
    (CONFIG.SHOW_PRICES_TO_EMPLOYEES ? ` · est. ${money(est)}` : "");
}

async function submitRequest(ev) {
  ev.preventDefault();
  if (S.submitting) return;
  const err = $("#form-error");
  err.hidden = true;
  const lines = Array.from(S.cart.values());
  const region = $("#f-region").value;
  const section = $("#f-section").value;
  if (!lines.length) return showFormError("Add at least one item.");
  if (!section) return showFormError("Choose your section.");
  if (!region) return showFormError("Choose your region / office.");
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 1) return showFormError(`Enter a quantity for “${l.item.description}”.`);
  }

  S.submitting = true;
  const btn = $("#submit-btn");
  btn.disabled = true;
  btn.textContent = "Submitting…";
  try {
    const id = newRequestId();
    const now = Date.now();
    const me = S.me;
    const est = lines.reduce((s, l) => s + l.qty * (Number(l.item.unit_cost) || 0), 0);
    const req = {
      request_id: id,
      status: REQUEST_STATUS.PENDING,
      submitted_date: now,
      requester_name: me.name,
      requester_email: (me.email || "").toLowerCase(),
      requester_edison_id: "",
      section,
      region,
      deliver_to: $("#f-deliver").value.trim(),
      request_note: $("#f-note").value.trim(),
      line_count: lines.length,
      est_total: Math.round(est * 100) / 100,
    };
    const lineRows = lines.map((l, i) => ({
      request_id: id,
      line_no: i + 1,
      item_id: l.item.item_id,
      category: l.item.category || "",
      description: l.item.description || "",
      vendor_item_no: l.item.vendor_item_no || "",
      unit_cost: l.item.unit_cost != null ? Number(l.item.unit_cost) : null,
      qty_requested: l.qty,
      line_note: (l.note || "").trim(),
    }));
    await applyServiceEdits(CONFIG.REQUESTS_SERVICE_URL, [
      { id: CONFIG.REQ_TABLE_ID, adds: [{ attributes: req }] },
      { id: CONFIG.LINES_TABLE_ID, adds: lineRows.map((a) => ({ attributes: a })) },
    ]);
    try { localStorage.setItem("temazon_form_prefs", JSON.stringify({ section, region })); } catch {}
    S.cart.clear();
    $("#f-deliver").value = "";
    $("#f-note").value = "";
    renderCatalog();
    renderCart();
    toast(`Request ${id} submitted.`, "success");
    switchTab("mine");
  } catch (e) {
    console.error(e);
    showFormError(`Could not submit: ${e.message}`);
  } finally {
    S.submitting = false;
    btn.disabled = false;
    btn.textContent = "Submit request";
  }
}
function showFormError(msg) {
  const el = $("#form-error");
  el.textContent = msg;
  el.hidden = false;
}

// ───────────────────────── my requests ─────────────────────────
const STATUS_CLASS = { Pending: "st-pending", Fulfilled: "st-ok", Denied: "st-bad", Cancelled: "st-muted" };

async function loadMine() {
  const email = (S.me.email || "").toLowerCase();
  if (!email) {
    S.mine = [];
    return renderMine();
  }
  $("#mine-list").innerHTML = `<div class="empty">Loading…</div>`;
  S.mine = await queryAll(REQ_URL, {
    where: `LOWER(requester_email) = ${sqlStr(email)}`,
    orderByFields: "submitted_date DESC",
    pageSize: CONFIG.FETCH_PAGE_SIZE,
  });
  renderMine();
}

function renderMine() {
  const pending = S.mine.filter((r) => r.status === REQUEST_STATUS.PENDING).length;
  const badge = $("#mine-badge");
  badge.hidden = !pending;
  badge.textContent = pending;
  $("#mine-list").innerHTML = S.mine.length
    ? S.mine
        .map(
          (r) => `<article class="req-card" data-rid="${esc(r.request_id)}">
        <button type="button" class="req-head" data-toggle aria-expanded="false">
          <span class="req-id">${esc(r.request_id)}</span>
          <span class="status-pill ${STATUS_CLASS[r.status] || ""}">${esc(r.status)}</span>
          <span class="req-date">${fmtDate(r.submitted_date)}</span>
          <span class="req-count">${r.line_count || 0} item${r.line_count === 1 ? "" : "s"}</span>
        </button>
        <div class="req-body" hidden></div>
      </article>`
        )
        .join("")
    : `<div class="empty">You haven't submitted any requests yet.</div>`;
}

async function toggleRequest(card) {
  const body = $(".req-body", card);
  const head = $("[data-toggle]", card);
  const open = body.hidden;
  head.setAttribute("aria-expanded", String(open));
  body.hidden = !open;
  if (!open || body.dataset.loaded) return;
  body.innerHTML = `<div class="empty">Loading…</div>`;
  const rid = card.dataset.rid;
  const req = S.mine.find((r) => r.request_id === rid);
  try {
    const lines = await queryAll(LINES_URL, { where: `request_id = ${sqlStr(rid)}`, orderByFields: "line_no" });
    const fulfilled = req.status === REQUEST_STATUS.FULFILLED;
    body.innerHTML = `
      <table class="mini-table">
        <thead><tr><th>Item</th><th class="num">Requested</th>${fulfilled || req.status === REQUEST_STATUS.DENIED ? `<th class="num">Approved</th>` : ""}</tr></thead>
        <tbody>${lines
          .map(
            (l) => `<tr><td>${esc(l.description)}${l.line_note ? `<div class="sub">Your note: ${esc(l.line_note)}</div>` : ""}${l.admin_note ? `<div class="sub admin">Property Office: ${esc(l.admin_note)}</div>` : ""}</td>
              <td class="num">${l.qty_requested}</td>
              ${fulfilled ? `<td class="num ${l.qty_approved !== l.qty_requested ? "changed" : ""}">${l.qty_approved ?? 0}</td>` : req.status === REQUEST_STATUS.DENIED ? `<td class="num">0</td>` : ""}</tr>`
          )
          .join("")}</tbody>
      </table>
      <dl class="req-facts">
        <dt>Region</dt><dd>${esc(req.region || "—")}</dd>
        ${req.deliver_to ? `<dt>Deliver to</dt><dd>${esc(req.deliver_to)}</dd>` : ""}
        ${req.request_note ? `<dt>Your note</dt><dd>${esc(req.request_note)}</dd>` : ""}
        ${req.decided_date ? `<dt>Decision</dt><dd>${esc(req.status)} ${fmtDate(req.decided_date)}${req.decided_by ? " by " + esc(req.decided_by) : ""}</dd>` : ""}
        ${req.decision_note ? `<dt>Property Office note</dt><dd>${esc(req.decision_note)}</dd>` : ""}
      </dl>
      <div class="req-actions">
        <button type="button" data-again>Request these items again</button>
        ${req.status === REQUEST_STATUS.PENDING ? `<button type="button" class="btn-danger" data-cancel>Cancel request</button>` : ""}
      </div>`;
    body.dataset.loaded = "1";
    body._lines = lines;
  } catch (e) {
    body.innerHTML = `<div class="form-error">Could not load items: ${esc(e.message)}</div>`;
  }
}

async function cancelRequest(card) {
  const rid = card.dataset.rid;
  const req = S.mine.find((r) => r.request_id === rid);
  if (!req || req.status !== REQUEST_STATUS.PENDING) return;
  if (!(await confirmDialog({ title: "Cancel request?", message: `Cancel ${rid}? The Property Office will no longer see it in the queue.`, confirmLabel: "Cancel request", kind: "danger" }))) return;
  try {
    await applyEdits(REQ_URL, { updates: [{ attributes: { [S.reqOid]: req._oid, status: REQUEST_STATUS.CANCELLED } }] });
    req.status = REQUEST_STATUS.CANCELLED;
    renderMine();
    toast(`${rid} cancelled.`, "success");
  } catch (e) {
    toast(`Could not cancel: ${e.message}`, "error");
  }
}

function requestAgain(card) {
  const lines = $(".req-body", card)._lines || [];
  let added = 0,
    skipped = 0;
  for (const l of lines) {
    const item = S.byId.get(l.item_id);
    if (!item) {
      skipped++;
      continue;
    }
    S.cart.set(item.item_id, { item, qty: l.qty_requested, note: "" });
    added++;
  }
  renderCatalog();
  renderCart();
  switchTab("new");
  toast(added ? `Added ${added} item${added === 1 ? "" : "s"} to a new request.` + (skipped ? ` ${skipped} no longer available.` : "") : "Those items are no longer available.", added ? "success" : "error");
}

// ───────────────────────── tabs / wiring ─────────────────────────
function switchTab(tab) {
  S.tab = tab;
  $$("#tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#screen-new").hidden = tab !== "new";
  $("#screen-mine").hidden = tab !== "mine";
  if (tab === "mine") loadMine().catch((e) => toast(`Could not load your requests: ${e.message}`, "error"));
}

function wire() {
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) switchTab(b.dataset.tab);
  });
  $("#search").addEventListener(
    "input",
    debounce((e) => {
      S.q = e.target.value;
      renderCatalog();
    }, 120)
  );
  $("#cat-pills").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b) return;
    S.cat = b.dataset.cat;
    renderPills();
    renderCatalog();
  });

  const qtyHandlers = (root) => {
    root.addEventListener("click", (e) => {
      const el = e.target.closest("[data-add],[data-inc],[data-dec],[data-remove]");
      if (!el) return;
      const holder = el.closest("[data-id]");
      const id = holder.dataset.id;
      const cur = S.cart.get(id);
      if (el.matches("[data-add]")) setQty(id, 1);
      else if (el.matches("[data-inc]")) setQty(id, (cur ? cur.qty : 0) + 1);
      else if (el.matches("[data-dec]")) setQty(id, (cur ? cur.qty : 1) - 1);
      else if (el.matches("[data-remove]")) setQty(id, 0);
    });
    root.addEventListener("change", (e) => {
      if (e.target.matches("[data-qty]")) setQty(e.target.closest("[data-id]").dataset.id, e.target.value);
    });
  };
  qtyHandlers($("#catalog-list"));
  qtyHandlers($("#cart-lines"));
  $("#cart-lines").addEventListener("input", (e) => {
    if (e.target.matches("[data-note]")) {
      const l = S.cart.get(e.target.closest("[data-id]").dataset.id);
      if (l) l.note = e.target.value;
    }
  });
  $("#request-form").addEventListener("submit", submitRequest);

  $("#mine-list").addEventListener("click", (e) => {
    const card = e.target.closest(".req-card");
    if (!card) return;
    if (e.target.closest("[data-toggle]")) toggleRequest(card);
    else if (e.target.closest("[data-again]")) requestAgain(card);
    else if (e.target.closest("[data-cancel]")) cancelRequest(card);
  });
  $("#refresh-mine").addEventListener("click", () => loadMine().catch((e) => toast(e.message, "error")));
}

async function onReady({ me }) {
  S.me = me;
  if (!REQ_URL || !ITEMS_URL) {
    setStatus("This form isn't configured yet: set INVENTORY_SERVICE_URL / REQUESTS_SERVICE_URL in shared/config.js (run the Setup page first).", "error");
    return;
  }
  if (!CONFIG.ITEMS_VIEW_URL) {
    console.warn(
      "[TEMAzon] ITEMS_VIEW_URL is empty — the catalog is being read straight from the Items table and restricted items are hidden only by this page's own filter. That is NOT a security boundary. Create the employee view (README step 4)."
    );
  }
  setStatus("Loading catalog…");
  wire();
  await loadLists(); // Section / Region choices set in the console (falls back to config.js)
  $("#f-region").innerHTML = `<option value="">Select…</option>` + CONFIG.REGIONS.map((r) => `<option>${esc(r)}</option>`).join("");
  $("#f-section").innerHTML = `<option value="">Select…</option>` + CONFIG.SECTIONS.map((r) => `<option>${esc(r)}</option>`).join("");
  try {
    const prefs = JSON.parse(localStorage.getItem("temazon_form_prefs") || "{}");
    if (CONFIG.SECTIONS.includes(prefs.section)) $("#f-section").value = prefs.section;
    if (CONFIG.REGIONS.includes(prefs.region)) $("#f-region").value = prefs.region;
  } catch {}

  const [rows, reqInfo] = await Promise.all([
    queryAll(ITEMS_URL, { pageSize: CONFIG.FETCH_PAGE_SIZE, orderByFields: "category, description" }),
    getLayerInfo(REQ_URL),
    checkFieldNames(REQ_URL, "Requests", fieldNames(REQUESTS_TABLE)),
    checkFieldNames(LINES_URL, "RequestLines", fieldNames(LINES_TABLE)),
  ]);
  S.reqOid = reqInfo.objectIdField;
  // Strict whitelist: only rows explicitly marked restricted = 'no' and active are ever shown.
  S.items = rows.filter((i) => String(i.restricted || "").toLowerCase() === "no" && String(i.active || "yes").toLowerCase() !== "no");
  S.byId = new Map(S.items.map((i) => [i.item_id, i]));

  $("#tabs").hidden = false;
  $("#screen-new").hidden = false;
  setStatus("");
  renderPills();
  renderCatalog();
  renderCart();
  // Pending badge on first load
  loadMine().catch(() => {});
}

startSession({ onReady });
