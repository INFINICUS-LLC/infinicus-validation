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

/** The sealed document ABA vouches for, with the digest ABA stored for it. */
export interface AuthorizedActionPackageSourceDocument {
  document: Record<string, unknown>;
  digest: string;
}

/**
 * ABA-owned port (P0-6a, planning decision 1): how Business Operations obtains the sealed package a notification refers to, without
 * reading any ABA table. The document is returned only for the exact id/version in the requested scope; BO still validates it itself
 * (contract + digest) before storing anything. Null = unknown, out of scope or unavailable: BO refuses and nothing is disclosed.
 */
export interface AuthorizedActionPackageSource {
  get(request: { packageId: string; packageVersion: number; scope: PackageScope }): Promise<AuthorizedActionPackageSourceDocument | null>;
}

export interface RecordConsumedRequest {
  packageId: string;
  packageVersion: number;
  digest: string;
  scope: PackageScope;
  /** The BO receipt that holds the claim (BO's claim is canonical; this is only ABA's mirror of it). */
  receiptId: string;
}

export type RecordConsumedResult =
  | { outcome: 'RECORDED' | 'ALREADY_RECORDED'; recordedAt: string }
  /** The mirror cannot be written (unknown package, another terminal fact, expired, or another receipt). BO's claim stays canonical. */
  | { outcome: 'NOT_RECORDABLE'; reason: 'NOT_FOUND' | 'DIGEST_MISMATCH' | 'OTHER_TERMINAL_STATE' | 'EXPIRED' | 'OTHER_RECEIPT' };

/**
 * ABA-owned port (P0-6a, planning decision 1; owner ruling R-5): ABA derives its CONSUMED lifecycle fact from BO's receipt. BO calls this
 * port; BO never writes an ABA table. Idempotent per (package version, receipt).
 */
export interface PackageConsumptionRecorder {
  recordConsumed(request: RecordConsumedRequest): Promise<RecordConsumedResult>;
}

/**
 * The runtime activation control for the authorized-action pipeline (planning decision 16; ruling O-11). The producer (ABA) asks it before
 * announcing a package and the consumer (BO) asks it before claiming one, so both sides are governed by the SAME control: with it OFF no
 * notification is emitted and no claim is made. The governed implementation (per-business activation record + global kill switch) arrives
 * with P0-6e; until then the only implementation is {@link DENY_ALL_EXECUTION_GATE}. Safety never depends on a variable being absent: an
 * unwired gate is a closed gate. A gate that throws is treated as closed.
 */
export interface ExecutionCapabilityGate {
  isEnabled(scope: PackageScope, actionType: { code: string; schemaVersion: string }): Promise<boolean>;
}

export const DENY_ALL_EXECUTION_GATE: ExecutionCapabilityGate = Object.freeze({ isEnabled: async () => false });
