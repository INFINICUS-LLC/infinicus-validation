'use client';

import { useState } from 'react';
import type { Resource } from '../../../../../lib/client/resource';
import { localDate, periodProblem, presetPeriod, type PeriodPreset } from '../../../../../lib/client/salesReport';
import { coverageText, groupDecimal, type CurrencyDelta, type CurrencyFigures, type FinancialReport } from '../../../../../lib/client/financialReport';

export interface FinanceViewProps {
  period: { from: string; to: string };
  resource: Resource<FinancialReport>;
  onApply: (period: { from: string; to: string }) => void;
  /** The device's calendar date; injectable so the presets are testable. */
  today?: string;
}

const PRESETS: readonly { key: PeriodPreset; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: 'last7', label: 'Last 7 days' }, { key: 'last30', label: 'Last 30 days' },
];

/** A server decimal with its currency; text that is not a plain decimal is shown as unavailable, never guessed. */
function Money({ amount, code }: { amount: string; code: string }) {
  const text = groupDecimal(amount);
  return text === null ? <span className="notice danger" role="alert">amount unavailable</span> : <span>{code} {text}</span>;
}
const Percent = ({ value }: { value: string | null }) => (value === null ? null : <span> ({value}%)</span>);

function GrossProfit({ f }: { f: CurrencyFigures }) {
  const g = f.grossProfit;
  if (g.state === 'COMPUTED' && g.amount !== null) return <><Money amount={g.amount} code={f.currency} /><Percent value={g.marginPercent} /></>;
  if (g.state === 'NO_REVENUE') return <>no revenue in this period</>;
  return <>not shown: cost is recorded for {g.evidence.saleLinesWithCostEvidence} of {g.evidence.saleLines} sale lines</>;
}

function Figures({ f }: { f: CurrencyFigures }) {
  const avg = f.averageOrderValue;
  return <dl className="kpis">
    <div><dt>Revenue ({f.revenue.count} orders)</dt><dd><Money amount={f.revenue.amount} code={f.currency} /></dd></div>
    <div><dt>Average order</dt><dd>{avg.state === 'OK' && avg.amount !== null ? <Money amount={avg.amount} code={f.currency} /> : avg.state === 'NO_ORDERS' ? 'no orders yet' : 'not available for this currency'}</dd></div>
    <div><dt>Expenses ({f.expenses.count} claims)</dt><dd><Money amount={f.expenses.amount} code={f.currency} /></dd></div>
    <div><dt>Goods received ({f.goodsReceived.count} lines)</dt><dd><Money amount={f.goodsReceived.amount} code={f.currency} /></dd></div>
    <div><dt>Gross profit</dt><dd><GrossProfit f={f} /></dd></div>
  </dl>;
}

function DeltaRow({ label, d, code, count }: { label: string; d: CurrencyDelta['revenue']; code: string; count?: boolean }) {
  const show = (v: string) => (count ? <span>{v}</span> : <Money amount={v} code={code} />);
  return <tr>
    <th scope="row">{label}</th>
    <td>{show(d.current)}</td>
    <td>{d.state === 'NO_BASELINE' ? 'none recorded' : show(d.previous)}</td>
    <td>{d.state === 'NO_BASELINE' ? 'no earlier figure to compare with' : <>{show(d.change)}<Percent value={d.changePercent} /></>}</td>
  </tr>;
}

function CurrencySection({ report, f }: { report: FinancialReport; f: CurrencyFigures }) {
  const delta = report.comparison?.deltas.find((d) => d.currency === f.currency);
  const buckets = report.trend.buckets.map((b) => ({ b, row: b.currencies.find((c) => c.currency === f.currency) })).filter((x) => x.row !== undefined);
  return <section className="card" aria-labelledby={`fin-${f.currency}`}>
    <h2 id={`fin-${f.currency}`}>{f.currency}</h2>
    <Figures f={f} />
    {report.comparison && delta ? <table className="fin-table">
      <caption>Compared with {report.comparison.range.from} to {report.comparison.range.to}</caption>
      <thead><tr><th scope="col">Measure</th><th scope="col">This period</th><th scope="col">Earlier period</th><th scope="col">Change</th></tr></thead>
      <tbody>
        <DeltaRow label="Revenue" d={delta.revenue} code={f.currency} />
        <DeltaRow label="Expenses" d={delta.expenses} code={f.currency} />
        <DeltaRow label="Orders" d={delta.orderCount} code={f.currency} count />
        {delta.grossProfit ? <DeltaRow label="Gross profit" d={delta.grossProfit} code={f.currency} /> : null}
      </tbody>
    </table> : null}
    {buckets.length > 0 ? <table className="fin-table">
      <caption>By {report.trend.granularity}</caption>
      <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Revenue</th><th scope="col">Expenses</th><th scope="col">Orders</th></tr></thead>
      <tbody>{buckets.map(({ b, row }) => <tr key={b.start}>
        <th scope="row">{b.start}</th><td>{b.end}</td>
        <td><Money amount={row!.revenue} code={f.currency} /></td><td><Money amount={row!.expenses} code={f.currency} /></td><td>{row!.orderCount}</td>
      </tr>)}</tbody>
    </table> : null}
  </section>;
}

function Report({ report }: { report: FinancialReport }) {
  return <>
    <p>{report.period.range.from} to {report.period.range.to} (UTC days, both included). Each currency is shown on its own and is never converted or added to another.</p>
    {report.period.currencies.length === 0
      ? <p className="empty-state">No sales or expenses were recorded in this period.</p>
      : report.period.currencies.map((f) => <CurrencySection key={f.currency} report={report} f={f} />)}
    {report.ordersByStatus.length > 0 ? <section className="card" aria-labelledby="fin-orders">
      <h2 id="fin-orders">Orders by status</h2>
      <table className="fin-table"><thead><tr><th scope="col">Status</th><th scope="col">Orders</th></tr></thead>
        <tbody>{report.ordersByStatus.map((s) => <tr key={s.status}><th scope="row">{s.status}</th><td>{s.count}</td></tr>)}</tbody></table>
    </section> : null}
    {report.indicators.length > 0 ? <section className="card" aria-labelledby="fin-ind">
      <h2 id="fin-ind">Recorded indicators</h2>
      <table className="fin-table"><thead><tr><th scope="col">Indicator</th><th scope="col">Value</th><th scope="col">Target</th><th scope="col">Variance</th><th scope="col">Period</th></tr></thead>
        <tbody>{report.indicators.map((i) => <tr key={`${i.metricCode}-${i.periodStart}-${i.periodEnd}`}>
          <th scope="row">{i.metricName}</th><td>{i.value}{i.unit ? ` ${i.unit}` : ''}</td><td>{i.target ?? 'none'}</td><td>{i.variance ?? 'none'}</td><td>{i.periodStart} to {i.periodEnd}</td>
        </tr>)}</tbody></table>
    </section> : null}
    <section className="card" aria-labelledby="fin-cov">
      <h2 id="fin-cov">What these figures include</h2>
      <ul>{report.coverage.map((c) => <li key={c}>{coverageText(c)}</li>)}</ul>
    </section>
  </>;
}

/** Read-only: every figure is the server's; this view only chooses the period and displays what came back. */
export function FinanceView({ period, resource, onApply, today }: FinanceViewProps) {
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const problem = periodProblem(from, to);
  const now = today ?? localDate(new Date());
  return <div className="finance-view">
    <section className="card" aria-labelledby="fin-period">
      <h2 id="fin-period">Period</h2>
      <p>{PRESETS.map((p) => <button key={p.key} type="button" className="secondary" onClick={() => { const r = presetPeriod(p.key, now); setFrom(r.from); setTo(r.to); onApply(r); }}>{p.label}</button>)}</p>
      <form onSubmit={(e) => { e.preventDefault(); if (!problem) onApply({ from, to }); }}>
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>{' '}
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></label>{' '}
        <button type="submit" disabled={problem !== null}>Show overview</button>
        {problem ? <p className="notice danger" role="alert">{problem}</p> : null}
      </form>
    </section>
    <div aria-live="polite" aria-busy={resource.kind === 'loading'}>
      {resource.kind === 'loading' ? <p role="status">Loading the overview…</p> : null}
      {resource.kind === 'error' ? <p className="notice danger" role="alert">{resource.message}</p> : null}
      {resource.kind === 'ok' ? <Report report={resource.data} /> : null}
    </div>
  </div>;
}
