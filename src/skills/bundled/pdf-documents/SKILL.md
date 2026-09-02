---
name: pdf-documents
description: Work with PDF files — extract text and tables, read metadata, merge, split, rotate, and watermark pages, fill forms, and generate new PDFs from data or HTML. Use when the request names a .pdf or asks to produce one; not for Word, Excel, or PowerPoint files (convert those to PDF with their own tools first).
when_to_use: The user hands over a PDF to read or summarise, wants pages combined or separated, needs a form filled, or wants a report rendered as a PDF.
argument-hint: "<path.pdf or 'new'> [what to do]"
---

# PDF documents

A PDF is a page-description format, not a document model: text comes back in
drawing order, tables have no structure, and scanned pages have no text at
all. Find out which kind of PDF you have before choosing a tool.

## Read first

```bash
python3 scripts/pdf_pages.py <file.pdf>         # page count, version, encryption, metadata, text present?
python3 scripts/pdf_pages.py --self-test
```

If the file is encrypted, ask for the password before anything else. If it
reports no text, the pages are images: OCR is required (`ocrmypdf` or
Tesseract) before any extraction.

## Extract (current libraries, August 2026)

- `pypdf` 6.x — pure Python: `PdfReader(path).pages[i].extract_text()`,
  metadata, form fields (`reader.get_fields()`), merge and split via
  `PdfWriter`.
- `pdfplumber` 0.11 — positioned text and tables:
  `page.extract_table()` and `page.extract_words()` when layout matters;
  `page.crop(bbox)` for one region.
- `pymupdf` (fitz) 1.28 — fastest text and image extraction, page rendering
  to PNG (`page.get_pixmap(dpi=110)`) for a visual check, and redaction.

Pick one per task; re-extract with a second library only when the first
returns garbled order (common with multi-column layouts) and compare.

## Transform

```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for path in ["a.pdf", "b.pdf"]:
    w.append(path)                        # merge
w.write("merged.pdf")

r = PdfReader("in.pdf"); w = PdfWriter()
w.add_page(r.pages[0]); w.write("first.pdf")   # split: one page out
```

- Rotate: `page.rotate(90)`; watermark/stamp: `page.merge_page(stamp_page)`.
- Forms: `PdfWriter(clone_from=reader)` then
  `w.update_page_form_field_values(w.pages[0], {"Name": "…"})`; set
  `NeedAppearances` so viewers render the values.
- Command-line alternatives when installed: `qpdf` (lossless merge/split/
  decrypt), `pdftotext -layout`, `pdftoppm`.

## Generate

- From structured data: `reportlab` 5.x (`SimpleDocTemplate` with
  `Paragraph`, `Table`, `Image` flowables) gives precise layout.
- From HTML/Markdown: render with a headless browser (Playwright's
  `page.pdf()`) or LibreOffice for office files; the CSS `@page` rule sets
  size and margins.
- Always open the output and check page count, that fonts embedded (no
  missing-glyph boxes), and that tables did not split mid-row.

## Verify before handing over

- `pdf_pages.py` on the output: expected page count, not encrypted unless
  requested, metadata title set.
- Spot-read two pages of extracted text against the rendered page image.
- Sensitive content removed by *redaction*, never by drawing a box over it.
