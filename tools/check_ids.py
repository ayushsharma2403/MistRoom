"""Check static HTML IDs referenced in frontend JavaScript against frontend/index.html."""
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO_ROOT / "frontend" / "index.html"
FRONTEND_JS_DIR = REPO_ROOT / "frontend" / "js"
APP_JS = REPO_ROOT / "frontend" / "app.js"

# Pattern to find $('id') and document.getElementById('id')
ID_CALL_REGEX = re.compile(r"""(?:\$|getElementById)\(\s*['"]([a-zA-Z0-9_\-]+)['"]\s*\)""")
HTML_ID_REGEX = re.compile(r"""id=['"]([a-zA-Z0-9_\-]+)['"]""")


def get_html_ids():
    content = INDEX_HTML.read_text(encoding="utf-8")
    return set(HTML_ID_REGEX.findall(content))


def get_js_referenced_ids():
    js_files = [APP_JS] + list(FRONTEND_JS_DIR.glob("*.js"))
    referenced = {}
    for js_path in js_files:
        if not js_path.is_file():
            continue
        content = js_path.read_text(encoding="utf-8")
        matches = ID_CALL_REGEX.findall(content)
        for m in matches:
            referenced.setdefault(m, []).append(js_path.name)
    return referenced


def find_missing_ids():
    html_ids = get_html_ids()
    js_ids = get_js_referenced_ids()
    missing = {}
    for id_name, files in js_ids.items():
        if id_name not in html_ids:
            missing[id_name] = files
    return missing


if __name__ == "__main__":
    missing = find_missing_ids()
    if missing:
        print("Missing IDs found:")
        for k, v in missing.items():
            print(f"  {k} in {set(v)}")
    else:
        print("All static IDs present in index.html.")
