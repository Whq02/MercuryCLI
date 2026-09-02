#!/usr/bin/env python3
"""Outline a .docx without any library: headings, counts, comments, tracked changes.

Usage:
  docx_outline.py <file.docx>
  docx_outline.py --self-test

Exit 0 on success, 1 when the file is not a readable .docx.
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


def para_text(p: ET.Element) -> str:
    return "".join(t.text or "" for t in p.iter(f"{{{W}}}t"))


def outline(path_or_bytes) -> dict:
    zf = zipfile.ZipFile(path_or_bytes if not isinstance(path_or_bytes, (bytes, bytearray)) else io.BytesIO(path_or_bytes))
    names = set(zf.namelist())
    if "word/document.xml" not in names:
        raise ValueError("no word/document.xml — not a .docx")
    body = ET.fromstring(zf.read("word/document.xml")).find("w:body", NS)
    headings: list[tuple[int, str]] = []
    paragraphs = 0
    empty = 0
    styles: dict[str, int] = {}
    for p in body.iter(f"{{{W}}}p"):
        paragraphs += 1
        text = para_text(p).strip()
        if not text:
            empty += 1
        style_el = p.find("w:pPr/w:pStyle", NS)
        style = style_el.get(f"{{{W}}}val") if style_el is not None else "Normal"
        styles[style] = styles.get(style, 0) + 1
        if style and style.lower().startswith("heading") and text:
            digits = "".join(ch for ch in style if ch.isdigit())
            headings.append((int(digits) if digits else 1, text))
    tables = len(body.findall(".//w:tbl", NS))
    insertions = len(list(body.iter(f"{{{W}}}ins")))
    deletions = len(list(body.iter(f"{{{W}}}del")))
    comments = 0
    if "word/comments.xml" in names:
        comments = len(ET.fromstring(zf.read("word/comments.xml")).findall("w:comment", NS))
    media = sorted(n for n in names if n.startswith("word/media/"))
    return {
        "headings": headings,
        "paragraphs": paragraphs,
        "empty_paragraphs": empty,
        "tables": tables,
        "styles": styles,
        "insertions": insertions,
        "deletions": deletions,
        "comments": comments,
        "media": media,
    }


def render(o: dict) -> str:
    lines = []
    for level, text in o["headings"]:
        lines.append(f"{'  ' * (level - 1)}{text}")
    if not o["headings"]:
        lines.append("(no headings)")
    lines.append("")
    lines.append(f"paragraphs: {o['paragraphs']} ({o['empty_paragraphs']} empty)  tables: {o['tables']}  media: {len(o['media'])}")
    lines.append(f"tracked changes: {o['insertions']} insertions, {o['deletions']} deletions  comments: {o['comments']}")
    top = sorted(o["styles"].items(), key=lambda kv: -kv[1])[:8]
    lines.append("styles: " + ", ".join(f"{k}×{v}" for k, v in top))
    return "\n".join(lines)


def _minimal_docx(with_changes: bool) -> bytes:
    doc = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W}"><w:body>'
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Plan</w:t></w:r></w:p>'
        '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Scope</w:t></w:r></w:p>'
        '<w:p><w:r><w:t>Body text.</w:t></w:r></w:p>'
        '<w:p/>'
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
        + ('<w:p><w:ins w:author="A"><w:r><w:t>new</w:t></w:r></w:ins><w:del w:author="A"><w:r><w:delText>old</w:delText></w:r></w:del></w:p>' if with_changes else '')
        + '</w:body></w:document>'
    )
    comments = f'<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="{W}"><w:comment w:id="0" w:author="A"><w:p><w:r><w:t>note</w:t></w:r></w:p></w:comment></w:comments>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        zf.writestr("word/document.xml", doc)
        if with_changes:
            zf.writestr("word/comments.xml", comments)
    return buf.getvalue()


def self_test() -> int:
    plain = outline(_minimal_docx(False))
    changed = outline(_minimal_docx(True))
    ok = (
        plain["headings"] == [(1, "Plan"), (2, "Scope")]
        and plain["tables"] == 1
        and plain["empty_paragraphs"] == 1
        and plain["insertions"] == 0 and plain["comments"] == 0
        and changed["insertions"] == 1 and changed["deletions"] == 1 and changed["comments"] == 1
    )
    with tempfile.TemporaryDirectory() as tmp:
        bad = os.path.join(tmp, "x.docx")
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr("hello.txt", "not a docx")
        try:
            outline(bad)
            ok = False
        except ValueError:
            pass
    print("self-test:", "PASS" if ok else "FAIL")
    if not ok:
        print(plain, changed)
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if len(argv) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        print(render(outline(argv[0])))
    except (ValueError, zipfile.BadZipFile, OSError, ET.ParseError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
