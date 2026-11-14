# Reading documents

`Read` opens PDFs, office documents and scanned pages as text on every model, `Grep` searches them, and a fetched PDF comes back with its first page; this page says how each road reads.

## JSON and JSONL queries

For UTF-8 JSON, JSONL or NDJSON input, append `#read?` to its Read target, for example
`<path>#read?limit=20&compact=1&q=select(.status == "failed") | {id, message}`.
Put `q` (or `query`) last: everything after its `=` is jq code, verbatim,
without URL or form decoding. Put modifiers before it: `offset` is a
zero-based value offset, `limit` is a positive value count (default 100),
`raw=1` unquotes strings, and `compact=1` compacts JSON. A single array is
paged by its elements; a stream is paged by whole values. The available
result room can shorten a page, whose continuation keeps the filter and
formatting. Read's ordinary `offset`, `limit` and `ranges` select generated
output lines when the target is a query. JSONL and NDJSON pages add one
bracket of source lines in value order, with `-` when no single line is
attributed; `input_line_number` can put the input record's line inside a
value. Existing local literal filenames win over the suffix; in an
`ssh://` path, percent-encode a literal `#read?`. Existing resource queries
stay before the suffix. A query on another machine's file brings the file
over first and evaluates it locally. The bundled jq 1.8.2 engine loads only
for a query and needs no installed jq; it preserves numeric literals,
while arithmetic follows jq's floating-point rules. Queries use a virtual
filesystem and environment; the named source is the only host file available
to a query. Each page reopens the source, and a continuation checks its file
identity. A query that consumes the entire input also reports its SHA-256.
Query output gives no edit anchor or source read coverage, even for the
identity filter. A result value too large to show is retained whole in the
generated result page's file, which the answer names.

## PDFs

`Read` opens a PDF's text layer on every model, without a separate PDF utility.
The result has line numbers and `--- page N ---` markers. `offset`, `limit`,
negative offsets and `ranges` select lines just as they do for a text file.
Text extraction accepts files up to 100 MiB and caches each document by its
content in the session's tool-results directory.

Text at the same height is grouped into rows. Wide gaps separate cells with
tabs. An image region is noted without guessing what it contains. Use `pages`
to inspect a figure or the original layout.

`pages: "3-5"` returns page pictures when the model accepts images, or those
pages as text otherwise. A picture request accepts up to 20 pages and needs
Poppler (`brew install poppler` on macOS, `sudo apt-get install poppler-utils`
on Debian or Ubuntu). A PDF with no text layer can still be sent as a whole
document on a model with native PDF input when OCR is unavailable or fails,
within the 20-page and 20 MiB inline limits. PDFs with text use the text road by default, so a long
paper remains readable without sending the whole document every turn.

Source builds prepare the pinned PDF.js pack with
`bun scripts/vendor/fetch-pdfjs.ts`, also included in `bun run setup`.
Release archives carry the pack.

## Office files

`Read` keeps headings, lists, table rows, footnotes and comments in Word
(`.docx`) and OpenDocument text (`.odt`). PowerPoint (`.pptx`) keeps slide order,
slide numbers, headings, list items, tables, speaker notes and comments.
OpenDocument presentations (`.odp`) keep their page sections.

Excel (`.xlsx`) and OpenDocument spreadsheets (`.ods`) show sheet names and
tab-separated cell rows. Empty cells keep their columns. A formula cell shows
its stored value followed by `[=formula]`; reading does not recalculate it.
Repeated OpenDocument rows are labelled with their repeat count.

The container limit is 16 MiB and each extracted ZIP entry is limited to
4 MiB. `offset`, `limit` and `ranges` select lines of the extracted text.

## OCR

A scanned PDF page is recognised automatically when read as text. An image
read on a model without image input also uses OCR. Set `ocr: true` to request
text from an image on any model. `crop` selects the image region before OCR.
The result names its engine and language set in `[OCR: engine; languages: ...]`,
and extracted text uses normal line windows. Recognition is cached by image
content, engine and language set.

macOS uses Vision through the packaged desktop bridge. Windows uses
`Windows.Media.Ocr` through that bridge and the installed recognition languages.
These file reads need neither screen capture nor desktop-control permission.
Linux uses `tesseract` on PATH, with Poppler for PDF page rendering.
Tesseract is also a fallback when the native bridge is absent. Vision receives
its full supported language set and uses language autodetection where available.
Windows tries each installed OCR language and labels differing readings by
language. Tesseract receives all installed recognition traineddata, including
Arabic when installed. No OCR engine or language pack is downloaded by `Read`.

To install Tesseract, use `brew install tesseract` on macOS or
`sudo apt-get install tesseract-ocr poppler-utils` on Debian or Ubuntu. On
Windows, add an OCR language under Settings › Time & language › Language &
region, or as Administrator run
`Add-WindowsCapability -Online -Name Language.OCR~~~en-US~0.0.1.0` with the
language you need in place of `en-US`.

## Searching documents

`Grep` searches extracted PDF, Word, PowerPoint, Excel, OpenDocument, EPUB
and RTF text alongside source files. Content matches include the PDF page or
sheet/slide heading and the extracted line number. Regex, literal matching,
case sensitivity, context, counts and output paging work as for text files.
`type: "pdf"` selects PDFs; `type: "ts"` excludes documents. `glob` and ignore
files retain their normal meaning.

Each folder search extracts at most 20 documents in path order. Its result
names how many remain and how many could not be read. Narrow `path` or `glob`
to search the rest. Every document must pass Read's own permission check;
search does not grant access to a document that Read would refuse. Extracted
text is cached by content, shared with Read, and never authorises a raw-byte
edit of an office file or PDF.

## Papers from the web

`WebFetch` saves a PDF and returns its local path, byte size and a preview of
the first page, limited to 4,000 characters. Continue with `Read` on that path
using line windows or `pages`. The preview uses OCR for a scanned first page
when an engine is installed. A failed extraction leaves the saved file intact
and names the problem instead of claiming there was text.

An arXiv abstract result includes the paper's PDF link. Fetch that link for
the saved PDF and first-page preview; the abstract is not the whole paper. Other binary downloads remain saved files without previews.

## Native PDF input

When a textless PDF cannot be read through OCR, the whole-document fallback
is available on Anthropic, image-capable OpenAI models using Responses,
Gemini models using the native content API, and image-capable Mistral chat models.
Custom endpoints and other provider transports do not inherit support just because a model name matches.
Text extraction remains available independently of native PDF input.

The native formats are Anthropic's
[document block](https://platform.claude.com/docs/en/build-with-claude/pdf-support),
OpenAI's [input_file](https://developers.openai.com/api/docs/guides/pdf-files),
Gemini's [document parts](https://ai.google.dev/gemini-api/docs/document-processing)
on [generateContent](https://ai.google.dev/api/generate-content), and
Mistral's [document_url](https://docs.mistral.ai/capabilities/document_ai/document_qna)
in chat completions.

## Enlarging a region

Use `crop: [x1, y1, x2, y2]` with `scale: 2` to enlarge small digits or text
before reading the crop. Coordinates refer to the original image. Scaling
also applies before OCR when `ocr: true` is set. The normal image-output
budget still applies, so a large crop may be downscaled to fit.

The crop coordinates, original dimensions and scale are metadata inside the
image's tool result instead of a separate user message.
