# Reading documents

`Read` opens PDFs, office documents and scanned pages as text on every model, `Grep` searches them, and a fetched PDF comes back with its first page; this page says how each road reads.

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

## Profiler reports

A whole `Read` of a recognised `.cpuprofile` (V8 or CDP-wrapped V8) or
`.sample.txt` (a macOS sampling report) returns measured hotspots and hot
paths. It reads an existing report on every platform; it
never starts a profiler or follows a source URL. Self and inclusive weights,
known idle/wait contribution, the denominator and any hit-count approximation
are named separately. Recorded function/file/line/module identities stay with
the rows; uncertain symbols remain unresolved.

Use `<path>#read?view=profile&offset=0&limit=20` for a result-row page.
The continuation preserves the target and pages the generated rows.
A summary grants neither a file edit anchor nor source read coverage.
`<path>#read?view=raw`, or an ordinary read with explicit `offset`, `limit` or
`ranges`, reads the original report with its original coordinates and anchors.
A misnamed or unrecognised report remains ordinary text.

Compare compatible reports with
`<after>#read?view=profile&compare=<before>`; `compare` is last and its value is
verbatim, with no URL decoding. Both files pass the ordinary Read rules.
The comparison names both totals and reports absolute self/inclusive deltas
separately from percentage-point share changes. Different profiler formats or
sampling intervals are not compared as if their weights meant the same thing.

The reader streams report tokens and lines; sample arrays are not retained in
memory. Memory follows the recorded call graph and largest field. Cancellation
interrupts parsing and graph traversal. Quality notes disclose
missing references, unequal sample/delta counts, cycles and estimated timing.
Continuation detects a changed report instead of mixing its pages silently.

## SQLite query views

`Read` takes SQL as the last value of a target, for example
`/project/data.sqlite#read?offset=0&limit=20&sql=SELECT name FROM items ORDER BY id`.
The SQL is verbatim: nothing is URL-decoded and `&`, `+`, `%` and `?` inside it
remain SQL. Tables can also use
`/project/data.sqlite#read?table=items&order=id DESC&where=id>10&limit=20`;
`/project/data.sqlite:items#read?where=id>10&limit=20` means the same table.
The predicate is one expression; a second statement is refused. Use `sql=` for
SQL that needs comments, statement syntax or an ampersand. Existing bare-table,
schema and slash-key reads keep their meaning.

The release's bundled SQLite engine opens the database read-only. A mutating
statement gets the engine's refusal; no SQL is sent to an SSH shell. Extra-file
attachment and extension loading are unavailable on this read connection.
Each row is a JSON array beside the ordered column names, preserving duplicate
names, exact integers and blob bytes (base64). A row too large for the answer
is saved as a complete generated JSON value with its Read path. Result offset
is zero-based, limit is positive, and the continuation preserves the SQL.

Queries have no file-size or result-count ceiling: a local query iterates to its
page plus lookahead without counting or copying the database, and cancellation
ends its SQLite process even during a long calculation. Every continuation
reruns the query against the live database. The result gives no source edit
anchor or read coverage. SQLite may maintain read marks in an existing shared-memory
sidecar, but Read changes neither the database nor its WAL and creates no
sidecar beside them; only a leftover WAL without shared memory uses a private
copy, named in the header. An SSH database and its WAL are transferred to a
private local copy before querying; every continuation transfers them again.

To delete a previously read row, call `Write` with
`file_path: "/project/data.sqlite:items/42#delete"` and `content: "DELETE"`.
Empty content never deletes a row, and an ordinary empty-file write still
writes an empty file. In modes that ask, the ordinary permission card shows
the current row as a removal before approval. The transaction rechecks the
row, schema and prior read, requires one affected row and verifies its absence;
foreign-key restrictions roll back and declared cascades are enforced.
The result distinguishes a deleted row from a missing-row no-op and gives no
empty-file edit anchor. A query result is not the prior row read. Hidden-rowid
shorthand uses an unshadowed alias. Composite or fully shadowed shorthand is
refused. A key that names more than one row is refused.
