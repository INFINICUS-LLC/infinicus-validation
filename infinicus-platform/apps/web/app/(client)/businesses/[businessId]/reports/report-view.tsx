'use client';

import { useState } from 'react';
import type { Resource } from '../../../../../lib/client/resource';
import {
  barPercent, formatMinor, localDate, periodProblem, presetPeriod,
  type PeriodPreset, type SalesCurrencySection, type SalesReportResponse,
} from '../../../../../lib/client/salesReport';

export interface ReportViewProps {
  /** The period currently shown (also the initial value of the inputs). */
  period: { from: string; to: string };
  resource: Resource<SalesReportResponse>;
  onApply: (period: { from: string; to: string }) => void;
  /** The device's calendar date; injectable so the presets are testable. */
  today?: string;
}

const PRESETS: readonly { key: PeriodPreset; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: 'last7', label: 'Last 7 days' }, { key: 'last30', label: 'Last 30 days' },
];

function Money({ minor, exponent, code }: { minor: number; exponent: number; code: string }) {
  const text = formatMinor(minor, exponent, code);
  return text === null ? <span className="notice danger" role="alert">amount unavailable</span> : <span>{code} {text}</span>;
}

function Section({ section }: { section: SalesCurrencySection }) {
  const { code, minorUnitExponent: exp } = section.currency;
  const t = section.totals;
  const max = section.daily.reduce((m, d) => Math.max(m, d.netMinor), 0);
  const consistent = [t.grossMinor, t.discountMinor, t.netMinor, ...section.daily.map((d) => d.netMinor)].every((v) => formatMinor(v, exp, code) !== null);
  if (!consistent) return <section className="card"><h2>{code}</h2><p className="notice danger" role="alert">This currency&apos;s amounts could not be shown exactly, so none are shown.</p></section>;
  return <section className="card" aria-labelledby={`cur-${code}`}>
    <h2 id={`cur-${code}`}>{code} sales</h2>
    {!t.reconciles ? <p className="notice danger" role="alert">These figures do not reconcile (gross minus discounts is not equal to net). Treat them as unconfirmed and tell support.</p> : null}
    <dl className="kpis">
      <div><dt>Net sales</dt><dd><Money minor={t.netMinor} exponent={exp} code={code} /></dd></div>
      <div><dt>Completed sales</dt><dd>{t.completedOrders}</dd></div>
      <div><dt>Average sale</dt><dd>{t.averageOrderNetMinor === null ? 'none yet' : <Money minor={t.averageOrderNetMinor} exponent={exp} code={code} />}</dd></div>
      <div><dt>Gross before discounts</dt><dd><Money minor={t.grossMinor} exponent={exp} code={code} /></dd></div>
      <div><dt>Discounts given</dt><dd><Money minor={t.discountMinor} exponent={exp} code={code} /></dd></div>
      <div><dt>Voided orders</dt><dd>{t.voidedOrders}</dd></div>
      <div><dt>Open orders</dt><dd>{t.openOrders}</dd></div>
    </dl>
    <table className="daily">
      <caption>Net sales by order date</caption>
      <thead><tr><th scope="col">Date</th><th scope="col">Sales</th><th scope="col">Net</th><th scope="col"><span className="visually-hidden">Relative size</span></th></tr></thead>
      <tbody>
        {section.daily.map((d) => <tr key={d.date}>
          <th scope="row">{d.date}</th>
          <td>{d.completedOrders}</td>
          <td><Money minor={d.netMinor} exponent={exp} code={code} /></td>
          <td aria-hidden="true"><span className="bar" style={{ display: 'inline-block', height: '0.6em', width: `${barPercent(d.netMinor, max)}%`, background: 'currentColor', opacity: 0.35 }} /></td>
        </tr>)}
      </tbody>
    </table>
  </section>;
}

/** Read-only: every figure is the server's; this view only chooses the period and displays what came back. */
export function SalesReportView({ period, resource, onApply, today }: ReportViewProps) {
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const problem = periodProblem(from, to);
  const now = today ?? localDate(new Date());
  return <div className="sales-report">
    <section className="card" aria-labelledby="period-heading">
      <h2 id="period-heading">Period</h2>
      <p>Sales are counted by the date each order was created. Both dates are included.</p>
      <p>{PRESETS.map((p) => <button key={p.key} type="button" className="secondary" onClick={() => { const r = presetPeriod(p.key, now); setFrom(r.from); setTo(r.to); onApply(r); }}>{p.label}</button>)}</p>
      <form onSubmit={(e) => { e.preventDefault(); if (!problem) onApply({ from, to }); }}>
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>{' '}
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></label>{' '}
        <button type="submit" disabled={problem !== null}>Show report</button>
        {problem ? <p className="notice danger" role="alert">{problem}</p> : null}
      </form>
    </section>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading the report…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' && resource.data.outcome === 'NOT_AVAILABLE'
        ? <p className="notice danger" role="alert">The report cannot be shown exactly right now ({resource.data.code}). {resource.data.detail}</p> : null}
      {resource.kind === 'ok' && resource.data.outcome === 'REPORT' && resource.data.report.currencies.length === 0
        ? <p className="empty-state">No orders were created between {resource.data.report.period.from} and {resource.data.report.period.to}.</p> : null}
      {resource.kind === 'ok' && resource.data.outcome === 'REPORT'
        ? resource.data.report.currencies.map((section) => <Section key={section.currency.code} section={section} />) : null}
    </div>
  </div>;
}
