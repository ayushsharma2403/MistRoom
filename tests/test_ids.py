import pytest
from tools.check_ids import find_missing_ids, get_html_ids, get_js_referenced_ids


def test_consent_modal_ids_present():
    html_ids = get_html_ids()
    consent_ids = [
        "beacon-consent-modal",
        "btn-consent-beacon",
        "btn-consent-room-only",
    ]
    for cid in consent_ids:
        assert cid in html_ids, f"Consent modal element #{cid} missing from index.html"


def test_check_ids_consent_modal_has_no_missing():
    missing = find_missing_ids()
    consent_ids = {
        "beacon-consent-modal",
        "btn-consent-beacon",
        "btn-consent-room-only",
        "beacon-consent-public-btn",
        "beacon-consent-room-btn",
    }
    missing_consent = {k: v for k, v in missing.items() if k in consent_ids}
    assert len(missing_consent) == 0, f"Found missing consent modal IDs in JS: {missing_consent}"
