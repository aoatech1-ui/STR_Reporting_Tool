import { createHash } from 'node:crypto';
import { buildAnnualReport } from '../accounting/annual.ts';
import { computeYtd, STATEMENT_DISCLAIMER } from '../accounting/statement.ts';
import type { Db } from '../db/pool.ts';
import { UserError } from '../errors.ts';
import type { FileStore } from '../files/store.ts';
import { monthlyStatementCsv } from '../export/csv.ts';
import { renderAnnualPdf, renderStatementPdf, type StatementPdfInput } from '../pdf/render.ts';
import { getOrganization } from '../repo/orgs.ts';
import { getOwner } from '../repo/owners.ts';
import { getProperty } from '../repo/properties.ts';
import { getStatementFiles, loadStatements, type StoredStatement } from '../repo/statements.ts';

/** This statement + the property's finalized statements earlier in the same year, so a draft previews its eventual YTD. */
export async function statementYtd(db: Db, orgId: string, s: StoredStatement) {
  const prior = (await loadStatements(db, orgId, { year: s.statement.year, throughMonth: s.statement.month, propertyId: s.propertyId, statuses: ['FINALIZED', 'LOCKED'] }))
    .filter((x) => x.id !== s.id).map((x) => x.statement);
  return computeYtd([...prior, s.statement], s.statement.year, s.statement.month);
}

export async function loadStatementDoc(db: Db, orgId: string, id: string, statuses?: StoredStatement['status'][]) {
  const [stored] = await loadStatements(db, orgId, { id, statuses });
  if (!stored) return null;
  const [ytd, organization, property, owner] = await Promise.all([statementYtd(db, orgId, stored), getOrganization(db, orgId), getProperty(db, orgId, stored.propertyId), getOwner(db, orgId, stored.ownerId)]);
  const final = stored.status === 'FINALIZED' || stored.status === 'LOCKED';
  const pdf: StatementPdfInput = {
    orgName: organization.displayName, statementNumber: stored.statementNumber, generatedAt: stored.generatedAt, ownerName: stored.ownerName, propertyName: stored.propertyName,
    propertyAddress: [property?.address, property?.city, property?.state, property?.zip].filter(Boolean).join(', ') || undefined,
    statement: stored.statement, ytd, disclaimer: STATEMENT_DISCLAIMER, draft: !final,
  };
  return { stored, ytd, organization, property, owner, disclaimer: STATEMENT_DISCLAIMER, pdf, final };
}

export const statementCsv = (s: StoredStatement) => monthlyStatementCsv([{ ownerName: s.ownerName, propertyName: s.propertyName, statement: s.statement }]);
export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/**
 * The statement PDF. A finalized statement serves its archived file (verified against the stored hash); if the archive is not there yet
 * (worker still queued) or fails verification, it is rendered on demand from the immutable snapshot. Drafts are always rendered fresh, watermarked.
 */
export async function statementPdf(db: Db, files: FileStore, orgId: string, id: string, statuses?: StoredStatement['status'][]): Promise<{ bytes: Buffer; filename: string; archived: boolean }> {
  const doc = await loadStatementDoc(db, orgId, id, statuses);
  if (!doc) throw new UserError('Statement not found');
  const filename = `${doc.stored.statementNumber}.pdf`;
  if (doc.final) {
    const { pdf } = await getStatementFiles(db, orgId, id);
    if (pdf) {
      const bytes = await files.get(pdf.storageKey).catch(() => null);
      if (bytes && sha256(bytes) === pdf.sha256) return { bytes, filename, archived: true };
    }
  }
  return { bytes: await renderStatementPdf(doc.pdf), filename, archived: false };
}

export async function annualDoc(db: Db, orgId: string, year: number, ownerId: string, propertyId?: string) {
  const owner = await getOwner(db, orgId, ownerId);
  if (!owner) throw new UserError('Owner not found');
  const rows = await loadStatements(db, orgId, { year, ownerId, propertyId, statuses: ['FINALIZED', 'LOCKED'] });
  return { organization: await getOrganization(db, orgId), owner, properties: [...new Set(rows.map((r) => r.propertyName))].sort(), report: buildAnnualReport(year, rows.map((r) => r.statement)) };
}

export async function annualPdf(db: Db, orgId: string, year: number, ownerId: string, propertyId: string | undefined, preparedOn: string) {
  const d = await annualDoc(db, orgId, year, ownerId, propertyId);
  return renderAnnualPdf({ orgName: d.organization.displayName, ownerName: d.owner.displayName, properties: d.properties, report: d.report, preparedOn });
}
