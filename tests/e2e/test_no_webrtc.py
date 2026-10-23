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


import socket


def get_free_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.mark.skipif(sync_playwright is None, reason="Playwright is not installed")
def test_no_webrtc_page_loads_and_joins():
    test_port = get_free_port()
    server = UvicornServerThread(port=test_port)
    server.start()
    time.sleep(1.0)

    page_errors = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()

            # Init script deletes window.RTCPeerConnection before scripts execute
            context.add_init_script("delete window.RTCPeerConnection;")

            page = context.new_page()
            page.on("pageerror", lambda err: page_errors.append(str(err)))

            # Navigate to MistRoom
            page.goto(f"http://127.0.0.1:{test_port}/")

            # Ensure no uncaught page errors on initial load
            assert len(page_errors) == 0, f"Page errors on load: {page_errors}"

            # Join room
            page.fill("#nickname-input", "Alice")
            page.fill("#passkey-input", "Password123")
            page.click("#join-btn")

            # Wait for join modal to close
            page.wait_for_selector("#join-modal", state="hidden", timeout=10000)

            # Verify mesh/call buttons are hidden via .u-hidden
            assert page.locator("#serverless-join-btn").evaluate("el => el.classList.contains('u-hidden')")
            assert page.locator("#start-voice-call-btn").evaluate("el => el.classList.contains('u-hidden')")

            # Verify no unhandled page errors occurred during join
            assert len(page_errors) == 0, f"Page errors after join: {page_errors}"

            browser.close()
    finally:
        server.stop()
