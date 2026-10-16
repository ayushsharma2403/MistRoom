"""MistRoom Offline AI Engine: Emergency Triage, Women's Safety, Threat Prevention & Vital Extraction.
Pure Python, 100% offline execution, zero external API keys required.
Supports English, Hindi, and Hinglish disaster & emergency vocabulary.
"""
from typing import List, Dict, Tuple, Optional
import re

# -------------------------------------------------------------
# 1. PROHIBITED THREAT & ABUSE RULES
# MistRoom is built strictly for civil society, women's safety, students,
# disaster victims, and emergency personnel.
# Prohibits terrorism, riot incitement, Naxalite violence, cyber theft/malware.
# -------------------------------------------------------------
PROHIBITED_THREAT_RULES: List[Tuple[str, List[str]]] = [
    (
        "terrorism_extremism",
        [
            "bomb blast", "ied", "detonator", "r規範dx", "suicide vest",
            "jihadist attack", "terror attack", "target killing", "assassination plot",
            "recruit for terror", "plant explosives", "bomb banana", "blast karenge",
            "fidayeen", "weapon drop", "terrorist cell"
        ]
    ),
    (
        "riot_communal_violence",
        [
            "danga karo", "dange bhadkao", "aag laga do", "burn their houses", "lynch them",
            "stone pelting", "pattharbaazi", "attack the temple", "attack the mosque",
            "communal clash", "bring petrol bombs", "molo tov", "looting start",
            "riot mobilization", "gather weapons for riot", "maro unko"
        ]
    ),
    (
        "naxalite_insurgency",
        [
            "naxalite attack", "ambush police", "crpf ambush", "red corridor strike",
            "blow railway track", "overthrow government by arms", "naxali strike",
            "guerrilla ambush", "landmine ambush"
        ]
    ),
    (
        "cyber_theft_malware",
        [
            "ransomware decryptor", "rat payload", "atm skimmer", "card dumps",
            "stolen creds", "ddos tool", "buy hacked db", "bank otp bypass",
            "phishing kit", "sim swap tool", "malware injector", "steal aadhaar database"
        ]
    )
]

# -------------------------------------------------------------
# 2. EMERGENCY & WOMEN'S SAFETY RULE DEFINITIONS
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
# 3. DISASTER VITALS EXTRACTION (Regex & NLP Parsing)
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

    # 1. Victim count extraction (e.g., '4 people trapped', '2 injured', '3 log phanse')
    victim_match = re.search(r'(\d+)\s*(people|persons|victims|injured|trapped|log|bachhe|women)', t)
    if victim_match:
        try:
            vitals["victims_count"] = int(victim_match.group(1))
        except ValueError:
            pass

    # 2. Blood group extraction (e.g., 'O+', 'A-', 'AB+', 'B positive')
    blood_match = re.search(r'\b(ab|a|b|o)\s*(\+|\-|positive|negative)?(?:\s+blood)?', t, re.IGNORECASE)
    if blood_match and (blood_match.group(2) or "blood" in blood_match.group(0)):
        grp = blood_match.group(1).upper()
        sign = (blood_match.group(2) or "+").lower()
        sign_str = "-" if ("-" in sign or "neg" in sign) else "+"
        vitals["blood_type"] = f"{grp}{sign_str}"

    # 3. Urgency tag
    if any(m in t for m in URGENCY_MODIFIERS):
        vitals["urgency"] = "critical"

    # 4. Location coordinates or street hint
    if re.search(r'(near|at|opposite|road|floor|gali|chowk|sector|lat|long|gps)', t):
        vitals["has_location_hint"] = True

    return vitals


# -------------------------------------------------------------
# 4. COMPREHENSIVE TRIAGE & SAFETY INSPECTION
# -------------------------------------------------------------
def inspect_threat(text: str) -> Tuple[bool, Optional[str]]:
    """Inspect text against prohibited threat vectors.
    Returns (is_threat, threat_reason).
    """
    t = (text or "").lower()
    for category, words in PROHIBITED_THREAT_RULES:
        for w in words:
            if re.search(r'\b' + re.escape(w) + r'\b', t) or w in t:
                return True, category
    return False, None


def triage(text: str) -> Dict:
    """Analyze emergency message text and return structured intelligence dictionary.
    
    Returns:
    {
        "cat": 'women_safety' | 'sos' | 'medical' | 'water' | 'shelter' | 'general',
        "prio": 0-3,
        "is_threat": bool,
        "threat_reason": Optional[str],
        "vitals": Dict,
        "is_women_safety": bool
    }
    """
    t = (text or "").lower()

    # Step 1: Check for prohibited threat violation
    is_threat, threat_reason = inspect_threat(text)
    if is_threat:
        return {
            "cat": "blocked_threat",
            "prio": 0,
            "is_threat": True,
            "threat_reason": threat_reason,
            "vitals": {},
            "is_women_safety": False
        }

    # Step 2: Match disaster & safety rules
    best = ("general", 0, 0)  # category, priority, match_count

    for cat, prio, words in RULES:
        score = sum(1 for w in words if re.search(r'\b' + re.escape(w) + r'\b', t) or w in t)
        if score > 0:
            if prio > best[1] or (prio == best[1] and score > best[2]):
                best = (cat, prio, score)

    cat, prio, _ = best

    # Urgency & punctuation escalation
    has_urgency_word = any(mod in t for mod in URGENCY_MODIFIERS)
    has_exclamation = ("!" in text or "?!" in text)
    is_caps = len(text) > 4 and text.isupper()

    if (has_urgency_word or has_exclamation or is_caps) and 0 < prio < 3:
        prio += 1

    # Extract actionable vitals
    vitals = extract_vitals(text)
    is_women_safety = (cat == "women_safety")

    return {
        "cat": cat,
        "prio": prio,
        "is_threat": False,
        "threat_reason": None,
        "vitals": vitals,
        "is_women_safety": is_women_safety
    }
