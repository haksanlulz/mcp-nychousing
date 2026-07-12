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
    firstname: "JOHN",
    lastname: "WARREN",
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
    firstname: "ANDRE",
    lastname: "PENNYE",
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
  it("lists exactly the five documented tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "building_complaints",
      "building_violations",
      "eviction_lookup",
      "landlord_litigation",
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
  it("escapes single quotes in a LIKE value (SoQL injection guard)", () => {
    expect(__test.likeCI("respondent", "O'Brien")).toBe("upper(respondent) like '%O''BRIEN%'");
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
    expect(body.contacts_by_type.Agent[0].person_name).toBe("JOHN WARREN");
    expect(body.contacts_by_type.CorporateOwner[0].business_address).toBe("43-55 11TH STREET, LIC NY 11101");

    // Contacts fetched via IN() on the numeric registrationid.
    expect(whereOf(1)).toBe("registrationid in (221729)");
  });

  it("returns found:false and skips the contacts call when no registration matches", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const body = payload(await call("who_owns", { house_number: "9999", street: "Nowhere", borough: "Queens" }));
    expect(body.found).toBe(false);
    expect(body.contacts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// landlord_litigation
// ---------------------------------------------------------------------------

describe("landlord_litigation", () => {
  it("searches by respondent name and normalizes penalty / harassment fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LITIGATION_ROWS));
    const body = payload(await call("landlord_litigation", { respondent: "realty llc" }));
    expect(whereOf(0)).toContain("upper(respondent) like '%REALTY LLC%'");
    expect(body.returned).toBe(2);
    expect(body.summary.by_status).toEqual({ CLOSED: 1, OPEN: 1 });
    const withFinding = body.results.find((r: any) => r.finding_of_harassment === "Yes");
    expect(withFinding.penalty).toBe("1000");
    expect(withFinding.respondent).toBe("2084 CRESTON AVENUE REALTY LLC");
  });

  it("searches by building using the numeric boroid", async () => {
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
});
