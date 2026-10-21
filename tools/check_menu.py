import sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context().new_page()
    pg.goto("http://localhost:3001/", wait_until="domcontentloaded"); pg.wait_for_timeout(500)
    pg.fill("#nickname-input", "MenuTest"); pg.fill("#passkey-input", "strongpass1"); pg.fill("#room-input", "menucheck")
    pg.click("#join-btn"); pg.wait_for_selector("#join-modal", state="hidden", timeout=40000); pg.wait_for_timeout(1500)
    pg.click("#header-more-btn"); pg.wait_for_timeout(400)
    top = pg.evaluate("(()=>{const e=document.querySelector('#menu-logout-btn');const r=e.getBoundingClientRect();const t=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return t.id||t.className})()")
    print("element at Disconnect center:", top)
    b.close(); sys.exit(0 if top == "menu-logout-btn" else 1)
