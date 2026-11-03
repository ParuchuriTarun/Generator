"""Build the single-file checklist from the editable sources in this folder.

Usage (from the project folder):
    python src/build.py

The output is written to the project root as:
    Branch Surprise Visit Checklist.html
"""

from pathlib import Path
import re

SRC = Path(__file__).resolve().parent
ROOT = SRC.parent
OUTPUT = ROOT / "Branch Surprise Visit Checklist.html"


def inline_script(source: str) -> str:
    """Make JavaScript safe and clean for a single inline <script> block."""
    source = re.sub(r"\n//# sourceMappingURL=.*", "", source)
    return source.replace("</script", r"<\/script")


def main() -> None:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    css = (SRC / "styles.css").read_text(encoding="utf-8")
    html_to_image = (SRC / "vendor" / "html-to-image.js").read_text(encoding="utf-8")
    jspdf = (SRC / "vendor" / "jspdf.umd.min.js").read_text(encoding="utf-8")
    data = (SRC / "data.js").read_text(encoding="utf-8")
    app = (SRC / "app.js").read_text(encoding="utf-8")

    replacements = [
        ('  <link rel="stylesheet" href="styles.css">', f"  <style>\n{css}\n  </style>"),
        (
            '  <script src="vendor/html-to-image.js"></script>',
            f"  <script>\n{inline_script(html_to_image)}\n  </script>",
        ),
        (
            '  <script src="vendor/jspdf.umd.min.js"></script>',
            f"  <script>\n{inline_script(jspdf)}\n  </script>",
        ),
        (
            '  <script src="data.js"></script>',
            f"  <script>\n{inline_script(data)}\n  </script>",
        ),
        (
            '  <script src="app.js"></script>',
            f"  <script>\n{inline_script(app)}\n  </script>",
        ),
    ]

    for original, replacement in replacements:
        if original not in html:
            raise SystemExit(f"Build failed: could not find {original.strip()!r} in index.html")
        html = html.replace(original, replacement, 1)

    OUTPUT.write_text(html, encoding="utf-8")
    size_kb = OUTPUT.stat().st_size / 1024
    print(f"Built {OUTPUT.name} ({size_kb:.0f} KB)")
    print("Open it in a browser; no server or internet connection is needed.")


if __name__ == "__main__":
    main()
