
import * as net from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  BLENDER_BRIDGE_PROTOCOL_VERSION,
  BLENDER_BRIDGE_OBJECTS_NODE_CAP,
  BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES,
  blenderBridgeVerbNames,
  type BlenderBridgeObjectNode,
  type BlenderReportEntry,
  type BlenderReportSeverity,
} from '../../src/services/blender/bridgeProtocol.js'

export type FakeBridgeMode =
  | 'echo'
  | 'silent-after-hello'
  | 'drop-on-request'
  | 'no-pong'
  | 'oversize-on-request'

export interface FakeBlenderBridgeOpts {
  token?: string
  protocolVersion?: number
  helloResultVersion?: number
  renderDurationMs?: number
  renderCancels?: boolean
  pythonTruncates?: boolean
  blendFile?: string
  mode?: FakeBridgeMode
}

export interface FakeBlenderBridge {
  port: number
  seenOps: string[]
  connectionCount: () => number
  setMode: (m: FakeBridgeMode) => void
  setDirty: (dirty: boolean) => void
  renderInFlight: () => boolean
  openBlendExternally: (blendPath: string) => void
  close: () => Promise<void>
}

const DEFAULT_BLEND = '/work/studio/scene.blend'
const KNOWN_BLENDS = new Set([DEFAULT_BLEND, '/work/studio/assets/props.blend'])

function objectsFixture(): Array<{ name: string; roots: BlenderBridgeObjectNode[] }> {
  const node = (
    name: string,
    type: string,
    children: BlenderBridgeObjectNode[] = [],
    visible = true,
  ): BlenderBridgeObjectNode => ({ name, type, visible, children })
  return [
    {
      name: 'Scene',
      roots: [
        node('Props', 'COLLECTION', [
          node('Cube', 'MESH'),
          node('Key Light', 'LIGHT', [], false),
        ]),
        node('Camera', 'CAMERA'),
        node('Suzanne', 'MESH'),
      ],
    },
  ]
}

const REPORT_FIXTURE: BlenderReportEntry[] = [
  { severity: 'debug', message: 'bridge: pump armed', source: 'bridge', at: 1_000 },
  { severity: 'info', message: 'Loaded scene.blend', source: 'handler', at: 2_000 },
  { severity: 'warning', message: 'Modifier on Suzanne is disabled in renders', source: 'logging', at: 3_000 },
  { severity: 'error', message: "KeyError: 'missing_node' in driver", source: 'logging', at: 4_000 },
]
const SEVERITY_RANK: Record<BlenderReportSeverity, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
}

export function startFakeBlenderBridge(opts: FakeBlenderBridgeOpts = {}): Promise<FakeBlenderBridge> {
  const token = opts.token ?? 'tok'
  const protocolVersion = opts.protocolVersion ?? BLENDER_BRIDGE_PROTOCOL_VERSION
  const helloResultVersion = opts.helloResultVersion ?? protocolVersion
  const state = {
    mode: opts.mode ?? ('echo' as FakeBridgeMode),
    seenOps: [] as string[],
    connections: 0,
    blendFile: opts.blendFile ?? DEFAULT_BLEND,
    isDirty: false,
    renderInFlight: false,
    reportDropped: 2,
  }
  let current: net.Socket | null = null
  const sockets = new Set<net.Socket>()
  let emitToCurrent: ((event: string, data: unknown) => void) | null = null

  const server = net.createServer(socket => {
    sockets.add(socket)
    state.connections++
    socket.on('close', () => {
      sockets.delete(socket)
      if (current === socket) {
        current = null
        emitToCurrent = null
      }
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
    const renderGuard = (id: unknown): boolean => {
      if (!state.renderInFlight) return false
      fail(id, 'RENDER_ACTIVE', 'a render job is running', 'wait for render_finished (or read render_state); mutate/exec verbs refuse during renders, reads stay free')
      return true
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
            reply({ ok: false, error: { code: 'AUTH_FAILED', message: 'bad token', hint: 'op:"blender_bridge_install" rewrites the token file beside the add-on' } })
            socket.end()
            return
          }
          if (frame.version !== protocolVersion) {
            reply({
              ok: false,
              error: {
                code: 'VERSION_SKEW',
                message: `the bridge add-on speaks protocol ${protocolVersion} but the client sent ${String(frame.version)}`,
                hint: 'op:"blender_bridge_install" refreshes the bundled add-on so both halves match',
              },
            })
            socket.end()
            return
          }
          authed = true
          if (current && current !== socket) current.destroy()
          current = socket
          emitToCurrent = emit
          reply({
            ok: true,
            result: {
              version: helloResultVersion,
              bridge: 'mercury_blender_bridge/0.1.0-fake',
              blender: '5.2.1-fake',
              blendFile: state.blendFile,
              background: false,
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
          case 'scene_info':
            reply({
              id,
              ok: true,
              result: {
                blendFile: state.blendFile,
                isSaved: state.blendFile !== '',
                isDirty: state.isDirty,
                blender: '5.2.1-fake',
                scenes: [
                  { name: 'Scene', isActive: true },
                  { name: 'Overview', isActive: false },
                ],
                frameCurrent: 1,
                frameStart: 1,
                frameEnd: 250,
                engine: 'BLENDER_EEVEE_NEXT',
                mode: 'OBJECT',
                activeObject: 'Cube',
              },
            })
            break
          case 'objects_list': {
            const cap = typeof args.maxObjects === 'number' && args.maxObjects > 0 ? args.maxObjects : BLENDER_BRIDGE_OBJECTS_NODE_CAP
            const wanted = typeof args.sceneName === 'string' ? args.sceneName : undefined
            const scenes = objectsFixture().filter(s => !wanted || s.name === wanted)
            if (wanted && scenes.length === 0) {
              fail(id, 'BAD_ARGS', `no scene named '${wanted}'`)
              break
            }
            let total = 0
            let kept = 0
            const walk = (n: BlenderBridgeObjectNode): BlenderBridgeObjectNode | null => {
              total++
              const keep = kept < cap
              if (keep) kept++
              const children: BlenderBridgeObjectNode[] = []
              for (const c of n.children) {
                const w = walk(c)
                if (w && keep) children.push(w)
              }
              return keep ? { ...n, children } : null
            }
            const out = scenes.map(s => ({
              name: s.name,
              roots: s.roots.map(walk).filter((n): n is BlenderBridgeObjectNode => n !== null),
            }))
            reply({ id, ok: true, result: { scenes: out, nodeCount: total, truncatedNodes: Math.max(0, total - kept) } })
            break
          }
          case 'blend_open': {
            if (renderGuard(id)) break
            const p = typeof args.path === 'string' ? args.path : ''
            if (!p) {
              fail(id, 'BAD_ARGS', 'path is required')
              break
            }
            if (!KNOWN_BLENDS.has(p)) {
              fail(id, 'BLEND_NOT_FOUND', `no .blend at ${p}`)
              break
            }
            if (state.isDirty) {
              fail(id, 'BLEND_DIRTY', 'the open file has unsaved changes', 'save it in Blender first (File > Save) — the bridge never discards unsaved work')
              break
            }
            state.blendFile = p
            reply({ id, ok: true, result: { opened: p } })
            break
          }
          case 'render_state':
            reply({
              id,
              ok: true,
              result: {
                jobs: { render: state.renderInFlight, renderPreview: false, composite: false, objectBake: false },
                engine: 'BLENDER_EEVEE_NEXT',
                resolutionX: 1920,
                resolutionY: 1080,
                resolutionPercentage: 100,
                outputPath: '/tmp/',
                frameCurrent: 1,
                frameStart: 1,
                frameEnd: 250,
              },
            })
            break
          case 'render_still': {
            if (renderGuard(id)) break
            const outputPath = typeof args.outputPath === 'string' ? args.outputPath : ''
            if (!outputPath) {
              fail(id, 'BAD_ARGS', 'outputPath is required (the durable result lands there)')
              break
            }
            const frame_ = typeof args.frame === 'number' ? args.frame : 1
            state.renderInFlight = true
            reply({ id, ok: true, result: { started: true, outputPath, frame: frame_ } })
            const t0 = Date.now()
            setTimeout(() => {
              state.renderInFlight = false
              if (opts.renderCancels) {
                emit('render_finished', { outputPath, frame: frame_, ok: false, cancelled: true, durationMs: Date.now() - t0 })
              } else {
                mkdirSync(path.dirname(outputPath), { recursive: true })
                writeFileSync(outputPath, 'FAKE-PNG-BYTES:' + frame_ + '\n')
                emit('render_finished', { outputPath, frame: frame_, ok: true, cancelled: false, durationMs: Date.now() - t0 })
              }
            }, opts.renderDurationMs ?? 30)
            break
          }
          case 'report_tail': {
            const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 100
            const floor = typeof args.severity === 'string' && args.severity in SEVERITY_RANK
              ? SEVERITY_RANK[args.severity as BlenderReportSeverity]
              : 0
            const entries = REPORT_FIXTURE.filter(e => SEVERITY_RANK[e.severity] >= floor).slice(-limit)
            reply({ id, ok: true, result: { entries, dropped: state.reportDropped } })
            break
          }
          case 'python_run': {
            if (renderGuard(id)) break
            const source = typeof args.source === 'string' ? args.source : ''
            if (!source) {
              fail(id, 'BAD_ARGS', 'source is required')
              break
            }
            if (Buffer.byteLength(source, 'utf8') > BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES) {
              fail(id, 'BAD_ARGS', `source exceeds the ${BLENDER_BRIDGE_PYTHON_SOURCE_CAP_BYTES}-byte cap`)
              break
            }
            if (source.includes('BOOM')) {
              fail(
                id,
                'PYTHON_EXCEPTION',
                'ValueError: boom',
                'traceback (tail): File "<mercury_python_run>", line 1, in <module>',
              )
              break
            }
            if (opts.pythonTruncates) {
              reply({
                id,
                ok: true,
                result: { value: null, stdout: 'x'.repeat(64), stderr: '', truncated: { stdout: 5_000, stderr: 0 }, elapsedMs: 3 },
              })
              break
            }
            const value = source.includes('result =') ? "'fixture-value'" : null
            const stdout = source.startsWith('print(') ? 'hello from blender\n' : ''
            reply({
              id,
              ok: true,
              result: { value, stdout, stderr: '', truncated: { stdout: 0, stderr: 0 }, elapsedMs: 2 },
            })
            break
          }
          default:
            fail(id, 'UNKNOWN_OP', `bridge does not handle '${op}'`, `one of: ${blenderBridgeVerbNames().join(', ')}`)
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
        setDirty: dirty => {
          state.isDirty = dirty
        },
        renderInFlight: () => state.renderInFlight,
        openBlendExternally: blendPath => {
          state.blendFile = blendPath
          emitToCurrent?.('blend_changed', { filepath: blendPath })
        },
        close: () =>
          new Promise<void>(r => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          }),
      })
    })
  })
}
