// Entities tab: look up a person, section or region, see their request
// history and compare their burn rate per item against peers.
import { CONFIG } from "../shared/config.js";
import { $, esc, money, fmtDate, matchesSearch, debounce, DAY_MS, unique } from "../shared/util.js";
import { S } from "./state.js";
import { computeBurn, entityKey, totalsFor } from "./burn.js";

const F = { type: "person", q: "", key: "", months: CONFIG.BURN_DEFAULT_WINDOW_MONTHS };
const TYPE_LABEL = { person: "People", section: "Sections", region: "Regions" };
const STATUS_CLASS = { Pending: "st-pending", Fulfilled: "st-ok", Denied: "st-bad", Cancelled: "st-muted" };

/** All known entities of a type: roster + anything seen in the ledger or requests. */
function entityList(type) {
  const map = new Map(); // key -> {key,label,sub}
  const add = (key, label, sub = "") => {
    if (!key) return;
    if (!map.has(key)) map.set(key, { key, label: label || key, sub });
    else if (label && map.get(key).label === key) map.get(key).label = label;
  };
  if (type === "person") {
    for (const t of S.txns) add(entityKey(t, "person"), t.entity_name);
    for (const r of S.reqs) add(entityKey(r, "person"), r.requester_name, r.section);
  } else {
    const cfg = type === "section" ? CONFIG.SECTIONS : CONFIG.REGIONS;
    for (const v of cfg) add(v.toLowerCase(), v);
    for (const t of S.txns) add(entityKey(t, type), type === "section" ? t.entity_section : t.entity_region);
    for (const r of S.reqs) add(entityKey(r, type), type === "section" ? r.section : r.region);
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function requestsFor(type, key) {
  return S.reqs.filter((r) => entityKey(r, type) === key).sort((a, b) => (b.submitted_date || 0) - (a.submitted_date || 0));
}

export function renderEntities() {
  $("#ent-type-pills").innerHTML = Object.keys(TYPE_LABEL)
    .map((t) => `<button type="button" class="pill${F.type === t ? " active" : ""}" data-type="${t}">${TYPE_LABEL[t]}</button>`)
    .join("");

  const list = entityList(F.type).filter((e) => matchesSearch([e.label, e.sub, e.key], F.q));
  $("#ent-list").innerHTML =
    list
      .map((e) => {
        const n = requestsFor(F.type, e.key).length;
        return `<li><button type="button" class="ent-item${e.key === F.key ? " active" : ""}" data-key="${esc(e.key)}">
          <span class="t">${esc(e.label)}</span><span class="sub">${esc(e.sub || "")}</span><span class="pill-n">${n}</span></button></li>`;
      })
      .join("") || `<li class="empty">No matches.</li>`;

  renderDetail();
}

function renderDetail() {
  const box = $("#ent-detail");
  if (!F.key) {
    box.innerHTML = `<div class="empty">Pick a ${F.type} on the left to see their requests and burn rates.</div>`;
    return;
  }
  const ent = entityList(F.type).find((e) => e.key === F.key);
  const label = ent ? ent.label : F.key;
  const months = F.months;
  const burn = computeBurn(S.txns, { type: F.type, key: F.key, months });
  const tot = totalsFor(S.txns, { type: F.type, key: F.key, months });
  const reqs = requestsFor(F.type, F.key);
  const windowLabel = months ? `last ${months} months` : "all time";

  const rows = Array.from(burn.entries())
    .filter(([, b]) => b.qty !== 0)
    .map(([id, b]) => ({ id, b, item: S.itemsById.get(id) }))
    .sort((a, b) => b.b.monthly - a.b.monthly);

  box.innerHTML = `
    <div class="ent-head">
      <h2>${esc(label)} <span class="sub">${esc(F.type)}</span></h2>
      <label class="inline">Window
        <select id="ent-window">
          ${[3, 6, 12].map((m) => `<option value="${m}" ${months === m ? "selected" : ""}>Last ${m} months</option>`).join("")}
          <option value="" ${months ? "" : "selected"}>All time</option>
        </select>
      </label>
    </div>
    <div class="tiles">
      <div class="tile"><div class="tile-n">${reqs.length}</div><div class="tile-l">Requests (all time)</div></div>
      <div class="tile"><div class="tile-n">${tot.units}</div><div class="tile-l">Units issued, ${windowLabel}</div></div>
      <div class="tile"><div class="tile-n">${money(tot.cost)}</div><div class="tile-l">Value issued, ${windowLabel}</div></div>
      <div class="tile"><div class="tile-n">${tot.last ? fmtDate(tot.last) : "—"}</div><div class="tile-l">Last issue</div></div>
    </div>

    <h3>Burn rate by item <span class="sub">(${windowLabel})</span></h3>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Item</th><th class="num">Qty used</th><th class="num">Per month</th><th class="num">Issues</th><th>Last issued</th><th class="num">Peer avg / mo</th><th class="num">vs. peers</th></tr></thead>
      <tbody>${
        rows
          .map(({ id, b, item }) => {
            const ratio = b.peerMonthly > 0 ? b.monthly / b.peerMonthly : null;
            const days = b.last ? Math.round((Date.now() - b.last) / DAY_MS) : null;
            return `<tr><td><div class="t">${esc(item ? item.description : id)}</div><div class="sub">${esc(id)}</div></td>
              <td class="num"><b>${b.qty}</b></td><td class="num">${b.monthly.toFixed(1)}</td><td class="num">${b.issues}</td>
              <td>${b.last ? `${fmtDate(b.last)} <span class="sub">(${days}d ago)</span>` : "—"}</td>
              <td class="num">${b.peerMonthly ? b.peerMonthly.toFixed(1) : "—"} <span class="sub">${b.peers ? `(${b.peers})` : ""}</span></td>
              <td class="num">${ratio === null ? "—" : `<span class="flag flag-${ratio >= 2 ? "alert" : ratio >= 1.25 ? "warn" : "ok"}">${ratio.toFixed(1)}×</span>`}</td></tr>`;
          })
          .join("") || `<tr><td colspan="7" class="empty">Nothing issued in this window.</td></tr>`
      }</tbody>
    </table></div>
    <p class="sub">“Peer avg” is the average monthly use among the ${esc(F.type)}s that received the same item (count in brackets, including this one). “vs. peers” above 1.0× means faster than that average.</p>

    <h3>Request history</h3>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Request</th><th>Date</th><th>Status</th><th class="num">Items</th><th>Requested → approved</th></tr></thead>
      <tbody>${
        reqs
          .map((r) => {
            const lines = S.lines.filter((l) => l.request_id === r.request_id);
            const summary = lines
              .slice(0, 4)
              .map((l) => `${esc(l.description)} ×${l.qty_requested}${r.status === "Fulfilled" && l.qty_approved !== l.qty_requested ? `→${l.qty_approved ?? 0}` : ""}`)
              .join("; ");
            return `<tr data-rid="${esc(r.request_id)}" tabindex="0"><td class="mono">${esc(r.request_id)}</td><td>${fmtDate(r.submitted_date)}</td>
              <td><span class="status-pill ${STATUS_CLASS[r.status] || ""}">${esc(r.status)}</span></td><td class="num">${r.line_count ?? lines.length}</td>
              <td class="sub-wide">${summary}${lines.length > 4 ? ` +${lines.length - 4} more` : ""}</td></tr>`;
          })
          .join("") || `<tr><td colspan="5" class="empty">No requests on file.</td></tr>`
      }</tbody>
    </table></div>`;
}

export function showEntity(type, key) {
  F.type = type;
  F.key = key;
  F.q = "";
  $("#ent-search").value = "";
  S.actions.switchTab("ent");
}

export function initEntities() {
  S.render.ent = renderEntities;
  S.actions.showEntity = showEntity;
  $("#ent-search").addEventListener("input", debounce((e) => { F.q = e.target.value; renderEntities(); }, 120));
  $("#ent-type-pills").addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b) return;
    F.type = b.dataset.type;
    F.key = "";
    renderEntities();
  });
  $("#ent-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-key]");
    if (!b) return;
    F.key = b.dataset.key;
    renderEntities();
  });
  $("#ent-detail").addEventListener("change", (e) => {
    if (e.target.id === "ent-window") { F.months = e.target.value ? Number(e.target.value) : null; renderDetail(); }
  });
  const open = (e) => {
    const tr = e.target.closest("tr[data-rid]");
    if (tr) S.actions.openRequest(tr.dataset.rid);
  };
  $("#ent-detail").addEventListener("click", open);
  $("#ent-detail").addEventListener("keydown", (e) => { if (e.key === "Enter") open(e); });
}
