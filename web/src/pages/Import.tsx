import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../auth';
import { fmtDate, fmtDateTime } from '../format';
import { Badge, Card, Empty, Loaded, Money, Note, Page, StatusBadge, useAction, useLoad, useToast } from '../ui';

const STEPS = ['Upload', 'Review', 'Import', 'Results'];
const MAX_BYTES = 10 * 1024 * 1024;

export function ImportPage() {
  const { can } = useSession();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [ack, setAck] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { busy, error, run, setError } = useAction();
  const history = useLoad(() => api.get('/api/imports'), []);
  const props = useLoad(() => api.get('/api/properties'), []);

  const reset = () => { setStep(0); setFile(null); setPreview(null); setResult(null); setAck(false); setError(null); if (input.current) input.current.value = ''; };
  const pick = async (f?: File) => {
    if (!f) return;
    setError(null);
    if (f.size > MAX_BYTES) return setError('That file is larger than 10 MB. Export a shorter date range from Airbnb.');
    setFile({ name: f.name, text: await f.text() });
  };
  const validate = async () => { const p = await run(() => api.post('/api/imports/preview', { filename: file!.name, csv: file!.text })); if (p) { setPreview(p); setStep(1); } };
  const commit = async () => {
    const r = await run(() => api.post('/api/imports/confirm', { filename: file!.name, csv: file!.text, confirmed: true }));
    if (r) { setResult(r); setStep(3); toast(`${r.imported} transactions imported`); history.reload(); props.reload(); }
  };

  const s = preview?.summary;
  const unmatchedNames = preview ? [...new Set<string>(preview.rows.filter((r: any) => r.status === 'UNMATCHED_PROPERTY').map((r: any) => r.record.listingName))] : [];
  const blocked = !!preview && (preview.headerErrors.length > 0 || s.READY === 0);

  return (
    <Page title="Airbnb import" sub="Upload an earnings export you downloaded from Airbnb. Nothing is saved until you confirm.">
      <div className="steps">{STEPS.map((l, i) => <div key={l} className={`step ${i === step ? 'on' : i < step ? 'done' : ''}`}>{i + 1}. {l}</div>)}</div>
      {error && <div className="alert bad" role="alert">{error}</div>}
      {!can('import:write') && <Note tone="warn">You do not have permission to import revenue.</Note>}

      {step === 0 && can('import:write') && (
        <Card title="1. Choose your Airbnb export">
          <p className="muted" style={{ marginTop: 0 }}>In Airbnb, open <b>Earnings → Transaction history</b>, export as CSV, then select the file here. The app never connects to your Airbnb account and never asks for your Airbnb password.</p>
          <input ref={input} type="file" accept=".csv,text/csv" onChange={(e) => pick(e.target.files?.[0])} aria-label="Airbnb CSV file" />
          {file && <p>Selected: <b>{file.name}</b> <span className="muted">({Math.round(file.text.length / 1024)} KB)</span></p>}
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}><button className="btn primary" disabled={!file || busy} onClick={validate}>{busy ? 'Checking…' : 'Check file'}</button></div>
        </Card>
      )}

      {step === 1 && preview && (<>
        <div className="chips" aria-label="Preview summary">
          <div className="chip"><b>{s.total}</b>rows read</div>
          <div className="chip"><b style={{ color: 'var(--good)' }}>{s.READY}</b>ready to import</div>
          <div className="chip"><b>{s.DUPLICATE_EXISTING + s.DUPLICATE_IN_FILE}</b>duplicates</div>
          <div className="chip"><b style={{ color: s.UNMATCHED_PROPERTY ? 'var(--bad)' : undefined }}>{s.UNMATCHED_PROPERTY}</b>no matching property</div>
          <div className="chip"><b>{s.PERIOD_LOCKED}</b>in closed months</div>
          <div className="chip"><b style={{ color: s.errors ? 'var(--bad)' : undefined }}>{s.errors}</b>errors</div>
        </div>
        {preview.headerErrors.length > 0 && <Note tone="bad">This does not look like an Airbnb earnings export: {preview.headerErrors.join('; ')}.</Note>}
        {unmatchedNames.length > 0 && <Note tone="warn"><b>These listings are not matched to a property:</b> {unmatchedNames.join(', ')}. Set each property's <i>Airbnb listing name</i> exactly as it appears in the export (<Link to="/properties">Properties</Link>), then upload the file again. Rows already imported are skipped automatically.</Note>}
        {preview.issues.filter((i: any) => i.severity !== 'INFO').length > 0 && (
          <Card title="Rows needing attention" flush><table><thead><tr><th>Row</th><th>Level</th><th>Issue</th></tr></thead><tbody>
            {preview.issues.filter((i: any) => i.severity !== 'INFO').slice(0, 100).map((i: any, k: number) => <tr key={k}><td>{i.row}</td><td><StatusBadge status={i.severity} /></td><td>{i.message}</td></tr>)}</tbody></table></Card>)}
        <Card title="Transactions" flush>
          {preview.rows.length === 0 ? <Empty>No transactions found in this file.</Empty> : <table><thead><tr><th>Status</th><th>Earned</th><th>Listing</th><th>Type</th><th>Reservation</th><th className="r">Net payout</th></tr></thead><tbody>
            {preview.rows.slice(0, 200).map((r: any, k: number) => <tr key={k}><td><StatusBadge status={r.status} /></td><td className="nowrap">{fmtDate(r.record.earningsDate)}</td><td>{r.record.listingName}</td><td>{r.record.kind.replace(/_/g, ' ').toLowerCase()}</td><td>{r.record.reservationId ?? '—'}</td><td className="r"><Money cents={r.record.netPayoutCents} /></td></tr>)}</tbody></table>}
          {preview.rows.length > 200 && <p className="muted small" style={{ padding: '0 14px' }}>Showing the first 200 of {preview.rows.length} rows.</p>}
        </Card>
        <div className="actions"><button className="btn" onClick={reset}>Start over</button><button className="btn primary" disabled={blocked} onClick={() => setStep(2)}>{blocked ? 'Nothing to import' : `Continue with ${s.READY} transactions`}</button></div>
      </>)}

      {step === 2 && preview && (
        <Card title="3. Confirm import">
          <p style={{ marginTop: 0 }}>You are about to import <b>{s.READY}</b> transactions from <b>{file?.name}</b>. {s.UNMATCHED_PROPERTY + s.PERIOD_LOCKED > 0 && <>The other <b>{s.UNMATCHED_PROPERTY + s.PERIOD_LOCKED}</b> rows that cannot be imported will be recorded as exceptions for follow-up. </>}Imported records are never overwritten; corrections are made with adjustments.</p>
          <label className="field check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I have reviewed the preview and want to import these transactions.</span></label>
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}><button className="btn" onClick={() => setStep(1)}>Back</button><button className="btn primary" disabled={!ack || busy} onClick={commit}>{busy ? 'Importing…' : 'Import transactions'}</button></div>
        </Card>
      )}

      {step === 3 && result && (
        <Card title="Import complete">
          <div className="chips"><div className="chip"><b style={{ color: 'var(--good)' }}>{result.imported}</b>imported</div><div className="chip"><b>{result.skipped}</b>skipped</div></div>
          <p className="muted">Batch {result.batchId.slice(0, 8)} is recorded in the audit log. Skipped rows are listed under unmatched transactions on the dashboard until they are resolved.</p>
          <div className="actions"><Link className="btn primary" to="/revenue">View revenue</Link><Link className="btn" to="/close">Go to monthly close</Link><button className="btn" onClick={reset}>Import another file</button></div>
        </Card>
      )}

      <div className="section-label">Import history</div>
      <Loaded q={history}>{(h) => <Card flush>{h.batches.length === 0 ? <Empty>No imports yet.</Empty> : <table><thead><tr><th>File</th><th>When</th><th>By</th><th className="r">Imported</th><th className="r">Skipped</th><th>Open issues</th></tr></thead><tbody>
        {h.batches.map((b: any) => <tr key={b.id}><td>{b.filename}</td><td>{fmtDateTime(b.importedAt)}</td><td>{b.importedBy}</td><td className="r">{b.imported}</td><td className="r">{b.skipped}</td><td>{b.unmatched > 0 && <Badge tone="bad">{b.unmatched} unmatched</Badge>} {b.locked > 0 && <Badge tone="warn">{b.locked} in closed months</Badge>}{b.unmatched + b.locked === 0 && <Badge tone="good">None</Badge>}</td></tr>)}</tbody></table>}</Card>}</Loaded>
    </Page>
  );
}
