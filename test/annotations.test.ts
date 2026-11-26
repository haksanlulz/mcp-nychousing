// MCP security audit 2026-11-25: no tool here declared annotations, which clients
// use to decide what to ask the person about. Every tool now declares all four
// hints, and this table is the spec: a new tool fails here until it is classified.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

const EXPECTED: Record<string, Record<string, boolean>> = {
  building_311: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  building_violations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  building_complaints: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  who_owns: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  landlord_portfolio: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  landlord_litigation: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  eviction_lookup: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  building_profile: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  true_owner: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  dob_building: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

describe("tool annotations", () => {
  it("every tool declares the hints in EXPECTED, and no tool is unclassified", async () => {
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const t of tools) {
      const a = t.annotations ?? {};
      for (const [k, v] of Object.entries(EXPECTED[t.name])) expect(a[k as keyof typeof a], `${t.name}.${k}`).toBe(v);
    }
  });
});
