import { useParams } from 'react-router-dom';
import { api } from '../api';
import { StatementDoc } from '../StatementDoc';
import { Loaded, useLoad } from '../ui';

/** Public, signed-link statement page for owners (no login). */
export function OwnerView() {
  const { token } = useParams();
  const q = useLoad(() => api.get(`/s/${token}`), [token]);
  return (
    <div style={{ minHeight: '100vh', padding: '8px 0 40px' }}>
      {q.error && !q.data ? (
        <div className="login-wrap"><div className="login"><h1>Link unavailable</h1><p className="muted">This statement link is invalid or has expired. Please contact your property manager for a new link.</p></div></div>
      ) : (
        <Loaded q={q}>{(d) => (<>
          <div className="public-bar"><b>{d.organization}</b><span className="actions"><button className="btn" onClick={() => window.print()}>Print / Save as PDF</button><a className="btn" href={`/s/${token}/csv`}>Download CSV</a></span></div>
          <StatementDoc orgName={d.organization} statementNumber={d.statementNumber} ownerName={d.owner} propertyName={d.property} statement={d.statement} ytd={d.ytd} disclaimer={d.disclaimer} />
        </>)}</Loaded>
      )}
    </div>
  );
}
