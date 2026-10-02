/**
 * Sends one real WhatsApp template message to check your setup.
 *   node src/cli/whatsapp-test.ts +15551234567                 # checks credentials, then sends the statement_ready template with sample values
 *   node src/cli/whatsapp-test.ts --verify-only                # credentials check only, sends nothing
 *   node src/cli/whatsapp-test.ts +15551234567 --template hello_world   # Meta's built-in test template (no variables)
 * The recipient must have opted in. With a Meta test number the recipient must also be on the allowed list in the Meta console.
 */
import { createWhatsAppProvider } from '../whatsapp/factory.ts';
import { metaWhatsApp } from '../whatsapp/meta.ts';

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify-only');
const ti = args.indexOf('--template');
const customTemplate = ti >= 0 ? args[ti + 1] : undefined;
const to = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--template');
if (!verifyOnly && !to) { console.error('Usage: whatsapp-test <+E164 number> [--template name] | --verify-only'); process.exit(2); }
if (to && !/^\+[1-9]\d{6,14}$/.test(to)) { console.error('Number must be in international format, e.g. +15551234567'); process.exit(2); }

try {
  const setup = createWhatsAppProvider(process.env, process.env.BASE_URL);
  if (!setup) { console.error('WHATSAPP_PROVIDER is not set'); process.exit(2); }
  console.log(`Provider: ${setup.id}`);
  for (const w of setup.warnings) console.warn(`WARNING: ${w}`);
  if (setup.provider.verify) { await setup.provider.verify(); console.log('Credentials: OK'); }
  if (!verifyOnly) {
    let r;
    if (customTemplate) {
      if (setup.id !== 'meta') throw new Error('--template is only supported for Meta; for Twilio set the Content SID env vars');
      const raw = metaWhatsApp({ accessToken: process.env.WHATSAPP_META_TOKEN!, phoneNumberId: process.env.WHATSAPP_META_PHONE_NUMBER_ID!, language: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US', templates: { statement_ready: customTemplate, statement_ready_summary: customTemplate } });
      r = await raw.sendTemplate({ to: to!, template: 'statement_ready', params: [] });
    } else {
      r = await setup.provider.sendTemplate({ to: to!, template: setup.includeSummary ? 'statement_ready_summary' : 'statement_ready',
        params: ['September 2026', 'Test Property', ...(setup.includeSummary ? ['$1,234.56'] : []), `${process.env.BASE_URL ?? 'https://example.com'}/view/test`] });
    }
    console.log(`Sent. Provider message id: ${r.messageId}`);
    console.log('Delivery status arrives at your webhook (see docs/whatsapp-setup.md).');
  }
} catch (e) { console.error(`FAILED: ${(e as Error).message}`); process.exit(1); }
