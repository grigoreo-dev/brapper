import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Hono } from 'hono';
import type { Logger } from 'pino';
import type { BrowserSession } from './browser/BrowserSession.js';

export interface BaseEnv {
  PORT: number;
  HOST: string;
  NODE_ENV: string;
  AUTH_TOKEN?: string | undefined;
  BROWSER_WS_ENDPOINT?: string | undefined;
  BROWSER_ENDPOINT?: string | undefined;
  LOG_LEVEL?: string | undefined;
}

export interface AppContext<TEnv extends BaseEnv = BaseEnv> {
  env: TEnv;
  session: BrowserSession | null;
  logger: Logger;
}

export interface BrapOptions<TEnv extends BaseEnv> {
  env: TEnv;
  routes: (app: Hono, ctx: AppContext<TEnv>) => void;
  mcpTools?: ((server: McpServer, ctx: AppContext<TEnv>) => void) | undefined;
  cookiesPath?: string;
  warmUp?: ((session: BrowserSession, env: TEnv) => Promise<void>) | undefined;
  // sessionConcurrency — proper semaphore pool coming in v0.2; disabled for now
}
