---
name: pdf-documents
description: Use when reading, transforming, filling, redacting or generating PDFs. Not for editing Word, Excel or PowerPoint source files.
argument-hint: "<file.pdf or new> [operation]"
---
# PDF documents

- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Inspect page count, metadata, encryption and text hints with `python3 "${MERCURY_SKILL_DIR}/scripts/pdf_pages.py" file.pdf`; use `--self-test` to test the helper.
- Obtain required passwords; treat text detection as heuristic and OCR image-only pages.
- Use pypdf for `extract_text()`, `get_fields()` and `PdfWriter` page operations.
- Use pdfplumber for positioned words, cropped regions and table extraction.
- Import `pymupdf` for rendering and redaction; apply redactions, never cover sensitive text with boxes.
- Merge with `append`, split with `add_page`, rotate with `rotate`, stamp with `merge_page`.
- Clone forms with `PdfWriter(clone_from=reader)`; fill using `writer.update_page_form_field_values(writer.pages[0], values, auto_regenerate=False)`.
- Generate structured layouts with ReportLab flowables; use browser PDF export for HTML and LibreOffice for office files.
- Save separately; reopen, check page count, encryption and metadata.
- Compare extracted text with rendered pages; inspect glyphs, clipping and table breaks.

## Sources
Checked: 2026-09-15. [pypdf](https://pypdf.readthedocs.io/en/stable/user/forms.html), [pdfplumber](https://github.com/jsvine/pdfplumber), [PyMuPDF](https://pymupdf.readthedocs.io/en/latest/page.html), [ReportLab](https://pypi.org/pypi/reportlab/json), [LibreOffice](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html).
