// ---------------------------------------------------------------------------
// One-time setup: creates the two hosted feature services (tables only), loads
// the seed items, and produces the config values. Uses the signed-in user's
// own token against ArcGIS Online's REST API (createService → addToDefinition).
// ---------------------------------------------------------------------------

import { CONFIG } from "../shared/config.js";
import * as auth from "../shared/arcgis-auth.js";
import { esriRequest, applyEdits, queryAll, tableUrl, EsriError } from "../shared/esri-client.js";
import {
  ITEMS_TABLE, TXN_TABLE, REQUESTS_TABLE, LINES_TABLE, toTableDefinition,
  INVENTORY_SERVICE_NAME, REQUESTS_SERVICE_NAME,
} from "../shared/schema.js";
import { $, esc, downloadText } from "../shared/util.js";
import { setStatus } from "../shared/ui.js";

const CID_KEY = "temazon_setup_client_id";
const R = { invUrl: "", reqUrl: "", invItemId: "", reqItemId: "", itemsId: 0, txnId: 1, reqId: 0, linesId: 1 };

try {
  const saved = localStorage.getItem(CID_KEY);
  if (saved) CONFIG.ARCGIS_APP_ID = saved;
} catch {}

const log = (msg, kind = "") => {
  const li = document.createElement("li");
  li.className = kind;
  li.innerHTML = msg;
  $("#log").appendChild(li);
  li.scrollIntoView({ block: "nearest" });
  return li;
};

const adminUrl = (serviceUrl) => serviceUrl.replace("/rest/services/", "/rest/admin/services/");

async function createService(name, description) {
  const profile = await auth.fetchProfile();
  const username = profile.username || auth.getUsername();
  const createParameters = {
    name,
    serviceDescription: description,
    hasStaticData: false,
    maxRecordCount: 2000,
    supportedQueryFormats: "JSON",
    capabilities: "Create,Delete,Query,Update,Editing",
    allowGeometryUpdates: true,
    units: "esriMeters",
    xssPreventionInfo: { xssPreventionEnabled: true, xssPreventionRule: "input", xssInputRule: "rejectInvalid" },
  };
  const data = await esriRequest(`${CONFIG.ARCGIS_PORTAL_URL}/sharing/rest/content/users/${encodeURIComponent(username)}/createService`, {
    createParameters: JSON.stringify(createParameters),
    outputType: "featureService",
    description,
    snippet: description,
    tags: "TEMAzon,inventory",
  });
  if (!data.success && !data.serviceurl) throw new Error("createService did not return a service URL");
  return { url: data.serviceurl || data.encodedServiceURL, itemId: data.itemId || data.serviceItemId };
}

async function addTables(serviceUrl, specs) {
  await esriRequest(`${adminUrl(serviceUrl)}/addToDefinition`, {
    addToDefinition: JSON.stringify({ tables: specs.map(toTableDefinition) }),
  });
  // Read the service back to learn the real table ids.
  const info = await esriRequest(serviceUrl, {}, { method: "GET" });
  const tables = info.tables || [];
  const idOf = (name) => {
    const t = tables.find((x) => x.name === name);
    if (!t) throw new Error(`Table “${name}” not found after creation (service has: ${tables.map((x) => x.name).join(", ") || "none"})`);
    return t.id;
  };
  return Object.fromEntries(specs.map((s) => [s.name, idOf(s.name)]));
}

async function enableTracking(serviceUrl) {
  try {
    await esriRequest(`${adminUrl(serviceUrl)}/updateDefinition`, {
      updateDefinition: JSON.stringify({
        editorTrackingInfo: {
          enableEditorTracking: true,
          enableOwnershipAccessControl: false,
          allowOthersToUpdate: true,
          allowOthersToDelete: true,
          allowOthersToQuery: true,
        },
      }),
    });
    return true;
  } catch (err) {
    console.warn("Editor tracking not enabled:", err);
    return false;
  }
}

async function runCreate() {
  const btn = $("#create-btn");
  btn.disabled = true;
  $("#log").innerHTML = "";
  const nameInv = $("#name-inv").value.trim() || INVENTORY_SERVICE_NAME;
  const nameReq = $("#name-req").value.trim() || REQUESTS_SERVICE_NAME;
  try {
    let li = log(`Creating <b>${esc(nameInv)}</b>…`);
    const inv = await createService(nameInv, "TEMAzon inventory: items and transaction ledger (Property Office only)");
    R.invUrl = inv.url;
    R.invItemId = inv.itemId;
    li.textContent = `Created ${nameInv}.`;
    li.className = "ok";

    li = log("Adding Items and Transactions tables…");
    const invIds = await addTables(R.invUrl, [ITEMS_TABLE, TXN_TABLE]);
    R.itemsId = invIds.Items;
    R.txnId = invIds.Transactions;
    await enableTracking(R.invUrl);
    li.textContent = `Added tables (Items = ${R.itemsId}, Transactions = ${R.txnId}).`;
    li.className = "ok";

    li = log(`Creating <b>${esc(nameReq)}</b>…`);
    const req = await createService(nameReq, "TEMAzon requests: employee supply requests and their lines");
    R.reqUrl = req.url;
    R.reqItemId = req.itemId;
    li.textContent = `Created ${nameReq}.`;
    li.className = "ok";

    li = log("Adding Requests and RequestLines tables…");
    const reqIds = await addTables(R.reqUrl, [REQUESTS_TABLE, LINES_TABLE]);
    R.reqId = reqIds.Requests;
    R.linesId = reqIds.RequestLines;
    await enableTracking(R.reqUrl);
    li.textContent = `Added tables (Requests = ${R.reqId}, RequestLines = ${R.linesId}).`;
    li.className = "ok";

    if ($("#load-seed").checked) {
      const seed = await (await fetch("items-seed.json")).json();
      const itemsLayer = tableUrl(R.invUrl, R.itemsId);
      for (let i = 0; i < seed.length; i += 200) {
        const batch = seed.slice(i, i + 200);
        li = log(`Loading items ${i + 1}–${i + batch.length} of ${seed.length}…`);
        await applyEdits(itemsLayer, { adds: batch.map((a) => ({ attributes: a })) });
        li.className = "ok";
      }
      const back = await queryAll(itemsLayer, { where: "restricted = 'yes'" });
      log(`Loaded ${seed.length} items. Restricted (hidden from employees): <b>${back.length}</b>.`, "ok");
    }
    log("<b>Done.</b> Continue with steps 3 and 4 below.", "ok");
    showResults();
  } catch (err) {
    console.error(err);
    log(`<b>Stopped:</b> ${esc(err.message)}${err instanceof EsriError ? "" : ""}<br>If a service was already created, delete it from your content (or pick a different name above) before trying again.`, "bad");
    btn.disabled = false;
  }
}

function values() {
  return {
    ARCGIS_APP_ID: $("#client-id").value.trim(),
    INVENTORY_SERVICE_URL: R.invUrl,
    REQUESTS_SERVICE_URL: R.reqUrl,
    ITEMS_TABLE_ID: R.itemsId,
    TXN_TABLE_ID: R.txnId,
    REQ_TABLE_ID: R.reqId,
    LINES_TABLE_ID: R.linesId,
  };
}

function showResults() {
  const v = values();
  $("#step-config").hidden = false;
  $("#step-view").hidden = false;
  $("#cid-note").hidden = !v.ARCGIS_APP_ID;
  $("#config-values").textContent = Object.entries(v).map(([k, val]) => `${k}: ${JSON.stringify(val)}`).join("\n");
  $("#inv-item-link").href = `${CONFIG.ARCGIS_PORTAL_URL}/home/item.html?id=${R.invItemId}`;
}

function setKey(text, key, val) {
  const re = typeof val === "number" ? new RegExp(`(${key}:\\s*)\\d+`) : new RegExp(`(${key}:\\s*)"[^"]*"`);
  if (!re.test(text)) throw new Error(`Couldn't find ${key} in config.js`);
  return text.replace(re, (_, p) => `${p}${JSON.stringify(val)}`);
}

async function downloadConfig() {
  let text = await (await fetch("../shared/config.js")).text();
  const v = values();
  for (const [k, val] of Object.entries(v)) {
    if (k === "ARCGIS_APP_ID" && !val) continue;
    text = setKey(text, k, val);
  }
  downloadText("config.js", text, "text/javascript;charset=utf-8");
}

async function testView() {
  const out = $("#view-result");
  out.hidden = false;
  out.className = "banner banner-info";
  out.textContent = "Testing…";
  try {
    const url = $("#view-url").value.trim().replace(/\/+$/, "");
    if (!/\/FeatureServer\/\d+$/.test(url)) throw new Error("URL should end in /FeatureServer/0");
    const rows = await queryAll(url, { where: "1=1" });
    const leaked = rows.filter((r) => String(r.restricted || "").toLowerCase() !== "no");
    if (!rows.length) throw new Error("The view returned 0 rows — is the filter too strict, or the layer empty?");
    if (leaked.length) {
      out.className = "banner banner-warn";
      out.innerHTML = `<b>Not hidden yet:</b> the view returned ${rows.length} rows and ${leaked.length} are restricted (e.g. ${esc(leaked[0].description)}). Fix the view's filter to <code>restricted is no</code>.`;
    } else {
      out.className = "banner banner-ok";
      out.innerHTML = `<b>Working.</b> The view returns ${rows.length} items and none are restricted. Put this URL in <code>ITEMS_VIEW_URL</code> in config.js: <code>${esc(url)}</code>`;
    }
  } catch (err) {
    out.className = "banner banner-warn";
    out.textContent = err.message;
  }
}

async function main() {
  $("#redirect-uri").textContent = auth.redirectUri();
  $("#client-id").value = CONFIG.ARCGIS_APP_ID.startsWith("REPLACE_") ? "" : CONFIG.ARCGIS_APP_ID;
  fetch("items-seed.json").then((r) => r.json()).then((s) => {
    $("#seed-count").textContent = s.length;
    $("#seed-restricted").textContent = s.filter((x) => x.restricted === "yes").length;
  }).catch(() => {});

  $("#sign-out-btn").addEventListener("click", () => { auth.signOut(); location.reload(); });
  $("#create-btn").addEventListener("click", runCreate);
  $("#download-config").addEventListener("click", () => downloadConfig().catch((e) => alert(e.message)));
  $("#test-view").addEventListener("click", testView);
  $("#sign-in-btn").addEventListener("click", async () => {
    const id = $("#client-id").value.trim();
    if (!id) return ($("#login-error").textContent = "Enter the OAuth client ID first.");
    CONFIG.ARCGIS_APP_ID = id;
    try { localStorage.setItem(CID_KEY, id); } catch {}
    try {
      $("#login-error").textContent = "";
      await auth.startSignIn();
      if (auth.isSignedIn()) await afterSignIn();
    } catch (e) {
      $("#login-error").textContent = e.message;
    }
  });

  try {
    if ((await auth.boot()) === "popup") return;
  } catch (e) {
    $("#login-error").textContent = e.message;
    return;
  }
  if (auth.isSignedIn()) await afterSignIn();
}

async function afterSignIn() {
  const p = await auth.fetchProfile();
  $("#user-label").textContent = p ? `${p.fullName || p.username}` : "";
  $("#sign-out-btn").hidden = false;
  $("#step-signin").hidden = true;
  $("#step-create").hidden = false;
  if (p && p.role && !["org_admin", "org_publisher"].includes(p.role) && !/admin|publisher/i.test(p.role)) {
    setStatus(`Your ArcGIS role is “${p.role}”. Creating feature services needs a publisher or administrator role — this may fail.`, "error");
  }
}

main();
