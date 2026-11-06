---
description: "Use when editing a PhotoCraft image, layers or selection, or saving/exporting its document. Not for video editing, a photo library, or installing an unrelated app."
argument-hint: "[image-editing task]"
---

# PhotoCraft

Work through the PhotoCraft MCP tools, never shell image tools or guessed GUI coordinates. “Crop the open PhotoCraft image and export a PNG” belongs here; “Trim the video timeline” does not. The live `tools/list` and `command_list` are the catalog: where this page or upstream's docs disagree with them, discovery wins.

- The desktop and the bridge share one active document; `session_list` and `doc_inspect` say which. Recheck after the user changes tabs.
- Target layers by the `id` from `doc_inspect`; names repeat. Inspect selection, layers and history after an edit that matters.
- `command_list {filter}` rows carry `params` (prose, not a schema), `enabled`, `disabledReason` and `needsDocument`. Do not invent ids or parameter keys. Before an experiment, `command_run {id: "image.duplicate", params: {}}` and edit the copy.
- `command_batch` is not atomic: steps before a failure stay applied. Read `completed` and the per-step `results`, then undo one history entry at a time. Undo never unwrites a file.
- `render_preview` is document pixels; `ui_screenshot` is the attached window. If the window is hidden or the display is off, report the screenshot failure rather than relabelling a preview.
- `doc_save` writes a fresh root-relative path under the write root; the extension picks PNG, PSD or native `.pcraft`, and only image or document files are ever replaced. Read its warnings, confirm the file decodes, and reopen a layered file to check its layer tree before calling it saved. Never overwrite the source unasked. A queued export is not a file. Since 0.20.2 `doc_save` and `doc_export` take `tiffCompression` (none, lzw, zip), `tiffTransparency` and `tiffPyramid`, a `.pcraft` save `pcraftFullComposite`, and a PSD or PSB that `doc_open` or `doc_place` refuses for memory opens with `approveHighMemory: true` only up to the hard limit the refusal names in bytes; above that, free memory first.

Boundaries: the control token lives in a private file shared by the desktop and the CLI; use its path only, never its contents. Files move only through scoped `doc_open` and `doc_save` under the read and write roots: `file.open`, `file.saveAs` and other ambient-path commands are disabled, and the answer to a refusal is never a wider root or a shell workaround. Embedded Smart Objects edit in memory (`layer.smartObjects.editContents`; `saveContents` updates the parent, while `doc_save` there exports the contents document); linked external sources and filesystem-bearing filter parameters are refused.

After a timeout or disconnect the edit may have applied: “request was not sent” means it did not run; “no reply” or “may have completed” means inspect the document and its history first and never replay automatically.
