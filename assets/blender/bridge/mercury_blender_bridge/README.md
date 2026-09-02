# Mercury Blender Bridge (add-on source)

The Python half of Mercury's Blender bridge. This directory ships as
SOURCE inside the Mercury tree (`assets/blender/bridge/`), is baked into
the build by `scripts/blender-bridge/regen-bridge.mjs` (drift-gated by
`--check`), and is materialized into the Blender user addon home by the
Mercury tool's `op:"blender_bridge_install"`. It never runs inside
Mercury's own test pool — runs-in-Blender is the written Mac drill.

## What it is

A token-authed, loopback-only (127.0.0.1) NDJSON control surface for the
Mercury terminal harness: scene/objects/render truth, `blend_open`,
`render_still`, a report tail, and `python_run`. The wire contract is
`src/services/blender/bridgeProtocol.ts` (protocol version 1); version skew
is refused from both sides.

## Enabling (your act — Mercury never automates it)

1. `op:"blender_bridge_install"` materializes this directory plus the
   `token` file (and `config.json` when a non-default port is set).
2. In Blender: Edit > Preferences > Add-ons, search "Mercury", tick the
   box. (Or run
   `blender --python-expr "import bpy; bpy.ops.preferences.addon_enable(module='mercury_blender_bridge'); bpy.ops.wm.save_userpref()"`
   yourself.)
3. `op:"blender_status"` should then report the bridge answering.

## The one danger worth stating twice

`python_run` executes Python inside Blender with full bpy authority and no
preemption — Mercury's tool asks permission on every call and its
description carries both danger sentences verbatim.

## Layout

- `__init__.py` — bl_info + register/unregister wiring
- `state.py` — contract constants (mirroring bridgeProtocol.ts) + shared state
- `server.py` — the socket thread: STDLIB ONLY, zero bpy
- `pump.py` — the persistent bpy.app.timers pump (main thread)
- `ops.py` — the verb handlers + @persistent lifecycle handlers
- `ring.py` — the report ring (logging/bridge/handler sources)
