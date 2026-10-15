/**
 * supabase-js adapter for IdentityProviderPort. Supabase keeps ITS OWN session (the provider's concern, not the INFINICUS backend session); the access
 * token is read from the change events and handed to the identity exchange, nothing else. Only the public project URL and anon/publishable key are used.
 */
import { createClient, type Session } from '@supabase/supabase-js';
import type { IdentityProviderPort, ProviderSession } from './authController';

const toSession = (s: Session | null): ProviderSession | null =>
  s?.user?.id && s.access_token ? { userId: s.user.id, email: s.user.email ?? '', accessToken: s.access_token } : null;

export function createSupabaseProvider(url: string, anonKey: string): IdentityProviderPort {
  const supabase = createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
  return {
    async signInWithPassword(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (!error) return { ok: true };
      // Deliberately generic: nothing about which part was wrong, nor the provider's raw message.
      return { ok: false, message: error.status === 400 || error.status === 401 ? 'The email or password is incorrect.' : 'Sign-in is temporarily unavailable. Please try again.' };
    },
    async signOut() { await supabase.auth.signOut(); },
    async getSession() { return toSession((await supabase.auth.getSession()).data.session); },
    onChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => listener(toSession(session)));
      return () => data.subscription.unsubscribe();
    },
  };
}
