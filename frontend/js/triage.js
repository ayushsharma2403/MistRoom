/**
 * Client-Side Emergency & Women's Safety Triage.
 * Loads /shared/triage_rules.json as the single source of truth.
 * Full Unicode word-boundary matching with /(?<![\p{L}\p{N}_])word(?![\p{L}\p{N}_])/iu
 */

let RULES_DATA = null;
let CATEGORY_REGEXES = null;
let FIRST_PERSON_REGEXES = [];
let URGENCY_REGEXES = [];
let LOCATION_REGEXES = [];
let NEGATION_REGEXES = [];
let BENIGN_REGEXES = [];

const BLOOD_REGEX = /(?<![\p{L}\p{N}_])(A|B|AB|O)\s*(\+|\-|positive|negative)\s*(blood)?(?![\p{L}\p{N}_])/iu;
const VICTIM_REGEX = /(\d+)\s*(people|persons|victims|injured|trapped|log|bachhe|women|mahilayein|bache)/iu;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordPattern(phrase) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(phrase)}(?![\\p{L}\\p{N}_])`, 'iu');
}

export async function initTriageRules() {
  if (RULES_DATA) return RULES_DATA;
  try {
    const res = await fetch('/shared/triage_rules.json');
    RULES_DATA = await res.json();
  } catch (e) {
    console.debug('Failed to fetch triage_rules.json, using fallback cache');
    return null;
  }

  CATEGORY_REGEXES = {};
  for (const [cat, info] of Object.entries(RULES_DATA.categories)) {
    CATEGORY_REGEXES[cat] = {
      prio: info.default_prio,
      strong: (info.strong_phrases || []).map(p => wordPattern(p)),
      weak: (info.weak_words || []).map(w => wordPattern(w))
    };
  }

  FIRST_PERSON_REGEXES = (RULES_DATA.first_person_signals || []).map(s => wordPattern(s));
  URGENCY_REGEXES = (RULES_DATA.urgency_words || []).map(u => wordPattern(u));
  LOCATION_REGEXES = (RULES_DATA.location_hints || []).map(l => wordPattern(l));
  NEGATION_REGEXES = (RULES_DATA.negation_guards || []).map(n => wordPattern(n));
  BENIGN_REGEXES = (RULES_DATA.benign_phrases || []).map(b => wordPattern(b));

  return RULES_DATA;
}

export function extractVitals(text) {
  const vitals = {
    victims_count: null,
    blood_type: null,
    urgency: 'normal',
    has_location_hint: false
  };
  const raw = text || '';

  const vMatch = raw.match(VICTIM_REGEX);
  if (vMatch) {
    const count = parseInt(vMatch[1], 10);
    if (!isNaN(count)) vitals.victims_count = count;
  }

  const bMatch = raw.match(BLOOD_REGEX);
  if (bMatch) {
    const grp = bMatch[1].toUpperCase();
    const signRaw = (bMatch[2] || '').toLowerCase();
    const sign = (signRaw.includes('-') || signRaw.includes('neg')) ? '-' : '+';
    vitals.blood_type = `${grp}${sign}`;
  }

  if (URGENCY_REGEXES.some(rgx => rgx.test(raw))) {
    vitals.urgency = 'critical';
  }

  if (LOCATION_REGEXES.some(rgx => rgx.test(raw))) {
    vitals.has_location_hint = true;
  }

  return vitals;
}

export function triageText(text) {
  const raw = text || '';
  const vitals = extractVitals(raw);

  if (!CATEGORY_REGEXES) {
    // If rules haven't finished loading yet, simple emergency fallback
    const isEmerg = /\b(sos|bachao|madad|trapped|drowning|fire)\b/i.test(raw);
    return {
      cat: isEmerg ? 'sos' : 'general',
      prio: isEmerg ? 3 : 0,
      vitals,
      is_women_safety: false,
      isSOS: isEmerg
    };
  }

  const isBenign = BENIGN_REGEXES.some(rgx => rgx.test(raw));
  const hasFirstPerson = FIRST_PERSON_REGEXES.some(rgx => rgx.test(raw));
  const hasUrgency = vitals.urgency === 'critical';
  const hasExclamation = raw.includes('!') || raw.includes('?!');
  const hasVictims = vitals.victims_count !== null;
  const hasLoc = vitals.has_location_hint;

  const hasSupportingSignal = (
    hasFirstPerson || hasUrgency || hasExclamation || hasVictims || hasLoc
  );

  let detectedCat = 'general';
  let detectedPrio = 0;

  // 1. Strong phrases: immediate classification
  if (!isBenign) {
    for (const [cat, data] of Object.entries(CATEGORY_REGEXES)) {
      if (data.strong.some(rgx => rgx.test(raw))) {
        if (data.prio > detectedPrio) {
          detectedCat = cat;
          detectedPrio = data.prio;
        }
      }
    }
  }

  // 2. Weak words: only count if another signal is present and not benign
  if (detectedCat === 'general' && hasSupportingSignal && !isBenign) {
    for (const [cat, data] of Object.entries(CATEGORY_REGEXES)) {
      if (data.weak.some(rgx => rgx.test(raw))) {
        if (data.prio > detectedPrio) {
          detectedCat = cat;
          detectedPrio = data.prio;
        }
      }
    }
  }

  // 3. Negation & benign guard checks (lowers priority by one level)
  if (detectedPrio > 0 && NEGATION_REGEXES.some(rgx => rgx.test(raw))) {
    detectedPrio = Math.max(1, detectedPrio - 1);
  }

  return {
    cat: detectedCat,
    prio: detectedPrio,
    vitals,
    is_women_safety: detectedCat === 'women_safety',
    isSOS: detectedPrio === 3
  };
}
