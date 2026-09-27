---
name: pdf-documents
description: Use when inspecting, creating or changing PDFs, including forms and redaction. Not for editing an Office source document.
argument-hint: "<file.pdf or new> [operation]"
---
# PDF documents

Open the requested pages with Mercury `Read`; separate visible content from extractable text. Use OCR for scans. Check which PDF libraries and renderers are installed before writing a transformation; a byte-regex scan is not a PDF parser.

Choose the operation, not a universal converter: pypdf for page assembly and AcroForms, pdfplumber for positioned extraction, PyMuPDF for rendering or applied redactions, ReportLab for new layouts. For forms, preserve the document's field tree and verify the filled values and their rendered appearances. Obtain authorised access to encrypted inputs.

Write a separate output. Redaction must remove the underlying content, not paint over it; check extracted text, metadata and embedded material as well as the page image. Do not claim secure removal from a visual check alone.

Reopen the output and inspect changed pages with `Read`. Compare page order, form values and required text; look for clipping and missing glyphs. Name any missing dependency or unverified visual result instead of calling conversion success proof.
