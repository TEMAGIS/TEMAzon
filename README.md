# TEMAzon — supply inventory, request form and management console

Three small static web apps (no build step, no server) that sit on two ArcGIS Online hosted feature services and use the **same OAuth 2.0 + PKCE ArcGIS Online sign-in** as the Assigned Inventory Editor. People are simply their ArcGIS accounts — the app uses the account's **full name and email**; there is no separate user list (it no longer depends on the Assigned Inventory Users layer).

| App | Folder | Who | What it does |
|---|---|---|---|
| **Request form** | `request/` | Anyone who can sign in with ArcGIS and open the shared Requests service + employee view | Browse the catalog, build a request, submit it, track *My requests*, cancel a pending one, "request again". |
| **Management console** | `console/` | Property Officers only — whoever the Inventory service is shared with (plus optional `CONSOLE_ALLOWED_EMAILS`) | Current inventory, receive / issue / count stock, approval queue with **adjustable approved quantities**, full transaction ledger, **entity lookup with burn-rate comparison**, CSV export, reconcile. |
| **Setup** | `setup/` | You, once | Creates the two feature services, loads the 170 spreadsheet items, writes the config values. |

---

## How the red items stay hidden

Hiding rows in the page alone is not security — anyone can call the REST endpoint with their own token. So the design uses an ArcGIS **view layer** as the real boundary:

```
TEMAzon_Inventory  (Items + Transactions)      shared with: Property Officer(s) only
   └─ TEMAzon_Items_Employee_View              shared with: all employees, read-only,
        filter:  restricted is no                           contains NO restricted rows
TEMAzon_Requests   (Requests + RequestLines)   shared with: all employees, editing on
```

* The request form reads **only the view**, so restricted items are never sent to an employee's browser. As a second line of defence the form also drops any row whose `restricted` isn't exactly `no`.
* If `ITEMS_VIEW_URL` is left empty the form falls back to the Items table with only that client-side filter and logs a warning in the browser console. Don't run that way in production.
* Employees have no access to the Inventory service at all, so they can't see quantities for restricted items, the ledger, or other people's issue history.
* A red item is just `restricted = yes` on its Items row. Flip it in the console (Edit item → *Visible to employees?*) and it appears/disappears from the form immediately.

**The 13 items flagged from the red rows in your spreadsheet** (the two "Red-hide" legend rows were skipped):

- MCH-004 — HP OFFICE JET 250 WIRELESS ALL IN ONE COLOR PRINTER
- MCH-005 — HP OFFICE JET PRO 9130B MULTI FUNCTION PRINTER COLOR
- MCH-007 / MCH-008 — HP COLOR LASER JET PRO MFP3301FDW (ODP and CDW listings)
- MCH-009 — EPSON DS-70 PORTABLE SCANNER
- MCH-017 — OWL LABS CONFERENCE KIT
- MCH-018 — OWL LABS PELICAN CASE 15"X13"
- MCH-020 — MOUNT IT MI7955 ADJUSTABLE DESK RISER
- MCH-022 — DYMO LABELWRITER 550 SERIES
- ORG-010 … ORG-013 — the four whiteboards / dry-erase boards

Toner for the restricted printers is *not* red in your sheet, so it stays requestable (its "For:" line shows the printer model).

---

## Setup (about 20 minutes)

1. **Register an OAuth app.** ArcGIS Online → Content → New item → *Developer credentials* → OAuth 2.0. Add these Redirect URIs (trailing slash matters; swap in your real host if it isn't GitHub Pages under `temagis`):
   `https://temagis.github.io/TEMAzon/request/`, `…/TEMAzon/console/`, `…/TEMAzon/setup/`.
   Copy the **Client ID**. (Use a *new* app, not the Assigned Inventory one.)
2. **Host the folder** (this whole `TEMAzon` folder, keeping `shared/`, `request/`, `console/`, `setup/` side by side), e.g. a GitHub Pages repo.
3. **Run the Setup page** (`…/setup/`): paste the Client ID, sign in as the ArcGIS user who should own the services, click **Create services**. It creates `TEMAzon_Inventory` and `TEMAzon_Requests`, adds the four tables, loads the 170 items, and reports that 13 are restricted. Click **Download updated config.js** and replace `shared/config.js` with it.
4. **Create the employee view** (Setup page step 4 walks through it): Inventory service item → *Create view layer* → Items only → name `TEMAzon_Items_Employee_View` → make it read-only → set the layer filter `restricted is no`. Paste its `/FeatureServer/0` URL into the Setup page's *Test the view* box — it fails loudly if any restricted row leaks — then put that URL in `ITEMS_VIEW_URL` in `shared/config.js`.
5. **Share:**
   * Inventory service → Property Officer(s) only, ideally via one ArcGIS group (they need edit access). This is what gates the console.
   * Employee view → everyone who may request (view only).
   * Requests service → everyone who may request, **editing on**. (Optional: *Settings → Editing* and tick "editors can only see their own features" if you don't want employees seeing each other's requests — the console user must then be the item owner or an org admin.)
6. **Enter opening counts.** Every item starts at 0, so the form shows everything as *Out of stock* until you do this. Console → Inventory → **Count mode** → type the real on-hand numbers → Save. Each one is logged as an *Initial count*. Optionally set a **Reorder level** per item to get Low-stock flags.

**Who is who.** Each person signs in with their own ArcGIS Online account; their full name and email come from that account (an account with no email is stopped with a message, because the email is how *My requests* finds their requests). The request form asks for **Section** and **Region** (remembered on that browser for next time), since those aren't on an ArcGIS account.

**Console access** is decided by sharing: the console probes the Inventory service on sign-in, and anyone whose account can't open it sees "can't open the TEMAzon Inventory service". For a second lock, put emails in `CONSOLE_ALLOWED_EMAILS` in `shared/config.js` (case-insensitive; empty = no extra check). A tidy way to manage officers: create an ArcGIS group, share the Inventory service with that group only.

---

## How inventory is tracked

* **Transactions is the ledger** — every add or remove is a row: *Initial count, Received, Returned, Issued, Adjustment*, with the signed change, the quantity after, who/what it went to (person, section, region), the request number if any, who recorded it, and when.
* `Items.qty_on_hand` is the cached running total. It's updated **in the same transaction** as the ledger rows (one service-level `applyEdits`), and the current quantity is re-read from the service just before writing so two people can't overwrite each other.
* Stock can't go negative unless you tick *Allow stock to go negative (backorder)*.
* Console → Transactions → **Reconcile** compares each item's stored quantity with the ledger sum and can reset the stored number to the ledger total.

## Requests and adjustable amounts

1. Employee picks items, chooses section + region, and submits → `Pending` (request + lines saved atomically).
2. Property Officer opens it in **Console → Requests → Review**. Each line shows on-hand, requested, and an **Approve** box pre-filled with the requested quantity — change it to whatever you're willing to give. Add a note per line and an overall decision note (shown to the employee).
3. **Approve & issue stock** writes one *Issued* ledger row per line (using the *approved* quantity, tagged with the requester's name, email, section and region), reduces stock, and marks the request `Fulfilled`. **Deny** (note required) closes it with nothing issued. Employees can cancel their own pending requests.
4. If a connection drops between the stock write and the request update, the next time you open that request it shows a warning and offers **Finish without issuing again**, so stock is never double-issued.

## Entity lookup and burn rates

* **Review dialog:** for each line, *Their usage* (units used in the window, per-month rate, number of issues, days since last), *Peer avg* (average monthly use among others of the same kind, with the count), and *Supply after* — how many months the approved quantity would last at their historical rate (green ≤ 3, amber > 3, red > 6; change `BURN_WARN_/ALERT_MONTHS_OF_SUPPLY` in config). Switch the comparison between **this person / their section / their region** and the window (3, 6, 12 months, all time). Quantities update live as you type.
* **Entities tab:** pick a person, section or region → request count, units and dollars issued, last issue date, a per-item burn table (qty, per-month, issues, last issued, peer average, ratio vs. peers), and the full request history (click a row to open the request).
* Burn rate is computed from the ledger (issues minus returns), so direct issues you record from the Inventory tab count too — fill in *Issued to* so they're attributed. Known people (anyone who has made a request or been issued something) autocomplete with their email and section; someone new can be typed in. Person history is keyed on email, so a person's name changing in ArcGIS doesn't split their history.

---

## Notes on your spreadsheet

* 170 items loaded: Office Supplies 85, Toner 39, Machines 29, Office Organizer 13, Cleaning Supplies 4. Vendors normalised (`odp`, `CDW `, trailing spaces/non-breaking spaces removed). Item IDs are generated (`OFF-001`, `MCH-001`, `ORG-001`, `TNR-001`, `CLN-001`).
* **Six HP 730 plotter inks (TNR-024 … TNR-029)** have the text `101-194` in the COST column, which isn't a number. They're loaded with no unit cost and a note "confirm price". Fix in the console (Edit item).
* **Canon imagePROGRAF inks (TNR-030 … TNR-039):** the *Device used on* text had a number that auto-incremented down the column (…PRO 6600, 6601, 6602 …). I reset all ten to `…PRO 6600`.
* `SHARPIE S GEL BOLD BLUE 1.0MM 12PK` appears twice in Office Supplies and the HP MFP3301FDW appears under both ODP and CDW — both kept as separate rows (different vendor items); merge if they're really the same thing.
* The sheet's *QUANTITY ON HAND* and *NEED* columns were empty, so everything starts at 0.
* `seed/items.csv` is the same data as a CSV (handy for a manual import — see below).

## What was and wasn't verified

Tested end to end in a headless browser against a **mock** ArcGIS service (≈80 checks: hidden red items, submit, approve with a reduced amount, blocked overdraw, deny, half-saved-approval recovery, receive/issue/count/add-item, reconcile, burn rate, entity lookup, console access gates, the Setup page's request sequence and the config download). I could not run it against your live ArcGIS Online org from here, so two things are worth a quick look on first use:

* The Setup page uses Esri's documented `createService` → `addToDefinition` calls to make tables. If ArcGIS rejects any step, the page stops and shows the exact error. **Manual fallback:** create two hosted table layers yourself, add the fields listed below (names must match exactly), and import `seed/items.csv` into Items.
* The Setup page enables editor tracking (Creator/EditDate fields) as a best effort; the apps don't depend on it.
* Open DevTools → Console after the first sign-in. Each page logs a `[schema check]` line that warns about any expected field missing from the live tables.

Trust model, as in the Assigned Inventory Editor: ArcGIS layer sharing is the real access boundary; the apps' role checks decide what each signed-in person is *offered*. Don't share the Inventory service more widely than Property Officers.

## Field reference

**Items** (Inventory service, table 0)

| Field | Type | Label |
|---|---|---|
| item_id | String(40) | Item ID |
| category | String(60) | Category |
| vendor | String(40) | Vendor |
| vendor_item_no | String(40) | Vendor item # |
| description | String(255) | Description |
| product_title | String(500) | Product title |
| product_url | String(1000) | Product link |
| unit_cost | Double | Unit cost |
| qty_on_hand | Integer | Qty on hand |
| reorder_level | Integer | Reorder level |
| restricted | String(3) | Restricted (hidden from employees) |
| device_used_on | String(255) | Device used on |
| active | String(3) | Active |
| notes | String(500) | Notes |

**Transactions** (Inventory service, table 1)

| Field | Type | Label |
|---|---|---|
| txn_id | String(40) | Transaction ID |
| item_id | String(40) | Item ID |
| item_description | String(255) | Item |
| category | String(60) | Category |
| txn_type | String(20) | Type |
| qty_change | Integer | Qty change |
| qty_after | Integer | Qty after |
| unit_cost | Double | Unit cost |
| request_id | String(40) | Request ID |
| entity_name | String(150) | Person |
| entity_email | String(150) | Person email |
| entity_section | String(80) | Section |
| entity_region | String(40) | Region |
| performed_by | String(150) | Performed by |
| performed_by_email | String(150) | Performed by email |
| txn_date | Date | Date |
| note | String(500) | Note |

**Requests** (Requests service, table 0)

| Field | Type | Label |
|---|---|---|
| request_id | String(40) | Request ID |
| status | String(20) | Status |
| submitted_date | Date | Submitted |
| requester_name | String(150) | Requester |
| requester_email | String(150) | Requester email |
| requester_edison_id | String(40) | Edison ID |
| section | String(80) | Section |
| region | String(40) | Region |
| deliver_to | String(255) | Deliver to |
| request_note | String(1000) | Request note |
| line_count | Integer | Lines |
| est_total | Double | Estimated total |
| decided_by | String(150) | Decided by |
| decided_by_email | String(150) | Decided by email |
| decided_date | Date | Decided |
| decision_note | String(1000) | Decision note |

**RequestLines** (Requests service, table 1)

| Field | Type | Label |
|---|---|---|
| request_id | String(40) | Request ID |
| line_no | Integer | Line # |
| item_id | String(40) | Item ID |
| category | String(60) | Category |
| description | String(255) | Description |
| vendor_item_no | String(40) | Vendor item # |
| unit_cost | Double | Unit cost |
| qty_requested | Integer | Qty requested |
| qty_approved | Integer | Qty approved |
| line_note | String(500) | Employee note |
| admin_note | String(500) | Admin note |


`restricted` is `no` (employees can request it) or `yes` (hidden). `active` is `yes` or `no` (discontinued, hidden from employees). Dates are stored as ArcGIS date fields (UTC).

## File map

```
shared/   config.js (edit this)  arcgis-auth.js  esri-client.js  schema.js  session.js  ui.js  util.js  common.css
request/  index.html  app.js
console/  index.html  app.js  state.js  inventory.js  requests.js  transactions.js  entities.js  stock.js  burn.js
setup/    index.html  setup.js  items-seed.json
seed/     items.csv
```

### Importing counts from a CSV
Console → Inventory → **Import CSV**. Include an **Item ID** column and a quantity column (`Qty` or `Quantity`). In the preview, tick **Also apply these as counts** and the number in the file **replaces** what is on hand (logged as an adjustment, or Initial for an item's first count). Nothing is saved until you click Apply. A blank Item ID adds a new item, and its quantity becomes the starting count.

### Section and Region lists (Console → Settings)
The Section and Region dropdowns on the request form are edited in the console's **Settings** tab: add, rename, reorder or remove values, then Save each list. They are stored in a small **Lists** table inside the Requests service (found by name, so nothing to add to `config.js`), and the form picks them up the next time it opens.

* **First time on an existing install:** open Settings and click **Create the Lists table** (needs the owner of the Requests service or an ArcGIS admin). New installs get the table from the Setup page. By hand: add a table named `Lists` to the Requests service with text fields `list_name` (20), `value` (80) and integer `sort_order`.
* Until a list is saved, the form uses `SECTIONS` / `REGIONS` in `config.js` as defaults, so nothing breaks if the table is missing or can't be read.
* Removing or renaming a value only affects new requests; existing requests and ledger rows keep the text they were saved with, so a renamed section shows as a separate group in burn-rate comparisons. Settings shows how many requests use each value.
* The Lists table shares the Requests service's sharing, so employees technically have edit rights to it. The console is the supported way to change it. For a hard lock, share a read-only view of the table with employees instead.

### Need by date
The request form has an optional **Need by** date (it can't be in the past). The console shows it as a **Need by** column on the Requests tab, sorts Pending requests with the soonest date first, flags requests due within 3 days or overdue, and shows the date in the review dialog. The new-request email to officers includes it too (redeploy `temazon_notify_lambda.py`).

* **Existing install:** the Requests table needs a Date field named `need_by_date`. Open console → Settings and click **Add the Need by field** (service owner or ArcGIS admin), or add the field by hand. Until it exists, the date isn't saved. New installs get it from the Setup page.
* Dates are stored at 12:00 UTC so every time zone shows the same calendar day.

## Requests for things not on the list

The request form has a **Not on the list** tab where employees describe what they need in a text box (what, why, section, region, deliver to, need by). No schema change or setup is needed.

It is saved as a normal request with a single line whose Item ID is `CUSTOM` (the details are in the request note), so it appears in the console queue, My requests, and the notification email like any other request. In the console review window the line shows "Not in inventory"; the button reads **Approve** and moves no stock. Use the decision note to tell the requester what happens next (for example, "ordered, expect 2 weeks").
