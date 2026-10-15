import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'INFINICUS — Customer Decision Workflows',
  description: 'Review business intelligence, digital twin state, simulation, and AI recommendations, then approve actions and record outcomes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to main content</a>
        <header className="site-header">
          <strong>INFINICUS</strong>
          <nav aria-label="Primary">
            <ul>
              <li><a href="/console">Console</a></li>
              <li><a href="/businesses">Businesses</a></li>
            </ul>
          </nav>
        </header>
        <main id="main-content">{children}</main>
      </body>
    </html>
  );
}
