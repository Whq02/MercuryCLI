---
description: "Use when editing, cutting, grading or exporting a FilmCraft project, or attaching Mercury to its open window. Not for PhotoCraft still-image editing or LightCraft photo-library development."
argument-hint: "[project or editing task]"
---

# FilmCraft

FilmCraft 0.17.0 answers control requests only with the session token it was started with (`FILMCRAFT_CONTROL_TOKEN`). A `craft_connect` launch creates one; to attach to a window the user opened themselves, pass `tokenFile`, a private file holding that token. The port is loopback-only with no filesystem confinement, so the token is the only gate. A different installed version is not overwritten.

Inspect the open project and sequence first; that identity is what every later edit is checked against. Discover command IDs, enablement and parameters with `command_list` instead of guessing; bring in media with `media_import`. Cuts are `sequence.addEdit`, placement `timeline.place`, grading `effects.setParam`; prefer seconds, frame or timecode parameters (raw ticks are 254016000000 per second). The task sets the order of edits.

Preserve originals: save to a new `.fcproj` and export with `file.exportMedia` to a new path. `ui_screenshot` shows the actual window; `render_frame` is output pixels, not the window. An export is done only once the file exists and its dimensions and duration have been inspected.

A timeout or disconnect may follow an applied edit. Inspect the project before retrying; never replay a mutation blindly. A hidden window or sleeping display makes screenshots fail; report that rather than substituting a render.
