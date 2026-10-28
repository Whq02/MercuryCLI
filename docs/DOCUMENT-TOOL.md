# Documents, spreadsheets and references

The `Document` tool creates, converts and inspects local documents. Ask Mercury for the deliverable you need, such as a DOCX report, a PDF, slides or a spreadsheet. It does not need an office account.

## Create a document

```json
{
  "op": "create",
  "output": "report.docx",
  "markdown": "# Findings\n\nThe result, with its source citation.",
  "metadata": { "title": "Research report", "author": "Research desk" },
  "paper": "A4",
  "pageNumbers": true
}
```

The output extension selects DOCX, PDF, PPTX, XLSX, HTML or Markdown. Structured content supports headings, paragraphs, lists, tables, local PNG or JPEG images, page breaks and footnotes. DOCX and PDF support page size and margins. DOCX supports a title page, headers and footers. A DOCX template can supply styles and `{{key}}` placeholders; `replacements` fills the placeholders without recreating the template.

PDF creation uses the provisioned browser for HTML typography. Without a browser, it uses a plain layout. `renderer: "browser"` or `renderer: "plain"` selects one explicitly. The plain PDF font does not cover every writing system; use the browser for text outside its character set. Mercury does not download a browser as part of document creation.

## Create a spreadsheet

```json
{
  "op": "create",
  "output": "evidence.xlsx",
  "sheets": [
    { "name": "Results", "rows": [["Source", "Count"], ["Study A", 42]] }
  ]
}
```

CSV text and JSON record arrays can also supply a worksheet. Values remain text or numbers as supplied; strings are not turned into spreadsheet formulas. Choose a worksheet by name when exporting CSV from a workbook with several sheets.

## Convert and assemble

`convert` takes `source` and `output`. DOCX, standard-font text PDFs, HTML and Markdown convert between each other. PPTX can become PDF; XLSX and CSV convert in both directions. Converting text reflows the document; the original page layout is not preserved. An image-only PDF needs OCR before its text can be converted.

LibreOffice and pandoc are used when installed and suitable. They run on temporary working files and never on the original source. `renderer: "libreoffice"` and `renderer: "pandoc"` request a particular converter. Documents containing external relationships, linked fields or embedded programs are not passed to these converters. Without LibreOffice, the PPTX-to-PDF fallback uses the slide text without the slide design.

- `merge` takes PDF `sources` in order and one `output`.
- `split` takes a PDF `source` and `parts`, each with `pages` and `output`.
- PDF-to-PDF `convert` with `pages: "1-3,7"` extracts those pages in that order. `rotate: 90` turns the extracted pages clockwise. Omit `pages` to keep every page.
- DOCX-to-DOCX `convert` with `append: true` adds Markdown or structured blocks while keeping the existing document. `metadata` sets its title and author.

## Inspect before replacing

`inspect` returns structure without returning the body: headings, table dimensions, image counts, metadata, word count and a SHA-256 digest. PDF results include page count, outlines and per-page text-layer and image flags. DOCX page count depends on layout, so explicit page breaks are reported instead. PDF table dimensions are not inferred from positioned text.

Use a different output filename to keep a source unchanged. Replacing an existing output requires `expectedSha256`, keyed by its absolute path, from an inspection of its current bytes. A changed destination causes the write to refuse. All split destinations are checked before any output is written. Reading inputs and writing destinations use the normal file permissions, including permission for paths outside the starting folder.

## Build a reference list

`cite` accepts BibTeX, reference records or an explicit list of DOIs. It returns a reference list and in-text keys, with optional Markdown, HTML or DOCX output. The local formatter covers basic journal-article and book references in APA, IEEE, Chicago author-date and Harvard author-date. It preserves supplied title capitalisation and is not a complete CSL processor. Check a publication's particular requirements before submitting a bibliography.

Only an explicit `dois` list contacts [Crossref](https://www.crossref.org/documentation/retrieve-metadata/rest-api/). Its bibliographic metadata is public without sign-up; some abstracts carry copyright and are not used. DOI requests do not follow redirects or automatically retry a refusal.

The formatting references are the CSL project's [APA](https://github.com/citation-style-language/styles/blob/master/apa.csl), [IEEE](https://github.com/citation-style-language/styles/blob/master/ieee.csl), [Chicago author-date](https://github.com/citation-style-language/styles/blob/master/chicago-author-date.csl) and [Harvard](https://github.com/citation-style-language/styles/blob/master/harvard-cite-them-right.csl) styles. No CSL style files are included in the tool.

## Research a corpus

Mercury's bundled `research` skill guides a research agent through finding primary sources, reading by page, recording precise source locations, extracting tables and drafting a cited report. It distinguishes an OCR result from a checked quotation and a formatted citation from evidence. The agent selects the skill for paper or corpus research; a quick factual lookup or an application-code change does not call for it.
