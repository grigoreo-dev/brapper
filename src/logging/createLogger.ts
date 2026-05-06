import pino, { type Logger } from 'pino';

export function createLogger(level?: string, dev?: boolean): Logger {
  const isDev = dev ?? process.env.NODE_ENV !== 'production';
  const resolvedLevel = level ?? (isDev ? 'debug' : 'info');

  return pino({
    level: resolvedLevel,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}
