// SISMO911 — Telegram bot: response redaction.
// ---------------------------------------------------------------------------
// Turns an internal CaseRecord into a PublicView containing ONLY the fields a
// given viewer is allowed to receive. This is the last line of defense before
// text is sent to a chat: even if an upstream bug fetched sensitive fields, a
// public reply built from a PublicView cannot contain them.
//
// Public (group / unauthorized) replies may carry only:
//   case id · public status · verification level · general (city/state) location
//   · last-verified date · a recommended next action.
// Never: full id, exact address, phone, hospital/medical detail, family contact,
// minors' detail, unverified allegations.

import { coarsenLocation } from '../lib/minor-protect';
import type { CaseRecord, PublicStatus, VerificationLevel, ViewerRole } from './types';

const DEFAULT_BASE_URL = 'https://sismo911.com';

/** Public, shareable URL for a case/profile page on sismo911.com. Familia
 *  (personas) records open on /familia?persona=<id>; everything else uses the
 *  unified case view /casos#caso=<caseId> (mirrors lib/case-subscribe.caseUrlFor). */
export function profileUrlFor(record: CaseRecord, baseUrl: string = DEFAULT_BASE_URL): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (record.registry === 'personas') {
    return `${base}/familia?persona=${encodeURIComponent(record.internalId)}`;
  }
  return `${base}/casos#caso=${encodeURIComponent(record.caseId)}`;
}

export interface PublicView {
  caseId: string;
  status: PublicStatus;
  verification: VerificationLevel;
  generalLocation: string | null;
  lastVerifiedMs: number | null;
  profileUrl: string;
  // Privileged extras — populated ONLY for an admin/authorized viewer in a DM.
  privileged?: {
    fullName: string;
    cedula?: string | null;
    phone?: string | null;
    address?: string | null;
    hospital?: string | null;
    medicalNotes?: string | null;
    familyContact?: string | null;
  };
}

/**
 * Build the redaction-safe view. `canSeeSensitive` must already encode the full
 * gate (admin/authorized AND a private DM — see auth.canViewSensitiveData);
 * pass false for any group or unauthorized requester.
 */
export function toPublicView(
  record: CaseRecord,
  role: ViewerRole,
  canSeeSensitive: boolean,
  baseUrl: string = DEFAULT_BASE_URL,
): PublicView {
  const view: PublicView = {
    caseId: record.caseId,
    status: record.publicStatus,
    verification: record.verification,
    // General location is already coarsened in the adapter; re-coarsen defensively.
    generalLocation: coarsenLocation(record.generalLocation),
    lastVerifiedMs: record.lastVerifiedMs,
    profileUrl: profileUrlFor(record, baseUrl),
  };
  if (canSeeSensitive) {
    view.privileged = {
      fullName: record.fullName,
      cedula: record.sensitive.cedula ?? null,
      phone: record.sensitive.phone ?? null,
      address: record.sensitive.address ?? null,
      hospital: record.sensitive.hospital ?? null,
      medicalNotes: record.sensitive.medicalNotes ?? null,
      familyContact: record.sensitive.familyContact ?? null,
    };
  }
  // role is retained for callers/telemetry; redaction itself is driven by the
  // explicit canSeeSensitive flag so the gate can't be bypassed by role alone.
  void role;
  return view;
}
