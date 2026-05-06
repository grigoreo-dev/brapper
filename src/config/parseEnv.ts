import { z } from 'zod';

export const baseEnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.string().default('development'),
  BROWSER_WS_ENDPOINT: z.string().optional(),
  BROWSER_ENDPOINT: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
});

export type BaseEnvInput = z.input<typeof baseEnvSchema>;

export async function resolveBrowserWsEndpoint(
  wsEndpoint?: string,
  httpEndpoint?: string,
): Promise<string | undefined> {
  if (wsEndpoint) return wsEndpoint;

  if (httpEndpoint) {
    const url = httpEndpoint.replace(/\/$/, '');
    const versionUrl = `${url}/json/version`;
    const res = await fetch(versionUrl);
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    return data.webSocketDebuggerUrl;
  }

  return undefined;
}

export function parseEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    throw new Error(`Invalid environment variables:\n${JSON.stringify(formatted, null, 2)}`);
  }
  return result.data;
}
