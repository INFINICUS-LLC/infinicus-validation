'use client';

/** Last-resort boundary: generic by design, so no internal detail (and nothing about identity or scope) is shown. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card">
      <p className="notice danger" role="alert">Something went wrong. Please try again.</p>
      <p><button type="button" onClick={reset}>Try again</button></p>
    </div>
  );
}
