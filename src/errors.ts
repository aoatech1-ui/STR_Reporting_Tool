/** An error whose message is safe to show the caller. Anything else becomes a generic 500. */
export class UserError extends Error {
  readonly status: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UserError';
    this.status = status ?? (/not found$/i.test(message) ? 404 : 422);
  }
}
