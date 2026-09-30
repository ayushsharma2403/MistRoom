"""On-device AI for MistRoom: emergency triage + situation summary.
Pure Python, runs offline, no API keys."""

RULES = [  # (category, priority, keywords). Hindi/Hinglish words included.
    ("sos", 3, ["sos", "help me", "emergency", "trapped", "drowning", "fire", "collapsed",
                "attack", "dying", "madad", "bachao", "bachaao", "aag"]),
    ("medical", 2, ["bleeding", "injured", "injury", "hurt", "unconscious", "broken", "pain",
                    "medicine", "doctor", "ambulance", "pregnant", "insulin", "breathing",
                    "dawai", "ghayal", "chot"]),
    ("water", 1, ["water", "food", "hungry", "thirsty", "milk", "baby", "paani", "khana", "bhook"]),
    ("shelter", 1, ["shelter", "roof", "blanket", "cold", "stuck", "road blocked", "evacuate",
                    "safe place", "ghar", "rescue"]),
]


def triage(text: str) -> tuple[str, int]:
    """Return (category, priority 0-3) for a message."""
    t = text.lower()
    best = ("general", 0, 0)  # cat, prio, score
    for cat, prio, words in RULES:
        score = sum(w in t for w in words)
        if score and (prio > best[1] or (prio == best[1] and score > best[2])):
            best = (cat, prio, score)
    cat, prio, _ = best
    if "!!" in text and 0 < prio < 3:  # urgency boost
        prio += 1
    return cat, prio


def summarize(msgs: list[dict]) -> str:
    """Short situation update for rescuers."""
    if not msgs:
        return "No messages yet."
    count = lambda c: sum(m["cat"] == c for m in msgs)
    people = len({m["from"] for m in msgs})
    s = (f"{len(msgs)} messages from {people} people. SOS: {count('sos')}, "
         f"medical: {count('medical')}, water/food: {count('water')}, shelter: {count('shelter')}.")
    urgent = [m for m in msgs if m["prio"] >= 2][-3:]
    if urgent:
        s += " Latest urgent: " + " | ".join(f"{m['from']}: \"{m['text'][:60]}\"" for m in urgent)
    return s
