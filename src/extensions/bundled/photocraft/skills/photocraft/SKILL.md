---
description: "Use when editing a PhotoCraft image, layers or selection, or saving/exporting its document. Not for video editing, a photo library, or installing an unrelated app."
argument-hint: "[image-editing task]"
---

# PhotoCraft

Use the PhotoCraft MCP tools, not shell editing commands or guessed GUI coordinates. A request such as “Crop the open PhotoCraft image and export a PNG” belongs here; “Trim the video timeline” does not.

1. Read `craft_status`. If installation is needed, use `craft_install` only when the user requests it. Connect with `craft_connect`, normally `mode: "attach"`. Launch a window only when requested, with a specific project read root and output write root. An ordinary open window without control is not attached: preserve its unsaved work and explain that it needs to be saved and restarted with control enabled. Never substitute a headless document; `mode: "headless"` is only an explicit user choice.
2. Read `session_list`, `doc_inspect` and the configured roots. Use `doc_open` with a root-relative path for an image under the read root. Use `doc_new` for an explicitly requested new image. The desktop and MCP share the same active document; recheck it when the user changes tabs.
3. Discover commands with `command_list {filter: "crop"}` (or a relevant layer/selection/adjustment term). Read each command's `params`, `enabled`, `disabledReason` and `needsDocument`. Parameter descriptions are prose, not JSON Schemas. Do not invent command names or pass guessed parameter keys. The full command/tool catalog remains available.
4. Before experiments use `command_run {id: "image.duplicate", params: {}}`. Adjust the copy with discovered commands such as `image.crop`, `select.rect`, `layer.new.layer`, `layer.setProps`, or adjustment-layer commands. Target the layer ID read from the document; names can be duplicated. Inspect selection, layers and history after each meaningful edit.
5. For a pending background job, use `jobs_list` until it finishes; use `jobs_cancel` only when cancellation is wanted. `command_batch` is not atomic: earlier successful steps remain applied after a failure. Read its per-step results and document history before undoing. Undo does not undo files already written.
6. Inspect `render_preview` for document pixels and `ui_screenshot` for the actual attached window. They are different evidence. If the window is hidden or the display is unavailable, report the screenshot failure; do not relabel a rendered preview as a window capture.
7. Save/export through `doc_save` to a fresh root-relative PNG, PSD or `.pcraft` path under the write root. The extension selects the format. Read warnings about flattening or unsupported features. Verify the output exists and decodes, and for a layered file reopen it and inspect the layer tree, before saying it was saved. Do not overwrite the source unless the user requested it.

## Boundaries and recovery

The control token stays in a private file shared by the desktop and CLI. Never read its contents into a tool result, prompt or argument; use only the file path. Keep app and CLI on the same release. Do not replace a user's different installed version.

Use scoped `doc_open` / `doc_save`, not `file.open`, `file.saveAs`, ambient filesystem commands, broader roots, or shell workarounds after a refusal. Embedded Smart Objects can be edited in memory; external linked sources and filesystem-bearing filter parameters may be refused. Save Contents updates a parent in memory; `doc_save` exports the active document instead.

A timeout or disconnect can leave an edit applied. “Not run” or “request was not sent” differs from “no reply” or “operation may have completed”: inspect the document and history before retrying the latter. Never replay an uncertain edit automatically. An export request being accepted or queued is not an exported file.
