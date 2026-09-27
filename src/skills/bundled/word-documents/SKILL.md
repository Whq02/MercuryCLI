---
name: word-documents
description: Use when creating or revising a Word file while preserving its document structure. Not for plain-text drafting or PDF editing.
argument-hint: "<file.docx or new> [operation]"
---
# Word documents

Identify the requested edits and use the supplied document or template as the starting package. Before choosing an installed library, inspect styles, sections, tables, headers, comments and tracked revisions. Plain text extraction does not show everything that must survive.

For ordinary edits, python-docx can retain the template and change individual runs without flattening paragraph formatting. Walk paragraphs and tables in document order, including nested tables where relevant. Do not replace a whole paragraph just to change one phrase.

Comments and tracked changes are different structures. python-docx is not a complete revision editor: use a capable Office tool or narrowly edit OOXML while preserving untouched parts and relationships. Never silently accept revisions or discard unsupported features to make saving work.

Save a new file, reopen it and compare the requested edits plus preserved structures. If a local Office renderer is available, export to PDF and inspect pagination, tables and headers with Mercury `Read`. Report structural checks and visual checks separately; disclose when no renderer was available.
