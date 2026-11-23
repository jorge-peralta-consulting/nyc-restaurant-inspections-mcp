import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodRawShape } from "zod";
import { runTool, type ToolResult } from "./result.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  /** Zod shape of the tool's arguments. */
  input: ZodRawShape;
  /** True when the tool changes data in the client's system. */
  writes?: boolean;
  handler: (args: any) => Promise<unknown>;
}

export interface ConnectorDefinition {
  name: string;
  version: string;
  tools: ToolDefinition[];
  /** When true (set from <PREFIX>_READ_ONLY=1), tools marked `writes` are not registered. */
  readOnly?: boolean;
}

/** Build the MCP server for a connector. Exported separately so tests can inspect it. */
export function buildServer(definition: ConnectorDefinition): { server: McpServer; registered: string[] } {
  const server = new McpServer({ name: definition.name, version: definition.version });
  const registered: string[] = [];
  for (const tool of definition.tools) {
    if (definition.readOnly && tool.writes) continue;
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: { readOnlyHint: !tool.writes } },
      async (args: unknown): Promise<ToolResult> => runTool(() => tool.handler(args)),
    );
    registered.push(tool.name);
  }
  return { server, registered };
}

export async function startStdioServer(definition: ConnectorDefinition): Promise<void> {
  const { server } = buildServer(definition);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol; diagnostics go to stderr only.
  console.error(`${definition.name} ${definition.version} ready`);
}
