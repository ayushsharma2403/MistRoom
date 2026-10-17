/**
 * Client-Side Emergency, Women's Safety & Threat Triage.
 */
export const CLIENT_THREAT_KEYWORDS = [
  'bomb blast', 'ied', 'suicide vest', 'terror attack', 'assassination plot',
  'plant explosives', 'danga karo', 'dange bhadkao', 'aag laga do', 'lynch them',
  'stone pelting', 'pattharbaazi', 'naxalite attack', 'ambush police',
  'ransomware decryptor', 'atm skimmer', 'stolen creds', 'ddos tool', 'bank otp bypass'
];

export const CLIENT_WOMEN_SAFETY_KEYWORDS = [
  'following me', 'stalking', 'stalker', 'harassment', 'unsafe', 'molested',
  'cab driver wrong route', 'cornered', 'alone in dark', 'trying to grab me',
  'chhedchhad', 'pichha kar raha', 'koi pichhe pada hai', 'dara raha hai',
  'galat jagah le ja raha', 'akeli hoon', 'bachao koi', 'eve teasing', '#safe', '#helpme'
];

export function triageText(text) {
  const lower = (text || '').toLowerCase();

  for (const kw of CLIENT_THREAT_KEYWORDS) {
    if (lower.includes(kw)) {
      return { cat: 'blocked_threat', prio: 0, isThreat: true };
    }
  }

  for (const kw of CLIENT_WOMEN_SAFETY_KEYWORDS) {
    if (lower.includes(kw)) {
      return { cat: 'women_safety', prio: 3, isSOS: true, isWomenSafety: true };
    }
  }

  const isSOS = /\b(sos|emergency|help|danger|bachao|madad|trapped|fire|drowning)\b/i.test(lower);
  if (isSOS) {
    return { cat: 'sos', prio: 3, isSOS: true };
  }

  return { cat: 'general', prio: 0 };
}
