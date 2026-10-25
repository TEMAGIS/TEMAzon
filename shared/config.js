// ---------------------------------------------------------------------------
// TEMAzon — shared configuration for the Request form, Management console
// and one-time Setup page. Nothing in this file is secret: the OAuth client
// ID is a *public* identifier (PKCE, no client secret).
//
// The three values marked  >>> SETUP <<<  are filled in for you by the
// Setup page ("Download updated config.js") — or paste them by hand.
// ---------------------------------------------------------------------------

export const CONFIG = {
  // --- ArcGIS OAuth (authorization-code + PKCE, same pattern as Assigned Inventory Editor) ---
  ARCGIS_PORTAL_URL: "https://www.arcgis.com",

  // >>> SETUP <<< Client ID of a NEW OAuth app (Content > New item > Developer
  // credentials) registered with these Redirect URIs (trailing slash included):
  //   https://temagis.github.io/TEMAzon/request/
  //   https://temagis.github.io/TEMAzon/console/
  //   https://temagis.github.io/TEMAzon/setup/
  ARCGIS_APP_ID: "zZU8M0ze0fC1IgJ3",

  // Leave blank: each page uses its own folder URL as the redirect URI.
  ARCGIS_REDIRECT_URI: "",

  ARCGIS_TOKEN_EXPIRATION_MINUTES: 20160, // refresh-token lifetime (ArcGIS max = 14 days)
  ARCGIS_REFRESH_BUFFER_MS: 5 * 60 * 1000,
  // Shared by all three pages (same origin) so signing in once signs you in everywhere.
  ARCGIS_TOKEN_STORAGE_KEY: "temazon_arcgis_token_v1",

  // --- Feature services created by the Setup page ---
  // Inventory service  = Items + Transactions   (share with the Property Officer only)
  // Requests service   = Requests + RequestLines (share with all employees, editing on)
  // Items view         = read-only view of Items filtered to restricted = 'no'
  //                      (share with all employees — this is what hides the red items)
  // URLs end in /FeatureServer (items view: /FeatureServer/0).
  INVENTORY_SERVICE_URL: "https://services1.arcgis.com/kILp9lqGUeOhnDbI/arcgis/rest/services/TEMAzon_Inventory/FeatureServer", // >>> SETUP <<<
  REQUESTS_SERVICE_URL: "https://services1.arcgis.com/kILp9lqGUeOhnDbI/arcgis/rest/services/TEMAzon_Requests/FeatureServer", // >>> SETUP <<<
  ITEMS_VIEW_URL: "https://services1.arcgis.com/kILp9lqGUeOhnDbI/arcgis/rest/services/TEMAzon_Items_Employee_View/FeatureServer/0", // >>> SETUP <<< (after you create the view — see README step 4)

  ITEMS_TABLE_ID: 0,
  TXN_TABLE_ID: 1,
  REQ_TABLE_ID: 0,
  LINES_TABLE_ID: 1,

  // --- Who can sign in ---
  // Everyone signs in with their own ArcGIS Online account; the app uses the
  // account's full name and email (no separate Users list). What each person
  // can actually reach is decided by how you SHARE the services (README step 5).
  //
  // Console: anyone whose account can open the Inventory service is let in.
  // Optionally also require their email to be in this list (empty = no extra check).
  CONSOLE_ALLOWED_EMAILS: [],

  // --- Lists ---
  REGIONS: ["HQ", "West", "Middle", "East", "Southeast"],
  SECTIONS: ["Ops & Admin Support", "Executive", "Operations", "Mitigation & Recovery", "Preparedness"],

  // --- Request form ---
  SHOW_PRICES_TO_EMPLOYEES: false,

  // What employees see about stock on the request form:
  //   "full"   = exact count   ("12 in stock", "Low — 3 in stock")
  //   "status" = no numbers    ("In stock", "Low stock", "Out of stock")
  //   "hidden" = nothing shown
  // Note: this only changes the screen. To keep the count out of the data itself,
  // remove qty_on_hand from the employee view's fields in ArcGIS Online.
  STOCK_VISIBILITY: "status",
  MAX_QTY_PER_LINE: 999,

  // --- Console: burn-rate review ---
  // On a pending request each line is compared with how much that same
  // person/section/region has received before. A line is flagged when the
  // quantity requested would last longer than these many months at their
  // historical monthly rate.
  BURN_WARN_MONTHS_OF_SUPPLY: 3,
  BURN_ALERT_MONTHS_OF_SUPPLY: 6,
  BURN_DEFAULT_WINDOW_MONTHS: 6,

  // Page size when loading whole tables into memory.
  FETCH_PAGE_SIZE: 1000,
};

export const TXN_TYPES = {
  INITIAL: { label: "Initial count", sign: +1 },
  RECEIVE: { label: "Received", sign: +1 },
  RETURN: { label: "Returned", sign: +1 },
  ISSUE: { label: "Issued", sign: -1 },
  ADJUST: { label: "Adjustment", sign: 0 }, // either direction
};

export const REQUEST_STATUS = {
  PENDING: "Pending",
  FULFILLED: "Fulfilled",
  DENIED: "Denied",
  CANCELLED: "Cancelled",
};
