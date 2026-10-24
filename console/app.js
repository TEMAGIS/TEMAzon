// ---------------------------------------------------------------------------
// TEMAzon — Management console (Property Officer).
// Loads the four tables fully into memory on sign-in (same "load once, work
// in memory" approach as the Assigned Inventory Editor) and writes through
// shared/esri-client.js. The ledger (Transactions) is the source of truth;
// Items.qty_on_hand is the cached running total.
// ---------------------------------------------------------------------------

import { CONFIG } from "../shared/config.js";
import { startSession } from "../shared/session.js";
import { queryAll, getLayerInfo, checkFieldNames } from "../shared/esri-client.js";
import { ITEMS_TABLE, TXN_TABLE, REQUESTS_TABLE, LINES_TABLE, fieldNames } from "../shared/schema.js";
import { $, $$, esc } from "../shared/util.js";
import { setStatus, toast } from "../shared/ui.js";
import { S, URLS, reindexItems } from "./state.js";
import { initInventory, renderInventory } from "./inventory.js";
import { initRequests, renderRequests } from "./requests.js";
import { initTransactions, renderTransactions } from "./transactions.js";
import { initEntities, renderEntities } from "./entities.js";

function switchTab(tab) {
  S.tab = tab;
  $$("#tabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of ["inv", "req", "txn", "ent"]) $(`#screen-${t}`).hidden = t !== tab;
  const render = S.render[tab];
  if (render) render();
}

async function loadAll() {
  setStatus("Loading inventory, ledger and requests…");
  const page = CONFIG.FETCH_PAGE_SIZE;
  const [items, txns, reqs, lines, infos] = await Promise.all([
    queryAll(URLS.items, { pageSize: page }),
    queryAll(URLS.txns, { pageSize: page }),
    queryAll(URLS.reqs, { pageSize: page }),
    queryAll(URLS.lines, { pageSize: page }),
    Promise.all([getLayerInfo(URLS.items), getLayerInfo(URLS.txns), getLayerInfo(URLS.reqs), getLayerInfo(URLS.lines)]),
  ]);
  S.items = items;
  S.txns = txns;
  S.reqs = reqs;
  S.lines = lines;
  S.oid = { items: infos[0].objectIdField, txns: infos[1].objectIdField, reqs: infos[2].objectIdField, lines: infos[3].objectIdField };
  reindexItems();
  setStatus("");
}

async function onReady({ me }) {
  S.me = me;
  if (!URLS.invService || !URLS.reqService) {
    setStatus("The console isn't configured yet: set INVENTORY_SERVICE_URL and REQUESTS_SERVICE_URL in shared/config.js (run the Setup page first).", "error");
    return;
  }
  S.actions.switchTab = switchTab;
  initInventory();
  initRequests();
  initTransactions();
  initEntities();

  await loadAll();
  // schema sanity check (console warnings only)
  checkFieldNames(URLS.items, "Items", fieldNames(ITEMS_TABLE));
  checkFieldNames(URLS.txns, "Transactions", fieldNames(TXN_TABLE));
  checkFieldNames(URLS.reqs, "Requests", fieldNames(REQUESTS_TABLE));
  checkFieldNames(URLS.lines, "RequestLines", fieldNames(LINES_TABLE));

  $("#tabs").hidden = false;
  $("#reload-btn").hidden = false;
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (b) switchTab(b.dataset.tab);
  });
  $("#reload-btn").addEventListener("click", async () => {
    try {
      await loadAll();
      switchTab(S.tab);
      renderRequests();
      toast("Data refreshed.", "success");
    } catch (err) {
      setStatus(`Refresh failed: ${err.message}`, "error");
    }
  });
  renderRequests(); // sets the pending badge
  switchTab(S.reqs.some((r) => r.status === "Pending") ? "req" : "inv");
}

startSession({
  allowedEmails: CONFIG.CONSOLE_ALLOWED_EMAILS,
  probe: () => getLayerInfo(URLS.items),
  noAccessMessage: "Your ArcGIS account can't open the TEMAzon Inventory service. The console is for Property Officers — ask the service owner to share it with you.",
  onReady,
}).catch((err) => setStatus(err.message, "error"));
