#!/usr/bin/env python3
"""Summarise an .xlsx without any library: sheets, dimensions, header row, formulas.

Usage:
  sheet_summary.py <file.xlsx>
  sheet_summary.py --self-test

Exit 0 on success, 1 when the file is not a readable .xlsx.
"""
from __future__ import annotations

import io
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN, "r": PKG_REL}


def _shared_strings(zf: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in zf.namelist():
        return []
    root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    out = []
    for si in root.findall("m:si", NS):
        out.append("".join(t.text or "" for t in si.iter(f"{{{MAIN}}}t")))
    return out


def _sheet_parts(zf: zipfile.ZipFile) -> list[tuple[str, str]]:
    wb = ET.fromstring(zf.read("xl/workbook.xml"))
    rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    target_by_id = {r.get("Id"): r.get("Target") for r in rels.findall("r:Relationship", NS)}
    out = []
    for s in wb.find("m:sheets", NS).findall("m:sheet", NS):
        rid = s.get(f"{{{REL}}}id")
        target = target_by_id.get(rid, "")
        part = target if target.startswith("/") else "xl/" + target
        out.append((s.get("name"), part.lstrip("/")))
    return out


def _cell_value(c: ET.Element, shared: list[str]) -> str:
    t = c.get("t")
    v = c.find("m:v", NS)
    if t == "s" and v is not None and v.text is not None:
        idx = int(v.text)
        return shared[idx] if idx < len(shared) else ""
    if t == "inlineStr":
        return "".join(x.text or "" for x in c.iter(f"{{{MAIN}}}t"))
    return v.text if v is not None and v.text is not None else ""


def summarize(path_or_bytes) -> list[dict]:
    src = io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, (bytes, bytearray)) else path_or_bytes
    zf = zipfile.ZipFile(src)
    if "xl/workbook.xml" not in zf.namelist():
        raise ValueError("no xl/workbook.xml — not an .xlsx")
    shared = _shared_strings(zf)
    sheets = []
    for name, part in _sheet_parts(zf):
        root = ET.fromstring(zf.read(part))
        dim = root.find("m:dimension", NS)
        rows = root.findall("m:sheetData/m:row", NS)
        formulas = sum(1 for c in root.iter(f"{{{MAIN}}}c") if c.find("m:f", NS) is not None)
        header = [_cell_value(c, shared) for c in rows[0].findall("m:c", NS)] if rows else []
        sheets.append({
            "name": name,
            "dimension": dim.get("ref") if dim is not None else "",
            "rows": len(rows),
            "formulas": formulas,
            "header": header,
        })
    return sheets


def render(sheets: list[dict]) -> str:
    lines = []
    for s in sheets:
        lines.append(f"{s['name']}: {s['dimension'] or '?'}  rows={s['rows']}  formulas={s['formulas']}")
        if s["header"]:
            lines.append("  header: " + " | ".join(h for h in s["header"]))
    return "\n".join(lines) if lines else "(no sheets)"


def _minimal_xlsx() -> bytes:
    ct = ('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
    wb = (f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="{MAIN}" xmlns:r="{REL}"><sheets>'
          '<sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>')
    rels = (f'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="{PKG_REL}">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
    sst = f'<?xml version="1.0" encoding="UTF-8"?><sst xmlns="{MAIN}" count="2" uniqueCount="2"><si><t>Region</t></si><si><t>Total</t></si></sst>'
    sheet = (f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="{MAIN}"><dimension ref="A1:B3"/><sheetData>'
             '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
             '<row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>10</v></c></row>'
             '<row r="3"><c r="A3" t="inlineStr"><is><t>Sum</t></is></c><c r="B3"><f>SUM(B2:B2)</f><v>10</v></c></row>'
             '</sheetData></worksheet>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", ct)
        zf.writestr("xl/workbook.xml", wb)
        zf.writestr("xl/_rels/workbook.xml.rels", rels)
        zf.writestr("xl/sharedStrings.xml", sst)
        zf.writestr("xl/worksheets/sheet1.xml", sheet)
    return buf.getvalue()


def self_test() -> int:
    s = summarize(_minimal_xlsx())
    ok = (
        len(s) == 1 and s[0]["name"] == "Sales" and s[0]["dimension"] == "A1:B3"
        and s[0]["rows"] == 3 and s[0]["formulas"] == 1 and s[0]["header"] == ["Region", "Total"]
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", "x")
    try:
        summarize(buf.getvalue())
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
        print(render(summarize(argv[0])))
    except (ValueError, zipfile.BadZipFile, OSError, ET.ParseError, KeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
