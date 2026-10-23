/**
 * Signed Responder Badges module for MistRoom.
 * Supports authority public key trust list, badge import, signature verification,
 * expiry check, and revocation list management.
 */
import { state, $ } from './state.js';
import { base64ToBytes, derivePeerIdFromPk } from './crypto.js';
import { ed25519 } from '../vendor/noble-crypto.js';

const TRUSTED_AUTH_STORAGE_KEY = 'mistroom_trusted_authorities';
const MY_BADGE_STORAGE_KEY = 'mistroom_my_badge';
const REVOKED_LIST_STORAGE_KEY = 'mistroom_revoked_badges';

export function getTrustedAuthorities() {
  try {
    const raw = localStorage.getItem(TRUSTED_AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

export function addTrustedAuthority(name, pubkeyB64) {
  const list = getTrustedAuthorities();
  const cleanedPk = pubkeyB64.trim();
  if (!list.some(a => a.pubkey === cleanedPk)) {
    list.push({ name: name.trim() || 'Unknown Authority', pubkey: cleanedPk });
    localStorage.setItem(TRUSTED_AUTH_STORAGE_KEY, JSON.stringify(list));
  }
}

export function getRevocations() {
  try {
    const raw = localStorage.getItem(REVOKED_LIST_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

export function addRevocationList(revocationObj) {
  if (!revocationObj || !revocationObj.issuer_pk || !revocationObj.sig) {
    throw new Error('Invalid revocation list format');
  }
  // Verify revocation signature
  const canonicalBytes = canonicalRevocationBytes(revocationObj);
  const issuerPkBytes = base64ToBytes(revocationObj.issuer_pk);
  const sigBytes = base64ToBytes(revocationObj.sig);
  const valid = ed25519.verify(sigBytes, canonicalBytes, issuerPkBytes);
  if (!valid) {
    throw new Error('Revocation list signature invalid');
  }

  const current = getRevocations();
  for (const sub of (revocationObj.revoked_subjects || [])) {
    if (!current.includes(sub)) {
      current.push(sub);
    }
  }
  localStorage.setItem(REVOKED_LIST_STORAGE_KEY, JSON.stringify(current));
}

function canonicalBadgeBytes(badge) {
  const keys = Object.keys(badge).filter(k => k !== 'sig').sort();
  const obj = {};
  for (const k of keys) {
    obj[k] = badge[k];
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

function canonicalRevocationBytes(payload) {
  const keys = Object.keys(payload).filter(k => k !== 'sig').sort();
  const obj = {};
  for (const k of keys) {
    obj[k] = payload[k];
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function verifyBadge(badge, expectedSubjectPk = null) {
  if (!badge || badge.v !== 1) {
    return { status: 'invalid', reason: 'Malformed badge' };
  }

  // 1. Expiry check
  const now = Math.floor(Date.now() / 1000);
  if (badge.expires_at && now > badge.expires_at) {
    return { status: 'expired', reason: 'Badge expired' };
  }

  // 2. Subject match check
  if (expectedSubjectPk && badge.subject_pk !== expectedSubjectPk) {
    return { status: 'subject_mismatch', reason: 'Subject does not match sender' };
  }

  // 3. Revocation check
  const revocations = getRevocations();
  if (revocations.includes(badge.subject_pk)) {
    return { status: 'revoked', reason: 'Badge has been revoked by authority' };
  }

  // 4. Signature check
  try {
    const dataBytes = canonicalBadgeBytes(badge);
    const issuerBytes = base64ToBytes(badge.issuer_pk);
    const sigBytes = base64ToBytes(badge.sig);
    const valid = ed25519.verify(sigBytes, dataBytes, issuerBytes);
    if (!valid) {
      return { status: 'invalid_sig', reason: 'Cryptographic signature invalid' };
    }
  } catch (e) {
    return { status: 'invalid_sig', reason: 'Signature verification error' };
  }

  // 5. Authority trust check
  const trusted = getTrustedAuthorities();
  const isTrusted = trusted.some(a => a.pubkey === badge.issuer_pk);
  if (!isTrusted) {
    return { status: 'untrusted', reason: 'Authority not in user trust list', badge };
  }

  return { status: 'verified', badge };
}

export function issueBadge({ issuerName, issuerPkB64, issuerPrivKeyBytes, subjectPkB64, role = 'medic', validityDays = 30 }) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + validityDays * 86400;
  const badgePayload = {
    v: 1,
    issuer_name: issuerName,
    issuer_pk: issuerPkB64,
    subject_pk: subjectPkB64,
    role: role,
    issued_at: now,
    expires_at: expiresAt
  };
  const canonicalBytes = canonicalBadgeBytes(badgePayload);
  const sigBytes = ed25519.sign(canonicalBytes, issuerPrivKeyBytes);
  const sigB64 = btoa(String.fromCharCode(...sigBytes));
  return {
    ...badgePayload,
    sig: sigB64
  };
}

export function getMyBadge() {
  try {
    const raw = localStorage.getItem(MY_BADGE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function setMyBadge(badgeObj) {
  localStorage.setItem(MY_BADGE_STORAGE_KEY, JSON.stringify(badgeObj));
}
