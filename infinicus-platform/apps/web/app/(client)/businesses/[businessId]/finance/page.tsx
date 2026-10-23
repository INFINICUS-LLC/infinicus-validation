'use client';

import { useMemo, useState } from 'react';
import { useBusinessId } from '../use-business-id';
import { StateNotice } from '../../../state-notice';
import { useAuth } from '../../../auth-provider';
import { useRequireWorkspace } from '../../../use-require-workspace';
import { useScopedResource } from '../../../use-scoped-resource';
import { localDate, presetPeriod } from '../../../../../lib/client/salesReport';
import { financialReportPath, financialReportSchema } from '../../../../../lib/client/financialReport';
import { FinanceView } from './finance-view';

export default function FinancePage() {
  const { state } = useAuth();
  const { scope } = useRequireWorkspace();
  const businessId = useBusinessId();
  const [period, setPeriod] = useState(() => presetPeriod('last30', localDate(new Date())));
  const path = useMemo(() => (businessId ? financialReportPath(businessId, period.from, period.to) : null), [businessId, period.from, period.to]);
  const { resource } = useScopedResource(scope && path ? path : null, financialReportSchema);

  if (!scope) return <StateNotice state={state} />;
  if (!businessId) return <div className="card"><p className="notice danger" role="alert">That business address is not valid.</p><p><a href="/businesses">&larr; All businesses</a></p></div>;
  return <div>
    <h1>Finance overview</h1>
    <FinanceView period={period} resource={resource} onApply={setPeriod} />
  </div>;
}
