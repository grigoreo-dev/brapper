import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { CookieData } from 'puppeteer-core';

/**
 * Reads a cookies JSON file and returns the parsed array.
 * Throws if the file is missing, not valid JSON, or not an array.
 */
export function loadCookies(cookiesPath: string): CookieData[] {
  const resolved = path.resolve(process.cwd(), cookiesPath);

  if (!existsSync(resolved)) {
    throw new Error(`Cookies file not found: ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch {
    throw new Error(`Invalid JSON in cookies file: ${resolved}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Cookies file must be a JSON array: ${resolved}`);
  }

  return parsed as CookieData[];
}
