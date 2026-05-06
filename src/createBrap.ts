import { serve } from '@hono/node-server';
import { BrowserSession } from './browser/BrowserSession.js';
import { resolveBrowserWsEndpoint } from './config/parseEnv.js';
import { createApp } from './http/createApp.js';
import { createLogger } from './logging/createLogger.js';
import { createMcpHandler } from './mcp/createMcpServer.js';
import type { AppContext, BaseEnv, BrapOptions } from './types.js';

export async function createBrap<TEnv extends BaseEnv>(
  options: BrapOptions<TEnv>,
): Promise<{ start: () => Promise<void> }> {
  const { env, routes, mcpTools, cookiesPath, warmUp } = options;

  const logger = createLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');

  const wsEndpoint = await resolveBrowserWsEndpoint(env.BROWSER_WS_ENDPOINT, env.BROWSER_ENDPOINT);

  if (!wsEndpoint) {
    throw new Error('No browser endpoint provided — set BROWSER_WS_ENDPOINT or BROWSER_ENDPOINT');
  }

  const session = new BrowserSession({ wsEndpoint, logger });
  await session.connect();

  if (cookiesPath) {
    const count = await session.applyCookies(cookiesPath);
    logger.info({ count, path: cookiesPath }, 'Cookies loaded');
  }

  const ctx: AppContext<TEnv> = { env, session, logger };

  if (warmUp) {
    logger.info('Running warm-up...');
    await warmUp(session, env);
    session.setWarm(true);
    logger.info('Warm-up complete');
  }

  const app = createApp({
    logger,
    session,
    auth: { token: env.AUTH_TOKEN },
  });

  routes(app, ctx);

  if (mcpTools) {
    const envRecord = env as Record<string, unknown>;
    const name = (envRecord.npm_package_name as string) ?? 'brapper-app';
    const version = (envRecord.npm_package_version as string) ?? '0.0.0';
    app.all('/mcp', createMcpHandler({ name, version, register: mcpTools, ctx }));
  }

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
        logger.info({ port: info.port, host: info.address }, 'Server started');
      });

      const shutdown = async () => {
        logger.info('Shutting down...');
        server.close();
        await session?.disconnect();
        resolve();
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });
  };

  return { start };
}
