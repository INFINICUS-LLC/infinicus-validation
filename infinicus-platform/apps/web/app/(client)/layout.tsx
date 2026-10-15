import type { ReactNode } from 'react';
import { AuthProvider } from './auth-provider';
import { AccountBar } from './account-bar';

export default function ClientLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AccountBar />
      {children}
    </AuthProvider>
  );
}
