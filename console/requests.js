// Requests tab: approval queue + review dialog with burn-rate comparison and
// adjustable approved quantities.
import { CONFIG, REQUEST_STATUS } from "../shared/config.js";
import { applyServiceEdits } from "../shared/esri-client.js";
import { $, esc, money, fmtDate, fmtDateTime, matchesSearch, debounce, clampInt, DAY_MS } from "../shared/util.js";
import { openModal, toast } from "../shared/ui.js";
import { S, URLS, linesFor } from "./state.js";
import { postStockMoves } from "./stock.js";
import { computeBurn, entityKey, monthsOfSupply, supplyFlag } from "./burn.js";

const F = { status: "Pending", q: "" };
const STATUS_CLASS = { Pending: "st-pending", Fulfilled: "st-ok", Denied: "st-bad", Cancelled: "st-muted" };
const STATUSES = ["Pending", "Fulfilled", "Denied", "Cancelled", "All"];

export function renderRequests() {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, s === "All" ? S.reqs.length : S.reqs.filter((r) => r.status === s).length]));
  $("#req-pills").innerHTML = STATUSES.map(
    (s) => `<button type="button" class="pill${F.status === s ? " active" : ""}" data-status="${s}">${s} <span class="pill-n">${counts[s]}</span></button>`
  ).join("");
  const pendingN = counts.Pending;
  const badge = $("#req-badge");
  badge.hidden = !pendingN;
  badge.textContent = pendingN;

  const rows = S.reqs
    .filter((r) => (F.status === "All" || r.status === F.status) && matchesSearch([r.request_id, r.requester_name, r.requester_email, r.section, r.region, r.request_note], F.q))
    .sort((a, b) => (F.status === "Pending" ? (a.submitted_date || 0) - (b.submitted_date || 0) : (b.submitted_date || 0) - (a.submitted_date || 0)));

  $("#req-body").innerHTML =
    rows
      .map(
        (r) => `<tr data-rid="${esc(r.request_id)}" tabindex="0">
        <td class="mono">${esc(r.request_id)}</td>
        <td>${fmtDate(r.submitted_date)}</td>
        <td><div class="t">${esc(r.requester_name)}</div><div class="sub">${esc(r.requester_email)}</div></td>
        <td>${esc(r.section || "—")}</td>
        <td>${esc(r.region || "—")}</td>
        <td class="num">${r.line_count ?? 0}</td>
        <td class="num">${money(r.est_total)}</td>
        <td><span class="status-pill ${STATUS_CLASS[r.status] || ""}">${esc(r.status)}</span></td>
        <td class="row-actions"><button type="button" data-open>${r.status === "Pending" ? "Review" : "View"}</button></td>
      </tr>`
      )
      .join("") || `<tr><td colspan="9" class="empty">${F.status === "Pending" ? "No pending requests." : "No requests match."}</td></tr>`;
}

// ───────────────────────── review dialog ─────────────────────────
export function openRequest(rid) {
  const req = S.reqs.find((r) => r.request_id === rid);
  if (!req) return toast(`Request ${rid} not found.`, "error");
  const lines = linesFor(rid);
  const pending = req.status === REQUEST_STATUS.PENDING;
  const issuedBefore = S.txns.filter((t) => t.request_id === rid && t.txn_type === "ISSUE");
  const alreadyIssued = pending && issuedBefore.length > 0;

  // working state
  const st = {
    basis: "person",
    months: CONFIG.BURN_DEFAULT_WINDOW_MONTHS,
    approve: new Map(), // line_no -> qty
    notes: new Map(), // line_no -> admin note
  };
  for (const l of lines) {
    let q = l.qty_approved ?? l.qty_requested;
    if (alreadyIssued) q = issuedBefore.filter((t) => t.item_id === l.item_id).reduce((s, t) => s - t.qty_change, 0);
    st.approve.set(l.line_no, pending || req.status === REQUEST_STATUS.FULFILLED ? q : 0);
    st.notes.set(l.line_no, l.admin_note || "");
  }

  const facts = `
    <dl class="req-facts cols">
      <dt>Requester</dt><dd>${esc(req.requester_name)} <button type="button" class="link-btn" data-hist="person">history</button><div class="sub">${esc(req.requester_email)}</div></dd>
      <dt>Section</dt><dd>${esc(req.section || "—")} ${req.section ? `<button type="button" class="link-btn" data-hist="section">history</button>` : ""}</dd>
      <dt>Region</dt><dd>${esc(req.region || "—")} ${req.region ? `<button type="button" class="link-btn" data-hist="region">history</button>` : ""}</dd>
      <dt>Submitted</dt><dd>${fmtDateTime(req.submitted_date)}</dd>
      ${req.deliver_to ? `<dt>Deliver to</dt><dd>${esc(req.deliver_to)}</dd>` : ""}
      ${req.request_note ? `<dt>Note</dt><dd>${esc(req.request_note)}</dd>` : ""}
      ${!pending ? `<dt>${esc(req.status)}</dt><dd>${fmtDateTime(req.decided_date)}${req.decided_by ? " by " + esc(req.decided_by) : ""}${req.decision_note ? `<div class="sub">${esc(req.decision_note)}</div>` : ""}</dd>` : ""}
    </dl>`;

  const body = `
    ${alreadyIssued ? `<div class="banner banner-warn"><b>Stock was already issued for this request</b> (${esc(fmtDateTime(issuedBefore[0].txn_date))}) but the request was never marked complete — usually a dropped connection. Use <b>Finish without issuing again</b>; do not re-issue.</div>` : ""}
    ${facts}
    ${S.reqs && pending ? `<div class="burn-controls">
      <label>Compare against
        <select id="rv-basis"><option value="person">This person</option><option value="section">Their section</option><option value="region">Their region</option></select>
      </label>
      <label>Window
        <select id="rv-window"><option value="3">Last 3 months</option><option value="6">Last 6 months</option><option value="12">Last 12 months</option><option value="">All time</option></select>
      </label>
      <span class="sub" id="rv-basis-note"></span>
    </div>` : ""}
    <div class="table-wrap"><table class="grid" id="rv-table">
      <thead><tr>
        <th>Item</th><th class="num">On hand</th><th class="num">Requested</th><th class="num">${pending ? "Approve" : "Approved"}</th>
        ${pending ? `<th>Their usage</th><th>Peer avg</th><th>Supply after</th>` : ""}<th>${pending ? "Note to requester" : "Admin note"}</th>
      </tr></thead>
      <tbody id="rv-body"></tbody>
    </table></div>
    <div class="rv-totals" id="rv-totals"></div>
    ${pending ? `<label>Decision note <span class="hint">(shown to the requester; required to deny)</span><textarea id="rv-note" rows="2" maxlength="900"></textarea></label>
      <label class="check"><input type="checkbox" id="rv-neg" /> Allow stock to go negative (backorder)</label>` : ""}`;

  const burnFor = () => {
    const key = entityKey(req, st.basis);
    return key ? computeBurn(S.txns, { type: st.basis, key, months: st.months }) : null;
  };

  let dlg;
  const renderBody = () => {
    const burn = burnFor();
    const basisNote = $("#rv-basis-note", dlg.el);
    if (basisNote) basisNote.textContent = burn ? "" : `This request has no ${st.basis} on it, so there's nothing to compare against.`;
    $("#rv-body", dlg.el).innerHTML = lines
      .map((l) => {
        const item = S.itemsById.get(l.item_id);
        const onHand = item ? Number(item.qty_on_hand) || 0 : null;
        const appr = st.approve.get(l.line_no) ?? 0;
        const short = pending && onHand !== null && appr > onHand;
        let usage = "", peer = "", supply = "";
        if (pending) {
          const b = burn && burn.get(l.item_id);
          if (!burn) usage = peer = supply = `<span class="sub">—</span>`;
          else if (!b || b.qty <= 0) {
            usage = `<span class="sub">No prior issues</span>`;
            peer = b && b.peerMonthly ? `${b.peerMonthly.toFixed(1)}/mo <span class="sub">(${b.peers})</span>` : `<span class="sub">—</span>`;
            supply = `<span class="sub">no history</span>`;
          } else {
            const months = monthsOfSupply(appr, b.monthly);
            const flag = supplyFlag(months, CONFIG.BURN_WARN_MONTHS_OF_SUPPLY, CONFIG.BURN_ALERT_MONTHS_OF_SUPPLY);
            const daysAgo = b.last ? Math.round((Date.now() - b.last) / DAY_MS) : null;
            usage = `<b>${b.qty}</b> used · ${b.monthly.toFixed(1)}/mo<div class="sub">${b.issues} issue${b.issues === 1 ? "" : "s"}${daysAgo !== null ? ` · last ${daysAgo}d ago` : ""}</div>`;
            peer = b.peerMonthly ? `${b.peerMonthly.toFixed(1)}/mo <span class="sub">(${b.peers})</span>` : `<span class="sub">—</span>`;
            supply = appr > 0 ? `<span class="flag flag-${flag}" title="Months this quantity lasts at their historical rate">${months.toFixed(1)} mo</span>` : `<span class="sub">—</span>`;
          }
        }
        return `<tr data-line="${l.line_no}" class="${short ? "row-short" : ""}">
          <td><div class="t">${esc(l.description)}</div><div class="sub">${esc(l.item_id)}${l.line_note ? ` · they wrote: “${esc(l.line_note)}”` : ""}${item ? "" : " · <b>item no longer exists</b>"}</div></td>
          <td class="num ${short ? "stock-out" : ""}">${onHand ?? "?"}</td>
          <td class="num">${l.qty_requested}</td>
          <td class="num">${pending ? `<input type="number" class="appr-input" min="0" step="1" value="${appr}" data-appr aria-label="Approved quantity for ${esc(l.description)}" ${alreadyIssued ? "readonly" : ""} />` : `<span class="${(l.qty_approved ?? 0) !== l.qty_requested ? "changed" : ""}">${l.qty_approved ?? 0}</span>`}</td>
          ${pending ? `<td>${usage}</td><td>${peer}</td><td>${supply}</td>` : ""}
          <td>${pending ? `<input type="text" class="line-note" data-lnote maxlength="250" value="${esc(st.notes.get(l.line_no) || "")}" aria-label="Note for ${esc(l.description)}" />` : esc(l.admin_note || "")}</td>
        </tr>`;
      })
      .join("");
    updateTotals();
  };

  const updateTotals = () => {
    let units = 0, cost = 0, requested = 0;
    for (const l of lines) {
      const q = st.approve.get(l.line_no) || 0;
      units += q;
      requested += l.qty_requested;
      cost += q * (Number(l.unit_cost) || 0);
    }
    $("#rv-totals", dlg.el).innerHTML = `<b>${units}</b> of ${requested} requested units ${pending ? "approved" : "issued"} · ${money(cost)}`;
  };

  const finalize = async (status, decisionNote) => {
    const now = Date.now();
    const res = await applyServiceEdits(URLS.reqService, [
      {
        id: CONFIG.REQ_TABLE_ID,
        updates: [{ attributes: { [S.oid.reqs]: req._oid, status, decided_by: S.me.name, decided_by_email: (S.me.email || "").toLowerCase(), decided_date: now, decision_note: decisionNote } }],
      },
      {
        id: CONFIG.LINES_TABLE_ID,
        updates: lines.map((l) => ({ attributes: { [S.oid.lines]: l._oid, qty_approved: status === REQUEST_STATUS.FULFILLED ? st.approve.get(l.line_no) || 0 : 0, admin_note: (st.notes.get(l.line_no) || "").slice(0, 500) } })),
      },
    ]);
    Object.assign(req, { status, decided_by: S.me.name, decided_by_email: S.me.email, decided_date: now, decision_note: decisionNote });
    for (const l of lines) {
      l.qty_approved = status === REQUEST_STATUS.FULFILLED ? st.approve.get(l.line_no) || 0 : 0;
      l.admin_note = st.notes.get(l.line_no) || "";
    }
    return res;
  };

  const buttons = [{ label: "Close" }];
  if (pending) {
    buttons.push({
      label: "Deny request",
      kind: "danger",
      action: async (api) => {
        const note = $("#rv-note", api.el).value.trim();
        if (!note) throw new Error("Add a decision note explaining why this is denied.");
        await finalize(REQUEST_STATUS.DENIED, note);
        toast(`${rid} denied.`, "success");
        refresh();
      },
    });
    buttons.push({
      label: alreadyIssued ? "Finish without issuing again" : "Approve & issue stock",
      kind: "primary",
      action: async (api) => {
        const note = $("#rv-note", api.el).value.trim();
        const approved = lines.map((l) => ({ l, q: clampInt(st.approve.get(l.line_no) || 0, 0, 1e9) }));
        if (!alreadyIssued) {
          const moves = approved
            .filter((a) => a.q > 0)
            .map((a) => {
              const item = S.itemsById.get(a.l.item_id);
              if (!item) throw new Error(`“${a.l.description}” no longer exists — set its approved quantity to 0.`);
              return {
                item,
                type: "ISSUE",
                change: -a.q,
                requestId: rid,
                note: `Request ${rid}`,
                entity: { name: req.requester_name, email: req.requester_email, section: req.section, region: req.region },
              };
            });
          if (!moves.length) throw new Error("Every approved quantity is 0 — use “Deny request” instead.");
          await postStockMoves(moves, { allowNegative: $("#rv-neg", api.el).checked });
        }
        try {
          await finalize(REQUEST_STATUS.FULFILLED, note);
        } catch (err) {
          refresh();
          throw new Error(`Stock WAS issued, but the request record couldn't be updated (${err.message}). Re-open this request and choose “Finish without issuing again”.`);
        }
        toast(`${rid} approved and issued.`, "success");
        refresh();
      },
    });
  }

  dlg = openModal({ title: `${rid}`, body, wide: true, buttons });

  // events
  dlg.el.addEventListener("input", (e) => {
    const tr = e.target.closest("tr[data-line]");
    if (!tr) return;
    const ln = Number(tr.dataset.line);
    if (e.target.matches("[data-appr]")) {
      st.approve.set(ln, clampInt(e.target.value === "" ? 0 : e.target.value, 0, 1e9));
      // re-render only the derived cells to keep focus in the input
      const l = lines.find((x) => x.line_no === ln);
      const item = S.itemsById.get(l.item_id);
      tr.classList.toggle("row-short", !!item && st.approve.get(ln) > (Number(item.qty_on_hand) || 0));
      refreshSupplyCell(tr, l);
      updateTotals();
    } else if (e.target.matches("[data-lnote]")) {
      st.notes.set(ln, e.target.value);
    }
  });
  const refreshSupplyCell = (tr, l) => {
    const burn = burnFor();
    const b = burn && burn.get(l.item_id);
    const cell = tr.children[6];
    if (!cell || !b || b.qty <= 0) return;
    const appr = st.approve.get(l.line_no) || 0;
    const months = monthsOfSupply(appr, b.monthly);
    const flag = supplyFlag(months, CONFIG.BURN_WARN_MONTHS_OF_SUPPLY, CONFIG.BURN_ALERT_MONTHS_OF_SUPPLY);
    cell.innerHTML = appr > 0 ? `<span class="flag flag-${flag}">${months.toFixed(1)} mo</span>` : `<span class="sub">—</span>`;
  };
  const basisSel = $("#rv-basis", dlg.el);
  const winSel = $("#rv-window", dlg.el);
  if (basisSel) {
    basisSel.addEventListener("change", () => { st.basis = basisSel.value; renderBody(); });
    winSel.value = String(st.months);
    winSel.addEventListener("change", () => { st.months = winSel.value ? Number(winSel.value) : null; renderBody(); });
  }
  dlg.el.addEventListener("click", (e) => {
    const h = e.target.closest("[data-hist]");
    if (!h) return;
    const type = h.dataset.hist;
    const key = entityKey(req, type);
    dlg.close();
    S.actions.showEntity(type, key);
  });
  renderBody();

  function refresh() {
    renderRequests();
    S.render.inv && S.render.inv();
    S.render.txn && S.render.txn();
    S.render.ent && S.render.ent();
  }
}

export function initRequests() {
  S.render.req = renderRequests;
  S.actions.openRequest = openRequest;
  $("#req-search").addEventListener("input", debounce((e) => { F.q = e.target.value; renderRequests(); }, 120));
  $("#req-pills").addEventListener("click", (e) => {
    const b = e.target.closest("[data-status]");
    if (!b) return;
    F.status = b.dataset.status;
    renderRequests();
  });
  const open = (e) => {
    const tr = e.target.closest("tr[data-rid]");
    if (tr) openRequest(tr.dataset.rid);
  };
  $("#req-body").addEventListener("click", open);
  $("#req-body").addEventListener("keydown", (e) => { if (e.key === "Enter") open(e); });
}
