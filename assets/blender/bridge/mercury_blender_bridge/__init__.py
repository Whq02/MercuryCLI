"""Mercury Blender Bridge — the add-on half of Mercury's Blender bridge.

Shipped as SOURCE in the Mercury tree (assets/blender/bridge/), baked into
the build by scripts/blender-bridge/regen-bridge.mjs and materialized into
the user addon home by the Mercury tool's op:"blender_bridge_install".
Mercury never enables it — that stays your act in Blender (Edit >
Preferences > Add-ons, search "Mercury").

What it serves: a token-authed loopback (127.0.0.1 only) NDJSON control
surface for the Mercury terminal harness — scene/objects/render truth,
blend_open, render_still, a report tail, and python_run. The wire contract
lives in Mercury's services/blender/bridgeProtocol.ts; protocol version
skew is refused from BOTH sides.

Architecture (the main-thread law): server.py runs the socket on a
background thread with ZERO bpy; every verb marshals through a queue into
ONE persistent bpy.app.timers pump (pump.py) that runs the bpy handlers
(ops.py) on the main thread. The report ring (ring.py) carries what Python
can honestly see.
"""

bl_info = {
    "name": "Mercury Blender Bridge",
    "author": "Mercury",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "Runs headless — no UI panels; serves 127.0.0.1 only",
    "description": "Token-authed loopback control bridge for the Mercury terminal harness",
    "category": "Development",
}

import json
import os

import bpy

from . import ops, pump, ring, server, state

_server = None


def _config_port():
    """The port half the installer aligns: config.json beside this add-on
    (present only when Mercury's MERCURY_BLENDER_BRIDGE_PORT differs from
    the default), else the contract default."""
    cfg = os.path.join(os.path.dirname(__file__), "config.json")
    try:
        with open(cfg, "r", encoding="utf-8") as f:
            port = json.load(f).get("port")
        if isinstance(port, int) and 1 <= port <= 65535:
            return port
    except (OSError, ValueError):
        pass
    return state.DEFAULT_PORT


def register():
    global _server
    state.snapshot_update(
        blender=bpy.app.version_string,
        blendFile=bpy.data.filepath,
        background=bool(bpy.app.background),
    )
    ring.attach_logging()
    ops.register_lifecycle()
    pump.register_pump()
    port = _config_port()
    token_path = os.path.join(os.path.dirname(__file__), "token")
    _server = server.BridgeServer(port, token_path)
    server.set_active(_server)
    if _server.start():
        ring.bridge_report("info", "bridge listening on 127.0.0.1:%d" % port)
    # a bind failure already ring-reported itself (the port hint included)


def unregister():
    global _server
    pump.unregister_pump()
    ops.unregister_lifecycle()
    ring.detach_logging()
    server.set_active(None)
    if _server is not None:
        _server.stop()
        _server = None
