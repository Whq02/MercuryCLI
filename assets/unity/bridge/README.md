# Mercury Unity Bridge (`com.mercury.unity-bridge`)

The editor-side half of Mercury's Unity bridge: a token-authed, loopback-only
NDJSON/TCP listener inside the Unity editor, speaking protocol version 1
(the contract lives in Mercury's `src/services/unity/bridgeProtocol.ts`).
Verbs: `play_state` · `play_enter` · `play_exit` · `play_pause` ·
`scene_list` · `scene_open` · `hierarchy_read` · `console_tail` ·
`tests_run`. Every mutation-free verb is read-only in the editor; play and
test verbs only ever do what the matching editor button would.

## How it gets here

Mercury materializes this package into `<project>/Packages/com.mercury.unity-bridge/`
(an embedded package — no manifest.json entry needed) via
`op:"unity_bridge_install"`, writes the session token to
`Library/mercury-unity-bridge-token`, and aligns a non-default port through
`ProjectSettings/MercuryUnityBridge.json`. The editor imports and compiles
it on the next focus/refresh. `op:"unity_bridge_uninstall"` removes all of
it. Hand-editing the installed copy is safe but will be reported as drift
and refreshed by the next install.

## Runtime shape (why the code looks like this)

- `[InitializeOnLoad]` re-arms everything after every domain reload —
  entering play mode and script recompiles kill all static state, including
  the TCP listener and registered Test Runner callbacks. The old domain's
  listener closes on `DomainUnload`, and the new domain rebinds.
- All Unity API work happens on the main thread via an
  `EditorApplication.update` pump; the socket thread only reads frames,
  answers the hello from a lock-guarded snapshot, and queues requests.
- `play_enter`/`play_exit` answer BEFORE the transition (scheduled with
  `EditorApplication.delayCall`), so the client always learns `willReload`
  before the socket drops.
- Test runs go through `TestRunnerApi`; the pending run's results path
  survives domain reloads in `SessionState`, and the finished run's XML is
  written with a guaranteed `<test-run>` root for Mercury's results parser.
- One connection at a time: a newer hello wins, the older socket drops
  (stale post-reload sockets self-heal).

## Security posture

Loopback only (`IPAddress.Loopback`), token-authed (the token file is
project-private, mode 0600, minted by Mercury), version-gated (a protocol
mismatch refuses before any verb runs), and path arguments must stay inside
the project. No verb executes arbitrary code.
