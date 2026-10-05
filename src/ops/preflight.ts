import { randomUUID } from 'node:crypto';
import type { Pool } from '../db/pool.ts';
import { pendingMigrations } from '../db/migrate.ts';
import { loadConfig } from '../server/config.ts';
import { verifyAuditChain } from '../repo/audit.ts';
import { getWorkerStatus } from '../repo/ops.ts';
import { createFileStore, type FileStore } from '../files/store.ts';

export type Level = 'pass' | 'warn' | 'fail';
export interface Check { name: string; level: Level; detail: string }

const WEBHOOK_PROVIDERS = new Set(['brevo', 'resend', 'mailjet', 'mailersend', 'postmark', 'sendgrid', 'mailgun']);

/** Weak-secret heuristic: too few distinct characters or an obvious placeholder. */
export function weakSecret(s: string): string | null {
  if (s.length < 32) return 'shorter than 32 characters';
  if (new Set(s).size < 12) return 'too little variety (fewer than 12 distinct characters)';
  if (/change.?me|example|secret|password|xxxx|0000|1234/i.test(s)) return 'looks like a placeholder';
  return null;
}

/**
 * Checks that a deployment can actually do its job. Nothing here changes data except one throwaway file written to and
 * removed from the file store. Safe to run against production.
 */
export async function runPreflight(env: Record<string, string | undefined>, pool: Pool, o: { files?: FileStore; now?: () => Date } = {}): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, level: Level, detail: string) => out.push({ name, level, detail });
  const guard = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { add(name, 'fail', (e as Error).message); } };

  let cfg: ReturnType<typeof loadConfig> | null = null;
  try { cfg = loadConfig(env); add('configuration', 'pass', 'required settings present and valid'); }
  catch (e) { add('configuration', 'fail', (e as Error).message); }

  if (cfg) {
    const weak = weakSecret(env.LINK_SECRET ?? '');
    add('link secret', weak ? 'fail' : 'pass', weak ? `LINK_SECRET is ${weak}. Generate one with: openssl rand -base64 48` : 'strong');
    const host = new URL(cfg.app.baseUrl).hostname;
    if (['localhost', '127.0.0.1'].includes(host)) add('public URL', 'warn', 'BASE_URL points at localhost: emailed statement links will not work for owners');
    else add('public URL', cfg.app.cookieSecure ? 'pass' : 'fail', cfg.app.cookieSecure ? `${cfg.app.baseUrl} (cookies are Secure, HSTS on)` : 'BASE_URL is not https');
    if (cfg.app.cookieSecure && !cfg.app.trustProxy) add('reverse proxy', 'warn', 'TRUST_PROXY is not true: behind a TLS proxy every client will look like the proxy to rate limits and the audit log');
    if (cfg.app.trustProxy) add('reverse proxy', 'pass', 'TRUST_PROXY=true (make sure only the proxy can reach the app port)');
  }

  await guard('database', async () => {
    const v = await pool.query('SELECT version() AS v, now() AS t');
    add('database', 'pass', String(v.rows[0].v).split(' ').slice(0, 2).join(' '));
    const skew = Math.abs((o.now?.() ?? new Date()).getTime() - new Date(v.rows[0].t).getTime()) / 1000;
    add('clock', skew > 5 ? 'warn' : 'pass', skew > 5 ? `application and database clocks differ by ${skew.toFixed(0)}s (links, sessions and job scheduling use both)` : `application and database clocks agree (${skew.toFixed(1)}s)`);
    const host = (() => { try { return new URL(env.DATABASE_URL ?? '').hostname; } catch { return ''; } })();
    if (host && !['localhost', '127.0.0.1', 'db', 'postgres'].includes(host) && !env.DB_SSL && !/sslmode=/.test(env.DATABASE_URL ?? '')) add('database TLS', 'warn', `connecting to ${host} without TLS: set DB_SSL=true (or no-verify)`);
  });
  await guard('migrations', async () => {
    const p = await pendingMigrations(pool);
    add('migrations', p.length ? 'fail' : 'pass', p.length ? `pending: ${p.join(', ')}. Run "npm run migrate"` : 'all applied');
  });
  await guard('extensions', async () => {
    const r = await pool.query(`SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto','btree_gist')`);
    const have = new Set(r.rows.map((x) => x.extname));
    const missing = ['pgcrypto', 'btree_gist'].filter((x) => !have.has(x));
    add('extensions', missing.length ? 'fail' : 'pass', missing.length ? `missing: ${missing.join(', ')}` : 'pgcrypto, btree_gist');
  });
  await guard('administrator', async () => {
    const r = await pool.query(`SELECT (SELECT count(*)::int FROM organizations) AS orgs, (SELECT count(*)::int FROM users WHERE role='ADMIN' AND active AND password_hash IS NOT NULL) AS admins`);
    const { orgs, admins } = r.rows[0];
    add('administrator', admins > 0 ? 'pass' : 'fail', admins > 0 ? `${admins} active administrator(s), ${orgs} organization(s)` : 'no active administrator: run "npm run create-admin"');
  });
  await guard('two-factor login', async () => {
    const key = env.MFA_ENCRYPTION_KEY?.trim();
    const r = await pool.query(`SELECT (SELECT count(*)::int FROM users WHERE totp_enabled_at IS NOT NULL) AS enrolled,
      (SELECT count(*)::int FROM users WHERE role='ADMIN' AND active AND totp_enabled_at IS NULL) AS admins_without,
      (SELECT count(*)::int FROM organizations WHERE require_mfa) AS required`);
    const { enrolled, admins_without, required } = r.rows[0];
    if (key && key.length < 32) { add('two-factor login', 'fail', 'MFA_ENCRYPTION_KEY must be at least 32 characters'); return; }
    if (!key) {
      if (enrolled > 0 || required > 0) add('two-factor login', 'fail', `${enrolled} user(s) have two-factor login but MFA_ENCRYPTION_KEY is not set: they cannot sign in. Restore the original key.`);
      else add('two-factor login', 'warn', 'not available: set MFA_ENCRYPTION_KEY (openssl rand -base64 48) to let people turn on two-factor login');
      return;
    }
    add('two-factor login', admins_without > 0 ? 'warn' : 'pass', `${enrolled} user(s) enrolled; ${required} organization(s) require it${admins_without > 0 ? `; ${admins_without} administrator(s) have not turned it on` : ''}`);
  });
  await guard('month-end reminders', async () => {
    const r = await pool.query(`SELECT count(*)::int AS n FROM reminder_settings WHERE enabled`);
    const n = r.rows[0].n;
    if (!n) return; // feature not in use: nothing to report
    if (!cfg?.email) add('month-end reminders', 'warn', `on for ${n} organization(s) but no email provider is configured: reminders will fail`);
    else add('month-end reminders', 'pass', `on for ${n} organization(s); sent by the worker`);
  });
  await guard('audit log', async () => {
    const orgs = (await pool.query('SELECT id FROM organizations')).rows;
    for (const x of orgs) { const broken = await verifyAuditChain(pool, x.id); if (broken !== null) { add('audit log', 'fail', `hash chain broken at entry #${broken} for organization ${x.id}`); return; } }
    add('audit log', 'pass', `hash chain intact for ${orgs.length} organization(s)`);
  });

  await guard('file storage', async () => {
    const store = o.files ?? createFileStore(env);
    const key = `preflight/${randomUUID()}.txt`, body = Buffer.from(`preflight ${new Date().toISOString()}`);
    await store.put(key, body, 'text/plain');
    const back = await store.get(key);
    await store.delete(key);
    if (!back || !back.equals(body)) throw new Error('wrote a test file but could not read it back');
    add('file storage', store.kind === 'local' ? 'warn' : 'pass', store.kind === 'local' ? 'local disk works. Make sure FILE_STORE_DIR is a persistent volume that is backed up' : 's3 write/read/delete OK');
  });

  if (cfg) {
    if (!cfg.email) add('email', 'warn', 'EMAIL_PROVIDER not set: statements cannot be emailed');
    else {
      const e = cfg.email;
      await guard('email', async () => {
        if (e.provider.verify) { await e.provider.verify(); add('email', 'pass', `${e.id}: login OK`); }
        else add('email', 'pass', `${e.id} configured (no login check for HTTP APIs: send a test with "npm run email:test -- you@example.com")`);
      });
      for (const w of e.warnings) add('email', 'warn', w);
      if (WEBHOOK_PROVIDERS.has(e.id) && !cfg.app.webhook.token && !cfg.app.webhook.signingSecret) add('email webhooks', 'warn', 'no EMAIL_WEBHOOK_TOKEN/SECRET: deliveries will stay "Sent" and bounces will not be recorded');
    }
  }

  if (cfg) {
    const wa = cfg.whatsapp;
    if (!wa) add('whatsapp', 'warn', 'WHATSAPP_PROVIDER not set: owners cannot receive WhatsApp notifications (email still works)');
    else {
      await guard('whatsapp', async () => {
        if (wa.provider.verify) { await wa.provider.verify(); add('whatsapp', 'pass', `${wa.id}: credentials OK`); }
        else add('whatsapp', 'pass', `${wa.id} configured`);
      });
      for (const w of wa.warnings) add('whatsapp', 'warn', w);
      add('whatsapp templates', 'warn', `templates must be APPROVED by WhatsApp before they can be sent: ${Object.values(wa.templates).filter(Boolean).join(', ')} (see docs/whatsapp-setup.md)`);
    }
  }

  await guard('worker', async () => {
    const w = await getWorkerStatus(pool);
    add('worker', w.active > 0 ? 'pass' : 'warn', w.active > 0 ? `${w.active} worker(s) alive (last seen ${w.lastSeenSecondsAgo}s ago)` : 'no worker heartbeat: emails will not be sent and PDFs not archived until "npm run worker" is running');
    const j = await pool.query(`SELECT count(*) FILTER (WHERE status='FAILED')::int AS failed, count(*) FILTER (WHERE status='QUEUED' AND run_at < now() - interval '10 minutes')::int AS stuck FROM jobs`);
    if (j.rows[0].failed) add('jobs', 'warn', `${j.rows[0].failed} job(s) in FAILED state: check the Communications screen`);
    if (j.rows[0].stuck) add('jobs', w.active > 0 ? 'warn' : 'fail', `${j.rows[0].stuck} job(s) queued for over 10 minutes`);
  });
  return out;
}

export const exitCode = (checks: Check[]) => (checks.some((c) => c.level === 'fail') ? 1 : 0);
