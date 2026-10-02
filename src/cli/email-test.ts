/**
 * Checks the configured email provider with real credentials.
 *   node src/cli/email-test.ts you@example.com        # verifies SMTP login (if supported), then sends one test message
 *   node src/cli/email-test.ts --verify-only          # login check only, sends nothing
 * Reads EMAIL_PROVIDER / EMAIL_FROM / provider credentials from the environment, exactly like the server and worker.
 */
import { createEmailProvider } from '../email/factory.ts';

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const to = args.find((a) => !a.startsWith('--'));
if (!verifyOnly && !to) { console.error('Usage: email-test <recipient@example.com> | --verify-only'); process.exit(2); }

try {
  const setup = createEmailProvider(process.env);
  if (!setup) { console.error('EMAIL_PROVIDER is not set'); process.exit(2); }
  console.log(`Provider: ${setup.id}`);
  for (const w of setup.warnings) console.warn(`WARNING: ${w}`);
  if (setup.provider.verify) { await setup.provider.verify(); console.log('Connection and login: OK'); }
  else console.log('This provider has no login check; the test message is the check.');
  if (!verifyOnly) {
    const r = await setup.provider.send({ to: [to!], subject: 'Test from STR Reporting Tool', text: 'If you can read this, outgoing email is configured correctly.', html: '<p>If you can read this, outgoing email is configured correctly.</p>', idempotencyKey: `email-test:${Date.now()}` });
    console.log(`Sent. Provider message id: ${r.messageId}`);
  }
} catch (e) { console.error(`FAILED: ${(e as Error).message}`); process.exit(1); }
