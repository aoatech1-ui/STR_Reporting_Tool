import { createEmailProvider, type EmailSetup } from '../email/factory.ts';
import type { ScryptCost } from '../auth/password.ts';

export interface AppConfig {
  baseUrl: string; linkSecret: string; cookieSecure: boolean; trustProxy: boolean; allowedOrigins: string[];
  loginRateLimit: number; webhook: { token?: string; signingSecret?: string }; scryptCost?: ScryptCost;
}
export interface Env { [k: string]: string | undefined }

export function loadConfig(env: Env): { databaseUrl: string; port: number; host: string; app: AppConfig; email: EmailSetup | null } {
  const need = (k: string) => { const v = env[k]?.trim(); if (!v) throw new Error(`${k} is required`); return v; };
  const baseUrl = need('BASE_URL').replace(/\/+$/, '');
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('BASE_URL must be https outside localhost');
  const linkSecret = need('LINK_SECRET');
  if (linkSecret.length < 32) throw new Error('LINK_SECRET must be at least 32 characters');
  return {
    databaseUrl: need('DATABASE_URL'), port: Number(env.PORT) || 3000, host: env.HOST || '0.0.0.0',
    app: {
      baseUrl, linkSecret, cookieSecure: url.protocol === 'https:', trustProxy: env.TRUST_PROXY === 'true',
      allowedOrigins: [url.origin, ...(env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])],
      loginRateLimit: Number(env.LOGIN_RATE_LIMIT) || 10,
      webhook: { token: env.EMAIL_WEBHOOK_TOKEN, signingSecret: env.EMAIL_WEBHOOK_SECRET },
    },
    email: createEmailProvider(env),
  };
}
