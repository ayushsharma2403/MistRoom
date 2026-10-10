"""On-device AI for MistRoom: multilingual emergency triage, severity scoring & situation summarization.
Pure Python, runs completely offline, zero external API keys needed.
"""
from typing import List, Dict, Tuple
import re

RULES: List[Tuple[str, int, List[str]]] = [
    # SOS & Immediate Life Threat (Prio 3)
    (
        "sos",
        3,
        [
            "sos", "help", "help me", "emergency", "trapped", "drowning", "fire",
            "collapsed", "attack", "dying", "danger", "khatra", "madad", "bachao",
            "bachaao", "aag", "phans gaye", "phas gaya", "doob", "emergency call",
            "save us", "need rescue", "send help"
        ],
    ),
    # Medical Emergencies & Injuries (Prio 2)
    (
        "medical",
        2,
        [
            "bleeding", "injured", "injury", "hurt", "unconscious", "broken",
            "fracture", "pain", "medicine", "doctor", "ambulance", "pregnant",
            "delivery", "insulin", "breathing", "asthma", "heart attack", "stroke",
            "burn", "dawai", "ghayal", "chot", "khoon", "dard", "saans", "behosh",
            "bimari", "medic"
        ],
    ),
    # Essential Rations: Water, Food & Infant Needs (Prio 1)
    (
        "water",
        1,
        [
            "water", "clean water", "drinking water", "food", "ration", "hungry",
            "starving", "thirsty", "milk", "baby food", "infant", "paani", "khana",
            "bhook", "bhookh", "pyaas", "doodh", "bache ke liye"
        ],
    ),
    # Evacuation & Shelter Requirements (Prio 1)
    (
        "shelter",
        1,
        [
            "shelter", "roof", "blanket", "tarp", "cold", "hypothermia", "stuck",
            "road blocked", "evacuate", "landslide", "flood", "safe place", "ghar",
            "rescue camp", "chhat", "sardi", "thand", "rasta band", "sharan"
        ],
    ),
]

URGENCY_MODIFIERS = [
    "urgent", "immediately", "right now", "jaldi", "turant", "critical",
    "asap", "can't breathe", "failing", "severe"
]


def triage(text: str) -> Tuple[str, int]:
    """Analyze emergency message text and return (category, priority 0-3)."""
    t = (text or "").lower()
    best = ("general", 0, 0)  # cat, prio, score

    for cat, prio, words in RULES:
        score = sum(1 for w in words if re.search(r'\b' + re.escape(w) + r'\b', t) or w in t)
        if score > 0:
            if prio > best[1] or (prio == best[1] and score > best[2]):
                best = (cat, prio, score)

    cat, prio, _ = best

    # Urgency & exclamation analysis
    has_urgency_word = any(mod in t for mod in URGENCY_MODIFIERS)
    has_exclamation = ("!" in text or "?!" in text)
    is_caps = len(text) > 4 and text.isupper()

    if (has_urgency_word or has_exclamation or is_caps) and 0 < prio < 3:
        prio += 1

    return cat, prio


def summarize(msgs: List[Dict]) -> str:
    """Generate crisis situation report for emergency responders and peer units."""
    if not msgs:
        return "No messages recorded in this emergency cluster."

    count = lambda c: sum(1 for m in msgs if m.get("cat") == c)
    unique_senders = len({m.get("from") or m.get("sender") for m in msgs})

    sos_count = count("sos")
    med_count = count("medical")
    water_count = count("water")
    shelter_count = count("shelter")

    report_lines = [
        f"[SITUATION REPORT] {len(msgs)} messages from {unique_senders} active peer(s).",
        f"Priority Breakdown -> SOS: {sos_count} | Medical: {med_count} | Water/Food: {water_count} | Shelter: {shelter_count}."
    ]

    # Collect latest high-priority incidents (prio >= 2)
    urgent = [m for m in msgs if m.get("prio", 0) >= 2][-3:]
    if urgent:
        snippets = []
        for m in urgent:
            sender = m.get("from") or m.get("sender") or "Peer"
            # Support both plaintext preview or encrypted notice
            txt = m.get("text") or "[E2EE Protected Message]"
            snippets.append(f"{sender}: \"{txt[:50]}\"")
        report_lines.append(f"[Recent Critical] {' | '.join(snippets)}")
    else:
        report_lines.append("[Status] No critical priority alerts currently active.")

    return " \n".join(report_lines)
