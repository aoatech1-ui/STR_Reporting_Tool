export interface EmailMessage {
  to: string[]; subject: string; text: string; html?: string;
  /** Stable per delivery. Forwarded to providers that de-duplicate on it, so a retry after a crash cannot double-send. */
  idempotencyKey?: string;
}
export interface EmailProvider {
  readonly name: string;
  send(m: EmailMessage): Promise<{ messageId: string }>;
  /** Optional connectivity/credential check that sends nothing (SMTP). */
  verify?(): Promise<void>;
}

/** retryable=false for definitive provider rejections (bad key, invalid sender, invalid recipient). */
export class EmailError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, retryable: boolean, status?: number) { super(message); this.name = 'EmailError'; this.retryable = retryable; this.status = status; }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; headers: { get(n: string): string | null }; text(): Promise<string> }>;

export interface Sender { email: string; name?: string }

export function parseSender(raw: string): Sender {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(raw);
  if (m) return { email: m[2], name: m[1]?.trim() || undefined };
  if (/^[^\s@<>]+@[^\s@<>]+$/.test(raw.trim())) return { email: raw.trim() };
  throw new Error(`EMAIL_FROM must look like "Name <addr@domain>" or "addr@domain", got "${raw}"`);
}
export const formatSender = (s: Sender) => (s.name ? `${s.name.replace(/[<>"\r\n]/g, '')} <${s.email}>` : s.email);

/** Strips tags/newline injection from header-ish values. */
export const cleanHeader = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();

/** The same error type is used by every outbound channel (email, WhatsApp). */
export { EmailError as SendError };
