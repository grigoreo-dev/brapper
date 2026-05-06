import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { timing } from 'hono/timing';
import type { Logger } from 'pino';
import type { BrowserSession } from '../browser/BrowserSession.js';

export interface CreateAppOptions {
  logger: Logger;
  session: BrowserSession | null;
  auth?: { token?: string | undefined };
  cors?: { origins?: string[] };
}

export function createApp(options: CreateAppOptions): Hono {
  const { logger, session, auth } = options;

  const app = new Hono();

  app.use('*', timing());

  app.use(
    '*',
    cors({
      origin: options.cors?.origins ?? '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - start,
      },
      'request',
    );
  });

  if (auth?.token) {
    app.use('/v1/*', async (c, next) => {
      const authorization = c.req.header('Authorization');
      if (authorization !== `Bearer ${auth.token}`) {
        return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
      }
      await next();
    });
  }

  app.get('/health', (c) => {
    return c.json({
      ok: true,
      browser_connected: session?.isWarm ?? false,
      timestamp: new Date().toISOString(),
    });
  });

  app.notFound((c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

  app.onError((err, c) => {
    logger.error({ err }, 'Unhandled error');
    return c.json({ error: err.message, code: 'internal_error' }, 500);
  });

  return app;
}
