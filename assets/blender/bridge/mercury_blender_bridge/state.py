"""Shared module state + the contract constants (Mercury Blender bridge).

The constants MIRROR services/blender/bridgeProtocol.ts — the TypeScript
contract module is the source of truth and the structural prover
(scripts/blender-bridge/prove-blender-bridge-package.ts) pins equality; a
drift here is a build failure, not a runtime surprise.
"""

import threading

PROTOCOL_VERSION = 1
BRIDGE_VERSION = "0.1.0"
DEFAULT_PORT = 6012
MAX_LINE_BYTES = 8 * 1024 * 1024
OBJECTS_NODE_CAP = 2000
REPORT_RING_CAP = 1000
PYTHON_SOURCE_CAP_BYTES = 64 * 1024
PYTHON_OUTPUT_CAP_BYTES = 32 * 1024
# Unauthed sockets die on this receive deadline (the probe-immunity law's
# other half: a bare connect can never displace the authed client, and it
# cannot squat forever either).
UNAUTHED_DEADLINE_S = 10.0
PUMP_INTERVAL_S = 0.1

# The wire verb table (names only — classes/summaries live in the TS
# contract). ops.HANDLERS carries exactly these keys; the prover pins both
# against the TypeScript table.
VERBS = (
    "scene_info",
    "objects_list",
    "blend_open",
    "render_state",
    "render_still",
    "report_tail",
    "python_run",
)

# ── the hello snapshot ───────────────────────────────────────────────────────
# bpy facts the SOCKET THREAD may read but never compute: the pump (main
# thread) refreshes this each tick and the lifecycle handlers update it on
# load; the lock keeps the handoff sane. The socket thread must never import
# bpy (the threading-gotcha law) — this dict is its only window into Blender.

_snapshot_lock = threading.Lock()
_snapshot = {"blender": "", "blendFile": "", "background": False}


def snapshot_update(**kv):
    with _snapshot_lock:
        _snapshot.update(kv)


def snapshot_read():
    with _snapshot_lock:
        return dict(_snapshot)


# ── render-job bookkeeping (main-thread only) ────────────────────────────────
# Tracks the render THE BRIDGE started, so the completion handlers can
# restore the scene's own output settings and emit render_finished honestly.
# bpy.app.is_job_running('RENDER') stays the refusal truth — this record is
# bookkeeping, never the gate.

render_job = {
    "active": False,
    "outputPath": "",
    "frame": 0,
    "prev_filepath": "",
    "prev_frame": 0,
    "started_at": 0.0,
}


# ── python_run's persistent namespace (main-thread only) ─────────────────────
# Survives between runs so a session can build state; a variable named
# `result` is CONSUMED by each run's answer (popped, repr'd).

python_namespace = {}
