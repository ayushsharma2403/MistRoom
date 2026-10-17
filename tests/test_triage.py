"""Regression and comprehensive test suite for MistRoom triage engine."""
import pytest
from backend.triage import triage


def test_triage_sos_immediate():
    res = triage("SOS! I need immediate help.")
    assert res["cat"] == "sos"
    assert res["prio"] == 3


def test_triage_general_hello():
    res = triage("hello how are you")
    assert res["cat"] == "general"
    assert res["prio"] == 0


def test_triage_women_safety_following():
    res = triage("someone is following me")
    assert res["cat"] == "women_safety"
    assert res["prio"] == 3


def test_triage_general_help_project():
    res = triage("can you help me with my project")
    assert res["cat"] == "general"
    assert res["prio"] == 0


def test_triage_general_fire_song():
    res = triage("the fire in this song is great")
    assert res["cat"] == "general"
    assert res["prio"] == 0


def test_triage_general_unsafe_chair():
    res = triage("this chair is unsafe to sit on")
    assert res["cat"] == "general"
    assert res["prio"] == 0


def test_triage_cafe_not_blocked():
    # "tried" must not match weak word "ied"
    res = triage("I tried the new cafe")
    assert res["cat"] == "general"
    assert res["prio"] == 0


def test_triage_medical_bleeding():
    res = triage("bleeding heavily, need ambulance")
    assert res["cat"] == "medical"
    assert res["prio"] >= 2


def test_triage_water_drinking():
    res = triage("need drinking water for 5 people")
    assert res["cat"] == "water"
    assert res["prio"] >= 1


def test_triage_shelter_stuck():
    res = triage("we are stuck, road blocked, flood")
    assert res["cat"] == "shelter"
    assert res["prio"] >= 1


def test_triage_sos_hinglish_aag():
    res = triage("aag lag gayi")
    assert res["cat"] == "sos"
    assert res["prio"] == 3


def test_triage_devanagari_madad():
    res = triage("मदद करो बचाओ")
    assert res["cat"] == "sos"
    assert res["prio"] == 3


def test_triage_devanagari_paani():
    res = triage("पानी चाहिए")
    assert res["cat"] == "water"
    assert res["prio"] >= 1


def test_triage_vitals_extraction():
    res = triage("4 people trapped, need O+ blood")
    assert res["cat"] == "sos"
    assert res["prio"] == 3
    assert res["vitals"]["victims_count"] == 4
    assert res["vitals"]["blood_type"] == "O+"


# -------------------------------------------------------------
# 15 ADDITIONAL CASES (Hinglish, Devanagari, Benign & Vitals)
# -------------------------------------------------------------
def test_triage_weak_fire_with_exclamation_and_help():
    res = triage("fire! help")
    assert res["cat"] == "sos"
    assert res["prio"] == 3


def test_triage_weak_trapped_first_person():
    res = triage("I am trapped")
    assert res["cat"] == "sos"
    assert res["prio"] == 3


def test_triage_hinglish_women_safety_pichha():
    res = triage("koi pichhe pada hai")
    assert res["cat"] == "women_safety"
    assert res["prio"] == 3


def test_triage_hinglish_women_safety_akeli():
    res = triage("akeli hoon andhera hai dara raha hai")
    assert res["cat"] == "women_safety"
    assert res["prio"] == 3


def test_triage_devanagari_women_safety_chhedchhad():
    res = triage("रास्ते में छेड़छाड़ कर रहा है कोई")
    assert res["cat"] == "women_safety"
    assert res["prio"] == 3


def test_triage_devanagari_medical_behosh():
    res = triage("मरीज बेहोश हो गया है")
    assert res["cat"] == "medical"
    assert res["prio"] >= 2


def test_triage_devanagari_shelter_rasta():
    res = triage("बाढ़ आ गई है, रास्ता बंद है")
    assert res["cat"] == "shelter"
    assert res["prio"] >= 1


def test_triage_hinglish_water_peene_ka_paani():
    res = triage("peene ka paani chahiye bache ke liye")
    assert res["cat"] == "water"
    assert res["prio"] >= 1


def test_triage_blood_regex_does_not_match_person():
    res = triage("a person walked by")
    assert res["vitals"]["blood_type"] is None


def test_triage_blood_regex_does_not_match_boy():
    res = triage("I am a boy from Mumbai")
    assert res["vitals"]["blood_type"] is None


def test_triage_blood_regex_positive_matches():
    res = triage("need AB positive blood immediately")
    assert res["vitals"]["blood_type"] == "AB+"
    assert res["vitals"]["urgency"] == "critical"


def test_triage_blood_negative_matches():
    res = triage("victim requires B- blood")
    assert res["vitals"]["blood_type"] == "B-"


def test_triage_location_hint_extraction():
    res = triage("injured person near metro pillar 42 at MG road")
    assert res["vitals"]["has_location_hint"] is True


def test_triage_negation_guard_lowers_prio():
    # An emergency phrase with "just testing" lowers priority by 1 level
    res = triage("fire! just testing the alarm")
    assert res["cat"] == "sos"
    assert res["prio"] == 2


def test_triage_benign_devanagari_koi_khatra_nahi():
    res = triage("चिंता मत करो, कोई खतरा नहीं है सब ठीक है")
    assert res["cat"] == "general"
    assert res["prio"] == 0
