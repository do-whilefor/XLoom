// Real stdio protocol fixture. No Chrome, network, model or external target.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const server = new Server({ name: "chrome-fixture", version: "1" }, { capabilities: { tools: {} } });
const schema = { type: "object", properties: { value: { type: "string" } } };
const names = ["echo", "image", "structured", "large", "failure", "hang", "disconnect", "new_page"];
server.setRequestHandler(ListToolsRequestSchema, async request => ({
  tools: (request.params?.cursor ? names.slice(3) : names.slice(0, 3)).map(name => ({ name, description: `Fixture ${name}`, inputSchema: schema })),
  ...(!request.params?.cursor ? { nextCursor: "second" } : {}),
}));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name;
  if (name === "hang") return new Promise(() => {});
  if (name === "disconnect") process.exit(1);
  if (name === "image") return { content: [{ type: "image", data: "dGVzdA==", mimeType: "image/webp" }] };
  if (name === "structured") return { content: [], structuredContent: { answer: 42 } };
  if (name === "large") return { content: [{ type: "text", text: "x".repeat(30000) }] };
  return { content: [{ type: "text", text: name === "failure" ? "Fixture tool failed" : JSON.stringify(request.params.arguments) }], ...(name === "failure" ? { isError: true } : {}) };
});
await server.connect(new StdioServerTransport());
process.stdin.on("end", () => process.exit(0));
