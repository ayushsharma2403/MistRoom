"""MistRoom Emergency Triage & Vitals Engine.
Uses shared/triage_rules.json as the single source of truth.
Pure Python, 100% offline execution.
"""
import json
import re
from pathlib import Path
from typing import Dict, Any

RULES_PATH = Path(__file__).resolve().parent.parent / "shared" / "triage_rules.json"

with open(RULES_PATH, "r", encoding="utf-8") as f:
    RULES_DATA: Dict[str, Any] = json.load(f)

CATEGORIES = RULES_DATA["categories"]
FIRST_PERSON_SIGNALS = RULES_DATA["first_person_signals"]
URGENCY_WORDS = RULES_DATA["urgency_words"]
LOCATION_HINTS = RULES_DATA["location_hints"]
NEGATION_GUARDS = RULES_DATA["negation_guards"]
BENIGN_PHRASES = RULES_DATA.get("benign_phrases", [])


def word_pattern(phrase: str) -> re.Pattern:
    """Build Unicode-aware whole-word/phrase regex."""
    escaped = re.escape(phrase)
    return re.compile(rf"(?<!\w){escaped}(?!\w)", re.IGNORECASE | re.UNICODE)


CATEGORY_REGEXES = {
    cat: {
        "prio": info["default_prio"],
        "strong": [word_pattern(p) for p in info.get("strong_phrases", [])],
        "weak": [word_pattern(w) for w in info.get("weak_words", [])]
    }
    for cat, info in CATEGORIES.items()
}

FIRST_PERSON_REGEXES = [word_pattern(s) for s in FIRST_PERSON_SIGNALS]
URGENCY_REGEXES = [word_pattern(u) for u in URGENCY_WORDS]
LOCATION_REGEXES = [word_pattern(l) for l in LOCATION_HINTS]
NEGATION_REGEXES = [word_pattern(n) for n in NEGATION_GUARDS]
BENIGN_REGEXES = [word_pattern(b) for b in BENIGN_PHRASES]

BLOOD_REGEX = re.compile(r"(?<!\w)(A|B|AB|O)\s*(\+|\-|positive|negative)\s*(blood)?(?!\w)", re.IGNORECASE | re.UNICODE)
VICTIM_REGEX = re.compile(r"(\d+)\s*(people|persons|victims|injured|trapped|log|bachhe|women|mahilayein|bache)", re.IGNORECASE | re.UNICODE)


def extract_vitals(text: str) -> Dict[str, Any]:
    """Extract medical, casualty, and location hints from message text."""
    vitals = {
        "victims_count": None,
        "blood_type": None,
        "urgency": "normal",
        "has_location_hint": False
    }
    raw = text or ""

    # Victims count
    v_match = VICTIM_REGEX.search(raw)
    if v_match:
        try:
            vitals["victims_count"] = int(v_match.group(1))
        except ValueError:
            pass

    # Blood type - strict regex prevents "a person" or "I am a boy" from matching
    b_match = BLOOD_REGEX.search(raw)
    if b_match:
        grp = b_match.group(1).upper()
        sign_raw = b_match.group(2).lower()
        sign = "-" if ("-" in sign_raw or "neg" in sign_raw) else "+"
        vitals["blood_type"] = f"{grp}{sign}"

    # Urgency check
    if any(rgx.search(raw) for rgx in URGENCY_REGEXES):
        vitals["urgency"] = "critical"

    # Location hint
    if any(rgx.search(raw) for rgx in LOCATION_REGEXES):
        vitals["has_location_hint"] = True

    return vitals


def triage(text: str) -> Dict[str, Any]:
    """Classify text using the two-tier strong/weak rule system."""
    raw = text or ""
    vitals = extract_vitals(raw)

    is_benign = any(rgx.search(raw) for rgx in BENIGN_REGEXES)

    has_first_person = any(rgx.search(raw) for rgx in FIRST_PERSON_REGEXES)
    has_urgency = (vitals["urgency"] == "critical")
    has_exclamation = ("!" in raw or "?!" in raw)
    has_victims = (vitals["victims_count"] is not None)
    has_loc = vitals["has_location_hint"]

    has_supporting_signal = (
        has_first_person or has_urgency or has_exclamation or has_victims or has_loc
    )

    detected_cat = "general"
    detected_prio = 0

    # 1. Check strong phrases first (immediate classification)
    if not is_benign:
        for cat, data in CATEGORY_REGEXES.items():
            if any(rgx.search(raw) for rgx in data["strong"]):
                if data["prio"] > detected_prio:
                    detected_cat = cat
                    detected_prio = data["prio"]

    # 2. Check weak words only if supporting signal is present and not benign
    if detected_cat == "general" and has_supporting_signal and not is_benign:
        for cat, data in CATEGORY_REGEXES.items():
            if any(rgx.search(raw) for rgx in data["weak"]):
                if data["prio"] > detected_prio:
                    detected_cat = cat
                    detected_prio = data["prio"]

    # 3. Negation & benign guard checks (lowers priority by one level)
    if detected_prio > 0 and any(rgx.search(raw) for rgx in NEGATION_REGEXES):
        detected_prio = max(1, detected_prio - 1)

    return {
        "cat": detected_cat,
        "prio": detected_prio,
        "vitals": vitals,
        "is_women_safety": (detected_cat == "women_safety"),
        "isSOS": (detected_prio == 3)
    }
