import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { loadConfig, type ServerConfig } from "./config.js";

type Transport = StreamableHTTPServerTransport;

interface RunningServer {
  app: ReturnType<typeof createMcpExpressApp>;
  config: ServerConfig;
}

function isAuthorized(req: Request, config: ServerConfig): boolean {
  if (!config.authToken) return true;

  const authorization = req.header("authorization");
  return authorization === `Bearer ${config.authToken}`;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function createMcpServer(config: ServerConfig): McpServer {
  const server = new McpServer({
    name: "pi-on-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "server_info",
    {
      title: "Server info",
      description: "Return basic information about this local pi-on-mcp server.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name: "pi-on-mcp",
              allowedRoots: config.allowedRoots,
              mutationToolsEnabled: false,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  return server;
}

export function createServer(config = loadConfig()): RunningServer {
  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: [config.host, "localhost", "127.0.0.1"],
  });
  const transports = new Map<string, Transport>();

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "pi-on-mcp" });
  });

  app.all("/mcp", async (req, res) => {
    if (!isAuthorized(req, config)) {
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    try {
      const sessionId = req.header("mcp-session-id");
      let transport: Transport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (req.method === "POST" && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
        };

        const server = createMcpServer(config);
        await server.connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    }
  });

  return { app, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, config } = createServer();
  app.listen(config.port, config.host, () => {
    console.log(`pi-on-mcp listening on http://${config.host}:${config.port}/mcp`);
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(config.authToken ? "auth: bearer token required" : "auth: disabled");
  });
}
