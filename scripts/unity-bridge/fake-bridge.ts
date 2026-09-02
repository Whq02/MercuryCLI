// ============================================================================
//  scripts/unity-bridge/fake-bridge.ts — the loopback double speaking the
//  FULL UNITY-BRIDGE contract: every verb, every error arm, version skew
//  (both levers), token refusal, the accept-newest connection law, the
//  ack-then-drop domain-reload simulation, and the tests_run road that
//  writes a real fixture XML for the LANDED results door. The instrument
//  for every Mercury-side pin — cpu-pure, fixture-driven, ephemeral ports,
//  zero Unity.
//
//  This is a PROOF INSTRUMENT: it implements the same contract the C#
//  package implements (assets/unity/bridge/), not the package's internals.
// ============================================================================

import * as net from 'node:net'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  UNITY_BRIDGE_PROTOCOL_VERSION,
  UNITY_BRIDGE_HIERARCHY_NODE_CAP,
  unityBridgeVerbNames,
  type UnityBridgeHierarchyNode,
  type UnityBridgePlayState,
  type UnityBridgeSceneRow,
  type UnityBridgeBuildSceneRow,
  type UnityConsoleEntry,
  type UnityConsoleSeverity,
} from '../../src/services/unity/bridgeProtocol.js'

export type FakeBridgeMode =
  | 'echo'
  | 'silent-after-hello'
  | 'drop-on-request'
  | 'no-pong'
  | 'oversize-on-request'

export interface FakeUnityBridgeOpts {
  token?: string
  /** The protocol version the SERVER demands in the hello (default 1) —
   *  raising it drives the server-side VERSION_SKEW arm. */
  protocolVersion?: number
  /** What the hello RESULT claims (default = protocolVersion) — skewing it
   *  while accepting the hello drives the CLIENT-side skew arm. */
  helloResultVersion?: number
  willReloadOnPlay?: boolean
  /** The ack-then-drop gap simulating the domain reload (default 15ms). */
  reloadDropDelayMs?: number
  testRunDurationMs?: number
  /** Fixture XML whose CONTENT lands at resultsPath when a run finishes
   *  (default: the landed editmode-pass fixture). */
  testsXmlPath?: string
  /** Counts carried on the test_run_finished event. */
  testCounts?: { passed: number; failed: number; skipped: number; inconclusive: number }
  /** Default results home when tests_run carries no resultsPath. */
  projectRoot?: string
  mode?: FakeBridgeMode
}

export interface FakeUnityBridge {
  port: number
  seenOps: string[]
  connectionCount: () => number
  setMode: (m: FakeBridgeMode) => void
  setActiveSceneDirty: (dirty: boolean) => void
  playState: () => UnityBridgePlayState
  close: () => Promise<void>
}

const DEFAULT_TESTS_XML = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'ide',
  'fixtures',
  'unity',
  'editmode-pass.xml',
)

const SCENES: UnityBridgeSceneRow[] = [
  { path: 'Assets/Scenes/Main.unity', name: 'Main', isDirty: false, isLoaded: true, isActive: true },
  { path: 'Assets/Scenes/Loading.unity', name: 'Loading', isDirty: false, isLoaded: false, isActive: false },
]
const BUILD_SCENES: UnityBridgeBuildSceneRow[] = [
  { path: 'Assets/Scenes/Loading.unity', enabled: true },
  { path: 'Assets/Scenes/Main.unity', enabled: true },
  { path: 'Assets/Scenes/Debug.unity', enabled: false },
]
const KNOWN_SCENES = new Set([...SCENES.map(s => s.path), ...BUILD_SCENES.map(s => s.path)])

function hierarchyFixture(): Array<{ path: string; roots: UnityBridgeHierarchyNode[] }> {
  const node = (
    name: string,
    componentTypeNames: string[],
    children: UnityBridgeHierarchyNode[] = [],
    active = true,
  ): UnityBridgeHierarchyNode => ({ name, active, componentTypeNames, children })
  return [
    {
      path: 'Assets/Scenes/Main.unity',
      roots: [
        node('Main Camera', ['Transform', 'Camera', 'AudioListener']),
        node('Directional Light', ['Transform', 'Light']),
        node('Player', ['Transform', 'Rigidbody', 'PlayerController'], [
          node('Model', ['Transform', 'MeshFilter', 'MeshRenderer']),
          node('Muzzle', ['Transform'], [], false),
        ]),
      ],
    },
  ]
}

const CONSOLE_FIXTURE: UnityConsoleEntry[] = [
  { severity: 'log', message: 'Boot: services ready', stackTrace: '', at: 1_000 },
  { severity: 'warning', message: 'Missing reference on Muzzle', stackTrace: 'PlayerController.Awake ()', at: 2_000 },
  { severity: 'error', message: 'NullReferenceException: Object reference not set', stackTrace: 'PlayerController.Update ()', at: 3_000 },
  { severity: 'log', message: 'Spawned wave 1', stackTrace: '', at: 4_000 },
]
const SEVERITY_RANK: Record<UnityConsoleSeverity, number> = {
  log: 0,
  warning: 1,
  assert: 2,
  error: 3,
  exception: 4,
}

export function startFakeUnityBridge(opts: FakeUnityBridgeOpts = {}): Promise<FakeUnityBridge> {
  const token = opts.token ?? 'tok'
  const protocolVersion = opts.protocolVersion ?? UNITY_BRIDGE_PROTOCOL_VERSION
  const helloResultVersion = opts.helloResultVersion ?? protocolVersion
  const state = {
    mode: opts.mode ?? ('echo' as FakeBridgeMode),
    seenOps: [] as string[],
    connections: 0,
    playState: {
      isPlaying: false,
      isPaused: false,
      isPlayingOrWillChangePlaymode: false,
      willReloadOnPlay: opts.willReloadOnPlay ?? true,
    } as UnityBridgePlayState,
    activeSceneDirty: false,
    openScenes: SCENES.map(s => ({ ...s })),
    consoleDropped: 2, // the ring has already evicted this many (honesty fixture)
    testRunning: false,
  }
  let current: net.Socket | null = null
  const sockets = new Set<net.Socket>()

  const server = net.createServer(socket => {
    sockets.add(socket)
    state.connections++
    socket.on('close', () => {
      sockets.delete(socket)
      if (current === socket) current = null
    })
    let buf = ''
    let authed = false
    const reply = (frame: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(JSON.stringify(frame) + '\n')
    }
    const fail = (id: unknown, code: string, message: string, hint?: string) => {
      reply({ id, ok: false, error: { code, message, ...(hint ? { hint } : {}) } })
    }
    const emit = (event: string, data: unknown) => {
      reply({ event, data })
    }
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(line) as Record<string, unknown>
        } catch {
          socket.destroy()
          return
        }
        if (!authed) {
          if (frame.op !== 'hello' || frame.token !== token) {
            reply({ ok: false, error: { code: 'AUTH_FAILED', message: 'bad token', hint: 'op:"unity_bridge_install" rewrites the token file' } })
            socket.end()
            return
          }
          if (frame.version !== protocolVersion) {
            reply({
              ok: false,
              error: {
                code: 'VERSION_SKEW',
                message: `the bridge package speaks protocol ${protocolVersion} but the client sent ${String(frame.version)}`,
                hint: 'op:"unity_bridge_install" refreshes the bundled package so both halves match',
              },
            })
            socket.end()
            return
          }
          authed = true
          // THE ACCEPT-NEWEST LAW, HELLO-TIME: only an AUTHENTICATED newer
          // connection replaces the older one — a bare connect (a
          // reachability probe) can never kick the live client.
          if (current && current !== socket) current.destroy()
          current = socket
          reply({
            ok: true,
            result: {
              version: helloResultVersion,
              bridge: 'com.mercury.unity-bridge/0.1.0-fake',
              unity: '6000.3.1f1-fake',
              project: 'fixture',
              playState: state.playState,
            },
          })
          continue
        }
        const op = String(frame.op)
        const id = frame.id
        const args = (frame.args ?? {}) as Record<string, unknown>
        state.seenOps.push(op)
        if (op === 'ping') {
          if (state.mode !== 'no-pong') reply({ id, ok: true, result: 'pong' })
          continue
        }
        if (state.mode === 'drop-on-request') {
          socket.destroy()
          continue
        }
        if (state.mode === 'silent-after-hello') continue
        if (state.mode === 'oversize-on-request') {
          socket.write('{"pad":"' + 'x'.repeat(9 * 1024 * 1024) + '"}\n')
          continue
        }
        switch (op) {
          case 'play_state':
            reply({ id, ok: true, result: state.playState })
            break
          case 'play_enter': {
            if (state.playState.isPlaying) {
              fail(id, 'PLAY_MODE_ACTIVE', 'already in play mode')
              break
            }
            // ACK-THEN-TRANSITION: the answer leaves before the reload drop.
            reply({ id, ok: true, result: { willReload: state.playState.willReloadOnPlay } })
            state.playState = { ...state.playState, isPlaying: true, isPlayingOrWillChangePlaymode: true }
            if (state.playState.willReloadOnPlay) {
              setTimeout(() => socket.destroy(), opts.reloadDropDelayMs ?? 15)
            } else {
              emit('play_state_changed', { playState: state.playState })
            }
            break
          }
          case 'play_exit': {
            if (!state.playState.isPlaying) {
              fail(id, 'PLAY_MODE_ACTIVE', 'not in play mode')
              break
            }
            reply({ id, ok: true, result: { willReload: state.playState.willReloadOnPlay } })
            state.playState = { ...state.playState, isPlaying: false, isPaused: false, isPlayingOrWillChangePlaymode: false }
            if (state.playState.willReloadOnPlay) {
              setTimeout(() => socket.destroy(), opts.reloadDropDelayMs ?? 15)
            } else {
              emit('play_state_changed', { playState: state.playState })
            }
            break
          }
          case 'play_pause': {
            if (typeof args.paused !== 'boolean') {
              fail(id, 'BAD_ARGS', 'paused must be a boolean')
              break
            }
            state.playState = { ...state.playState, isPaused: args.paused }
            reply({ id, ok: true, result: { isPaused: state.playState.isPaused } })
            break
          }
          case 'scene_list':
            reply({ id, ok: true, result: { open: state.openScenes, build: BUILD_SCENES } })
            break
          case 'scene_open': {
            if (state.playState.isPlaying) {
              fail(id, 'PLAY_MODE_ACTIVE', 'scene_open is edit-mode only — in play mode the SceneManager owns loading')
              break
            }
            const p = typeof args.path === 'string' ? args.path : ''
            if (!p) {
              fail(id, 'BAD_ARGS', 'path is required')
              break
            }
            if (p.includes('..')) {
              fail(id, 'BAD_ARGS', 'path must stay inside the project')
              break
            }
            if (!KNOWN_SCENES.has(p)) {
              fail(id, 'SCENE_NOT_FOUND', `no scene at ${p}`)
              break
            }
            if (state.activeSceneDirty) {
              fail(id, 'SCENE_DIRTY', 'the open scene has unsaved changes', 'save it in the editor first (File > Save) — the bridge never discards unsaved work')
              break
            }
            const additive = args.additive === true
            if (!additive) {
              state.openScenes = [{ path: p, name: path.basename(p, '.unity'), isDirty: false, isLoaded: true, isActive: true }]
            } else if (!state.openScenes.some(s => s.path === p)) {
              state.openScenes.push({ path: p, name: path.basename(p, '.unity'), isDirty: false, isLoaded: true, isActive: false })
            }
            reply({ id, ok: true, result: { opened: p, mode: additive ? 'Additive' : 'Single' } })
            break
          }
          case 'hierarchy_read': {
            const cap = typeof args.maxNodes === 'number' && args.maxNodes > 0 ? args.maxNodes : UNITY_BRIDGE_HIERARCHY_NODE_CAP
            const wanted = typeof args.scenePath === 'string' ? args.scenePath : undefined
            const scenes = hierarchyFixture().filter(s => !wanted || s.path === wanted)
            let total = 0
            let kept = 0
            // The TOTAL counts the whole tree even past the cap — only the
            // KEPT set is bounded (truncatedNodes stays honest at any cap).
            const walk = (n: UnityBridgeHierarchyNode): UnityBridgeHierarchyNode | null => {
              total++
              const keep = kept < cap
              if (keep) kept++
              const children: UnityBridgeHierarchyNode[] = []
              for (const c of n.children) {
                const w = walk(c)
                if (w && keep) children.push(w)
              }
              return keep ? { ...n, children } : null
            }
            const out = scenes.map(s => ({
              path: s.path,
              roots: s.roots.map(walk).filter((n): n is UnityBridgeHierarchyNode => n !== null),
            }))
            reply({ id, ok: true, result: { scenes: out, nodeCount: total, truncatedNodes: Math.max(0, total - kept) } })
            break
          }
          case 'console_tail': {
            const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 100
            const floor = typeof args.severity === 'string' && args.severity in SEVERITY_RANK
              ? SEVERITY_RANK[args.severity as UnityConsoleSeverity]
              : 0
            const entries = CONSOLE_FIXTURE.filter(e => SEVERITY_RANK[e.severity] >= floor).slice(-limit)
            reply({ id, ok: true, result: { entries, dropped: state.consoleDropped } })
            break
          }
          case 'tests_run': {
            const mode = args.mode
            if (mode !== 'EditMode' && mode !== 'PlayMode') {
              fail(id, 'BAD_ARGS', 'mode must be "EditMode" or "PlayMode"')
              break
            }
            if (state.testRunning) {
              fail(id, 'RUN_IN_FLIGHT', 'a test run is already executing — one at a time')
              break
            }
            const resultsPath =
              typeof args.resultsPath === 'string' && args.resultsPath.length > 0
                ? args.resultsPath
                : opts.projectRoot
                  ? path.join(opts.projectRoot, '.mercury', 'unity-test-results', `${(mode as string).toLowerCase()}.xml`)
                  : undefined
            if (!resultsPath) {
              fail(id, 'BAD_ARGS', 'resultsPath is required (the fake has no project root configured)')
              break
            }
            state.testRunning = true
            reply({ id, ok: true, result: { started: true, mode, resultsPath } })
            setTimeout(() => {
              const xml = readFileSync(opts.testsXmlPath ?? DEFAULT_TESTS_XML, 'utf8')
              mkdirSync(path.dirname(resultsPath), { recursive: true })
              writeFileSync(resultsPath, xml)
              state.testRunning = false
              const counts = opts.testCounts ?? { passed: 3, failed: 0, skipped: 0, inconclusive: 0 }
              emit('test_run_finished', { resultsPath, ...counts, durationMs: opts.testRunDurationMs ?? 30 })
            }, opts.testRunDurationMs ?? 30)
            break
          }
          default:
            fail(id, 'UNKNOWN_OP', `bridge does not handle '${op}'`, `one of: ${unityBridgeVerbNames().join(', ')}`)
        }
      }
    })
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        seenOps: state.seenOps,
        connectionCount: () => state.connections,
        setMode: m => {
          state.mode = m
        },
        setActiveSceneDirty: dirty => {
          state.activeSceneDirty = dirty
        },
        playState: () => state.playState,
        close: () =>
          new Promise<void>(r => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}
