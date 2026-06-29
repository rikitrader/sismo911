// ---------------------------------------------------------------------------
// WIRING STATUS — the source-of-truth ledger of which of the 77 catalogued
// transactional emails are actually wired to a real trigger in the live code,
// vs. deferred (and WHY). This is the anti-hallucination meter: an email may
// only be marked `wired` when a real handler sends it. The enforcement test
// (test/email-wiring-status.test.ts) asserts every catalogued ID appears here
// exactly once, that `wired` entries name a `where`, and that `deferred` entries
// give a `reason`. "100% wired" = zero `deferred` entries remain.
//
// Keep entries in sync with src/lib/email-samples.ts (CATALOG).
// ---------------------------------------------------------------------------

export type WiringEntry =
  | { status: 'wired'; where: string }            // file/handler that sends it
  | { status: 'deferred'; reason: string }        // buildable, not wired YET
  | { status: 'not_applicable'; reason: string }; // architecturally impossible here

// Goal target: zero `deferred`. `not_applicable` entries are documented + accepted
// (the email describes a flow that cannot exist in this platform without
// fabricating a recipient/event — e.g. an anonymous on-chain x402 payer has no
// email; a deploy notification belongs in CI, not the Worker).

export const WIRING_STATUS: Record<string, WiringEntry> = {
  // ---- Identity & Access ----
  'AUTH-01': { status: 'wired', where: 'routes/auth.ts POST /register → verifyEmailTpl' },
  'AUTH-02': { status: 'wired', where: 'routes/auth.ts GET /verify → welcomeEmailTpl' },
  'AUTH-03': { status: 'wired', where: 'routes/auth.ts POST /forgot-password → resetEmail' },
  'AUTH-04': { status: 'wired', where: 'routes/auth.ts reset/change-password → passwordChangedEmail' },
  'AUTH-05': { status: 'deferred', reason: 'no email-change flow exists (no pending_new_email)' },
  'AUTH-06': { status: 'deferred', reason: 'no email-change flow exists' },
  'AUTH-07': { status: 'wired', where: 'routes/admin-sessions.ts /mfa/verify + /mfa/disable → mfaChangedEmail' },
  'AUTH-08': { status: 'deferred', reason: 'login records login_history but does not email new-device' },
  'AUTH-09': { status: 'wired', where: 'routes/auth.ts login MFA-lockout transition → accountLockedEmail' },
  'AUTH-10': { status: 'wired', where: 'routes/admin-lifecycle.ts invitations → inviteEmail' },
  'AUTH-11': { status: 'wired', where: 'routes/admin-lifecycle.ts /users/:id/approve → operationalAlert (access granted)' },
  'AUTH-12': { status: 'deferred', reason: 'lifecycle suspend/activate does not email the user' },
  'AUTH-13': { status: 'deferred', reason: 'no passwordless/magic-link login endpoint exists' },

  // ---- Incident & Operations ----
  'OPS-01': { status: 'deferred', reason: 'sismo911 has no incidents domain (lives in aidrc); mirror later' },
  'OPS-02': { status: 'deferred', reason: 'no proposals/approval domain in sismo911' },
  'OPS-03': { status: 'deferred', reason: 'no proposals domain in sismo911' },
  'OPS-04': { status: 'deferred', reason: 'no incident escalation domain in sismo911' },
  'OPS-05': { status: 'deferred', reason: 'FLOTA dispatch exists; unit-dispatch email not wired yet' },
  'OPS-06': { status: 'deferred', reason: 'no SITREP digest cron in sismo911' },
  'OPS-07': { status: 'deferred', reason: 'no incident-close domain in sismo911' },

  // ---- Medical ----
  'MED-01': { status: 'deferred', reason: 'no medical triage-callout domain (telemedicina is a different flow)' },
  'MED-02': { status: 'deferred', reason: 'no hospital-capacity domain' },
  'MED-03': { status: 'deferred', reason: 'no medical-supply-request domain' },
  'MED-04': { status: 'deferred', reason: 'no patient-transfer domain' },
  'MED-05': { status: 'deferred', reason: 'no epidemic-watch domain' },

  // ---- Logistics & Supply ----
  'LOG-01': { status: 'deferred', reason: 'suministros/acopio exists; supply-request-ack email not wired' },
  'LOG-02': { status: 'deferred', reason: 'no purchase-order domain' },
  'LOG-03': { status: 'deferred', reason: 'no reorder-threshold trigger wired' },
  'LOG-04': { status: 'deferred', reason: 'no shipment-dispatch email wired' },
  'LOG-05': { status: 'deferred', reason: 'no proof-of-delivery email wired' },

  // ---- Finance & Donations ----
  'FIN-01': { status: 'wired', where: 'routes/donations.ts applyPaid → donationReceiptEmail' },
  'FIN-02': { status: 'deferred', reason: 'no Stripe card webhook (Crossmint only)' },
  'FIN-03': { status: 'not_applicable', reason: 'x402 payments identify the payer by wallet address only — no email exists in the protocol (anonymous on-chain M2M). Crypto DONATIONS already get FIN-01 (method=Cripto).' },
  'FIN-04': { status: 'deferred', reason: 'payout-initiated email not wired (withdrawals exist)' },
  'FIN-05': { status: 'deferred', reason: 'payout-settled email not wired' },
  'FIN-06': { status: 'deferred', reason: 'no refund flow' },
  'FIN-07': { status: 'deferred', reason: 'suministros-facturas exists; invoice email not wired' },
  'FIN-08': { status: 'deferred', reason: 'no grant-disbursement domain' },
  'FIN-09': { status: 'deferred', reason: 'no failed-payment retry webhook' },

  // ---- Volunteer Mgmt ----
  'VOL-01': { status: 'wired', where: 'routes/voluntarios.ts POST /register → volunteerApplicationEmail' },
  'VOL-02': { status: 'deferred', reason: 'volunteers auto-approve; no separate vetting email' },
  'VOL-03': { status: 'deferred', reason: 'no rejection decision flow' },
  'VOL-04': { status: 'deferred', reason: 'no shift-scheduling domain' },
  'VOL-05': { status: 'deferred', reason: 'no shift-reminder cron' },
  'VOL-06': { status: 'deferred', reason: 'no deployment-closeout domain' },

  // ---- Missing Persons ----
  'MP-01': { status: 'wired', where: 'routes/familia.ts POST /persons → caseRegisteredEmail (optional reporter email)' },
  'MP-02': { status: 'deferred', reason: 'face-match dup-review exists; operator email not wired' },
  'MP-03': { status: 'deferred', reason: 'reunification (localizar) does not email reporter (no email on file)' },
  'MP-04': { status: 'deferred', reason: 'public tip (investigation /:id/tip) does not capture/email tipster' },
  'MP-05': { status: 'deferred', reason: 'case-status change does not email reporter (no email on file)' },

  // ---- Public Affairs ----
  'PA-01': { status: 'deferred', reason: 'no PIO alert-dispatch domain' },
  'PA-02': { status: 'deferred', reason: 'blog publishes; no press-published email' },
  'PA-03': { status: 'deferred', reason: 'newsletter exists; emergency-alert broadcast not wired to catalog' },
  'PA-04': { status: 'deferred', reason: 'no rumor-control domain' },

  // ---- Security & Cyber ----
  'SEC-01': { status: 'deferred', reason: 'no per-account suspicious-activity emailer' },
  'SEC-02': { status: 'deferred', reason: 'no secret-rotation notifier' },
  'SEC-03': { status: 'deferred', reason: 'no SOC incident domain' },
  'SEC-04': { status: 'deferred', reason: 'no breach-notification flow' },

  // ---- Aviation & Maritime ----
  'AVM-01': { status: 'deferred', reason: 'no air-ops tasking domain' },
  'AVM-02': { status: 'deferred', reason: 'no drone-sortie domain' },
  'AVM-03': { status: 'deferred', reason: 'no airspace-deconfliction domain' },
  'AVM-04': { status: 'deferred', reason: 'no maritime-rescue domain' },

  // ---- Shelter & Recovery ----
  'SHL-01': { status: 'deferred', reason: 'refugios siting engine exists; shelter-online email not wired' },
  'SHL-02': { status: 'deferred', reason: 'no live shelter-capacity threshold trigger' },
  'SHL-03': { status: 'deferred', reason: 'no resident-intake domain' },
  'SHL-04': { status: 'deferred', reason: 'no reconstruction-task domain' },

  // ---- Compliance & Privacy ----
  'CMP-01': { status: 'deferred', reason: 'no consent-capture flow' },
  'CMP-02': { status: 'deferred', reason: 'no DSAR data-export flow' },
  'CMP-03': { status: 'deferred', reason: 'no data-deletion flow' },
  'CMP-04': { status: 'deferred', reason: 'no policy-update notifier' },

  // ---- Intelligence & Hazard ----
  'INT-01': { status: 'deferred', reason: 'USGS hazard feed exists; subscriber threshold-alert email not wired' },
  'INT-02': { status: 'deferred', reason: 'no damage-assessment email' },
  'INT-03': { status: 'deferred', reason: 'no daily hazard-briefing digest email' },

  // ---- System & DevOps ----
  'SYS-01': { status: 'not_applicable', reason: 'deploy notifications belong in CI/CD (GitHub Actions), not the runtime Worker — the Worker never observes its own deploy.' },
  'SYS-02': { status: 'wired', where: 'cron.ts runCronGroup catch → operationalAlert to OPS_ALERT_EMAIL' },
  'SYS-03': { status: 'deferred', reason: 'no quota-threshold monitor' },
  'SYS-04': { status: 'deferred', reason: 'no health-degraded monitor email' },
};

export function wiringTally(): { wired: number; deferred: number; notApplicable: number; total: number } {
  const vals = Object.values(WIRING_STATUS);
  const wired = vals.filter((v) => v.status === 'wired').length;
  const deferred = vals.filter((v) => v.status === 'deferred').length;
  const notApplicable = vals.filter((v) => v.status === 'not_applicable').length;
  return { wired, deferred, notApplicable, total: vals.length };
}
