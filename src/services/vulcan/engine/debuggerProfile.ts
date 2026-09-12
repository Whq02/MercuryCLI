import { engineMediaStats, type EngineMediaPhase, type EngineMediaRequest, type EngineMediaStats } from './media.js'
import { GODOT_DEBUGGER_VERSION, GodotDebuggerTransport, requireGodotDebuggerVersion, type GodotDebuggerMessage } from './debuggerTransport.js'

const MAX_FUNCTIONS = 4096
const MAX_VALUES = 2_000_000

interface ProfileFrame {
  frame: number
  frameMs: number
  processMs: number
  physicsMs: number
  physicsFrameMs: number
  scriptMs: number
  servers: Record<string, number>
  scripts: Array<{ id: number; calls: number; selfMs: number; totalMs: number; internalMs: number }>
}

export interface EngineDebuggerPhase extends EngineMediaPhase {
  firstFrame: number
  lastFrame: number
  physicsIntervalMs: EngineMediaStats
  scripts: Array<EngineMediaPhase['scripts'][number] & { totalCalls: number; internalMs: EngineMediaStats }>
  servers: Record<string, EngineMediaStats>
  monitors: { frameMs: EngineMediaStats; physicsMs: EngineMediaStats; memoryBytes: EngineMediaStats | null; memoryPeakBytes: EngineMediaStats | null; performanceSamples: number }
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Godot debugger ${name} must be a finite nonnegative number`)
  return value
}

function count(value: unknown, name: string): number {
  const n = number(value, name)
  if (!Number.isSafeInteger(n)) throw new Error(`Godot debugger ${name} must be an integer`)
  return n
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`Godot debugger ${name} must be a nonempty string`)
  return value
}

export function decodeGodotProfileFrame(data: unknown[]): ProfileFrame {
  let i = 0
  const integer = (name: string): number => count(data[i++], name)
  const ms = (name: string): number => number(data[i++], name) * 1000
  const frame: ProfileFrame = { frame: integer('frame'), frameMs: ms('frame time'), processMs: ms('process time'), physicsMs: ms('physics time'), physicsFrameMs: ms('physics frame time'), scriptMs: ms('script time'), servers: Object.create(null), scripts: [] }
  const servers = integer('server count')
  if (servers > data.length / 2) throw new Error('Godot debugger server count exceeds frame payload')
  for (let s = 0; s < servers; s++) {
    const server = text(data[i++], 'server name')
    const length = integer('server function values')
    if (length % 2 || i + length > data.length) throw new Error('Godot debugger server function table is malformed')
    for (let j = 0; j < length; j += 2) {
      const key = `${server}/${text(data[i++], 'server function')}`
      frame.servers[key] = (frame.servers[key] ?? 0) + ms('server function time')
    }
  }
  const length = integer('script function values')
  if (length % 5 || i + length !== data.length) throw new Error('Godot debugger script function table is malformed')
  for (let j = 0; j < length; j += 5) frame.scripts.push({ id: integer('signature id'), calls: integer('call count'), selfMs: ms('self time'), totalMs: ms('total time'), internalMs: ms('internal time') })
  if (frame.scripts.length >= MAX_FUNCTIONS) throw new Error(`Godot debugger script table reaches its ${MAX_FUNCTIONS}-function cap; no complete profile is claimed`)
  return frame
}

export class GodotDebuggerProfile {
  readonly transport: GodotDebuggerTransport
  readonly phases: EngineDebuggerPhase[] = []
  readonly examples: Record<string, unknown[]> = Object.create(null)
  engine: Record<string, unknown> | null = null
  finished = false
  private thread: number | bigint | null = null
  private signatures = new Map<number, string>()
  private frames: ProfileFrame[] = []
  private monitors: Array<{ frame: number; values: number[] }> = []
  private windows: Array<{ variant: string; stepIndex: number; begin: number; end: number }> = []
  private retainedValues = 0
  private lastFrame = 0
  private stopping = false

  constructor(private request: EngineMediaRequest, private driverPath?: string) {
    this.transport = new GodotDebuggerTransport(message => this.receive(message))
  }

  private send(name: string, data: unknown[]): void {
    if (this.thread === null) throw new Error('Godot debugger has no worker thread')
    this.examples[`send ${name}${name.startsWith('profiler:') ? data[0] ? ' on' : ' off' : ''}`] ??= data
    this.transport.send(name, this.thread, data)
  }

  private receive({ name, thread, data }: GodotDebuggerMessage): void {
    if (name === 'mercury_profile:hello') {
      if (this.engine || data.length !== 2 || data[0] !== this.transport.token || !data[1] || typeof data[1] !== 'object' || Array.isArray(data[1])) throw new Error('Godot debugger worker hello has the wrong identity or shape')
      const engine = data[1] as Record<string, unknown>
      requireGodotDebuggerVersion(`${count(engine.major, 'engine major')}.${count(engine.minor, 'engine minor')}.${count(engine.patch, 'engine patch')}`)
      this.engine = engine
      this.thread = thread
      this.transport.connected = true
      this.examples[name] = ['<job token>', engine]
      this.send('set_ignore_error_breaks', [true])
      this.send('profiler:servers', [true, [MAX_FUNCTIONS, false]])
      this.send('profiler:performance', [true])
      this.send('mercury_profile:ready', [])
      return
    }
    if (!this.engine) return
    if (thread !== this.thread) return
    if (name === 'error' && data[9] !== true) throw new Error(`Godot debugger worker error: ${String(data[7])}: ${String(data[8])}`)
    if (name === 'servers:function_signature') {
      if (data.length !== 2) throw new Error('Godot debugger function signature is malformed')
      const id = count(data[1], 'signature id')
      if (this.signatures.size >= MAX_FUNCTIONS * 16) throw new Error('Godot debugger signature limit exceeded')
      const signature = text(data[0], 'function signature')
      this.signatures.set(id, this.driverPath && signature.startsWith(`${this.driverPath}::`) ? `<profile driver>${signature.slice(this.driverPath.length)}` : signature)
    } else if (name === 'servers:profile_frame') {
      this.retainedValues += data.length
      if (this.retainedValues > MAX_VALUES) throw new Error('Godot debugger profile exceeds two million retained values; shorten the sample window')
      const frame = decodeGodotProfileFrame(data)
      if (this.frames.length && frame.frame <= this.lastFrame) throw new Error('Godot debugger profiler frames are not increasing')
      this.lastFrame = frame.frame
      this.frames.push(frame)
    } else if (name === 'performance:profile_frame') {
      if (data.length < 6) throw new Error('Godot debugger performance frame is incomplete')
      if (this.monitors.length >= 10_000) throw new Error('Godot debugger performance sample limit exceeded')
      this.monitors.push({ frame: this.lastFrame, values: data.slice(0, 6).map((n, i) => number(n, `performance monitor ${i}`)) })
    } else if (name === 'mercury_profile:window') {
      if (data.length !== 4) throw new Error('Godot debugger sample window is malformed')
      this.windows.push({ variant: text(data[0], 'variant'), stepIndex: count(data[1], 'step'), begin: count(data[2], 'window begin'), end: count(data[3], 'window end') })
      if (this.windows.length > this.request.tour.steps.length * (this.request.pair ? 2 : 1)) throw new Error('Godot debugger returned too many sample windows')
    } else if (name === 'mercury_profile:stop') {
      if (this.stopping) throw new Error('Godot debugger repeated profiler stop')
      this.stopping = true
      this.send('profiler:servers', [false])
      this.send('profiler:performance', [false])
    } else if (name === 'servers:profile_total') {
      if (!this.stopping) throw new Error('Godot debugger profiler stopped before the sample window ended')
      decodeGodotProfileFrame(data)
      this.settle()
      this.finished = true
      this.send('mercury_profile:stopped', [])
    }
    if (['servers:function_signature', 'servers:profile_frame', 'servers:profile_total', 'performance:profile_frame', 'mercury_profile:window', 'mercury_profile:stop'].includes(name)) this.examples[name] ??= data
  }

  private settle(): void {
    const variants = this.request.pair ? ['a', 'b'] : ['single']
    if (this.windows.length !== variants.length * this.request.tour.steps.length) throw new Error('Godot debugger profile has incomplete sample windows')
    let index = 0
    for (const variant of variants) for (const [stepIndex, step] of this.request.tour.steps.entries()) {
      const window = this.windows[index++]!
      if (window.variant !== variant || window.stepIndex !== stepIndex || window.end - window.begin !== this.request.sampleFrames) throw new Error('Godot debugger window does not match the frozen request')
      const frames = this.frames.filter(frame => frame.frame >= window.begin && frame.frame < window.end)
      if (frames.length !== this.request.sampleFrames || frames.some((frame, i) => frame.frame !== window.begin + i)) throw new Error(`Godot debugger missing frames for ${variant}/${stepIndex}: expected ${this.request.sampleFrames}, received ${frames.length}`)
      const stats = (values: number[]): EngineMediaStats => engineMediaStats(values, 'engine debugger')
      const sample = (key: 'frameMs' | 'processMs' | 'physicsMs' | 'physicsFrameMs'): EngineMediaStats => stats(frames.map(frame => frame[key]))
      const servers = Object.fromEntries([...new Set(frames.flatMap(frame => Object.keys(frame.servers)))].sort().map(key => [key, stats(frames.map(frame => frame.servers[key] ?? 0))]))
      const ids = [...new Set(frames.flatMap(frame => frame.scripts.map(script => script.id)))]
      const scripts = ids.map(id => {
        const signature = this.signatures.get(id)
        if (!signature) throw new Error(`Godot debugger has no function signature for ${id}`)
        const rows = frames.map(frame => frame.scripts.find(row => row.id === id))
        return { script: signature, selfMs: stats(rows.map(row => row?.selfMs ?? 0)), totalMs: stats(rows.map(row => row?.totalMs ?? 0)), calls: stats(rows.map(row => row?.calls ?? 0)), totalCalls: rows.reduce((n, row) => n + (row?.calls ?? 0), 0), internalMs: stats(rows.map(row => row?.internalMs ?? 0)) }
      }).sort((a, b) => b.selfMs.median - a.selfMs.median)
      const monitors = this.monitors.filter(m => m.frame >= window.begin && m.frame < window.end)
      this.phases.push({
        variant, stepIndex, step, firstFrame: window.begin, lastFrame: window.end - 1, physicsIntervalMs: sample('physicsFrameMs'),
        frameMs: sample('frameMs'), processMs: sample('processMs'), physicsMs: sample('physicsMs'),
        navigationMs: monitors.length ? stats(monitors.map(m => m.values[3]! * 1000)) : null,
        gpuMs: null, renderCpuMs: null, scripts, servers,
        physics: Object.fromEntries(Object.entries(servers).filter(([name]) => /physics/i.test(name))),
        monitors: { frameMs: sample('frameMs'), physicsMs: sample('physicsMs'), memoryBytes: monitors.length ? stats(monitors.map(m => m.values[4]!)) : null, memoryPeakBytes: monitors.length ? stats(monitors.map(m => m.values[5]!)) : null, performanceSamples: monitors.length },
      })
    }
    this.frames = []
    this.monitors = []
  }

  evidence(): Record<string, unknown> {
    return { source: 'engine debugger', engine: this.engine, decoderVersion: GODOT_DEBUGGER_VERSION, connected: this.transport.connected, port: this.transport.port, receivedBytes: this.transport.receivedBytes, complete: this.finished, error: this.transport.error, phases: this.phases, protocolExamples: this.examples, limits: { functionsPerFrame: MAX_FUNCTIONS, retainedValues: MAX_VALUES }, notes: 'Script and server times are Godot profiler seconds converted to milliseconds, including the driver overhead; frame time is engine work, not wall-clock spacing. physicsIntervalMs is the simulation interval, not physics work. Missing functions below the cap count as zero for that frame. Performance monitors arrive once per second; memory and navigation are null when the settled window has no monitor sample. Frame and physics monitors use servers:profile_frame. GPU timing is not supplied by this source.' }
  }
}
