---
name: word-documents
description: Use when creating, reading, editing or reviewing Word documents, comments or tracked revisions. Not for plain-text drafting, spreadsheets, slides or PDF editing.
argument-hint: "<file.docx or new> [operation]"
---
# Word documents

- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Inspect headings, tables, styles, comments and revision markers with `python3 "${MERCURY_SKILL_DIR}/scripts/docx_outline.py" document.docx`; use `--self-test` to test the helper.
- Open the supplied template with python-docx's `Document`; preserve its styles, sections, headers and footers.
- Traverse top-level paragraphs and tables in order with `iter_inner_content()`; inspect nested tables separately.
- Fill styles and placeholders; edit `run.text` rather than replacing whole paragraphs and losing run formatting.
- Add headings, paragraphs, tables and pictures through the document API; set page geometry through `sections`.
- Read `Document.comments`; create comments with `Document.add_comment`, anchored to whole runs.
- Treat tracked revisions separately: python-docx does not provide a complete revision-editing API.
- Inspect OOXML insertions, deletions, property changes and relationships before accepting, rejecting or proposing revisions; do not reduce every revision to a run wrapper.
- Preserve untouched package parts when XML editing is necessary.
- Save to a new path, rerun the outline and compare intended edits.
- Render with `soffice --headless --convert-to pdf document.docx`; check pagination, tables, glyphs and rendered text before delivery.

## Sources
Checked: 2026-09-15. [python-docx API](https://python-docx.readthedocs.io/en/latest/api/document.html), [comments](https://python-docx.readthedocs.io/en/latest/user/comments.html), [LibreOffice](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html).
