/** The shape MCP tools return. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a tool body and turn any thrown error into a readable tool error instead of crashing the server. */
export async function runTool(body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await body());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
