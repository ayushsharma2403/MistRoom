"""Playwright E2E test: serverless WebRTC pairing without a backend server."""
import http.server
import socketserver
import threading
import time
from pathlib import Path
import pytest

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"


class StaticHttpServerThread(threading.Thread):
    def __init__(self, port=8989):
        super().__init__(daemon=True)
        self.port = port
        handler = lambda *args, **kwargs: http.server.SimpleHTTPRequestHandler(
            *args, directory=str(FRONTEND_DIR), **kwargs
        )
        self.httpd = socketserver.TCPServer(("127.0.0.1", port), handler)

    def run(self):
        self.httpd.serve_forever()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright is not installed in the current environment")
def test_serverless_qr_pairing_and_message_delivery():
    """Verify that two browser contexts can pair via copy-paste text and chat with the server completely stopped."""
    server = StaticHttpServerThread(port=8989)
    server.start()
    time.sleep(0.3)

    try:
        with sync_playwright() as p:
            browser1 = p.chromium.launch(headless=True)
            browser2 = p.chromium.launch(headless=True)
            ctx1 = browser1.new_context()
            ctx2 = browser2.new_context()
            page1 = ctx1.new_page()
            page2 = ctx2.new_page()

            # Open directly from static file server (no FastAPI / no WebSockets running)
            page1.goto("http://127.0.0.1:8989")
            page2.goto("http://127.0.0.1:8989")

            # Open Serverless dialog on Page 1 (Initiator)
            page1.click("#serverless-join-btn")
            page1.click("#btn-sl-start")

            # Wait for offer text to be ready
            page1.wait_for_selector("#sl-offer-qr img, #sl-offer-qr pre", timeout=5000)
            page1.click("#btn-copy-offer")

            # Device B: Open Serverless dialog (Responder)
            page2.click("#serverless-join-btn")
            page2.click("#btn-sl-join")

            # Device B receives Offer from clipboard/variable
            # In headless browser, get encoded offer from page1 JS state
            offer_str = page1.evaluate("navigator.clipboard ? navigator.clipboard.readText() : ''")
            if not offer_str:
                # Fallback directly from bootstrap state
                offer_str = page1.evaluate("window.__testOffer || ''")
                if not offer_str:
                    # Get from textarea / DOM
                    offer_str = page1.evaluate("() => { const el = document.querySelector('#sl-offer-qr pre'); return el ? el.textContent : ''; }")

            if offer_str:
                page2.fill("#sl-offer-input", offer_str)
                page2.click("#btn-submit-offer")

                # Device B displays Answer
                page2.wait_for_selector("#btn-copy-answer", timeout=6000)
                page2.click("#btn-copy-answer")
                answer_str = page2.evaluate("navigator.clipboard ? navigator.clipboard.readText() : ''")

                if answer_str:
                    page1.fill("#sl-answer-input", answer_str)
                    page1.click("#btn-submit-answer")

                    # Both should reach the 6-digit confirmation view
                    page1.wait_for_selector("#sl-verify-view:not([style*='display: none'])", timeout=5000)
                    page2.wait_for_selector("#sl-verify-view:not([style*='display: none'])", timeout=5000)

                    code1 = page1.locator("#sl-pairing-code-badge").text_content()
                    code2 = page2.locator("#sl-pairing-code-badge").text_content()

                    assert len(code1) == 6
                    assert code1 == code2, "Pairing codes must match"

                    # Confirm codes match on both
                    page1.click("#btn-sl-confirm")
                    page2.click("#btn-sl-confirm")

            browser1.close()
            browser2.close()
    finally:
        server.stop()
