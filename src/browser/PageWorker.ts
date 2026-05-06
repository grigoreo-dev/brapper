import type { HTTPResponse, Page } from 'puppeteer-core';

export interface InterceptedResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export interface WaitForResponseOptions {
  timeout?: number;
}

export class PageWorker {
  constructor(readonly page: Page) {}

  /**
   * Safely inject a script string as evaluateOnNewDocument.
   * Pass script as a string literal to avoid TS/esbuild __name() artifacts.
   */
  async injectScript(source: string): Promise<void> {
    await this.page.evaluateOnNewDocument(source);
  }

  /**
   * Attach a response listener before navigation and return a Promise
   * that resolves when a matching response is received.
   */
  waitForResponse(
    match: (url: string, method: string) => boolean,
    options: WaitForResponseOptions = {},
  ): Promise<InterceptedResponse> {
    const timeout = options.timeout ?? 30_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.page.off('response', handler);
        reject(new Error(`waitForResponse timed out after ${timeout}ms`));
      }, timeout);

      const handler = (res: HTTPResponse) => {
        const req = res.request();
        if (!match(res.url(), req.method())) return;
        clearTimeout(timer);
        this.page.off('response', handler);
        resolve(wrapResponse(res));
      };

      this.page.on('response', handler);
    });
  }

  /**
   * Subscribe to matching responses continuously. Returns unsubscribe fn.
   */
  onResponse(
    match: (url: string, method: string) => boolean,
    handler: (res: InterceptedResponse) => void,
  ): () => void {
    const listener = (res: HTTPResponse) => {
      const req = res.request();
      if (match(res.url(), req.method())) handler(wrapResponse(res));
    };
    this.page.on('response', listener);
    return () => this.page.off('response', listener);
  }

  /**
   * Execute a fetch from within the browser page context.
   * Runs with the page's cookies, origin, and session state.
   */
  async browserFetch(
    url: string,
    init?: RequestInit,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    text(): Promise<string>;
    json<T>(): Promise<T>;
  }> {
    const result = await this.page.evaluate(
      async (u: string, i: RequestInit | undefined) => {
        const res = await fetch(u, i);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: res.status, headers, body: await res.text() };
      },
      url,
      init as RequestInit,
    );

    return {
      status: result.status,
      headers: result.headers,
      text: () => Promise.resolve(result.body),
      json: <T>() => Promise.resolve(JSON.parse(result.body) as T),
    };
  }

  /**
   * Evaluate a serializable function inside the page.
   */
  evaluate<T>(fn: () => T): Promise<T> {
    return this.page.evaluate(fn);
  }

  /**
   * Evaluate a string expression inside the page (avoids serialization artifacts).
   */
  evaluateExpression<T>(expression: string): Promise<T> {
    return this.page.evaluate(expression) as Promise<T>;
  }
}

function wrapResponse(res: HTTPResponse): InterceptedResponse {
  return {
    url: res.url(),
    status: res.status(),
    headers: res.headers(),
    text: () => res.text(),
    json: <T>() => res.json() as Promise<T>,
  };
}
