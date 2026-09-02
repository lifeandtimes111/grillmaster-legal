/**
 * The shape the Agent SDK expects back from a tool handler. Declared here
 * rather than imported, so we don't depend on the MCP SDK's module layout.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  // The SDK's result type is an open object, so match it to stay assignable.
  [key: string]: unknown;
}

/** A plain text tool result. */
export function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] };
}

/**
 * A failed tool result. Returning this rather than throwing lets us compose the
 * message Claude reads, so it can recover instead of seeing a bare stack trace.
 */
export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wrap a handler so integration errors reach Claude as actionable text. */
export function guarded<A>(
  label: string,
  handler: (args: A) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail(`${label} failed: ${message}`);
    }
  };
}
