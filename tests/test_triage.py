"""Regression tests for MistRoom triage engine."""
import pytest
from backend.ai import triage


def test_triage_sos_immediate():
    res = triage("SOS! I need immediate help.")
    assert res["cat"] == "sos"
    assert res["prio"] == 3
    assert not res["is_threat"]


def test_triage_general_hello():
    res = triage("hello how are you")
    assert res["cat"] == "general"
    assert res["prio"] == 0
    assert not res["is_threat"]


def test_triage_women_safety_following():
    res = triage("someone is following me")
    assert res["cat"] == "women_safety"
    assert res["prio"] == 3
    assert not res["is_threat"]


@pytest.mark.xfail(reason="Bug in current AI rules: 'help' keyword matches 'can you help me with my project' as SOS")
def test_triage_general_help_project():
    res = triage("can you help me with my project")
    assert res["cat"] == "general"
    assert res["prio"] == 0
    assert not res["is_threat"]


@pytest.mark.xfail(reason="Bug in current AI rules: 'fire' keyword matches 'fire in this song' as SOS")
def test_triage_general_fire_song():
    res = triage("the fire in this song is great")
    assert res["cat"] == "general"
    assert res["prio"] == 0
    assert not res["is_threat"]


@pytest.mark.xfail(reason="Bug in current AI rules: 'unsafe' keyword matches 'unsafe to sit on' as women_safety")
def test_triage_general_unsafe_chair():
    res = triage("this chair is unsafe to sit on")
    assert res["cat"] == "general"
    assert res["prio"] == 0
    assert not res["is_threat"]


@pytest.mark.xfail(reason="Bug in current AI rules: 'ied' substring matches in 'tried' and triggers terrorism false positive")
def test_triage_cafe_not_blocked():
    res = triage("I tried the new cafe")
    assert not res["is_threat"]
    assert res["cat"] == "general"
    assert res["prio"] == 0


def test_triage_medical_bleeding():
    res = triage("bleeding heavily, need ambulance")
    assert res["cat"] == "medical"
    assert res["prio"] >= 2
    assert not res["is_threat"]


def test_triage_water_drinking():
    res = triage("need drinking water for 5 people")
    assert res["cat"] == "water"
    assert res["prio"] >= 1
    assert not res["is_threat"]


def test_triage_shelter_stuck():
    res = triage("we are stuck, road blocked, flood")
    assert res["cat"] == "shelter"
    assert res["prio"] >= 1
    assert not res["is_threat"]


def test_triage_sos_hinglish_aag():
    res = triage("aag lag gayi")
    assert res["cat"] == "sos"
    assert res["prio"] == 3
    assert not res["is_threat"]


@pytest.mark.xfail(reason="Bug in current AI rules: Devanagari Hindi keywords not in RULES dictionary")
def test_triage_devanagari_madad():
    res = triage("मदद करो बचाओ")
    assert res["cat"] == "sos"
    assert res["prio"] == 3
    assert not res["is_threat"]


@pytest.mark.xfail(reason="Bug in current AI rules: Devanagari Hindi keywords not in RULES dictionary")
def test_triage_devanagari_paani():
    res = triage("पानी चाहिए")
    assert res["cat"] == "water"
    assert res["prio"] >= 1
    assert not res["is_threat"]


def test_triage_vitals_extraction():
    res = triage("4 people trapped, need O+ blood")
    assert res["cat"] == "sos"
    assert res["prio"] == 3
    assert res["vitals"]["victims_count"] == 4
    assert res["vitals"]["blood_type"] == "O+"
