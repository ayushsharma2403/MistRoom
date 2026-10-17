"""Build tool: generates content hashes for frontend assets and updates index.html."""
import hashlib
import re
from pathlib import Path

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


def hash_file(path: Path) -> str:
    content = path.read_bytes()
    return hashlib.md5(content).hexdigest()[:8]


def main():
    css_file = FRONTEND_DIR / "style.css"
    app_file = FRONTEND_DIR / "app.js"
    index_file = FRONTEND_DIR / "index.html"

    if not index_file.exists():
        print("index.html not found.")
        return

    css_hash = hash_file(css_file) if css_file.exists() else "0"
    app_hash = hash_file(app_file) if app_file.exists() else "0"

    html = index_file.read_text(encoding="utf-8")
    html = re.sub(r'href="style\.css(?:\?v=[^"]*)?"', f'href="style.css?v={css_hash}"', html)
    html = re.sub(r'src="app\.js(?:\?v=[^"]*)?"', f'src="app.js?v={app_hash}"', html)

    index_file.write_text(html, encoding="utf-8")
    print(f"Assets versioned: style.css?v={css_hash}, app.js?v={app_hash}")


if __name__ == "__main__":
    main()
