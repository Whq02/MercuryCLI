#!/usr/bin/env python3
"""Outline a .pptx without any library: per-slide title, layout, text, notes, pictures.

Usage:
  deck_outline.py <file.pptx>
  deck_outline.py --self-test

Exit 0 on success, 1 when the file is not a readable .pptx.
"""
from __future__ import annotations

import io
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"p": P, "a": A, "r": PKG_REL}


def _rels(zf: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str]]:
    """Id → (Type, Target) for a part's relationships file, or {}."""
    d, _, f = part.rpartition("/")
    rel_part = f"{d}/_rels/{f}.rels"
    if rel_part not in zf.namelist():
        return {}
    root = ET.fromstring(zf.read(rel_part))
    return {r.get("Id"): (r.get("Type", ""), r.get("Target", "")) for r in root.findall("r:Relationship", NS)}


def _resolve(part: str, target: str) -> str:
    if target.startswith("/"):
        return target.lstrip("/")
    base = part.rpartition("/")[0]
    segs = (base + "/" + target).split("/")
    out: list[str] = []
    for s in segs:
        if s == "..":
            out.pop()
        elif s and s != ".":
            out.append(s)
    return "/".join(out)


def _texts(root: ET.Element) -> list[str]:
    out = []
    for para in root.iter(f"{{{A}}}p"):
        t = "".join(x.text or "" for x in para.iter(f"{{{A}}}t")).strip()
        if t:
            out.append(t)
    return out


def outline(path_or_bytes) -> list[dict]:
    src = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, (bytes, bytearray)) else path_or_bytes
    zf = zipfile.ZipFile(src)
    if "ppt/presentation.xml" not in zf.namelist():
        raise ValueError("no ppt/presentation.xml — not a .pptx")
    pres = ET.fromstring(zf.read("ppt/presentation.xml"))
    rels = _rels(zf, "ppt/presentation.xml")
    slides = []
    for sld in pres.findall("p:sldIdLst/p:sldId", NS):
        rid = sld.get(f"{{{R}}}id")
        _, target = rels.get(rid, ("", ""))
        part = _resolve("ppt/presentation.xml", target)
        root = ET.fromstring(zf.read(part))
        title = ""
        for sp in root.iter(f"{{{P}}}sp"):
            ph = sp.find("p:nvSpPr/p:nvPr/p:ph", NS)
            if ph is not None and ph.get("type") in ("title", "ctrTitle"):
                title = " ".join(_texts(sp))
                break
        body = [t for t in _texts(root) if t != title]
        srels = _rels(zf, part)
        layout = ""
        notes = ""
        pictures = 0
        for _, (typ, tgt) in srels.items():
            if typ.endswith("/slideLayout"):
                lroot = ET.fromstring(zf.read(_resolve(part, tgt)))
                cs = lroot.find("p:cSld", NS)
                layout = cs.get("name", "") if cs is not None else ""
            elif typ.endswith("/notesSlide"):
                notes = " ".join(_texts(ET.fromstring(zf.read(_resolve(part, tgt)))))
            elif typ.endswith("/image"):
                pictures += 1
        slides.append({"part": part, "title": title, "layout": layout, "body": body, "notes": notes, "pictures": pictures})
    return slides


def render(slides: list[dict]) -> str:
    lines = [f"slides: {len(slides)}"]
    for i, s in enumerate(slides, 1):
        lines.append(f"{i}. {s['title'] or '(untitled)'}  [{s['layout'] or 'layout ?'}]{'  notes' if s['notes'] else ''}{'  pictures=' + str(s['pictures']) if s['pictures'] else ''}")
        for b in s["body"][:6]:
            lines.append(f"     - {b[:100]}")
    return "\n".join(lines)


def _minimal_pptx() -> bytes:
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
    pres = f'<?xml version="1.0"?><p:presentation xmlns:p="{P}" xmlns:r="{R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'
    prels = (f'<?xml version="1.0"?><Relationships xmlns="{PKG_REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>')
    slide = (f'<?xml version="1.0"?><p:sld xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree>'
             '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Results</a:t></a:r></a:p></p:txBody></p:sp>'
             '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Revenue up</a:t></a:r></a:p><a:p><a:r><a:t>Costs flat</a:t></a:r></a:p></p:txBody></p:sp>'
             '</p:spTree></p:cSld></p:sld>')
    srels = (f'<?xml version="1.0"?><Relationships xmlns="{PKG_REL}">'
             '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
             '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/>'
             '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>')
    layout = f'<?xml version="1.0"?><p:sldLayout xmlns:p="{P}" xmlns:a="{A}"><p:cSld name="Title and Content"><p:spTree/></p:cSld></p:sldLayout>'
    notes = f'<?xml version="1.0"?><p:notes xmlns:p="{P}" xmlns:a="{A}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Say the number first.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", ct)
        zf.writestr("ppt/presentation.xml", pres)
        zf.writestr("ppt/_rels/presentation.xml.rels", prels)
        zf.writestr("ppt/slides/slide1.xml", slide)
        zf.writestr("ppt/slides/_rels/slide1.xml.rels", srels)
        zf.writestr("ppt/slideLayouts/slideLayout1.xml", layout)
        zf.writestr("ppt/notesSlides/notesSlide1.xml", notes)
        zf.writestr("ppt/media/image1.png", b"\x89PNG\r\n\x1a\n")
    return buf.getvalue()


def self_test() -> int:
    s = outline(_minimal_pptx())
    ok = (
        len(s) == 1 and s[0]["title"] == "Results" and s[0]["layout"] == "Title and Content"
        and s[0]["body"] == ["Revenue up", "Costs flat"] and "number first" in s[0]["notes"] and s[0]["pictures"] == 1
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", "x")
    try:
        outline(buf.getvalue())
        ok = False
    except ValueError:
        pass
    print("self-test:", "PASS" if ok else f"FAIL {s}")
    return 0 if ok else 1


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    if len(argv) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        print(render(outline(argv[0])))
    except (ValueError, zipfile.BadZipFile, OSError, ET.ParseError, KeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
