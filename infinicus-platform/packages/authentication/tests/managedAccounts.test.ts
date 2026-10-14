import { describe, it, expect } from 'vitest';
import { MANAGED_ACCOUNT_EMAIL_DOMAIN, isManagedAccountEmail, managedAccountEmailFor } from '../src/managedAccounts.js';

describe('managedAccountEmailFor', () => {
  it('matches the legacy browser derivation (known-answer vector)', () => {
    expect(managedAccountEmailFor('00000000-0000-4000-8000-000000000000')).toBe('shadow-b7f08614066b3c7cad2baf3f192ccbd9@infini-cus.local');
  });
  it('is deterministic, id-specific and lives in the managed domain', () => {
    const a = managedAccountEmailFor('11111111-1111-4111-8111-111111111111');
    expect(a).toBe(managedAccountEmailFor('11111111-1111-4111-8111-111111111111'));
    expect(a).not.toBe(managedAccountEmailFor('22222222-2222-4222-8222-222222222222'));
    expect(a).toMatch(/^shadow-[0-9a-f]{32}@infini-cus\.local$/);
    expect(isManagedAccountEmail(a)).toBe(true);
  });
});

describe('isManagedAccountEmail', () => {
  it('matches the domain case-insensitively and ignores surrounding whitespace', () => {
    expect(MANAGED_ACCOUNT_EMAIL_DOMAIN).toBe('infini-cus.local');
    for (const e of ['a@infini-cus.local', 'A@INFINI-CUS.LOCAL', '  a@Infini-Cus.Local  ']) expect(isManagedAccountEmail(e)).toBe(true);
  });
  it('matches on the domain only', () => {
    for (const e of ['a@infini-cus.com', 'a@x.infini-cus.local', 'a@infini-cus.local.evil.com', 'infini-cus.local', 'shadow@infini-cus.locale', '']) expect(isManagedAccountEmail(e)).toBe(false);
  });
});
