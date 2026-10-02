/** An error whose message is safe to show the caller. Anything else becomes a generic 500. */
export class UserError extends Error {
  readonly status: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UserError';
    this.status = status ?? (/not found$/i.test(message) ? 404 : 422);
  }
}

/** A failure retrying cannot fix. The job queue gives up immediately instead of backing off. */
export class PermanentError extends Error {
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = 'PermanentError'; }
}
