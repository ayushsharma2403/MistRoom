"""E2E Playwright test for CSP clean violation checks and modal responsive viewport bounding box."""
import threading
import time
from pathlib import Path
import pytest
import uvicorn

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

from backend.server import app


class UvicornServerThread(threading.Thread):
    def __init__(self, host="127.0.0.1", port=3001):
        super().__init__(daemon=True)
        self.host = host
        self.port = port
        self.config = uvicorn.Config(app, host=self.host, port=self.port, log_level="warning")
        self.server = uvicorn.Server(self.config)

    def run(self):
        self.server.run()

    def stop(self):
        self.server.should_exit = True


@pytest.mark.skipif(sync_playwright is None, reason="Playwright is not installed")
def test_csp_clean_and_modal_bounding_box():
    server = UvicornServerThread(port=3001)
    server.start()
    time.sleep(0.5)

    csp_violations = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 360, "height": 740})

            # Listen for securitypolicyviolation events
            context.add_init_script("""
                window.addEventListener('securitypolicyviolation', (e) => {
                    window._cspViolations = window._cspViolations || [];
                    window._cspViolations.push({
                        blockedURI: e.blockedURI,
                        violatedDirective: e.violatedDirective,
                        originalPolicy: e.originalPolicy
                    });
                });
            """)

            page = context.new_page()

            # 1. Load page
            page.goto("http://127.0.0.1:3001/")

            # 2. Join
            page.fill("#nickname-input", "Tester")
            page.fill("#passkey-input", "Password123")
            page.click("#join-btn")
            page.wait_for_selector("#join-modal", state="hidden", timeout=10000)

            # 3. Open settings modal
            page.evaluate("""() => {
                const btn = document.getElementById('settings-toggle-btn');
                if (btn) btn.click();
            }""")
            page.wait_for_selector("#settings-modal", state="visible", timeout=5000)

            # Assert settings close button bounding box is inside the viewport at 360x740
            close_btn = page.locator("#close-settings-btn")
            bbox = close_btn.bounding_box()
            assert bbox is not None, "close-settings-btn bounding box not found"
            assert bbox["x"] >= 0, f"close-settings-btn x={bbox['x']} < 0"
            assert bbox["y"] >= 0, f"close-settings-btn y={bbox['y']} < 0"
            assert bbox["x"] + bbox["width"] <= 360, f"close-settings-btn right edge {bbox['x'] + bbox['width']} > 360"
            assert bbox["y"] + bbox["height"] <= 740, f"close-settings-btn bottom edge {bbox['y'] + bbox['height']} > 740"

            # Close settings modal
            close_btn.click()
            page.wait_for_selector("#settings-modal", state="hidden", timeout=5000)

            # 4. Open serverless modal
            page.click("#header-more-btn")
            page.click("#menu-serverless-btn")
            page.wait_for_selector("#serverless-modal", state="visible", timeout=5000)
            page.click("#close-serverless-btn")
            page.wait_for_selector("#serverless-modal", state="hidden", timeout=5000)

            # 5. Open safe-walk modal
            page.click("#composer-plus-btn")
            page.click("#safewalk-btn")
            page.wait_for_selector("#safewalk-modal", state="visible", timeout=5000)
            page.click("#close-safewalk-btn")
            page.wait_for_selector("#safewalk-modal", state="hidden", timeout=5000)

            # 6. Assert zero 'securitypolicyviolation' events
            violations = page.evaluate("() => window._cspViolations || []")
            assert len(violations) == 0, f"CSP violations detected: {violations}"

            browser.close()
    finally:
        server.stop()
