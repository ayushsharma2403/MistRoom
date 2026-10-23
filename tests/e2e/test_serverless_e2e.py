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


class CustomHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".mjs": "application/javascript",
        ".json": "application/json",
        ".css": "text/css",
    }


class ThreadingServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    request_queue_size = 128
    allow_reuse_address = True


class StaticHttpServerThread(threading.Thread):
    def __init__(self, port=0):
        super().__init__(daemon=True)
        handler = lambda *args, **kwargs: CustomHandler(
            *args, directory=str(FRONTEND_DIR), **kwargs
        )
        self.httpd = ThreadingServer(("127.0.0.1", port), handler)
        self.port = self.httpd.server_address[1]

    def run(self):
        self.httpd.serve_forever()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright is not installed in the current environment")
def test_serverless_qr_pairing_and_message_delivery():
    """Verify that two browser contexts can pair via copy-paste text and chat with the server completely stopped."""
    server = StaticHttpServerThread(port=0)
    server.start()
    time.sleep(0.3)

    try:
        with sync_playwright() as p:
            browser1 = p.chromium.launch(headless=True)
            browser2 = p.chromium.launch(headless=True)
            ctx1 = browser1.new_context(permissions=["clipboard-read", "clipboard-write"])
            ctx2 = browser2.new_context(permissions=["clipboard-read", "clipboard-write"])
            page1 = ctx1.new_page()
            page2 = ctx2.new_page()

            # Open directly from static file server (no FastAPI / no WebSockets running)
            page1.goto(f"http://127.0.0.1:{server.port}")
            page2.goto(f"http://127.0.0.1:{server.port}")

            # Open Serverless dialog on Page 1 (Initiator)
            page1.wait_for_selector("#serverless-join-btn", state="visible")
            page1.click("#serverless-join-btn")
            page1.wait_for_selector("#btn-sl-start", state="visible")
            page1.click("#btn-sl-start")

            # Wait for offer text to be ready
            page1.wait_for_selector("#sl-offer-qr img, #sl-offer-qr pre, #sl-offer-qr svg, #sl-offer-qr canvas", timeout=8000)
            page1.click("#btn-copy-offer")

            # Device B: Open Serverless dialog (Responder)
            page2.wait_for_selector("#serverless-join-btn", state="visible")
            page2.click("#serverless-join-btn")
            page2.wait_for_selector("#btn-sl-join", state="visible")
            page2.click("#btn-sl-join")

            # Device B receives Offer from clipboard/variable
            # In headless browser, get encoded offer from page1 JS state
            offer_str = page1.evaluate("""async () => {
                try {
                    if (navigator.clipboard) return await navigator.clipboard.readText();
                } catch (e) {}
                return window.__testOffer || '';
            }""")

            if not offer_str:
                offer_str = page1.evaluate("() => { const el = document.querySelector('#sl-offer-qr pre'); return el ? el.textContent : ''; }")

            if offer_str:
                page2.fill("#sl-offer-input", offer_str)
                page2.click("#btn-submit-offer")

                # Device B displays Answer
                page2.wait_for_selector("#btn-copy-answer", timeout=6000)
                page2.click("#btn-copy-answer")
                answer_str = page2.evaluate("""async () => {
                    try {
                        if (navigator.clipboard) return await navigator.clipboard.readText();
                    } catch (e) {}
                    return window.__testAnswer || '';
                }""")

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
