// src/security/spam-score.ts
//
// Weighted spam scoring. Each signal adds points; a submission is rejected when
// the total reaches SPAM_THRESHOLD (default 100, configurable via env). Scoring
// (vs. hard yes/no) lets a single weak signal pass while a stack of them blocks,
// which is what we want for citizen disaster reports — we must NOT lose a real
// "trapped people" report over one heuristic, but we must stop bot floods.
//
// Calibrated against the real abuse this site has seen (see lib/security.ts /
// lib/clean.ts comments): the "infinityhotel.it" link-spam name, the "SIMONE
// BURATTI" ×353 flood, and the stored-XSS '<svg/onload=…>' name flood — each of
// those alone scores >= 100 and is blocked.

import { SPAM_PHRASES } from '../lib/clean';
import { nameHasMarkup, nameHasSpam } from '../lib/security';
import {
  looksLikeCommandInjection,
  looksLikePromptInjection,
  looksLikeSqlInjection,
  hasHiddenUnicode,
} from './validators';

export interface SpamSignal {
  code: string;
  points: number;
  field?: string;
}
export interface SpamScore {
  score: number;
  signals: SpamSignal[];
}

// Built-in disposable / throwaway email domains. Extended at runtime by
// env.EMAIL_BLOCKLIST. Kept short + high-signal; this is a hook, not a complete
// list (a full list belongs in KV — see isDisposableEmail()).
export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'getnada.com',
  'trashmail.com', 'sharklasers.com', 'maildrop.cc', 'fakeinbox.com', 'dispostable.com',
  'mailnesia.com', 'mintemail.com', 'spamgourmet.com', 'mohmal.com', 'emailondeck.com',
]);

export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const m = /^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(email.trim());
  return m ? m[1].toLowerCase() : null;
}

export function isDisposableEmail(
  email: string | null | undefined,
  extra?: Set<string>,
): boolean {
  const d = emailDomain(email);
  if (!d) return false;
  if (DISPOSABLE_EMAIL_DOMAINS.has(d)) return true;
  return !!extra && extra.has(d);
}

export interface ScoreInput {
  // Fields that must read like a human-entered short name (strict).
  names?: Array<{ field: string; value: string | null | undefined }>;
  // Free-text fields (links allowed; markup/injection penalized).
  texts?: Array<{ field: string; value: string | null | undefined }>;
  email?: string | null;
  // Honeypot field value — ANY non-empty value means a bot filled a hidden input.
  honeypot?: string | null;
  userAgent?: string | null;
  // True if this exact payload/file hash was already seen (replay/dup).
  repeatHash?: boolean;
  // Extra disposable-email domains from env.
  extraDisposable?: Set<string>;
}

// Point weights. Anything >= threshold (default 100) blocks. A single decisive
// abuse signal is worth a full block on its own.
const W = {
  honeypot: 100,
  nameMarkup: 100, // stored-XSS in a name/title
  nameSpam: 100, // link/bare-domain/spam-phrase in a name
  spamPhrase: 100,
  repeatHash: 80, // identical content resubmitted
  hiddenUnicode: 40,
  promptInjection: 60,
  sqlInjection: 50,
  cmdInjection: 50,
  disposableEmail: 60,
  missingUa: 25,
  botUa: 70,
  allCaps: 20, // shouting name (weak signal)
  manyLinksInText: 30, // 3+ links in one description (weak signal)
} as const;

const BOT_UA_RE = /\b(curl|wget|python-requests|scrapy|httpclient|go-http-client|libwww|java\/|okhttp|axios\/|node-fetch)\b/i;
const LINK_RE = /(https?:\/\/|www\.)/gi;

export function scoreSpam(input: ScoreInput): SpamScore {
  const signals: SpamSignal[] = [];
  const add = (code: string, points: number, field?: string) =>
    signals.push({ code, points, field });

  if (input.honeypot && input.honeypot.trim() !== '') add('honeypot_filled', W.honeypot);

  for (const { field, value } of input.names ?? []) {
    if (!value) continue;
    if (nameHasMarkup(value)) add('name_markup', W.nameMarkup, field);
    else if (nameHasSpam(value)) add('name_spam', W.nameSpam, field);
    if (hasHiddenUnicode(value)) add('hidden_unicode', W.hiddenUnicode, field);
    const letters = value.replace(/[^a-zà-ÿ]/gi, '');
    if (letters.length >= 8 && value === value.toUpperCase() && /[a-zà-ÿ]/i.test(value) === false) {
      // all-caps with no lowercase letters at all
      add('all_caps', W.allCaps, field);
    }
  }

  for (const { field, value } of input.texts ?? []) {
    if (!value) continue;
    if (SPAM_PHRASES.some((p) => value.toLowerCase().includes(p))) add('spam_phrase', W.spamPhrase, field);
    if (hasHiddenUnicode(value)) add('hidden_unicode', W.hiddenUnicode, field);
    if (looksLikePromptInjection(value)) add('prompt_injection', W.promptInjection, field);
    if (looksLikeSqlInjection(value)) add('sql_injection', W.sqlInjection, field);
    if (looksLikeCommandInjection(value)) add('cmd_injection', W.cmdInjection, field);
    const links = (value.match(LINK_RE) || []).length;
    if (links >= 3) add('many_links', W.manyLinksInText, field);
  }

  if (isDisposableEmail(input.email, input.extraDisposable)) add('disposable_email', W.disposableEmail);

  const ua = (input.userAgent ?? '').trim();
  if (!ua) add('missing_user_agent', W.missingUa);
  else if (BOT_UA_RE.test(ua)) add('bot_user_agent', W.botUa);

  if (input.repeatHash) add('repeat_payload', W.repeatHash);

  const score = signals.reduce((t, s) => t + s.points, 0);
  return { score, signals };
}
