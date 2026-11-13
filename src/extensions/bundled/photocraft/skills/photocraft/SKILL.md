---
description: "Use when editing a PhotoCraft image, layers or selection, or saving/exporting its document. Not for video editing, a photo library, or installing an unrelated app."
argument-hint: "[image-editing task]"
---

# PhotoCraft

Use PhotoCraft's MCP tools, never shell image tools or guessed GUI coordinates (“Crop the open PhotoCraft image and export a PNG” belongs here; “Trim the video timeline” does not). Live `tools/list` and `command_list` own the catalog; on conflict, discovery wins.

- Desktop and bridge share one active document (`session_list` and `doc_inspect` name it; recheck when the user changes tabs).
- Target layers by `id` from `doc_inspect`; names repeat. Inspect selection, layers and history after material edits.
- `command_list {filter}` rows give `params` (prose, not a schema), `enabled`, `disabledReason` and `needsDocument`. Never invent ids or parameter keys. Before experimenting, run `command_run {id: "image.duplicate", params: {}}` and edit the copy.
- `command_batch` is not atomic: steps before a failure remain applied. Read `completed` and per-step `results`, then undo one history entry at a time. Undo never unwrites a file.
- `render_preview` is document pixels; `ui_screenshot` is the attached window (if hidden or display off, report the screenshot failure rather than substituting a preview).
- `doc_save` writes a new root-relative path under the write root (PNG, PSD or `.pcraft`; only image or document files are ever replaced, and never overwrite the source unasked). Check warnings, verify the file decodes, and reopen layered saves to confirm the layer tree; a queued export is not a file. Since 0.20.2 `doc_save` and `doc_export` take `tiffCompression` (none, lzw, zip), `tiffTransparency` and `tiffPyramid`, `.pcraft` saves take `pcraftFullComposite`, and PSD/PSB files refused by `doc_open` or `doc_place` for memory open with `approve_high_memory: true` up to the hard byte limit in the refusal (above that, free memory first).

Boundaries: pass the shared control token file's path: use its path only, never its contents. File I/O runs only via scoped `doc_open` and `doc_save` (`file.open`, `file.saveAs` and ambient-path commands are disabled; the answer to a refusal is never a wider root or a shell workaround). Embedded Smart Objects edit in memory (`layer.smartObjects.editContents`; `saveContents` updates the parent, while `doc_save` exports the contents document); linked external sources and path-bearing filter parameters refuse.

On timeout/disconnect: “request was not sent” means nothing ran; “no reply” or “may have completed” means inspect the document and history first and never replay automatically.
