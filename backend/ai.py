"""MistRoom Offline AI Engine: Emergency Triage, Women's Safety & Vital Extraction.
Pure Python, 100% offline execution, zero external API keys required.
Supports English, Hindi, and Hinglish disaster & emergency vocabulary.
"""
from typing import List, Dict, Tuple
import re

# -------------------------------------------------------------
# 1. EMERGENCY & WOMEN'S SAFETY RULE DEFINITIONS
# -------------------------------------------------------------
RULES: List[Tuple[str, int, List[str]]] = [
    # Women's Safety & Anti-Harassment (Prio 3)
    (
        "women_safety",
        3,
        [
            "following me", "stalking", "stalker", "harassment", "unsafe", "molested",
            "cab driver wrong route", "cornered", "alone in dark", "trying to grab me",
            "chhedchhad", "pichha kar raha", "koi pichhe pada hai", "dara raha hai",
            "galat jagah le ja raha", "akeli hoon", "bachao koi", "unsafe feeling",
            "forcefully pulling", "eve teasing", "emergency women", "#safe", "#helpme"
        ]
    ),
    # Immediate Life Threat & Disaster SOS (Prio 3)
    (
        "sos",
        3,
        [
            "sos", "help", "help me", "emergency", "trapped", "drowning", "fire",
            "collapsed", "attack", "dying", "danger", "khatra", "madad", "bachao",
            "bachaao", "aag", "phans gaye", "phas gaya", "doob", "emergency call",
            "save us", "need rescue", "send help", "landslide trapped"
        ]
    ),
    # Medical Emergencies & Critical Injuries (Prio 2)
    (
        "medical",
        2,
        [
            "bleeding", "injured", "injury", "hurt", "unconscious", "broken",
            "fracture", "pain", "medicine", "doctor", "ambulance", "pregnant",
            "delivery", "insulin", "breathing", "asthma", "heart attack", "stroke",
            "burn", "dawai", "ghayal", "chot", "khoon", "dard", "saans", "behosh",
            "bimari", "medic", "blood needed", "snake bite"
        ]
    ),
    # Essential Supplies: Water, Food & Infant Needs (Prio 1)
    (
        "water",
        1,
        [
            "water", "clean water", "drinking water", "food", "ration", "hungry",
            "starving", "thirsty", "milk", "baby food", "infant", "paani", "khana",
            "bhook", "bhookh", "pyaas", "doodh", "bache ke liye"
        ]
    ),
    # Evacuation & Shelter Requirements (Prio 1)
    (
        "shelter",
        1,
        [
            "shelter", "roof", "blanket", "tarp", "cold", "hypothermia", "stuck",
            "road blocked", "evacuate", "landslide", "flood", "safe place", "ghar",
            "rescue camp", "chhat", "sardi", "thand", "rasta band", "sharan"
        ]
    )
]

URGENCY_MODIFIERS = [
    "urgent", "immediately", "right now", "jaldi", "turant", "critical",
    "asap", "can't breathe", "failing", "severe", "life threat"
]


# -------------------------------------------------------------
# 2. DISASTER VITALS EXTRACTION (Regex & NLP Parsing)
# -------------------------------------------------------------
def extract_vitals(text: str) -> Dict:
    """Extract actionable medical, casualty, and logistical signals from text."""
    vitals = {
        "victims_count": None,
        "blood_type": None,
        "urgency": "normal",
        "has_location_hint": False
    }
    t = (text or "").lower()

    victim_match = re.search(r'(\d+)\s*(people|persons|victims|injured|trapped|log|bachhe|women)', t)
    if victim_match:
        try:
            vitals["victims_count"] = int(victim_match.group(1))
        except ValueError:
            pass

    blood_match = re.search(r'\b(ab|a|b|o)\s*(\+|\-|positive|negative)?(?:\s+blood)?', t, re.IGNORECASE)
    if blood_match and (blood_match.group(2) or "blood" in blood_match.group(0)):
        grp = blood_match.group(1).upper()
        sign = (blood_match.group(2) or "+").lower()
        sign_str = "-" if ("-" in sign or "neg" in sign) else "+"
        vitals["blood_type"] = f"{grp}{sign_str}"

    if any(m in t for m in URGENCY_MODIFIERS):
        vitals["urgency"] = "critical"

    if re.search(r'(near|at|opposite|road|floor|gali|chowk|sector|lat|long|gps)', t):
        vitals["has_location_hint"] = True

    return vitals


# -------------------------------------------------------------
# 3. TRIAGE CLASSIFICATION
# -------------------------------------------------------------
def triage(text: str) -> Dict:
    """Analyze emergency message text and return structured intelligence dictionary."""
    t = (text or "").lower()
    best = ("general", 0, 0)

    for cat, prio, words in RULES:
        score = sum(1 for w in words if re.search(r'\b' + re.escape(w) + r'\b', t) or w in t)
        if score > 0:
            if prio > best[1] or (prio == best[1] and score > best[2]):
                best = (cat, prio, score)

    cat, prio, _ = best

    has_urgency_word = any(mod in t for mod in URGENCY_MODIFIERS)
    has_exclamation = ("!" in text or "?!" in text)
    is_caps = len(text) > 4 and text.isupper()

    if (has_urgency_word or has_exclamation or is_caps) and 0 < prio < 3:
        prio += 1

    vitals = extract_vitals(text)
    is_women_safety = (cat == "women_safety")

    return {
        "cat": cat,
        "prio": prio,
        "vitals": vitals,
        "is_women_safety": is_women_safety
    }
