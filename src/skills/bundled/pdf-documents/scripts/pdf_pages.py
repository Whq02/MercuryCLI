#!/usr/bin/env python3
"""Inspect a PDF without any library: version, page count, encryption, metadata, text presence.

Usage:
  pdf_pages.py <file.pdf>
  pdf_pages.py --self-test

Page counting reads the page tree's /Count when the trailer is plain and
falls back to counting page objects (including inside object streams, where
the stream is uncompressed or FlateDecode). Exit 0 on success, 1 on failure.
"""
from __future__ import annotations

import io
import re
import sys
import zlib

PAGE_OBJ = re.compile(rb"/Type\s*/Page(?![s/A-Za-z])")
PAGES_COUNT = re.compile(rb"/Type\s*/Pages\b[^>]*?/Count\s+(\d+)", re.S)
INFO_KEYS = (b"Title", b"Author", b"Subject", b"Producer", b"Creator")


def _inflate_object_streams(data: bytes) -> bytes:
    """Return the data plus the decoded bodies of every FlateDecode object stream."""
    out = [data]
    for m in re.finditer(rb"/Type\s*/ObjStm.*?stream\r?\n", data, re.S):
        start = m.end()
        end = data.find(b"endstream", start)
        if end == -1:
            continue
        try:
            out.append(zlib.decompress(data[start:end].strip(b"\r\n")))
        except zlib.error:
            continue
    return b"\n".join(out)


def inspect(raw: bytes) -> dict:
    if not raw.startswith(b"%PDF-"):
        raise ValueError("not a PDF (missing %PDF- header)")
    version = raw[5:8].decode("ascii", "replace")
    expanded = _inflate_object_streams(raw)
    counts = [int(c) for c in PAGES_COUNT.findall(expanded)]
    pages = max(counts) if counts else len(PAGE_OBJ.findall(expanded))
    encrypted = b"/Encrypt" in raw
    meta = {}
    for key in INFO_KEYS:
        m = re.search(rb"/" + key + rb"\s*\((.*?)(?<!\\)\)", expanded, re.S)
        if m:
            meta[key.decode()] = m.group(1).decode("latin-1", "replace").strip()
    has_text = bool(re.search(rb"\bTj\b|\bTJ\b", expanded)) or b"/Font" in expanded
    return {"version": version, "pages": pages, "encrypted": encrypted, "metadata": meta, "text_likely": has_text}


def render(info: dict) -> str:
    lines = [f"PDF {info['version']}  pages: {info['pages']}  encrypted: {'yes' if info['encrypted'] else 'no'}  text: {'likely' if info['text_likely'] else 'none found (scanned? needs OCR)'}"]
    for k, v in info["metadata"].items():
        lines.append(f"{k}: {v}")
    return "\n".join(lines)


def _minimal_pdf(pages: int, title: str = "Probe") -> bytes:
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    kids = b" ".join(b"%d 0 R" % (3 + i) for i in range(pages))
    objs.append(b"<< /Type /Pages /Kids [" + kids + b"] /Count %d >>" % pages)
    for _ in range(pages):
        objs.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>")
    objs.append(b"<< /Title (" + title.encode() + b") /Producer (pdf_pages self-test) >>")
    out = io.BytesIO()
    out.write(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % i + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for off in offsets:
        out.write(b"%010d 00000 n \n" % off)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, len(objs), xref))
    return out.getvalue()


def self_test() -> int:
    three = inspect(_minimal_pdf(3))
    one = inspect(_minimal_pdf(1, "Single"))
    ok = (
        three["pages"] == 3 and three["version"] == "1.7" and not three["encrypted"]
        and three["metadata"].get("Title") == "Probe" and three["text_likely"]
        and one["pages"] == 1 and one["metadata"].get("Title") == "Single"
    )
    try:
        inspect(b"hello")
        ok = False
    except ValueError:
        pass
    print("self-test:", "PASS" if ok else f"FAIL {three} {one}")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if len(argv) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        with open(argv[0], "rb") as fh:
            print(render(inspect(fh.read())))
    except (ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
