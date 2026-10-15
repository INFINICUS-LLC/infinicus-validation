'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../auth-provider';
import { StateNotice } from '../state-notice';

export default function SignInPage() {
  const { state, signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { if (state.status === 'ready') router.replace(state.scope ? '/console' : '/workspaces'); }, [state, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await signIn(email.trim(), password);
    setBusy(false);
    setPassword('');
    if (!result.ok) setMessage(result.message);
  }

  if (state.status !== 'signed-out') {
    const notice = <StateNotice state={state} />;
    return state.status === 'ready' ? <div className="card"><p role="status">Signed in. Continuing…</p></div> : notice;
  }

  return (
    <div className="card">
      <h1>Sign in</h1>
      {state.notice ? <p className="notice" role="status">{state.notice}</p> : null}
      <form className="stack" onSubmit={onSubmit} noValidate>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {message ? <p className="notice danger" role="alert">{message}</p> : null}
        <button type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
