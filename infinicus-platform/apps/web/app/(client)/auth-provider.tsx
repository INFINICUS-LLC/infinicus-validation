'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AuthController, type AuthState } from '../../lib/client/authController';
import { getWebConfig } from '../../lib/client/config';
import { createSupabaseProvider } from '../../lib/client/supabaseProvider';
import type { ApiClient, Scope } from '../../lib/client/apiClient';

export interface AuthContextValue {
  state: AuthState;
  api: ApiClient | null;
  signIn: (email: string, password: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  signOut: () => Promise<void>;
  selectWorkspace: (scope: Scope) => boolean;
  retry: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

const LOADING: AuthState = { status: 'loading' };
const noSubscribe = () => () => undefined;

/** Owns the sign-in state machine for the (client) route group only; the older server-rendered pages are untouched. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const config = useMemo(() => getWebConfig(), []);
  const [controller, setController] = useState<AuthController | null>(null);

  useEffect(() => {
    if (!config.ok) return;
    const created = new AuthController({
      apiBaseUrl: config.apiBaseUrl,
      provider: createSupabaseProvider(config.supabaseUrl, config.supabaseAnonKey),
      storage: window.sessionStorage,
      // eslint-disable-next-line no-console -- the only diagnostic channel for an unconfirmed revocation; the message never contains a token
      warn: (message) => console.warn(message),
    });
    setController(created);
    void created.start();
    return () => created.stop();
  }, [config]);

  const state = useSyncExternalStore(
    controller ? controller.subscribe : noSubscribe,
    controller ? controller.getState : () => LOADING,
    () => LOADING,
  );

  const signIn = useCallback((email: string, password: string) => (controller ? controller.signIn(email, password) : Promise.resolve({ ok: false as const, message: 'Sign-in is not ready yet.' })), [controller]);
  const signOut = useCallback(() => (controller ? controller.signOut() : Promise.resolve()), [controller]);
  const selectWorkspace = useCallback((scope: Scope) => (controller ? controller.selectWorkspace(scope) : false), [controller]);
  const retry = useCallback(() => { void controller?.retry(); }, [controller]);

  const effective: AuthState = !config.ok ? { status: 'unconfigured', missing: config.missing, invalid: config.invalid } : state;
  const value = useMemo<AuthContextValue>(
    () => ({ state: effective, api: controller?.api ?? null, signIn, signOut, selectWorkspace, retry }),
    [effective, controller, signIn, signOut, selectWorkspace, retry],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside the (client) route group.');
  return value;
}
