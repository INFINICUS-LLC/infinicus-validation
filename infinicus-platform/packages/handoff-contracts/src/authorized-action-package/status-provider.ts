// ABA-owned authoritative status provider boundary (P0-5 Block 3e; owner rulings Q3, Q5).
//
// Business Operations never reads ABA storage. Immediately before it claims a package it asks THIS interface, implemented on the ABA
// side, for the package's authoritative status. There is no production ABA->BO transport yet: the interface is the architecture
// boundary, and a concrete provider is wired only in a later, separately authorized block.
//
// The answer carries two ABA-proven facts: the package lifecycle (the existing {@link AuthoritativePackageStatus}) and whether the
// approver authority behind the package is STILL current. A provider must never answer CURRENT from cached or inferred state.
// This module is pure types: no database, no I/O, no clock.

import type { AuthoritativePackageStatus, PackageScope } from './types';

/** Whether the authority the package rests on is current at `verifiedAt` (consumption-time revalidation, ruling D3D-3 / Q5). */
export interface PackageAuthorityAnswer {
  /** CURRENT = proven valid now. REVOKED = no longer valid. UNVERIFIABLE = ABA could not establish it (BO fails closed). */
  state: 'CURRENT' | 'REVOKED' | 'UNVERIFIABLE';
  /** ABA database time (millisecond UTC) at which authority was checked. */
  verifiedAt: string;
}

export interface AuthoritativeStatusAnswer {
  status: AuthoritativePackageStatus;
  authority: PackageAuthorityAnswer;
}

/** The identity BO asks about. The provider echoes it back inside the answer so BO can prove the answer is about this package. */
export interface AuthoritativeStatusRequest {
  packageId: string;
  packageVersion: number;
  digest: string;
  scope: PackageScope;
}

export interface AuthoritativePackageStatusProvider {
  /** Null (or a rejected promise) = status could not be obtained: BO refuses. */
  getStatus(request: AuthoritativeStatusRequest): Promise<AuthoritativeStatusAnswer | null>;
}
