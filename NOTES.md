# Missing DOM IDs noted during check_ids run
- beacon-list-modal (app.js)
- close-beacon-list-btn (app.js)
- tab-panel-peers (app.js)
- tab-panel-needs (app.js)
- tab-panel-mesh (app.js)
- active-beacons-container (ui.js)

# T13: Why responder stays at "------" and never reaches verify screen
1. The verify view badge (`sl-pairing-code-badge`) is initialized to "------" and was only populated inside a 4000ms setTimeout in app.js after clicking generate answer.
2. In bootstrap.js, `computePairingCode` was calling `sha256(combined)` synchronously on full minified SDP strings without pure canon() or modular arithmetic matching initiator.
3. If an error occurred or ICE gathering timed out / delayed, responder was stuck on the answer display view while the verify screen was never reached or showed initial "------".
