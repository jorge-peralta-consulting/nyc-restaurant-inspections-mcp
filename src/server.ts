#!/usr/bin/env -S npx tsx
import { loadConfig, startStdioServer } from "./shared/index.ts";
import { DEFAULT_BASE_URL, NycRestaurantClient } from "./client.ts";
import { tools } from "./tools.ts";

// No key is required: NYC Open Data is public. NYCRI_APP_TOKEN only raises the rate limit.
const config = loadConfig({
  required: [],
  optional: { NYCRI_APP_TOKEN: "", NYCRI_BASE_URL: DEFAULT_BASE_URL, NYCRI_READ_ONLY: "0" },
});

const client = new NycRestaurantClient({ NYCRI_APP_TOKEN: config.NYCRI_APP_TOKEN, NYCRI_BASE_URL: config.NYCRI_BASE_URL });

await startStdioServer({
  name: "nyc-restaurant-inspections-mcp",
  version: "0.1.0",
  tools: tools(client),
  // Every tool here is read-only, so this hides nothing today; honoured for consistency with all connectors.
  readOnly: config.NYCRI_READ_ONLY === "1",
});
