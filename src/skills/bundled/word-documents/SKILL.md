---
name: word-documents
description: Create, read, edit, and review Word (.docx) files — generate documents with python-docx, inspect or restructure the underlying OOXML, fill templates, add tables and images, work with tracked changes and comments, and convert to PDF. Use when the request names a .docx or Word document; not for spreadsheets, slides, PDFs, or plain Markdown drafting.
when_to_use: The user wants a .docx produced, summarised, edited in place, compared, or exported, or hands over a Word file to read.
argument-hint: "<path.docx or 'new'> [what to do]"
---

# Word documents

A `.docx` is a zip of XML parts; `word/document.xml` holds the body, with
styles, numbering, headers, footers, comments, and media beside it. Work at
the highest level that can express the change, and drop to the XML only when
the library cannot.

## Read first

```bash
python3 scripts/docx_outline.py <file.docx>        # headings, paragraph/table counts, comments, tracked changes
python3 scripts/docx_outline.py --self-test
```

The outline tells you the document's structure, whether it carries tracked
changes or comments, and which styles are in use — decide the approach from
that before opening anything else. For full text, `python-docx` reads every
paragraph and table in order:

```python
from docx import Document                      # python-docx 1.2 (August 2026)
doc = Document("report.docx")
for p in doc.paragraphs:
    print(p.style.name, "|", p.text)
for t in doc.tables:
    rows = [[c.text for c in r.cells] for r in t.rows]
```

## Create or edit with python-docx

- Build from the document's own styles: `doc.add_heading(text, level)`,
  `doc.add_paragraph(text, style="List Bullet")`, `doc.add_table(rows, cols,
  style="Table Grid")`, `doc.add_picture(path, width=Inches(5))`.
- Editing in place: change `run.text`, never rebuild paragraphs you did not
  touch — formatting lives on runs and is lost when a paragraph is replaced.
- Templates: start from the client's `.docx` so styles, headers, and page
  setup are inherited; replace placeholder runs rather than paragraphs.
- Page setup and sections: `doc.sections[0]` for margins, orientation,
  headers (`section.header.paragraphs`) and footers.
- Save to a new path first; overwrite only after the outline of the result
  matches what was intended.

## Tracked changes and comments

python-docx reads neither tracked changes nor comments; they are XML:

- Insertions are `<w:ins>` and deletions `<w:del>` wrapping runs, each with
  `w:author` and `w:date`. To accept all changes: unwrap `w:ins`, drop
  `w:del`. To reject: the reverse. To *propose* a change, wrap the new run in
  `w:ins` and the old in `w:del` (with `w:delText` instead of `w:t`).
- Comments live in `word/comments.xml`, anchored by `w:commentRangeStart`,
  `w:commentRangeEnd`, and a `w:commentReference` run in the body.
- Edit the XML with `zipfile` plus `xml.etree` (register the `w` namespace
  `http://schemas.openxmlformats.org/wordprocessingml/2006/main`), write
  every untouched part back byte-for-byte, and keep `[Content_Types].xml`
  first in the archive.

## Convert and check

- PDF export: LibreOffice headless, `soffice --headless --convert-to pdf
  file.docx`, is the portable route; verify the page count afterwards.
- Re-run the outline on the saved file: headings present, no unexpected
  empty paragraphs, tables intact, and tracked changes only where intended.
- A document the user will send onward gets a read-through of the rendered
  text, not just the structure.
