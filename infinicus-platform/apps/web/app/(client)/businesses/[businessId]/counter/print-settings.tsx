'use client';

import type { PaperMm, PrintSettings } from '../../../../../lib/client/printing';

/** Receipt printing choices for this page load: automatic printing after payment, and the paper width. Presentational; the page holds the state. */
export function PrintSettingsPanel({ settings, onChange }: { settings: PrintSettings; onChange: (next: PrintSettings) => void }) {
  return (
    <section className="card print-settings" aria-label="Receipt printing">
      <label>
        <input type="checkbox" checked={settings.auto} onChange={(e) => onChange({ ...settings, auto: e.target.checked })} />{' '}
        Print the receipt automatically after payment
      </label>
      <label>
        Paper{' '}
        <select value={settings.paperMm} onChange={(e) => onChange({ ...settings, paperMm: e.target.value === '58' ? 58 : 80 })}>
          {([80, 58] as PaperMm[]).map((mm) => <option key={mm} value={mm}>{mm} mm</option>)}
        </select>
      </label>
      <p className="muted">Remembered until this tab is closed. To skip the print dialog, start the browser in kiosk-printing mode with the receipt printer as its default printer.</p>
    </section>
  );
}
