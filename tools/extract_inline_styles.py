import re
import hashlib
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = ROOT / "frontend" / "index.html"
INDEX_BAK = ROOT / "frontend" / "index.html.bak"
STYLE_CSS = ROOT / "frontend" / "style.css"

def main():
    # Make backup (do not commit it)
    shutil.copyfile(INDEX_HTML, INDEX_BAK)

    html_content = INDEX_HTML.read_text(encoding="utf-8")

    # Mapping from normalized style declaration string to class name
    style_to_class = {}
    class_rules = []

    def get_class_name(style_decl: str) -> str:
        # Standardize / strip outer spaces
        s_clean = style_decl.strip()
        if s_clean not in style_to_class:
            h = hashlib.sha1(s_clean.encode("utf-8")).hexdigest()[:8]
            cls_name = f"u-{h}"
            style_to_class[s_clean] = cls_name
            # Ensure declaration ends with semicolon
            formatted_decl = s_clean if s_clean.endswith(";") else s_clean + ";"
            class_rules.append((cls_name, formatted_decl))
        return style_to_class[s_clean]

    # Pattern to match tag open up to tag close: <tag ...>
    # Match any opening/void tag that has style="..."
    tag_pattern = re.compile(r"<([a-zA-Z0-9\-]+)([^>]*)>", re.DOTALL)

    def process_tag(match: re.Match) -> str:
        tag_name = match.group(1)
        attrs = match.group(2)

        # Check if style attribute exists in attrs
        style_match = re.search(r'\bstyle="([^"]*)"', attrs)
        if not style_match:
            return match.group(0)

        style_str = style_match.group(1)
        cls_name = get_class_name(style_str)

        # Remove the style="..." attribute
        # Also clean up any extra surrounding space if present
        attrs_no_style = re.sub(r'\s*style="[^"]*"', '', attrs)

        # Check if class attribute already exists
        class_match = re.search(r'\bclass="([^"]*)"', attrs_no_style)
        if class_match:
            existing_classes = class_match.group(1).strip()
            new_classes = f"{existing_classes} {cls_name}" if existing_classes else cls_name
            # Replace existing class attribute
            attrs_final = re.sub(r'\bclass="[^"]*"', f'class="{new_classes}"', attrs_no_style, count=1)
        else:
            # Add class attribute at the start of attributes
            attrs_final = f' class="{cls_name}"{attrs_no_style}'

        return f"<{tag_name}{attrs_final}>"

    new_html = tag_pattern.sub(process_tag, html_content)

    # Double-check that no style="..." attributes remain
    remaining = len(re.findall(r'style="[^"]*"', new_html))
    if remaining > 0:
        raise RuntimeError(f"Still found {remaining} style attributes!")

    INDEX_HTML.write_text(new_html, encoding="utf-8")

    # Append new CSS classes to style.css
    css_content = STYLE_CSS.read_text(encoding="utf-8")
    
    append_block = ["\n\n/* generated from inline styles */\n"]
    for cls_name, decl in class_rules:
        append_block.append(f".{cls_name} {{ {decl} }}\n")

    STYLE_CSS.write_text(css_content + "".join(append_block), encoding="utf-8")
    print(f"Extracted {len(class_rules)} unique style declarations.")

if __name__ == "__main__":
    main()
