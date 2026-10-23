import os
import hashlib
import socket
import threading
import time
import pytest
import uvicorn

try:
    import playwright
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


@pytest.fixture(scope="module", autouse=True)
def ensure_server_running():
    # Check if 3001 is already listening
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    is_open = sock.connect_ex(("127.0.0.1", 3001)) == 0
    sock.close()

    server = None
    if not is_open:
        server = UvicornServerThread(port=3001)
        server.start()
        time.sleep(1.0)

    yield

    if server:
        server.stop()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright is not installed in the current environment")
def test_two_browsers_join_room_and_send_message():
    with sync_playwright() as p:
        browser1 = p.chromium.launch(headless=True)
        browser2 = p.chromium.launch(headless=True)
        page1 = browser1.new_page()
        page2 = browser2.new_page()

        page1.goto("http://localhost:3001")
        page2.goto("http://localhost:3001")

        # Handle join (passkey is required, min 8 chars)
        page1.fill("#nickname-input", "Alice")
        page1.fill("#passkey-input", "Password123")
        page1.click("#join-btn")

        page2.fill("#nickname-input", "Bob")
        page2.fill("#passkey-input", "Password123")
        page2.click("#join-btn")

        page1.wait_for_selector("#join-modal", state="hidden", timeout=15000)
        page2.wait_for_selector("#join-modal", state="hidden", timeout=15000)

        # Alice sends message
        test_text = f"E2E automated test message from Alice {os.urandom(4).hex()}"
        page1.fill("#message-input", test_text)
        page1.press("#message-input", "Enter")

        # Bob verifies delivery
        page2.wait_for_selector(f"text={test_text}", timeout=8000)
        assert page2.locator(f"text={test_text}").first.is_visible()

        browser1.close()
        browser2.close()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright is not installed in the current environment")
def test_send_file_1mb_and_compare_sha256(tmp_path):
    file_bytes = os.urandom(1024 * 1024)
    original_sha = hashlib.sha256(file_bytes).hexdigest()
    test_file = tmp_path / "test_1mb.dat"
    test_file.write_bytes(file_bytes)

    with sync_playwright() as p:
        browser1 = p.chromium.launch(headless=True)
        browser2 = p.chromium.launch(headless=True)
        page1 = browser1.new_page()
        page2 = browser2.new_page()

        page1.goto("http://localhost:3001")
        page2.goto("http://localhost:3001")

        page1.fill("#nickname-input", "Sender")
        page1.fill("#passkey-input", "Password123")
        page1.click("#join-btn")

        page2.fill("#nickname-input", "Receiver")
        page2.fill("#passkey-input", "Password123")
        page2.click("#join-btn")

        page1.wait_for_selector("#join-modal", state="hidden", timeout=15000)
        page2.wait_for_selector("#join-modal", state="hidden", timeout=15000)

        page1.set_input_files("#file-input", str(test_file))
        page2.wait_for_selector("a.file-card[download]", timeout=15000)

        with page2.expect_download() as download_info:
            page2.click("a.file-card[download]")
        download = download_info.value
        downloaded_path = tmp_path / "downloaded.dat"
        download.save_as(str(downloaded_path))

        downloaded_bytes = downloaded_path.read_bytes()
        downloaded_sha = hashlib.sha256(downloaded_bytes).hexdigest()
        assert downloaded_sha == original_sha

        browser1.close()
        browser2.close()


@pytest.mark.skipif(sync_playwright is None, reason="Playwright is not installed in the current environment")
def test_voice_call_connects():
    with sync_playwright() as p:
        browser1 = p.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        browser2 = p.chromium.launch(headless=True, args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        page1 = browser1.new_page()
        page2 = browser2.new_page()

        page1.goto("http://localhost:3001")
        page2.goto("http://localhost:3001")

        page1.fill("#nickname-input", "Caller")
        page1.fill("#passkey-input", "Password123")
        page1.click("#join-btn")

        page2.fill("#nickname-input", "Callee")
        page2.fill("#passkey-input", "Password123")
        page2.click("#join-btn")

        page1.wait_for_selector("#join-modal", state="hidden", timeout=15000)
        page2.wait_for_selector("#join-modal", state="hidden", timeout=15000)

        # Open peers sidebar and call peer
        page1.click("#toggle-peers-btn")
        page1.wait_for_selector(".peer-item-interactive", timeout=10000)
        page1.click(".peer-item-interactive")
        page1.click("#start-voice-call-btn")

        page2.wait_for_selector("#incoming-call-toast", timeout=5000)
        page2.click("#accept-call-btn")

        page1.wait_for_selector("#call-modal", timeout=5000)
        page2.wait_for_selector("#call-modal", timeout=5000)

        page1.click("#hangup-call-btn")
        page2.wait_for_selector("#call-modal", state="hidden", timeout=5000)

        browser1.close()
        browser2.close()

