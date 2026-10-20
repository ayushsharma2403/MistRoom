# Test Report

## Test Execution Summary

| Test Command | Status | Result Summary |
| --- | --- | --- |
| `python -m pytest tests -q --ignore=tests/e2e` | **PASS** | 71 passed, 54 warnings in 21.64s |
| `node tests/ble_sim.js` | **PASS** | 10/10 tests passed (protocol, fragmentation, queue, 10-node mesh, topologies) |
| `node tests/inbound_test.mjs` | **PASS** | All inbound_test.mjs test cases passed |
| `for f in frontend/js/*.js frontend/js/ble/*.js frontend/app.js; do node --check $f; done` | **PASS** | Syntax check passed for all 21 JavaScript modules |

## NOT TESTED

The following areas require specialized physical environments, external platforms, or cross-network setups not covered by local automated test execution:

- **Real BLE hardware** (requires physical Android / iOS BLE peripheral devices)
- **iOS** (requires physical Apple device or Xcode iOS Simulator with Capacitor runtime)
- **Cross-NAT WebRTC** (requires external STUN/TURN traversal testing across distinct NAT networks)
- **Firefox/Safari** (automated browser tests currently run in headless Chromium)
- **Docker build** (requires Docker daemon / container engine execution)
