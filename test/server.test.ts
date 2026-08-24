import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, __test } from "../server.js";

// ---------------------------------------------------------------------------
// Fixtures: real NYC Open Data (SODA) row shapes. Detail/list and aggregate
// queries both return a bare JSON array; errors return { error: true, message }.
// Building example: 1520 Sedgwick Avenue, Bronx.
// ---------------------------------------------------------------------------

const VIOLATION_ROW = {
  violationid: "19051745",
  buildingid: "108415",
  registrationid: "221729",
  boroid: "2",
  boro: "BRONX",
  housenumber: "1520",
  streetname: "SEDGWICK AVENUE",
  zip: "10453",
  apartment: "2D",
  story: "2",
  class: "C",
  inspectiondate: "2026-07-04T00:00:00.000",
  novdescription: "HMC ADM CODE: § 27-2017.4 ABATE THE INFESTATION CONSISTING OF MICE IN THE ENTIRE APARTMENT",
  novissueddate: "2026-07-06T00:00:00.000",
  currentstatus: "NOTICE OF ISSUANCE SENT TO TENANT",
  novtype: "Original",
  violationstatus: "Open",
  rentimpairing: "N",
};
const VIOLATION_SUMMARY = [
  { class: "A", n: "202" },
  { class: "B", n: "550" },
  { class: "C", n: "281" },
  { class: "I", n: "3" },
];

const COMPLAINT_ROW = {
  received_date: "2026-06-26T10:14:32.000",
  problem_id: "28894796",
  complaint_id: "14863019",
  building_id: "108415",
  borough: "BRONX",
  house_number: "1520",
  street_name: "SEDGWICK AVENUE",
  post_code: "10453",
  apartment: "2D",
  unit_type: "APARTMENT",
  space_type: "ENTIRE APARTMENT",
  type: "EMERGENCY",
  major_category: "HEAT/HOT WATER",
  minor_category: "APARTMENT ONLY",
  problem_code: "NO HEAT",
  complaint_status: "OPEN",
  complaint_status_date: "2026-06-27T09:00:00.000",
  problem_status: "OPEN",
  problem_status_date: "2026-06-27T09:00:00.000",
  status_description: "The complaint is open.",
};
const COMPLAINT_SUMMARY = [
  { complaint_status: "CLOSE", n: "120" },
  { complaint_status: "OPEN", n: "8" },
];

const REGISTRATION_ROW = {
  registrationid: "221729",
  buildingid: "108415",
  boroid: "2",
  boro: "BRONX",
  housenumber: "1520",
  streetname: "SEDGWICK AVENUE",
  zip: "10453",
  bin: "2009171",
  communityboard: "5",
  lastregistrationdate: "2025-09-05T00:00:00.000",
  registrationenddate: "2026-09-01T00:00:00.000",
};
// Real column shapes, synthetic people. HPD registration contacts are public
// record, but there is no reason to ship a real person's name inside a published
// package, and the assertions below test grouping and the SoQL name
// concatenation rather than any particular name. The corporate entity stays
// because it matches the worked example in the README.
const CONTACT_ROWS = [
  {
    registrationcontactid: "22172903",
    registrationid: "221729",
    type: "CorporateOwner",
    corporationname: "WFHA 1520 SEDGWICK LP",
    businesshousenumber: "43-55",
    businessstreetname: "11TH STREET",
    businesscity: "LIC",
    businessstate: "NY",
    businesszip: "11101",
  },
  {
    registrationcontactid: "22172904",
    registrationid: "221729",
    type: "Agent",
    corporationname: "M H R MANAGEMENT INC",
    firstname: "DANA",
    lastname: "REYES",
    businesshousenumber: "43-55",
    businessstreetname: "11TH STREET",
    businesscity: "LIC",
    businessstate: "NY",
    businesszip: "11101",
  },
  {
    registrationcontactid: "22172913",
    registrationid: "221729",
    type: "SiteManager",
    firstname: "MARCO",
    lastname: "OKONJO",
  },
];

// landlord_portfolio: the Sedgwick corporate owner also holding a second,
// synthetic building (real column shapes, placeholder values) so the reverse
// lookup's fan-out is exercised.
const PORTFOLIO_REGISTRATION_ROW_2 = {
  registrationid: "330001",
  buildingid: "300001",
  boroid: "4",
  boro: "QUEENS",
  housenumber: "120-15",
  streetname: "EXAMPLE STREET",
  zip: "11415",
  bin: "4000001",
  communityboard: "9",
  lastregistrationdate: "2025-08-01T00:00:00.000",
  registrationenddate: "2026-09-01T00:00:00.000",
};
const PORTFOLIO_CONTACT_MATCHES = [
  {
    registrationcontactid: "22172903",
    registrationid: "221729",
    type: "CorporateOwner",
    corporationname: "WFHA 1520 SEDGWICK LP",
    businesshousenumber: "43-55",
    businessstreetname: "11TH STREET",
    businesscity: "LIC",
    businessstate: "NY",
    businesszip: "11101",
  },
  {
    registrationcontactid: "33000101",
    registrationid: "330001",
    type: "CorporateOwner",
    corporationname: "WFHA 1520 SEDGWICK LP",
    businesshousenumber: "43-55",
    businessstreetname: "11TH STREET",
    businesscity: "LIC",
    businessstate: "NY",
    businesszip: "11101",
  },
];

const LITIGATION_ROWS = [
  {
    litigationid: "75707",
    buildingid: "1296",
    boroid: "2",
    housenumber: "1694",
    streetname: "WALTON AVENUE",
    zip: "10457",
    casetype: "Tenant Action",
    caseopendate: "2019-05-01T00:00:00.000",
    casestatus: "CLOSED",
    casejudgement: "NO",
    findingofharassment: "No",
    findingdate: "",
    penalty: "",
    respondent: "M 1695 G C LLC",
  },
  {
    litigationid: "426102",
    buildingid: "1297",
    boroid: "2",
    housenumber: "2084",
    streetname: "CRESTON AVENUE",
    zip: "10453",
    casetype: "Comprehensive",
    caseopendate: "2022-02-01T00:00:00.000",
    casestatus: "OPEN",
    casejudgement: "NO",
    findingofharassment: "Yes",
    findingdate: "2022-09-01T00:00:00.000",
    penalty: "1000",
    respondent: "2084 CRESTON AVENUE REALTY LLC",
  },
];

// Queens stores hyphenated house numbers (e.g. "120-15"); a user who types
// "12015" or "120 15" must still match instead of getting a silent zero.
// Placeholder street, not a real address.
const QUEENS_VIOLATION_ROW = {
  violationid: "20000001",
  buildingid: "300001",
  registrationid: "330001",
  boroid: "4",
  boro: "QUEENS",
  housenumber: "120-15",
  streetname: "EXAMPLE STREET",
  zip: "11415",
  apartment: "3B",
  class: "B",
  inspectiondate: "2026-05-10T00:00:00.000",
  novdescription: "HMC ADM CODE: SAMPLE HAZARDOUS VIOLATION",
  currentstatus: "VIOLATION OPEN",
  violationstatus: "Open",
  rentimpairing: "N",
};
const QUEENS_VIOLATION_SUMMARY = [
  { class: "A", n: "4" },
  { class: "B", n: "9" },
];

// Synthetic row: real column shape, placeholder values (not a real eviction).
const EVICTION_ROW = {
  court_index_number: "123456/24",
  docket_number: "70001",
  eviction_address: "123 EXAMPLE AVENUE APT 1A",
  eviction_apt_num: "1A",
  executed_date: "2025-09-17T00:00:00.000",
  marshal_first_name: "Jordan",
  marshal_last_name: "Marshal",
  residential_commercial_ind: "Residential",
  borough: "BRONX",
  eviction_zip: "10458",
  ejectment: "Not an Ejectment",
  eviction_possession: "Possession",
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let client: Client;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, text: async () => JSON.stringify(body) };
}
function textResponse(text: string, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, text: async () => text };
}

/** URL passed to the Nth fetch call (0-based). */
function urlOf(i: number): URL {
  const call = fetchMock.mock.calls[i];
  if (!call) throw new Error(`fetch call ${i} did not happen`);
  return call[0] as URL;
}
function lastUrl(): URL {
  return urlOf(fetchMock.mock.calls.length - 1);
}
function whereOf(i: number): string {
  return urlOf(i).searchParams.get("$where") ?? "";
}
function lastInit(): { headers: Record<string, string> } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return call[1] as { headers: Record<string, string> };
}
async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}
function payload(result: any) {
  return JSON.parse(result.content[0].text);
}

beforeEach(async () => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.NYC_APP_TOKEN;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NYC_APP_TOKEN;
});

// ---------------------------------------------------------------------------
// Registration + helpers
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  it("lists exactly the ten documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "building_311",
      "building_complaints",
      "building_profile",
      "building_violations",
      "dob_building",
      "eviction_lookup",
      "landlord_litigation",
      "landlord_portfolio",
      "true_owner",
      "who_owns",
    ]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });
});

describe("borough resolution + SoQL escaping (unit)", () => {
  it("maps names, abbreviations, and codes to the right boro text and boroid", () => {
    expect(__test.resolveBorough("Bronx")).toMatchObject({ id: 2, text: "BRONX" });
    expect(__test.resolveBorough("bk")).toMatchObject({ id: 3, text: "BROOKLYN" });
    expect(__test.resolveBorough("new york")).toMatchObject({ id: 1, text: "MANHATTAN" });
    expect(__test.resolveBorough("5")).toMatchObject({ id: 5, text: "STATEN ISLAND" });
  });
  it("expands eviction aliases for the mixed borough/county column", () => {
    expect(__test.resolveBorough("Brooklyn").evictionAliases).toEqual(["BROOKLYN", "KINGS"]);
    expect(__test.resolveBorough("Manhattan").evictionAliases).toEqual(["MANHATTAN", "NEW YORK"]);
  });
  it("throws on an unknown borough", () => {
    expect(() => __test.resolveBorough("Camden")).toThrow(/Unrecognized borough/);
  });

  // "NYC"/"NY" name the whole city, not Manhattan. They must NOT silently
  // resolve to Manhattan (which would return one borough's data city-wide).
  it("rejects city-wide NY/NYC as ambiguous instead of silently mapping to Manhattan", () => {
    for (const input of ["NYC", "NY", "nyc", "New York City"]) {
      expect(() => __test.resolveBorough(input)).toThrow(/ambiguous|whole city/i);
    }
    // Real single-borough references still resolve (New York County = Manhattan).
    expect(__test.resolveBorough("New York")).toMatchObject({ id: 1, text: "MANHATTAN" });
    expect(__test.resolveBorough("NEWYORK")).toMatchObject({ id: 1, text: "MANHATTAN" });
    expect(__test.resolveBorough("1")).toMatchObject({ id: 1, text: "MANHATTAN" });
    expect(__test.resolveBorough("Manhattan")).toMatchObject({ id: 1, text: "MANHATTAN" });
  });

  it("escapes single quotes in a LIKE value (SoQL injection guard)", () => {
    expect(__test.likeCI("respondent", "O'Brien")).toBe("upper(respondent) like '%O''BRIEN%'");
  });

  // % and _ are LIKE wildcards; unescaped user input would widen the match
  // (e.g. "100%" matching everything). SoQL uses backslash as the LIKE escape char.
  it("escapes LIKE wildcards (%, _) and backslash in the user portion", () => {
    expect(__test.likeCI("respondent", "100%_off")).toBe("upper(respondent) like '%100\\%\\_OFF%'");
    // A literal backslash the user typed is doubled so it stays literal.
    expect(__test.likeCI("streetname", "a\\b")).toBe("upper(streetname) like '%A\\\\B%'");
    // The outer %...% (our substring wildcards) are preserved; only the user text is escaped.
    expect(__test.likeCI("streetname", "217 STREET")).toBe("upper(streetname) like '%217 STREET%'");
  });
});

// ---------------------------------------------------------------------------
// building_violations
// ---------------------------------------------------------------------------

describe("building_violations", () => {
  it("returns a server-side class summary plus normalized rows", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(VIOLATION_SUMMARY)); // aggregate
    fetchMock.mockResolvedValueOnce(jsonResponse([VIOLATION_ROW])); // detail
    const body = payload(await call("building_violations", { house_number: "1520", street: "Sedgwick Avenue", borough: "Bronx" }));

    expect(body.summary.total_matching).toBe(1036);
    expect(body.summary.by_class).toEqual({ A: 202, B: 550, C: 281, I: 3 });
    expect(body.returned).toBe(1);
    const v = body.results[0];
    expect(v.violation_id).toBe("19051745");
    expect(v.class).toBe("C");
    expect(v.is_open).toBe(true);
    expect(v.rent_impairing).toBe(false);
    expect(v.description).toContain("MICE");

    // Detail query shape: exact house number, boro text, street substring, ordered.
    expect(urlOf(1).pathname).toContain("wvxf-dwi5.json");
    const w = whereOf(1);
    expect(w).toContain("upper(housenumber)='1520'");
    expect(w).toContain("boro='BRONX'");
    expect(w).toContain("upper(streetname) like '%SEDGWICK AVENUE%'");
    expect(urlOf(1).searchParams.get("$order")).toBe("inspectiondate DESC");
  });

  it("applies open_only, class, and since filters to the query", async () => {
    fetchMock.mockResolvedValue(jsonResponse([])); // both calls
    await call("building_violations", {
      house_number: "1520",
      street: "Sedgwick Avenue",
      borough: "BX",
      open_only: true,
      violation_class: "c",
      since: "2026-01-01",
    });
    const w = whereOf(0);
    expect(w).toContain("upper(violationstatus)='OPEN'");
    expect(w).toContain("upper(class)='C'");
    expect(w).toContain("inspectiondate >= '2026-01-01T00:00:00'");
  });

  it("handles a building with no violations cleanly", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const body = payload(await call("building_violations", { house_number: "1", street: "Nowhere St", borough: "Queens" }));
    expect(body.summary.total_matching).toBe(0);
    expect(body.returned).toBe(0);
    expect(body.results).toEqual([]);
  });

  it("errors (no network) when a required address part is missing", async () => {
    const res: any = await call("building_violations", { house_number: "1520", borough: "Bronx" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/street is required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed since date without calling the API", async () => {
    const res: any = await call("building_violations", { house_number: "1", street: "X", borough: "Bronx", since: "01/2026" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/YYYY-MM-DD/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A tool call with the city-wide "NYC"/"NY" must error, not silently query
  // Manhattan and report it as if it were the whole city.
  it("does not silently treat NYC/NY as Manhattan; errors before any network call", async () => {
    for (const borough of ["NYC", "NY"]) {
      const res: any = await call("building_violations", { house_number: "1520", street: "Sedgwick Avenue", borough });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/ambiguous|whole city/i);
      expect(res.content[0].text).not.toMatch(/MANHATTAN'/); // no silent Manhattan substitution
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Queens hyphenated house numbers: HPD stores them hyphenated (e.g. "120-15");
// a user typing "12015" / "120 15" must be retried against the stored form
// instead of reading as a clean building.
// ---------------------------------------------------------------------------

describe("house-number hyphenation (Queens silent-zero)", () => {
  it("houseNumberVariants: hyphenates plain Queens digits before the last two", () => {
    // Queens (hyphenateDigits): plain "12015" -> also try "120-15".
    expect(__test.houseNumberVariants("12015", { hyphenateDigits: true })).toEqual(["12015", "120-15"]);
    // Spaced/hyphenated input normalizes across separators regardless of borough.
    expect(__test.houseNumberVariants("120 15")).toEqual(["120 15", "120-15", "12015"]);
    expect(__test.houseNumberVariants("120-15")).toEqual(["120-15", "12015"]);
    // Non-Queens plain digits are left alone (no spurious "15-20" for "1520").
    expect(__test.houseNumberVariants("1520")).toEqual(["1520"]);
    expect(__test.houseNumberVariants("1520", { hyphenateDigits: true })).toEqual(["1520", "15-20"]);
  });

  it("building_violations retries a de-hyphenated Queens number and finds the building", async () => {
    // Literal "12015" summary returns empty (silent zero) ...
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    // ... retry with the stored "120-15" hits the summary ...
    fetchMock.mockResolvedValueOnce(jsonResponse(QUEENS_VIOLATION_SUMMARY));
    // ... then the detail page is fetched with the matched spelling.
    fetchMock.mockResolvedValueOnce(jsonResponse([QUEENS_VIOLATION_ROW]));

    const body = payload(await call("building_violations", { house_number: "12015", street: "Example Street", borough: "Queens" }));

    // Not a silent zero: it found the real building's 13 violations.
    expect(body.summary.total_matching).toBe(13);
    expect(body.summary.by_class).toEqual({ A: 4, B: 9 });
    expect(body.returned).toBe(1);
    // The detail query used the stored hyphenated house number.
    expect(whereOf(2)).toContain("upper(housenumber)='120-15'");
    // The response surfaces the correction to the caller.
    expect(body.query.house_number).toBe("120-15");
    expect(body.query.house_number_searched).toBe("12015");
    expect(body.note).toMatch(/120-15|hyphenat/i);
  });

  it("building_violations reports zero when no variant matches", async () => {
    // Both the literal and the hyphenated variant return empty.
    fetchMock.mockResolvedValue(jsonResponse([]));
    const body = payload(await call("building_violations", { house_number: "99999", street: "Nowhere Street", borough: "Queens" }));
    expect(body.summary.total_matching).toBe(0);
    expect(body.returned).toBe(0);
    // Two summary probes ("99999" then "999-99"); no detail call on a true zero.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Echoes what the user searched (no phantom correction).
    expect(body.query.house_number).toBe("99999");
    expect(body.query.house_number_searched).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// building_complaints
// ---------------------------------------------------------------------------

describe("building_complaints", () => {
  it("returns an open/closed summary plus normalized problems", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(COMPLAINT_SUMMARY));
    fetchMock.mockResolvedValueOnce(jsonResponse([COMPLAINT_ROW]));
    const body = payload(await call("building_complaints", { house_number: "1520", street: "Sedgwick Avenue", borough: "Bronx" }));

    expect(body.summary.total_matching).toBe(128);
    expect(body.summary.by_status).toEqual({ CLOSE: 120, OPEN: 8 });
    const c = body.results[0];
    expect(c.complaint_id).toBe("14863019");
    expect(c.major_category).toBe("HEAT/HOT WATER");
    expect(c.complaint_status).toBe("OPEN");
    // Complaints dataset uses house_number / street_name / borough columns.
    const w = whereOf(1);
    expect(w).toContain("upper(house_number)='1520'");
    expect(w).toContain("borough='BRONX'");
    expect(w).toContain("upper(street_name) like '%SEDGWICK AVENUE%'");
  });

  it("adds the open filter when open_only is set", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await call("building_complaints", { house_number: "1520", street: "Sedgwick", borough: "Bronx", open_only: true });
    expect(whereOf(0)).toContain("upper(complaint_status)='OPEN'");
  });
});

// ---------------------------------------------------------------------------
// who_owns
// ---------------------------------------------------------------------------

describe("who_owns", () => {
  it("joins registration to contacts and groups them by type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([REGISTRATION_ROW])); // registrations
    fetchMock.mockResolvedValueOnce(jsonResponse(CONTACT_ROWS)); // contacts
    const body = payload(await call("who_owns", { house_number: "1520", street: "Sedgwick Avenue", borough: "Bronx" }));

    expect(body.found).toBe(true);
    expect(body.registrations[0].registration_id).toBe("221729");
    expect(body.registrations[0].building_address).toBe("1520 SEDGWICK AVENUE");
    expect(body.contacts).toHaveLength(3);
    expect(Object.keys(body.contacts_by_type).sort()).toEqual(["Agent", "CorporateOwner", "SiteManager"]);
    expect(body.contacts_by_type.CorporateOwner[0].organization).toBe("WFHA 1520 SEDGWICK LP");
    expect(body.contacts_by_type.Agent[0].person_name).toBe("DANA REYES");
    expect(body.contacts_by_type.CorporateOwner[0].business_address).toBe("43-55 11TH STREET, LIC NY 11101");

    // Contacts fetched via IN() on the numeric registrationid.
    expect(whereOf(1)).toBe("registrationid in (221729)");
  });

  it("returns found:false and skips the contacts call when no registration matches", async () => {
    // Queens "9999" probes the literal then the hyphenated "99-99"; both empty,
    // so no contacts call follows (2 registration probes, 0 contact fetches).
    fetchMock.mockResolvedValue(jsonResponse([]));
    const body = payload(await call("who_owns", { house_number: "9999", street: "Nowhere", borough: "Queens" }));
    expect(body.found).toBe(false);
    expect(body.contacts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// landlord_portfolio (reverse who_owns: name -> contacts -> registrations)
// ---------------------------------------------------------------------------

describe("landlord_portfolio", () => {
  it("contactNameWhere ORs corporation, first, last, and full-name clauses (unit)", () => {
    expect(__test.contactNameWhere("O'Brien")).toBe(
      "(upper(corporationname) like '%O''BRIEN%'" +
        " OR upper(firstname) like '%O''BRIEN%'" +
        " OR upper(lastname) like '%O''BRIEN%'" +
        " OR upper(firstname || ' ' || lastname) like '%O''BRIEN%')",
    );
  });

  it("resolves a corporation name to every building it is registered under", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "2" }])); // contact count
    fetchMock.mockResolvedValueOnce(jsonResponse(PORTFOLIO_CONTACT_MATCHES)); // contact scan
    fetchMock.mockResolvedValueOnce(jsonResponse([REGISTRATION_ROW, PORTFOLIO_REGISTRATION_ROW_2])); // registrations
    const body = payload(await call("landlord_portfolio", { name: "WFHA 1520 Sedgwick" }));

    // Count and scan share the same name clause; the scan is capped + ordered.
    const w = whereOf(0);
    expect(urlOf(0).pathname).toContain("feu5-w2e2.json");
    expect(urlOf(0).searchParams.get("$select")).toBe("count(1) as n");
    expect(w).toContain("upper(corporationname) like '%WFHA 1520 SEDGWICK%'");
    expect(w).toContain("upper(firstname || ' ' || lastname) like '%WFHA 1520 SEDGWICK%'");
    expect(whereOf(1)).toBe(w);
    expect(urlOf(1).searchParams.get("$limit")).toBe("1000");
    expect(urlOf(1).searchParams.get("$order")).toBe("registrationid");
    // Registrations resolved by IN() on the deduped numeric ids.
    expect(urlOf(2).pathname).toContain("tesw-yqqr.json");
    expect(whereOf(2)).toBe("registrationid in (221729,330001)");

    expect(body.found).toBe(true);
    expect(body.summary).toEqual({ contact_matches: 2, distinct_registrations: 2, buildings_found: 2 });
    expect(body.returned).toBe(2);
    // Sorted for reading: borough, then address (BRONX before QUEENS).
    expect(body.buildings[0].building_address).toBe("1520 SEDGWICK AVENUE");
    expect(body.buildings[0].borough).toBe("BRONX");
    expect(body.buildings[1].building_address).toBe("120-15 EXAMPLE STREET");
    // Each building lists the contact(s) that matched.
    expect(body.buildings[0].matched_contacts).toEqual([
      { type: "CorporateOwner", organization: "WFHA 1520 SEDGWICK LP", person_name: null },
    ]);
  });

  it("matches a full person name via the first/last concatenation", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "1" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse([CONTACT_ROWS[1]])); // Agent DANA REYES @ 221729
    fetchMock.mockResolvedValueOnce(jsonResponse([REGISTRATION_ROW]));
    const body = payload(await call("landlord_portfolio", { name: "Dana Reyes" }));
    expect(whereOf(0)).toContain("upper(firstname || ' ' || lastname) like '%DANA REYES%'");
    expect(body.found).toBe(true);
    expect(body.buildings[0].matched_contacts[0].person_name).toBe("DANA REYES");
    expect(body.buildings[0].matched_contacts[0].type).toBe("Agent");
  });

  it("dedupes multiple matching contacts on one registration into one building", async () => {
    const officerRow = {
      registrationcontactid: "22172999",
      registrationid: "221729",
      type: "Officer",
      corporationname: "WFHA 1520 SEDGWICK LP",
      firstname: "MARCO",
      lastname: "OKONJO",
    };
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "2" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse([PORTFOLIO_CONTACT_MATCHES[0], officerRow]));
    fetchMock.mockResolvedValueOnce(jsonResponse([REGISTRATION_ROW]));
    const body = payload(await call("landlord_portfolio", { name: "WFHA" }));
    // One building, its id queried once, with both matching roles listed.
    expect(whereOf(2)).toBe("registrationid in (221729)");
    expect(body.summary).toEqual({ contact_matches: 2, distinct_registrations: 1, buildings_found: 1 });
    expect(body.buildings).toHaveLength(1);
    expect(body.buildings[0].matched_contacts).toHaveLength(2);
  });

  it("escapes LIKE wildcards in the name (no silent match-widening)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "0" }]));
    const body = payload(await call("landlord_portfolio", { name: "100%_MGMT" }));
    expect(whereOf(0)).toContain("upper(corporationname) like '%100\\%\\_MGMT%'");
    expect(body.found).toBe(false);
  });

  it("returns guidance on an empty result instead of a bare zero", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "0" }]));
    const body = payload(await call("landlord_portfolio", { name: "ZZZ NO SUCH OWNER" }));
    expect(body.found).toBe(false);
    expect(body.buildings).toEqual([]);
    expect(body.note).toMatch(/UPPERCASE/);
    expect(body.note).toMatch(/who_owns/);
    // The count probe is the only call; no scan or registration fetch on zero.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies the borough filter to the registration lookup and reports the city-wide count", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "2" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(PORTFOLIO_CONTACT_MATCHES));
    fetchMock.mockResolvedValueOnce(jsonResponse([REGISTRATION_ROW])); // only the Bronx building
    const body = payload(await call("landlord_portfolio", { name: "WFHA 1520 Sedgwick", borough: "bx" }));
    const w = whereOf(2);
    expect(w).toContain("registrationid in (221729,330001)");
    expect(w).toContain("boro='BRONX'");
    expect(body.query.borough).toBe("BRONX");
    expect(body.summary).toEqual({ contact_matches: 2, distinct_registrations: 2, buildings_found: 1 });
    expect(body.note).toMatch(/city-wide; 1 in BRONX/);
  });

  it("notes when the borough filter empties the portfolio", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "2" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(PORTFOLIO_CONTACT_MATCHES));
    fetchMock.mockResolvedValueOnce(jsonResponse([])); // nothing in Staten Island
    const body = payload(await call("landlord_portfolio", { name: "WFHA 1520 Sedgwick", borough: "SI" }));
    expect(body.found).toBe(false);
    expect(body.summary.distinct_registrations).toBe(2);
    expect(body.note).toMatch(/STATEN ISLAND/);
    expect(body.note).toMatch(/[Dd]rop the borough filter/);
  });

  it("reports Showing N of M when the page is capped", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "2" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(PORTFOLIO_CONTACT_MATCHES));
    fetchMock.mockResolvedValueOnce(jsonResponse([REGISTRATION_ROW, PORTFOLIO_REGISTRATION_ROW_2]));
    const body = payload(await call("landlord_portfolio", { name: "WFHA 1520 Sedgwick", limit: 1 }));
    expect(body.summary.buildings_found).toBe(2);
    expect(body.returned).toBe(1);
    expect(body.buildings).toHaveLength(1);
    expect(body.note).toMatch(/Showing 1 of 2/);
  });

  it("notes when the contact scan was capped (more matches than scanned)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "1500" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(PORTFOLIO_CONTACT_MATCHES)); // page smaller than total
    fetchMock.mockResolvedValueOnce(jsonResponse([REGISTRATION_ROW, PORTFOLIO_REGISTRATION_ROW_2]));
    const body = payload(await call("landlord_portfolio", { name: "MANAGEMENT" }));
    expect(body.summary.contact_matches).toBe(1500);
    expect(body.note).toMatch(/1500 contact/);
    expect(body.note).toMatch(/scanned/i);
    expect(body.note).toMatch(/incomplete|more specific/i);
  });

  it("chunks large registration-id sets into multiple IN() queries", async () => {
    const manyContacts = Array.from({ length: 150 }, (_, i) => ({
      registrationcontactid: String(90000000 + i),
      registrationid: String(400000 + i),
      type: "CorporateOwner",
      corporationname: "MEGA HOLDINGS LLC",
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse([{ n: "150" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(manyContacts));
    fetchMock.mockResolvedValueOnce(jsonResponse([])); // chunk 1: ids 400000..400099, none current
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ ...PORTFOLIO_REGISTRATION_ROW_2, registrationid: "400100" }]), // chunk 2 hit
    );
    const body = payload(await call("landlord_portfolio", { name: "Mega Holdings" }));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const ids1 = whereOf(2).match(/registrationid in \(([^)]+)\)/)?.[1]?.split(",") ?? [];
    const ids2 = whereOf(3).match(/registrationid in \(([^)]+)\)/)?.[1]?.split(",") ?? [];
    expect(ids1).toHaveLength(100);
    expect(ids2).toHaveLength(50);
    expect(ids1[0]).toBe("400000");
    expect(ids2[0]).toBe("400100");
    expect(body.summary).toEqual({ contact_matches: 150, distinct_registrations: 150, buildings_found: 1 });
    expect(body.buildings[0].registration_id).toBe("400100");
  });

  it("requires a name (error, no network)", async () => {
    const res: any = await call("landlord_portfolio", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/name is required/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// landlord_litigation
// ---------------------------------------------------------------------------

describe("landlord_litigation", () => {
  it("searches by respondent name and normalizes penalty / harassment fields", async () => {
    // Two queries: a server-side $group summary, then the detail page.
    fetchMock.mockResolvedValueOnce(jsonResponse([{ casestatus: "CLOSED", n: "1" }, { casestatus: "OPEN", n: "1" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(LITIGATION_ROWS));
    const body = payload(await call("landlord_litigation", { respondent: "realty llc" }));
    expect(whereOf(0)).toContain("upper(respondent) like '%REALTY LLC%'");
    expect(body.returned).toBe(2);
    expect(body.summary.by_status).toEqual({ CLOSED: 1, OPEN: 1 });
    const withFinding = body.results.find((r: any) => r.finding_of_harassment === "Yes");
    expect(withFinding.penalty).toBe("1000");
    expect(withFinding.respondent).toBe("2084 CRESTON AVENUE REALTY LLC");
  });

  // The by-status summary must be a server-side $group over ALL matches,
  // not a tally of the returned page (which is capped at `limit`).
  it("summarizes case status server-side over all matches, not just the returned page", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ casestatus: "CLOSED", n: "200" }, { casestatus: "OPEN", n: "50" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse(LITIGATION_ROWS)); // only 2 rows on the page
    const body = payload(await call("landlord_litigation", { respondent: "realty", limit: 2 }));
    // The summary query uses $group + count(1), like building_violations.
    expect(urlOf(0).searchParams.get("$group")).toBe("casestatus");
    expect(urlOf(0).searchParams.get("$select")).toContain("count(1)");
    // Counts reflect all 250 matches even though only 2 rows were returned.
    expect(body.summary.total_matching).toBe(250);
    expect(body.summary.by_status).toEqual({ CLOSED: 200, OPEN: 50 });
    expect(body.returned).toBe(2);
  });

  it("searches by building using the numeric boroid", async () => {
    // Summary $group (which also probes house-number variants) then detail.
    fetchMock.mockResolvedValueOnce(jsonResponse([{ casestatus: "CLOSED", n: "1" }]));
    fetchMock.mockResolvedValueOnce(jsonResponse([LITIGATION_ROWS[0]]));
    const body = payload(await call("landlord_litigation", { house_number: "1694", street: "Walton Avenue", borough: "Bronx" }));
    const w = whereOf(0);
    expect(w).toContain("upper(housenumber)='1694'");
    expect(w).toContain("boroid=2");
    expect(w).toContain("upper(streetname) like '%WALTON AVENUE%'");
    expect(body.results[0].litigation_id).toBe("75707");
  });

  it("requires a building or a respondent (error, no network)", async () => {
    const res: any = await call("landlord_litigation", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/building.*or.*respondent/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a partial building lookup (house number without street)", async () => {
    const res: any = await call("landlord_litigation", { house_number: "1694", borough: "Bronx" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/house_number, street, and borough/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// eviction_lookup
// ---------------------------------------------------------------------------

describe("eviction_lookup", () => {
  it("looks up by exact court index number", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([EVICTION_ROW]));
    const body = payload(await call("eviction_lookup", { court_index_number: "123456/24" }));
    expect(whereOf(0)).toBe("court_index_number='123456/24'");
    const e = body.results[0];
    expect(e.court_index_number).toBe("123456/24");
    expect(e.marshal_name).toBe("Jordan Marshal");
    expect(e.residential_or_commercial).toBe("Residential");
    expect(body.note).toMatch(/Marshal-executed evictions only/i);
  });

  it("expands the borough filter to all eviction aliases", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([EVICTION_ROW]));
    await call("eviction_lookup", { borough: "Brooklyn", limit: 5 });
    expect(whereOf(0)).toContain("borough in ('BROOKLYN','KINGS')");
    expect(lastUrl().searchParams.get("$order")).toBe("executed_date DESC");
  });

  it("requires at least one selector (error, no network)", async () => {
    const res: any = await call("eviction_lookup", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/court_index_number, address, or borough/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Transport-level behavior: token header, HTTP + non-JSON errors, unknown tool
// ---------------------------------------------------------------------------

describe("app token + error handling", () => {
  it("omits X-App-Token by default and sends it when NYC_APP_TOKEN is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([EVICTION_ROW]));
    await call("eviction_lookup", { court_index_number: "123456/24" });
    expect(lastInit().headers["X-App-Token"]).toBeUndefined();

    process.env.NYC_APP_TOKEN = "tok_abc";
    fetchMock.mockResolvedValueOnce(jsonResponse([EVICTION_ROW]));
    await call("eviction_lookup", { court_index_number: "123456/24" });
    expect(lastInit().headers["X-App-Token"]).toBe("tok_abc");
  });

  it("identifies itself to NYC Open Data with a descriptive User-Agent", async () => {
    // Socrata is a free public service and rate-limits anonymous clients harder.
    // A missing UA is invisible to every other assertion in this file, which is
    // how the sibling wagewatch server shipped without one until 2026-07-29.
    fetchMock.mockResolvedValueOnce(jsonResponse([EVICTION_ROW]));
    await call("eviction_lookup", { court_index_number: "123456/24" });
    expect(lastInit().headers["User-Agent"]).toMatch(/^mcp-nychousing\/\d/);
  });

  it("surfaces an HTTP 500 (with the SODA message) as isError", async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(JSON.stringify({ error: true, message: "boom" }), { ok: false, status: 500 }),
    );
    const res: any = await call("eviction_lookup", { borough: "Bronx" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("500");
    expect(res.content[0].text).toContain("boom");
  });

  it("surfaces a non-JSON (HTML) response as isError", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("<html>maintenance</html>"));
    const res: any = await call("eviction_lookup", { borough: "Bronx" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("non-JSON");
  });

  it("rejects an unknown tool with a protocol error", async () => {
    await expect(call("does_not_exist", {})).rejects.toThrow();
  });

  it("issues each request with an AbortSignal timeout", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([EVICTION_ROW]));
    await call("eviction_lookup", { court_index_number: "123456/24" });
    const init = fetchMock.mock.calls.at(-1)?.[1] as { signal?: unknown };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// SPEC no-implied-outcome — operator-authored 2026-07-29
// ---------------------------------------------------------------------------

describe("SPEC no-implied-outcome", () => {
  // spec: no-implied-outcome
  // Given HPD litigation records and the marshal-executed eviction dataset
  // When either is returned
  // Then the result says what the record does and does not establish, so no
  //      reader concludes a case was won, lost, or justified from a status code.
  // Operator's stated worst failure for this server: "it implies a case outcome."
  it("litigation results state that a status code is not an outcome", async () => {
    fetchMock.mockResolvedValue(jsonResponse(LITIGATION_ROWS));
    const body = payload(await call("landlord_litigation", { respondent: "realty llc" }));
    expect(body).toHaveProperty("record_scope");
    const note = String(body.record_scope).toLowerCase();
    expect(note).toContain("not");
    expect(note).toContain("outcome");
  });

  it("eviction results state that the dataset is executed-only", async () => {
    // The single most available wrong inference: no row means no eviction was
    // ever filed. It does not. This dataset begins at marshal execution.
    fetchMock.mockResolvedValue(jsonResponse([EVICTION_ROW]));
    const body = payload(await call("eviction_lookup", { borough: "MANHATTAN" }));
    expect(body).toHaveProperty("record_scope");
    expect(String(body.record_scope).toLowerCase()).toContain("marshal");
  });

  it("an empty result still carries the scope note", async () => {
    // An empty answer is where a reader is MOST likely to infer "clean record",
    // so this is the case that must never ship the note-less shape.
    fetchMock.mockResolvedValue(jsonResponse([]));
    const body = payload(await call("landlord_litigation", { respondent: "nobody" }));
    expect(body).toHaveProperty("record_scope");
  });
});

// ---------------------------------------------------------------------------
// 1.1.0 tools: building_profile, true_owner, dob_building, building_311
// ---------------------------------------------------------------------------

const PLUTO_ROW = {
  address: "1520 SEDGWICK AVENUE",
  bbl: "2032870050.00000000",
  block: "3287",
  lot: "50",
  ownername: "WFHA 1520 SEDGWICK LP",
  bldgclass: "D3",
  landuse: "03",
  unitsres: "120",
  unitstotal: "121",
  yearbuilt: "1968",
  numfloors: "10",
  zipcode: "10453",
};
const ACRIS_LEGAL_ROWS = [{ document_id: "2019010100001001" }, { document_id: "2015060900002001" }];
const ACRIS_MASTER_ROWS = [
  {
    document_id: "2019010100001001",
    doc_type: "DEED",
    document_date: "2018-12-20T00:00:00.000",
    recorded_datetime: "2019-01-01T00:00:00.000",
    document_amt: "12500000",
    percent_trans: "100",
  },
];
const ACRIS_PARTY_ROWS = [
  { document_id: "2019010100001001", party_type: "1", name: "OLD OWNER LLC" },
  { document_id: "2019010100001001", party_type: "2", name: "WFHA 1520 SEDGWICK LP" },
];
const SPEC_ROW = {
  bbl: "2032870050",
  hnum_lo: "1520",
  str_name: "SEDGWICK AVENUE",
  grantee: "WFHA 1520 SEDGWICK LP",
  deed_date: "2019-01-01T00:00:00.000",
  price: "12500000",
  cap_rate: "0.01",
  borough_cap_rate: "0.05",
  block: "3287",
  lot: "50",
};

describe("true_owner", () => {
  it("chains PLUTO -> ACRIS legals -> master -> parties -> speculation and labels the roles", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([PLUTO_ROW]))
      .mockResolvedValueOnce(jsonResponse(ACRIS_LEGAL_ROWS))
      .mockResolvedValueOnce(jsonResponse(ACRIS_MASTER_ROWS))
      .mockResolvedValueOnce(jsonResponse(ACRIS_PARTY_ROWS))
      .mockResolvedValueOnce(jsonResponse([SPEC_ROW]));
    const body = payload(await call("true_owner", { house_number: "1520", street: "Sedgwick Avenue", borough: "Bronx" }));

    expect(body.found).toBe(true);
    expect(body.assessor_owner).toBe("WFHA 1520 SEDGWICK LP");
    // PLUTO is queried with the 2-letter borough code and a combined-address LIKE.
    expect(urlOf(0).pathname).toContain("64uk-42ks.json");
    expect(whereOf(0)).toContain("borough='BX'");
    expect(whereOf(0)).toContain("upper(address) like '%1520 SEDGWICK AVENUE%'");
    // ACRIS legals by borough/block/lot as quoted text.
    expect(urlOf(1).pathname).toContain("8h5j-fqxa.json");
    expect(whereOf(1)).toContain("borough='2'");
    expect(whereOf(1)).toContain("block='3287'");
    // The deed's parties are attached with their role semantics.
    expect(body.acris_documents).toHaveLength(1);
    expect(body.acris_documents[0].doc_type).toBe("DEED");
    expect(body.acris_documents[0].party_1).toEqual(["OLD OWNER LLC"]);
    expect(body.acris_documents[0].party_2).toEqual(["WFHA 1520 SEDGWICK LP"]);
    expect(body.speculation_watch).toHaveLength(1);
    expect(body).toHaveProperty("record_scope");
  });

  it("Staten Island skips ACRIS entirely and says why", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ ...PLUTO_ROW, bbl: "5012340001.00000000" }]))
      .mockResolvedValue(jsonResponse([]));
    const body = payload(await call("true_owner", { house_number: "100", street: "Bay Street", borough: "SI" }));
    expect(body.found).toBe(true);
    expect(String(body.acris_note)).toContain("Richmond County Clerk");
    expect(body.acris_documents).toEqual([]);
    // No ACRIS dataset may be queried for SI.
    const paths = fetchMock.mock.calls.map((c: unknown[]) => (c[0] as URL).pathname);
    expect(paths.some((p: string) => p.includes("8h5j-fqxa") || p.includes("bnx9-e6tj"))).toBe(false);
  });

  it("a miss explains the combined-address format instead of a bare empty", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const body = payload(await call("true_owner", { house_number: "1", street: "Nowhere", borough: "Bronx" }));
    expect(body.found).toBe(false);
    expect(String(body.note)).toContain("PLUTO");
  });
});

describe("building_profile", () => {
  it("aggregates the nine sections from one resolved address", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([REGISTRATION_ROW])) // resolveBuilding: registrations
      .mockResolvedValueOnce(jsonResponse(CONTACT_ROWS)) // contacts
      .mockResolvedValueOnce(jsonResponse(VIOLATION_SUMMARY)) // violations by class
      .mockResolvedValueOnce(jsonResponse(COMPLAINT_SUMMARY)) // complaints by status
      .mockResolvedValueOnce(jsonResponse([{ casestatus: "CLOSED", n: "2" }])) // litigation
      .mockResolvedValueOnce(jsonResponse([{ n: "3" }])) // evictions count
      .mockResolvedValueOnce(jsonResponse([])) // aep
      .mockResolvedValueOnce(jsonResponse([])) // vacate
      .mockResolvedValueOnce(jsonResponse([])) // bedbug
      .mockResolvedValueOnce(jsonResponse([{ n: "7" }])); // hwo
    const body = payload(await call("building_profile", { house_number: "1520", street: "Sedgwick Avenue", borough: "Bronx" }));

    expect(body.registered_with_hpd).toBe(true);
    expect(body.hpd_violations.total).toBe(1036);
    expect(body.hpd_violations.by_class.C).toBe(281);
    expect(body.hpd_complaints.by_status.OPEN).toBe(8);
    expect(body.hpd_litigation.total).toBe(2);
    expect(body.evictions_executed).toBe(3);
    expect(body.emergency_repair_charges).toBe(7);
    expect(body.aep.in_program_history).toBe(false);
    expect(body).toHaveProperty("record_scope");
    expect(String(body.next_steps)).toContain("true_owner");
  });

  it("profile scope says zero is not a clean bill", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const body = payload(await call("building_profile", { house_number: "9", street: "Empty St", borough: "Queens" }));
    expect(String(body.record_scope)).toContain("not that nothing happened");
  });
});

describe("dob_building", () => {
  it("uses the numeric DOB borough code and the community-board prefix for complaints", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ violation_category: "V-DOB VIOLATION - ACTIVE", n: "4" }]))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            isn_dob_bis_viol: "1",
            number: "V123",
            issue_date: "20240105",
            violation_type_code: "LL6291",
            violation_category: "V-DOB VIOLATION - ACTIVE",
            description: "BOILER DEFECT",
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([{ status: "ACTIVE", n: "2" }]))
      .mockResolvedValueOnce(
        jsonResponse([
          { complaint_number: "5551", status: "ACTIVE", date_entered: "01/05/2024", complaint_category: "45", community_board: "205" },
        ]),
      );
    const body = payload(await call("dob_building", { house_number: "1520", street: "Sedgwick Avenue", borough: "Bronx" }));

    expect(whereOf(0)).toContain("boro='2'"); // numeric-as-text DOB code, not BRONX
    expect(whereOf(2)).toContain("starts_with(community_board, '2')");
    expect(body.violations.total_matching).toBe(4);
    expect(body.violations.results[0].description).toBe("BOILER DEFECT");
    expect(body.complaints.by_status.ACTIVE).toBe(2);
    expect(body).toHaveProperty("record_scope");
  });
});

describe("building_311", () => {
  it("defaults to the heat/hot-water types and returns newest-first with a status summary", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ status: "CLOSED", n: "11" }]))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            unique_key: "1",
            created_date: "2026-01-15T08:00:00",
            complaint_type: "HEAT/HOT WATER",
            descriptor: "ENTIRE BUILDING",
            status: "CLOSED",
            incident_address: "1520 SEDGWICK AVENUE",
          },
        ]),
      );
    const body = payload(await call("building_311", { address: "1520 Sedgwick Avenue", borough: "Bronx" }));

    expect(whereOf(0)).toContain("upper(complaint_type) in ('HEAT/HOT WATER','HEATING')");
    expect(whereOf(0)).toContain("upper(incident_address) like '%1520 SEDGWICK AVENUE%'");
    expect(urlOf(1).searchParams.get("$order")).toBe("created_date DESC");
    expect(body.summary.total_matching).toBe(11);
    expect(body.results[0].complaint_type).toBe("HEAT/HOT WATER");
    expect(body).toHaveProperty("record_scope");
  });

  it("an explicit complaint_type replaces the heat default and is escaped", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const body = payload(await call("building_311", { address: "1 Main St", borough: "Queens", complaint_type: "Rodent's" }));
    expect(whereOf(0)).toContain("upper(complaint_type)='RODENT''S'");
    expect(whereOf(0)).not.toContain("HEATING");
    expect(body.summary.total_matching).toBe(0);
    expect(String(body.note)).toContain("combined line");
  });
});



describe("ux fixes 1.1.1", () => {
  it("a zero-result building lookup names the tried variants and the substring trick", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const body = payload(await call("building_violations", { house_number: "120 15", street: "Sedgwich Av", borough: "Queens" }));
    expect(body.summary.total_matching).toBe(0);
    const note = String(body.note);
    expect(note).toContain("Tried house-number spellings:");
    expect(note).toContain("120-15"); // the variant it already tried, named
    expect(note).toContain("substring");
  });

  it("who_owns miss teaches the same rescues", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const body = payload(await call("who_owns", { house_number: "12015", street: "Queens Boulevard", borough: "Queens" }));
    expect(body.found).toBe(false);
    expect(String(body.note)).toContain("120-15");
    expect(String(body.note)).toContain("substring-matched");
  });

  it("true_owner chases the latest DEED when the newest documents hold none", async () => {
    const SUBM = { document_id: "2025081500001001", doc_type: "SUBM", recorded_datetime: "2025-08-15T00:00:00.000" };
    const DEED = { document_id: "2019010100001001", doc_type: "DEED", document_date: "2018-12-20T00:00:00.000", recorded_datetime: "2019-01-01T00:00:00.000", document_amt: "12500000" };
    fetchMock
      .mockResolvedValueOnce(jsonResponse([PLUTO_ROW])) // pluto
      .mockResolvedValueOnce(jsonResponse([{ document_id: "2025081500001001" }, { document_id: "2019010100001001" }])) // legals
      .mockResolvedValueOnce(jsonResponse([SUBM])) // newest N: no deed
      .mockResolvedValueOnce(jsonResponse([])) // parties for shown docs
      .mockResolvedValueOnce(jsonResponse([DEED])) // the deed chase
      .mockResolvedValueOnce(jsonResponse(ACRIS_PARTY_ROWS)) // deed parties
      .mockResolvedValueOnce(jsonResponse([])); // speculation
    const body = payload(await call("true_owner", { house_number: "1520", street: "Sedgwick Avenue", borough: "Bronx", docs_limit: 1 }));
    expect(body.latest_deed).not.toBeNull();
    expect(body.latest_deed.doc_type).toBe("DEED");
    expect(body.latest_deed.party_2).toEqual(["WFHA 1520 SEDGWICK LP"]);
    // The deed-chase where clause filters the doc family server-side.
    const deedCall = fetchMock.mock.calls.find((c: unknown[]) => String((c[0] as URL).searchParams.get("$where") ?? "").includes("doc_type like 'DEED%'"));
    expect(deedCall).toBeDefined();
  });
});
