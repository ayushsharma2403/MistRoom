"""Playwright E2E tests for MistRoom (Requires playwright installed)."""
import os
import hashlib
import pytest

try:
    import playwright
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


@pytest.mark.skipif(sync_playwright is None, reason="Playwright is not installed in the current environment")
def test_two_browsers_join_room_and_send_message():
    with sync_playwright() as p:
        browser1 = p.chromium.launch(headless=True)
        browser2 = p.chromium.launch(headless=True)
        page1 = browser1.new_page()
        page2 = browser2.new_page()

        page1.goto("http://localhost:3001")
        page2.goto("http://localhost:3001")

        # Handle join
        page1.fill("#nickname-input", "Alice")
        page1.click("#join-btn")
        page2.fill("#nickname-input", "Bob")
        page2.click("#join-btn")

        page1.wait_for_selector("#chat-screen:not(.hidden)", timeout=5000)
        page2.wait_for_selector("#chat-screen:not(.hidden)", timeout=5000)

        # Alice sends message
        test_text = "E2E automated test message from Alice"
        page1.fill("#message-input", test_text)
        page1.click("#send-btn")

        # Bob verifies delivery
        page2.wait_for_selector(f"text={test_text}", timeout=5000)
        assert page2.locator(f"text={test_text}").is_visible()

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
        page1.click("#join-btn")
        page2.fill("#nickname-input", "Receiver")
        page2.click("#join-btn")

        page1.wait_for_selector("#chat-screen:not(.hidden)", timeout=5000)
        page2.wait_for_selector("#chat-screen:not(.hidden)", timeout=5000)

        page1.set_input_files("#file-input", str(test_file))
        page2.wait_for_selector(".file-card a[download]", timeout=10000)

        with page2.expect_download() as download_info:
            page2.click(".file-card a[download]")
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
        page1.click("#join-btn")
        page2.fill("#nickname-input", "Callee")
        page2.click("#join-btn")

        page1.wait_for_selector("#chat-screen:not(.hidden)", timeout=5000)
        page2.wait_for_selector("#chat-screen:not(.hidden)", timeout=5000)

        # Call from direct peer
        page1.wait_for_selector(".peer-item", timeout=5000)
        page1.click(".peer-item")
        page1.click("#start-voice-call-btn")

        page2.wait_for_selector("#incoming-call-modal:not(.hidden)", timeout=5000)
        page2.click("#accept-call-btn")

        page1.wait_for_selector("#active-call-modal:not(.hidden)", timeout=5000)
        page2.wait_for_selector("#active-call-modal:not(.hidden)", timeout=5000)

        page1.click("#hangup-call-btn")
        page2.wait_for_selector("#active-call-modal.hidden", timeout=5000)

        browser1.close()
        browser2.close()
