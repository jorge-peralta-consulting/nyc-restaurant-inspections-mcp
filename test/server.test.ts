import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/server.ts", import.meta.url));

/** Start the real server over stdio, do the MCP handshake and list tools. No tool is called, so no network is used. */
test("the server starts over stdio and lists its four tools", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", serverPath], {
    env: { ...process.env, NYCRI_BASE_URL: "https://soda.invalid/resource/", NYCRI_APP_TOKEN: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const responses = new Map<number, any>();
    let buffer = "";
    const waitFor = (id: number) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no response for id ${id}`)), 15_000);
        const check = () => {
          if (responses.has(id)) { clearTimeout(timer); resolve(responses.get(id)); } else setTimeout(check, 20);
        };
        check();
      });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) { const message = JSON.parse(line); if (message.id !== undefined) responses.set(message.id, message); }
      }
    });
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    const init = await waitFor(1);
    assert.equal(init.result.serverInfo.name, "nyc-restaurant-inspections-mcp");
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await waitFor(2);
    const names = list.result.tools.map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(names, ["get_inspection_history", "grade_summary", "recent_critical_violations", "search_restaurants"]);
    for (const tool of list.result.tools) assert.equal(tool.annotations.readOnlyHint, true);
  } finally {
    child.kill();
  }
});
