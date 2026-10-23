---
description: "Use when editing, cutting, grading or exporting a FilmCraft project, or attaching Mercury to its open window. Not for PhotoCraft still-image editing or LightCraft photo-library development."
argument-hint: "[project or editing task]"
---

# FilmCraft

Check `craft_status`. If missing, request `craft_install`; Mercury handles consent for the app and matching command-line tool. Installation does not open a window. Use `craft_connect` to attach to the control-enabled FilmCraft instance. Never close or restart a user's app without permission, and never use headless as a substitute for their open project. Headless is an explicit separate-session choice.

FilmCraft 0.12.0 uses a loopback control port without authentication or filesystem confinement. Enable control only for a trusted local session. The desktop command is `filmcraft --control <port>`; the matching command-line server is `filmcraft-cli mcp --bridge 127.0.0.1:<port>`. A different installed version is not overwritten.

1. Inspect the current project and sequence. Discover the relevant command family with `command_list`; read current IDs, enablement and parameter descriptions rather than guessing.
2. Import with `media_import` or `file.import`. Select or create the intended sequence, then place media with `timeline.place`.
3. Cut with `sequence.addEdit`; discover effect IDs and use `effects.setParam` for grading. Prefer documented seconds, frame or timecode parameters. Raw ticks are 254016000000 per second.
4. Read back the timeline and use `ui_screenshot` for the actual window. `render_frame` is output pixels, not the app window.
5. Save a new `.fcproj` and export with `file.exportMedia` to a new path. Preserve originals. Observe completion, inspect the actual output file and verify its dimensions and duration before saying it was exported.

A timeout or disconnect may follow an applied edit. Inspect the project before deciding whether to retry; do not replay a mutation blindly. A hidden window or sleeping display can make screenshots fail. Report that failure rather than substituting a render.
