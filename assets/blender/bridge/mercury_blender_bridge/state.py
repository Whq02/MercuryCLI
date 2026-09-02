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
UNAUTHED_DEADLINE_S = 10.0
PUMP_INTERVAL_S = 0.1

VERBS = (
    "scene_info",
    "objects_list",
    "blend_open",
    "render_state",
    "render_still",
    "report_tail",
    "python_run",
)


_snapshot_lock = threading.Lock()
_snapshot = {"blender": "", "blendFile": "", "background": False}


def snapshot_update(**kv):
    with _snapshot_lock:
        _snapshot.update(kv)


def snapshot_read():
    with _snapshot_lock:
        return dict(_snapshot)


render_job = {
    "active": False,
    "outputPath": "",
    "frame": 0,
    "prev_filepath": "",
    "prev_frame": 0,
    "started_at": 0.0,
}


python_namespace = {}
