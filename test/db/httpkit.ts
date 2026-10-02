import { deriveMfaKeys } from '../../src/auth/mfa.ts';
import type { FastifyInstance } from 'fastify';
import { withTx, type Pool } from '../../src/db/pool.ts';
import { createUser } from '../../src/repo/orgs.ts';
import type { AppConfig } from '../../src/server/config.ts';
import type { Role } from '../../src/auth/permissions.ts';

export const COST = { N: 1024, r: 8, p: 1 };
export const PW = 'correct horse battery staple';
export const testConfig = (o: Partial<AppConfig> = {}): AppConfig => ({ baseUrl: 'https://app.test', linkSecret: 'x'.repeat(40), cookieSecure: true, trustProxy: false,
  allowedOrigins: ['https://app.test'], loginRateLimit: 1000, webhook: {}, scryptCost: COST, mfaKeys: deriveMfaKeys('test-mfa-master-key-0123456789abcdef'), ...o });

/** Adds a user with a password to an existing org. */
export async function addUser(pool: Pool, orgId: string, role: Role, email: string) {
  return withTx(pool, (tx) => createUser(tx, orgId, { name: role, email, role, password: PW }, COST));
}

export class Client {
  cookie = ''; csrf = ''; app: FastifyInstance;
  constructor(app: FastifyInstance) { this.app = app; }
  async login(email: string) {
    const r = await this.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: PW } });
    if (r.statusCode !== 200) throw new Error(`login ${email}: ${r.statusCode} ${r.body}`);
    this.cookie = `sid=${r.cookies[0].value}`; this.csrf = r.json().csrfToken; return this;
  }
  call(method: string, url: string, body?: unknown, o: { csrf?: string | null; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(this.cookie ? { cookie: this.cookie } : {}), ...(o.headers ?? {}) };
    const csrf = o.csrf === undefined ? this.csrf : o.csrf;
    if (csrf) headers['x-csrf-token'] = csrf;
    return this.app.inject({ method: method as any, url, headers, ...(body !== undefined ? { payload: body as any } : {}) });
  }
  get = (u: string) => this.call('GET', u);
  post = (u: string, b?: unknown) => this.call('POST', u, b ?? {});
  /** Raw-body upload like the browser does. */
  put(url: string, bytes: Buffer, contentType: string, o: { csrf?: string | null } = {}) { return this.call('PUT', url, bytes, { ...o, headers: { 'content-type': contentType } }); }
}
