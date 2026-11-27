import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ConfigError, HttpClient, HttpError, buildServer, loadConfig, redact, runTool } from "../src/shared/index.ts";

test("loadConfig returns required and optional values", () => {
  const config = loadConfig({ required: ["A_KEY"], optional: { A_URL: "https://x.example" } }, { A_KEY: " k1 " });
  assert.deepEqual(config, { A_KEY: "k1", A_URL: "https://x.example" });
});

test("loadConfig names missing variables without leaking values", () => {
  assert.throws(() => loadConfig({ required: ["A_KEY", "B_KEY"] }, { B_KEY: "secret-value" }), (error: Error) => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /A_KEY/);
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
});

test("redact removes secrets", () => {
  assert.equal(redact("token abcd1234 here", ["abcd1234"]), "token [redacted] here");
});

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status, headers: next.headers });
  };
  return { fetchImpl, calls };
}

test("HttpClient sends auth headers and query parameters", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { ok: true } }]);
  const client = new HttpClient({ baseUrl: "https://api.example/v1", headers: { Authorization: "Bearer k" }, fetch: fetchImpl });
  assert.deepEqual(await client.get("/items", { page: 2, skip: undefined }), { ok: true });
  assert.equal(calls[0]!.url, "https://api.example/v1/items?page=2");
  assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, "Bearer k");
});

test("HttpClient retries GET on 429 then succeeds", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 429 }, { status: 200, body: [1] }]);
  const client = new HttpClient({ baseUrl: "https://api.example", fetch: fetchImpl, sleep: async () => {} });
  assert.deepEqual(await client.get("/x"), [1]);
  assert.equal(calls.length, 2);
});

test("HttpClient does not retry POST and redacts secrets in errors", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 500, body: { echo: "Bearer topsecret" } }]);
  const client = new HttpClient({ baseUrl: "https://api.example", headers: { Authorization: "Bearer topsecret" }, fetch: fetchImpl, sleep: async () => {} });
  await assert.rejects(client.post("/x", {}), (error: Error) => {
    assert.ok(error instanceof HttpError);
    assert.doesNotMatch(error.message, /topsecret/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("runTool converts thrown errors into tool errors", async () => {
  const result = await runTool(async () => { throw new Error("boom"); });
  assert.equal(result.isError, true);
  assert.equal(result.content[0]!.text, "boom");
});

test("buildServer hides write tools in read-only mode", () => {
  const tools = [
    { name: "list_things", description: "List", input: {}, handler: async () => [] },
    { name: "create_thing", description: "Create", input: {}, writes: true, handler: async () => ({}) },
  ];
  assert.deepEqual(buildServer({ name: "t", version: "0", tools }).registered, ["list_things", "create_thing"]);
  assert.deepEqual(buildServer({ name: "t", version: "0", tools, readOnly: true }).registered, ["list_things"]);
});

test("buildServer publishes strict input schemas, applies defaults and strips unknown arguments", async () => {
  let received: unknown;
  const tools = [{
    name: "list_things",
    description: "List",
    input: {
      status: z.enum(["open", "closed"]).optional().describe("Status filter"),
      limit: z.number().int().min(1).max(100).default(25).describe("Maximum number"),
    },
    handler: async (args: unknown) => { received = args; return []; },
  }];
  const { server } = buildServer({ name: "t", version: "0", tools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools: listed } = await client.listTools();
    assert.deepEqual(listed[0]!.inputSchema, {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "closed"], description: "Status filter" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "Maximum number" },
      },
      additionalProperties: false,
    });
    const result = await client.callTool({ name: "list_things", arguments: { status: "open", unknown: 1 } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(received, { status: "open", limit: 25 });
    const invalid = await client.callTool({ name: "list_things", arguments: { limit: 101 } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});
