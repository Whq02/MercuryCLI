---
description: "Use when editing, cutting, grading or exporting a FilmCraft project, or attaching Mercury to its open window. Not for PhotoCraft still-image editing or LightCraft photo-library development."
argument-hint: "[project or editing task]"
---

# FilmCraft

FilmCraft 0.20.0 requires its startup session token (`FILMCRAFT_CONTROL_TOKEN`) on every control call. `craft_connect` launches with a fresh token; to attach to a user-opened window, pass `tokenFile` (a private file holding that token). The loopback port has no filesystem sandbox, so the token is the sole gate.

Inspect the open project and sequence first and verify every edit against that identity. Discover command IDs, enablement and parameters via `command_list` rather than guessing; import media via `media_import`. Use `sequence.addEdit` for cuts, `timeline.place` for placement, `timeline.move` for moves and `effects.setParam` for grading, preferring seconds, frame or timecode parameters (raw ticks = 254016000000/s; since 0.17.1 `timeline.move`'s `time` takes seconds, frame or timecode too).

Preserve originals: save to a new `.fcproj` and export via `file.exportMedia` to a new path. `ui_screenshot` captures the window; `render_frame` returns output pixels, not the window (if hidden or display asleep, report screenshot failure rather than substituting `render_frame`). Confirm exports exist with expected dimensions and duration before reporting done; image sequences report the first still as `path` and the last as `lastPath`.

On timeout or disconnect, inspect the project before retrying — never replay a mutation blindly.
