// ---------------------------------------------------------------------------
// Table definitions for the two hosted feature services. Used by the Setup
// page to create them, and the single source of truth for field names.
//
//   TEMAzon_Inventory : Items (0), Transactions (1)   — Property Officer only
//   TEMAzon_Requests  : Requests (0), RequestLines (1) — all employees
// ---------------------------------------------------------------------------

const str = (name, length, alias, extra = {}) => ({ name, type: "esriFieldTypeString", alias: alias || name, length, ...extra });
const int = (name, alias, extra = {}) => ({ name, type: "esriFieldTypeInteger", alias: alias || name, ...extra });
const dbl = (name, alias, extra = {}) => ({ name, type: "esriFieldTypeDouble", alias: alias || name, ...extra });
const date = (name, alias, extra = {}) => ({ name, type: "esriFieldTypeDate", alias: alias || name, ...extra });

export const INVENTORY_SERVICE_NAME = "TEMAzon_Inventory";
export const REQUESTS_SERVICE_NAME = "TEMAzon_Requests";
export const ITEMS_VIEW_NAME = "TEMAzon_Items_Employee_View";

export const ITEMS_TABLE = {
  name: "Items",
  displayField: "description",
  fields: [
    str("item_id", 40, "Item ID"),
    str("category", 60, "Category"),
    str("vendor", 40, "Vendor"),
    str("vendor_item_no", 40, "Vendor item #"),
    str("description", 255, "Description"),
    str("product_title", 500, "Product title"),
    str("product_url", 1000, "Product link"),
    dbl("unit_cost", "Unit cost"),
    int("qty_on_hand", "Qty on hand"),
    int("reorder_level", "Reorder level"),
    // 'no' = visible to employees. Anything else (incl. 'yes') is hidden from the employee view.
    str("restricted", 3, "Restricted (hidden from employees)", { defaultValue: "no" }),
    str("device_used_on", 255, "Device used on"),
    str("active", 3, "Active", { defaultValue: "yes" }),
    str("notes", 500, "Notes"),
  ],
};

export const TXN_TABLE = {
  name: "Transactions",
  displayField: "item_description",
  fields: [
    str("txn_id", 40, "Transaction ID"),
    str("item_id", 40, "Item ID"),
    str("item_description", 255, "Item"),
    str("category", 60, "Category"),
    str("txn_type", 20, "Type"), // INITIAL | RECEIVE | RETURN | ISSUE | ADJUST
    int("qty_change", "Qty change"), // + adds stock, − removes stock
    int("qty_after", "Qty after"),
    dbl("unit_cost", "Unit cost"),
    str("request_id", 40, "Request ID"),
    str("entity_name", 150, "Person"),
    str("entity_email", 150, "Person email"),
    str("entity_section", 80, "Section"),
    str("entity_region", 40, "Region"),
    str("performed_by", 150, "Performed by"),
    str("performed_by_email", 150, "Performed by email"),
    date("txn_date", "Date"),
    str("note", 500, "Note"),
  ],
};

export const REQUESTS_TABLE = {
  name: "Requests",
  displayField: "request_id",
  fields: [
    str("request_id", 40, "Request ID"),
    str("status", 20, "Status"), // Pending | Fulfilled | Denied | Cancelled
    date("submitted_date", "Submitted"),
    str("requester_name", 150, "Requester"),
    str("requester_email", 150, "Requester email"),
    str("requester_edison_id", 40, "Edison ID"),
    str("section", 80, "Section"),
    str("region", 40, "Region"),
    str("deliver_to", 255, "Deliver to"),
    str("request_note", 1000, "Request note"),
    int("line_count", "Lines"),
    dbl("est_total", "Estimated total"),
    str("decided_by", 150, "Decided by"),
    str("decided_by_email", 150, "Decided by email"),
    date("decided_date", "Decided"),
    str("decision_note", 1000, "Decision note"),
  ],
};

export const LINES_TABLE = {
  name: "RequestLines",
  displayField: "description",
  fields: [
    str("request_id", 40, "Request ID"),
    int("line_no", "Line #"),
    str("item_id", 40, "Item ID"),
    str("category", 60, "Category"),
    str("description", 255, "Description"),
    str("vendor_item_no", 40, "Vendor item #"),
    dbl("unit_cost", "Unit cost"),
    int("qty_requested", "Qty requested"),
    int("qty_approved", "Qty approved"),
    str("line_note", 500, "Employee note"),
    str("admin_note", 500, "Admin note"),
  ],
};

/** Expands a compact table spec into the full JSON addToDefinition expects. */
export function toTableDefinition(spec) {
  const base = (f) => ({
    sqlType: "sqlTypeOther",
    nullable: true,
    editable: true,
    domain: null,
    defaultValue: null,
    ...f,
  });
  const fields = [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID", sqlType: "sqlTypeOther", nullable: false, editable: false, domain: null, defaultValue: null },
    ...spec.fields.map(base),
    base({ name: "CreationDate", type: "esriFieldTypeDate", alias: "CreationDate", length: 8, editable: false }),
    base({ name: "Creator", type: "esriFieldTypeString", alias: "Creator", length: 128, editable: false }),
    base({ name: "EditDate", type: "esriFieldTypeDate", alias: "EditDate", length: 8, editable: false }),
    base({ name: "Editor", type: "esriFieldTypeString", alias: "Editor", length: 128, editable: false }),
  ];
  return {
    name: spec.name,
    type: "Table",
    displayField: spec.displayField || "",
    description: "",
    copyrightText: "",
    defaultVisibility: true,
    relationships: [],
    isDataVersioned: false,
    supportsRollbackOnFailureParameter: true,
    supportsStatistics: true,
    supportsAdvancedQueries: true,
    geometryType: "",
    minScale: 0,
    maxScale: 0,
    extent: null,
    drawingInfo: null,
    hasM: false,
    hasZ: false,
    objectIdField: "OBJECTID",
    globalIdField: "",
    types: [],
    templates: [],
    hasAttachments: false,
    capabilities: "Query,Create,Update,Delete,Editing",
    editFieldsInfo: {
      creationDateField: "CreationDate",
      creatorField: "Creator",
      editDateField: "EditDate",
      editorField: "Editor",
    },
    fields,
  };
}

/** Field names of a spec, for the [schema check] warning. */
export const fieldNames = (spec) => spec.fields.map((f) => f.name);
