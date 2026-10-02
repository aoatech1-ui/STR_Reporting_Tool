import { EmailError, type FetchLike } from './types.ts';

const defaultFetch: FetchLike = (url, init) => fetch(url, init) as any;
export const TIMEOUT_MS = 15_000;

export interface HttpResult { status: number; json: any; header(n: string): string | null }

/**
 * POST with timeout and uniform error classification. Network errors, timeouts, 408, 429 and 5xx are retryable;
 * other 4xx are definitive. Error text never includes request headers (they carry credentials).
 */
export interface Classified { retryable?: boolean; message?: string }
export type Classifier = (status: number, json: any) => Classified | void;

export const post = (provider: string, url: string, headers: Record<string, string>, body: string, fetchImpl: FetchLike = defaultFetch, classify?: Classifier) =>
  send(provider, 'POST', url, headers, body, fetchImpl, classify);
export const get = (provider: string, url: string, headers: Record<string, string>, fetchImpl: FetchLike = defaultFetch, classify?: Classifier) =>
  send(provider, 'GET', url, headers, undefined, fetchImpl, classify);

async function send(provider: string, method: 'GET' | 'POST', url: string, headers: Record<string, string>, body: string | undefined, fetchImpl: FetchLike, classify?: Classifier): Promise<HttpResult> {
  let res;
  try {
    res = await fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new EmailError(`${provider}: network error (${(e as Error).name})`, true);
  }
  const text = await res.text().catch(() => '');
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const nested = typeof json?.error === 'object' ? json.error?.message : json?.error;
    const detail = String(json?.message ?? nested ?? json?.ErrorMessage ?? json?.errors?.[0]?.message ?? text).slice(0, 200).replace(/\s+/g, ' ');
    const c = classify?.(res.status, json) ?? {};
    throw new EmailError(`${provider}: HTTP ${res.status} ${c.message ?? detail}`.trim(), c.retryable ?? (res.status === 408 || res.status === 429 || res.status >= 500), res.status);
  }
  return { status: res.status, json, header: (n) => res.headers.get(n) };
}

/** Provider message ids are compared across API response and webhook; normalise `<id>` forms. */
export const normId = (id: string) => id.trim().replace(/^<|>$/g, '');
