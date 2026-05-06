import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import type { AppContext, BaseEnv } from '../types.js';

export interface McpServerOptions<TEnv extends BaseEnv> {
  name: string;
  version: string;
  register: (server: McpServer, ctx: AppContext<TEnv>) => void;
  ctx: AppContext<TEnv>;
}

export function createMcpServer<TEnv extends BaseEnv>(options: McpServerOptions<TEnv>): McpServer {
  const server = new McpServer({ name: options.name, version: options.version });
  options.register(server, options.ctx);
  return server;
}

export function createMcpHandler<TEnv extends BaseEnv>(options: {
  name: string;
  version: string;
  register: (server: McpServer, ctx: AppContext<TEnv>) => void;
  ctx: AppContext<TEnv>;
}) {
  return async (c: Context): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createMcpServer(options);
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
}
