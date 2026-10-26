// Settings tab: edit the Section and Region dropdown lists used by the request
// form. Stored in the "Lists" table of the Requests service (shared/lists.js).
// Removing or renaming a value only affects NEW requests; existing requests and
// ledger rows keep the text they were saved with.
import { CONFIG } from "../shared/config.js";
import { applyEdits } from "../shared/esri-client.js";
import { LIST_KEYS, LIST_MAX, defaultValues, loadLists, createListsTable } from "../shared/lists.js";
import { $, esc } from "../shared/util.js";
import { toast, confirmDialog } from "../shared/ui.js";
import { S } from "./state.js";

const META = {
  section: { title: "Sections", help: "Choices in the Section dropdown on the request form.", usedBy: (v) => S.reqs.filter((r) => r.section === v).length },
  region: { title: "Regions / offices", help: "Choices in the Region / office dropdown on the request form.", usedBy: (v) => S.reqs.filter((r) => r.region === v).length },
};
const draft = { section: [], region: [] }; // [{orig: string|null, value: string}]
let busy = false;

const current = (name) => [...CONFIG[LIST_KEYS[name]]];

function resetDraft(name) {
  draft[name] = current(name).map((v) => ({ orig: v, value: v }));
}

function listHtml(name) {
  const m = META[name];
  const rows = draft[name]
    .map((it, i) => {
      const n = it.orig ? m.usedBy(it.orig) : 0;
      const renamed = it.orig && it.value.trim() !== it.orig;
      return `<li class="set-row" data-i="${i}">
        <input type="text" class="set-input" value="${esc(it.value)}" maxlength="${LIST_MAX[name]}" aria-label="${esc(m.title)} value ${i + 1}" />
        <span class="sub set-used">${n ? `used by ${n} request${n === 1 ? "" : "s"}${renamed ? ` as “${esc(it.orig)}”` : ""}` : it.orig ? "not used yet" : "new"}</span>
        <button type="button" class="icon-btn" data-act="up" ${i === 0 ? "disabled" : ""} title="Move up" aria-label="Move up">&uarr;</button>
        <button type="button" class="icon-btn" data-act="down" ${i === draft[name].length - 1 ? "disabled" : ""} title="Move down" aria-label="Move down">&darr;</button>
        <button type="button" class="icon-btn" data-act="del" title="Remove" aria-label="Remove">&times;</button>
      </li>`;
    })
    .join("");
  return `<div class="card set-card" data-list="${name}">
    <h2>${esc(m.title)}</h2>
    <p class="sub">${esc(m.help)}</p>
    <ul class="set-list">${rows || '<li class="sub">No values — the form would have nothing to choose from. Add at least one.</li>'}</ul>
    <div class="set-actions">
      <button type="button" data-act="add">+ Add</button>
      <span class="spacer"></span>
      <button type="button" data-act="reset">Discard changes</button>
      <button type="button" class="btn-primary" data-act="save">Save ${esc(m.title.toLowerCase())}</button>
    </div>
  </div>`;
}

export function renderSettings() {
  const host = $("#set-body");
  const L = S.lists || {};
  let banner = "";
  if (!L.url) {
    banner = `<div class="banner banner-warn" style="display:block">
      <b>One-time setup:</b> the lists live in a small “Lists” table in the Requests service, and it doesn't exist yet. The form is using the lists in config.js until it does.
      ${L.error ? `<div class="sub">Details: ${esc(L.error)}</div>` : ""}
      <div style="margin-top:.5rem"><button type="button" class="btn-primary" id="set-create">Create the Lists table</button>
      <span class="sub"> Needs the owner of the Requests service or an ArcGIS administrator.</span></div></div>`;
  }
  const unsaved = ["section", "region"].filter((n) => !L.stored || !L.stored[n]);
  const note = L.url && unsaved.length
    ? `<div class="banner banner-info">Showing the built-in defaults for ${unsaved.join(" and ")}. Click Save to store them; after that, edits here control the request form.</div>`
    : "";
  host.innerHTML = `${banner}${note}
    <p class="sub set-intro">Changes apply to the request form the next time someone opens it. Removing or renaming a value doesn't change past requests or the ledger — they keep the text they were saved with.</p>
    <div class="set-grid">${listHtml("section")}${listHtml("region")}</div>`;
}

async function save(name) {
  const m = META[name];
  const items = draft[name].map((it) => ({ ...it, value: it.value.trim() })).filter((it) => it.value);
  if (!items.length) throw new Error(`${m.title} can't be empty — add at least one value.`);
  const seen = new Set();
  for (const it of items) {
    const k = it.value.toLowerCase();
    if (seen.has(k)) throw new Error(`“${it.value}” appears twice in ${m.title.toLowerCase()}.`);
    seen.add(k);
    if (it.value.length > LIST_MAX[name]) throw new Error(`“${it.value}” is longer than ${LIST_MAX[name]} characters.`);
  }
  // warn about values that existing requests use and that are going away / being renamed
  const keep = new Set(items.map((it) => it.orig).filter(Boolean));
  const gone = current(name).filter((v) => !keep.has(v) && m.usedBy(v) > 0);
  if (gone.length) {
    const ok = await confirmDialog({
      title: "Remove or rename values in use?",
      message: `${gone.map((v) => `“${v}” (${m.usedBy(v)})`).join(", ")} ${gone.length === 1 ? "is" : "are"} used by existing requests. Those requests keep the old text, but it won't be selectable on the form any more. Continue?`,
      confirmLabel: "Save anyway",
    });
    if (!ok) return;
  }
  const url = S.lists.url;
  const oldRows = S.lists.rows.filter((r) => r.list_name === name);
  await applyEdits(url, {
    deletes: oldRows.map((r) => r._oid),
    adds: items.map((it, i) => ({ attributes: { list_name: name, value: it.value, sort_order: i + 1 } })),
  });
  // reload from the service so S.lists / CONFIG match what was stored
  S.lists = await loadLists();
  resetDraft(name);
  toast(`${m.title} saved.`, "success");
}

export function initSettings() {
  S.render.set = () => {
    resetDraftsIfIdle();
    renderSettings();
  };
  const host = $("#set-body");
  host.addEventListener("input", (e) => {
    const row = e.target.closest(".set-row");
    if (!row || !e.target.classList.contains("set-input")) return;
    const name = e.target.closest("[data-list]").dataset.list;
    draft[name][Number(row.dataset.i)].value = e.target.value;
  });
  host.addEventListener("click", async (e) => {
    if (e.target.id === "set-create") {
      try {
        e.target.disabled = true;
        await createListsTable();
        S.lists = await loadLists();
        ["section", "region"].forEach(resetDraft);
        renderSettings();
        toast("Lists table created. Click Save on each list to store it.", "success", 6000);
      } catch (err) {
        e.target.disabled = false;
        toast(err.message, "error", 9000);
      }
      return;
    }
    const btn = e.target.closest("[data-act]");
    const card = e.target.closest("[data-list]");
    if (!btn || !card || busy) return;
    const name = card.dataset.list;
    const act = btn.dataset.act;
    const rowEl = btn.closest(".set-row");
    const i = rowEl ? Number(rowEl.dataset.i) : -1;
    const arr = draft[name];
    if (act === "add") {
      arr.push({ orig: null, value: "" });
      renderSettings();
      const inputs = $("#set-body").querySelectorAll(`[data-list="${name}"] .set-input`);
      inputs[inputs.length - 1].focus();
    } else if (act === "del") {
      arr.splice(i, 1);
      renderSettings();
    } else if (act === "up" && i > 0) {
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      renderSettings();
    } else if (act === "down" && i < arr.length - 1) {
      [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
      renderSettings();
    } else if (act === "reset") {
      resetDraft(name);
      renderSettings();
    } else if (act === "save") {
      if (!S.lists || !S.lists.url) return toast("Create the Lists table first (see the notice at the top).", "error");
      try {
        busy = true;
        btn.disabled = true;
        await save(name);
        renderSettings();
      } catch (err) {
        toast(err.message, "error", 8000);
      } finally {
        busy = false;
        btn.disabled = false;
      }
    }
  });
  ["section", "region"].forEach(resetDraft);
}

// keep unsaved edits when switching tabs back and forth; start fresh if nothing was touched
function resetDraftsIfIdle() {
  for (const n of ["section", "region"]) {
    const pristine = draft[n].every((it) => it.orig === it.value) && draft[n].length === current(n).length;
    if (pristine) resetDraft(n);
  }
}
