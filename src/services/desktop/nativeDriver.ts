import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { getProjectsDir } from '../../utils/sessionStorage/paths.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { voiceCheckoutRoot } from '../voice/voicePack.js'
import { computerAccessWords } from './computerAccess.js'
import { bundleWebEngine } from './webEngine.js'
import {
  desktopAbortedAnswer,
  displaysFingerprint,
  isDesktopKey,
  type DesktopActKind,
  type DesktopActReceipt,
  type DesktopAnswer,
  type DesktopApplication,
  type DesktopBounds,
  type DesktopButton,
  type DesktopCapture,
  type DesktopCursor,
  type DesktopDisplay,
  type DesktopDisplays,
  type DesktopDriver,
  type DesktopDriverFacts,
  type DesktopError,
  type DesktopGrant,
  type DesktopHeld,
  type DesktopModifier,
  type DesktopPermissions,
  type DesktopPoint,
  type DesktopSessionKind,
  type DesktopFocusedText,
  type DesktopScrollReceipt,
  type DesktopTree,
  type DesktopTreeElement,
  type DesktopTreeLimits,
  type DesktopTypeOptions,
  type DesktopValueReceipt,
  type DesktopClickablePoint,
} from './driver.js'
import {
  DESKTOP_BUILD_COMMAND,
  DESKTOP_PACK_ABSENT_PREFIX,
  desktopPackAbsentNote,
  loadDesktopAddon,
  resetDesktopAddonForTest,
  resolveDesktopPackDir,
  type DesktopAddon,
  type DesktopAddonApplication,
  type DesktopAddonCapture,
  type DesktopAddonPermissions,
  type DesktopAddonScroll,
  type DesktopAddonTree,
  type DesktopAddonValue,
  type DesktopAddonClickablePoint,
} from './pack.js'

type DesktopDriverLoad =
  | { state: 'ok'; driver: DesktopDriver }
  | { state: 'unavailable'; note: string; remedy: string | null }

interface DesktopHealthFacts {
  ready: boolean
  line: string
  detail: string
  fix?: string
}

const BUTTONS: readonly DesktopButton[] = ['left', 'right', 'middle']
const MODIFIERS: readonly DesktopModifier[] = ['shift', 'control', 'alt', 'super']
const GRANTS: readonly DesktopGrant[] = ['granted', 'denied', 'not-required', 'unknown']
const SESSION_KINDS: readonly DesktopSessionKind[] = ['desktop', 'no-display', 'wayland', 'locked', 'service', 'unknown']
const TERMINAL_IDENTITIES: Record<string, string> = {
  Apple_Terminal: 'com.apple.Terminal',
  'iTerm.app': 'com.googlecode.iterm2',
  WezTerm: 'com.github.wez.wezterm',
  vscode: 'com.microsoft.VSCode',
}
const DESKTOP_TYPE_GAP_CAP_MS = 1_000
const ABORTED_PREFIX = 'aborted'
const TREE_SUBPROCESS_TIMEOUT_MS = 12_000
const TREE_SUBPROCESS_BUFFER = 16 * 1024 * 1024
const CAPTURE_CHILD_TIMEOUT_MS = 2_500
const CAPTURE_CHILD_RETRY_WAIT_MS: readonly [number, number] = [200, 800]
const CAPTURE_CHILD_BUFFER = 64 * 1024 * 1024
const CAPTURE_CHILD_SCRIPT = 'const a=require(process.argv[1]);const q=JSON.parse(require("node:fs").readFileSync(0,"utf8"));new Promise(r=>r(q.region?a.captureRegion(q.display,q.region):a.capture(q.display))).then(c=>{const png=Buffer.from(c.png.buffer,c.png.byteOffset,c.png.byteLength);process.stdout.write(Buffer.concat([Buffer.from(JSON.stringify({width:c.width,height:c.height,scale:c.scale,display:c.display,displayId:c.displayId,originX:c.originX,originY:c.originY,png:png.length})+"\\n"),png]),()=>process.exit(0))},e=>{process.stdout.write(JSON.stringify({error:e instanceof Error?e.message:String(e)})+"\\n",()=>process.exit(1))})'
type DesktopQuery = 'readElement' | 'readClipboard' | 'findApplication' | 'activateApplication' | 'scrollToVisible' | 'setValue' | 'clickablePoint'
const QUERY_PLATFORMS: Record<DesktopQuery, readonly string[]> = {
  readElement: ['darwin'],
  readClipboard: ['darwin'],
  findApplication: ['darwin'],
  activateApplication: ['darwin'],
  scrollToVisible: ['darwin', 'win32'],
  setValue: ['darwin', 'win32'],
  clickablePoint: ['win32'],
}

export function desktopGrantWords(platform: string = process.platform): string {
  if (platform === 'darwin') return 'allow your terminal application under System Settings → Privacy & Security → Screen Recording and → Accessibility, then restart the terminal application'
  if (platform === 'win32') return 'run Mercury from an interactive desktop session (not a service, not a locked desktop); input into an elevated window needs an elevated terminal'
  return 'an X11 session with DISPLAY set; Wayland sessions are refused'
}

const fail = <T>(error: DesktopError): DesktopAnswer<T> => ({ ok: false, error })

const contractDefect = (field: string, value: unknown): DesktopError => ({
  kind: 'defect',
  note: `the desktop addon answered ${field} "${String(value)}" outside its contract — rebuild it: ${DESKTOP_BUILD_COMMAND}`,
})

function classifyThrown(error: unknown): DesktopError {
  const note = error instanceof Error ? error.message : String(error)
  const head = note.trim().toLowerCase()
  logForDebugging(`desktop driver: the addon threw: ${note}`)
  if (head.startsWith('aborted')) return { kind: 'aborted', note: 'the act was interrupted before it completed; every held key and button was released' }
  if (head.startsWith('no such')) return { kind: 'input', note }
  if (head.startsWith('no display')) return { kind: 'display', note }
  if (head.startsWith('unsupported') || head.startsWith('no desktop session')) return { kind: 'session', note, remedy: desktopGrantWords() }
  if (head.includes('unsupported on this platform')) return { kind: 'unavailable', note }
  if (head.startsWith('the application is not in front')) return { kind: 'display', note }
  if (head.startsWith('screen capture is not granted') || head.startsWith('input control is not granted')) return { kind: 'permission', note, remedy: desktopGrantWords() }
  return { kind: 'defect', note }
}

const granted = (grant: DesktopGrant): boolean => grant === 'granted' || grant === 'not-required'

function decodePermissions(raw: DesktopAddonPermissions): DesktopAnswer<DesktopPermissions> {
  if (!(SESSION_KINDS as readonly string[]).includes(raw.session)) return fail(contractDefect('session', raw.session))
  if (!(GRANTS as readonly string[]).includes(raw.screenCapture)) return fail(contractDefect('screenCapture', raw.screenCapture))
  if (!(GRANTS as readonly string[]).includes(raw.input)) return fail(contractDefect('input', raw.input))
  return {
    ok: true,
    value: {
      session: raw.session as DesktopSessionKind,
      screenCapture: raw.screenCapture as DesktopGrant,
      input: raw.input as DesktopGrant,
      reason: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : null,
    },
  }
}

function sessionRefusal(permissions: DesktopPermissions): DesktopError | null {
  if (permissions.session === 'desktop') return null
  return { kind: 'session', note: permissions.reason ?? `no desktop session to drive (the session is ${permissions.session})`, remedy: desktopGrantWords() }
}

function captureRefusal(permissions: DesktopPermissions): DesktopError | null {
  const session = sessionRefusal(permissions)
  if (session !== null) return session
  if (granted(permissions.screenCapture)) return null
  return { kind: 'permission', note: `screen capture is not granted (${permissions.screenCapture})${permissions.reason ? ` — ${permissions.reason}` : ''}`, remedy: desktopGrantWords() }
}

function inputRefusal(permissions: DesktopPermissions): DesktopError | null {
  const session = sessionRefusal(permissions)
  if (session !== null) return session
  if (granted(permissions.input)) return null
  return { kind: 'permission', note: `input control is not granted (${permissions.input})${permissions.reason ? ` — ${permissions.reason}` : ''}`, remedy: desktopGrantWords() }
}

const finitePoint = (point: DesktopPoint): boolean => Number.isFinite(point.x) && Number.isFinite(point.y)
const pointRefusal = (point: DesktopPoint): DesktopError => ({ kind: 'input', note: `a point needs finite coordinates (got ${String(point.x)}, ${String(point.y)})` })

function application(raw: DesktopAddonApplication, identity: string): DesktopApplication {
  const b = raw.bounds
  const bounds: DesktopBounds | null =
    b && [b.x, b.y, b.width, b.height].every(n => Number.isFinite(n)) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null
  const webEngine = typeof raw.bundlePath === 'string' && raw.bundlePath !== '' ? bundleWebEngine(raw.bundlePath) : undefined
  return {
    identity,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : identity,
    pid: typeof raw.pid === 'number' && Number.isFinite(raw.pid) ? raw.pid : null,
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : null,
    bounds,
    windowId: typeof raw.windowId === 'string' && raw.windowId !== '' ? raw.windowId : null,
    tty: typeof raw.tty === 'string' && raw.tty !== '' ? raw.tty : null,
    ...(webEngine !== undefined ? { webEngine } : {}),
  }
}

function pageStillEmpty(elements: readonly { depth: number; role: string }[], depthLimit: number): boolean {
  const areas = elements.flatMap((element, index) => (element.role.startsWith('AXWebArea') ? [index] : []))
  return areas.length > 0 && areas.every(index => elements[index]!.depth < depthLimit && (elements[index + 1]?.depth ?? -1) <= elements[index]!.depth)
}

function pngSigned(png: unknown): png is Uint8Array {
  if (!(png instanceof Uint8Array) || png.length < 8) return false
  return png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
}

function bridgedElement(element: DesktopTreeElement): Record<string, unknown> {
  return Object.fromEntries(Object.entries(element).filter(([, value]) => value !== null))
}

let spansRead: boolean | undefined
function displaysSpan(): boolean {
  if (process.platform !== 'darwin') return true
  if (spansRead === undefined) {
    try {
      spansRead = execFileSync('/usr/bin/defaults', ['read', 'com.apple.spaces', 'spans-displays'], { encoding: 'utf8', timeout: 2_000, windowsHide: true, env: subprocessEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1'
    } catch {
      spansRead = false
    }
  }
  return spansRead
}

function boundsOf(raw: unknown): DesktopBounds | null {
  if (raw === null || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  return [b.x, b.y, b.width, b.height].every(n => typeof n === 'number' && Number.isFinite(n)) ? { x: b.x as number, y: b.y as number, width: b.width as number, height: b.height as number } : null
}

const noteOf = (reason: unknown): string | null => (typeof reason === 'string' && reason !== '' ? reason : null)

function readerExitWords(error: { killed?: boolean; code?: string | number | null }): string {
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return `the native reader answered more than ${TREE_SUBPROCESS_BUFFER / (1024 * 1024)} MiB`
  if (error.killed) return `no answer within ${TREE_SUBPROCESS_TIMEOUT_MS / 1000} seconds (the application may not be responding)`
  return 'the native reader exited without an answer'
}

type CaptureChildOutcome = { kind: 'captured'; raw: DesktopAddonCapture } | { kind: 'deadline' } | { kind: 'failed'; note: string }

function captureChildAnswer(stdout: Buffer): { raw: DesktopAddonCapture } | { error: string } | null {
  const newline = stdout.indexOf(0x0a)
  if (newline < 0) return null
  let head: unknown
  try {
    head = JSON.parse(stdout.subarray(0, newline).toString('utf8'))
  } catch {
    return null
  }
  if (head === null || typeof head !== 'object') return null
  const record = head as Record<string, unknown>
  if (typeof record.error === 'string') return { error: record.error }
  if (typeof record.png !== 'number' || stdout.length - newline - 1 !== record.png) return null
  const png = stdout.subarray(newline + 1)
  return { raw: { ...(record as unknown as Omit<DesktopAddonCapture, 'png'>), png, capturedAt: Date.now() } }
}

function sessionsOnThisBinary(): { read: boolean; named: string } {
  if (process.platform !== 'darwin') return { read: false, named: '' }
  let listing = ''
  let read = true
  try {
    listing = execFileSync('/usr/sbin/lsof', ['-t', '--', process.execPath], { encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024, windowsHide: true, env: subprocessEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    const killed = (error as { killed?: unknown }).killed === true || (error as { code?: unknown }).code === 'ENOENT'
    listing = typeof stdout === 'string' ? stdout : ''
    read = !killed && listing !== ''
  }
  const peers: number[] = []
  for (const line of listing.split('\n')) {
    const pid = Number(line.trim())
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !peers.includes(pid)) peers.push(pid)
  }
  if (peers.length === 0) return { read, named: '' }
  const sessions = new Map<number, string>()
  try {
    const projects = getProjectsDir()
    for (const project of readdirSync(projects)) {
      let names: string[]
      try {
        names = readdirSync(join(projects, project))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.writer.lock')) continue
        try {
          const lock = JSON.parse(readFileSync(join(projects, project, name), 'utf8')) as { pid?: unknown }
          if (typeof lock.pid === 'number' && peers.includes(lock.pid)) sessions.set(lock.pid, name.slice(0, 8))
        } catch {}
      }
    }
  } catch {}
  const named = peers.filter(pid => sessions.has(pid)).map(pid => `session ${sessions.get(pid)}… (pid ${pid})`)
  return { read, named: named.slice(0, 3).join('; ') + (named.length > 3 ? ` and ${named.length - 3} more` : '') }
}

function captureHeldNote(): string {
  const sessions = sessionsOnThisBinary()
  const others = sessions.named ? `the other Mercury sessions on this binary: ${sessions.named}` : sessions.read ? 'no other Mercury session was found on this binary' : 'the processes on this binary could not be listed'
  return `macOS cancelled the screen-capture connection twice: another process on this Mercury node binary was capturing at the same moment, or macOS is still settling after an earlier clash (${others}); Screen Recording is granted — wait about fifteen seconds and retry${sessions.named ? '; a session whose screenshots keep clashing with this one can be ended' : ''}`
}

type DesktopQueryAnswer = { value: unknown } | { error: string }

function queryAnswer(stdout: string): DesktopQueryAnswer | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  if ('error' in parsed && typeof parsed.error === 'string') return { error: parsed.error }
  if ('value' in parsed) return { value: parsed.value }
  return null
}

class NativeDesktopDriver implements DesktopDriver {
  private closed = false
  private grantsRequested = false
  private readonly webRequests = new Map<string, number>()
  private readonly pageWindows = new Set<string>()
  private readonly pageApplications = new Set<string>()

  readonly captureRegion?: DesktopDriver['captureRegion']

  constructor(
    private readonly addon: DesktopAddon,
    private readonly facts: DesktopDriverFacts,
    private readonly addonPath: string,
  ) {
    if (addon.captureRegion) this.captureRegion = (display, bounds, signal) => this.capture(display, signal, bounds)
  }

  describe(): DesktopDriverFacts {
    return { ...this.facts }
  }

  private closedRefusal<T>(): DesktopAnswer<T> | null {
    return this.closed ? fail({ kind: 'unavailable', note: 'the desktop driver is closed — resolve it again to drive' }) : null
  }

  private readPermissions(): DesktopAnswer<DesktopPermissions> {
    try {
      return decodePermissions(this.addon.permissions())
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  private refuseAndRequestGrants<T>(refusal: DesktopError): DesktopAnswer<T> {
    if (refusal.kind === 'permission' && !this.grantsRequested) {
      this.grantsRequested = true
      try {
        this.addon.requestPermissions()
      } catch (error) {
        logForDebugging(`desktop driver: the grant request threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return fail(refusal)
  }

  private async withCancel<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const onAbort = (): void => {
      try {
        this.addon.cancel()
      } catch (error) {
        logForDebugging(`desktop driver: cancel threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await run()
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async act(kind: DesktopActKind, at: DesktopPoint | null, signal: AbortSignal, run: () => void | Promise<void>): Promise<DesktopAnswer<DesktopActReceipt>> {
    const closed = this.closedRefusal<DesktopActReceipt>()
    if (closed !== null) return closed
    if (signal.aborted) return desktopAbortedAnswer()
    const permissions = this.readPermissions()
    if (!permissions.ok) return fail(permissions.error)
    const refusal = inputRefusal(permissions.value)
    if (refusal !== null) return this.refuseAndRequestGrants(refusal)
    try {
      await this.withCancel(signal, async () => {
        await run()
      })
    } catch (error) {
      return fail(classifyThrown(error))
    }
    if (signal.aborted) {
      await this.releaseAll()
      return desktopAbortedAnswer()
    }
    return { ok: true, value: { act: kind, at, completedAt: Date.now() } }
  }

  async keyboardIdleMs(): Promise<number | null> {
    try {
      const value = this.addon.keyboardIdleMs?.()
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    } catch {
      return null
    }
  }
  async permissions(): Promise<DesktopAnswer<DesktopPermissions>> {
    return this.permissionsNow()
  }

  permissionsNow(): DesktopAnswer<DesktopPermissions> {
    return this.closedRefusal<DesktopPermissions>() ?? this.readPermissions()
  }

  async requestPermissions(): Promise<DesktopAnswer<DesktopPermissions>> {
    const closed = this.closedRefusal<DesktopPermissions>()
    if (closed !== null) return closed
    try {
      return decodePermissions(this.addon.requestPermissions())
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  async displays(): Promise<DesktopAnswer<DesktopDisplays>> {
    const closed = this.closedRefusal<DesktopDisplays>()
    if (closed !== null) return closed
    try {
      const raw = this.addon.displays()
      if (!Array.isArray(raw.displays)) return fail(contractDefect('displays', typeof raw.displays))
      if (raw.displays.length === 0) return fail({ kind: 'session', note: raw.reason ?? 'no displays', remedy: desktopGrantWords() })
      const displays: DesktopDisplay[] = []
      for (const d of raw.displays) {
        const numbers = [d.index, d.originX, d.originY, d.width, d.height, d.scale]
        if (!numbers.every(n => typeof n === 'number' && Number.isFinite(n)) || typeof d.id !== 'string') return fail(contractDefect('display', JSON.stringify(d)))
        const work = boundsOf(d.work)
        displays.push({ index: d.index, id: d.id, originX: d.originX, originY: d.originY, width: d.width, height: d.height, scale: d.scale, primary: d.primary === true, ...(work ? { work } : {}) })
      }
      return { ok: true, value: { displays, fingerprint: displaysFingerprint(displays), spanning: displaysSpan() } }
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  async capture(display: number, signal: AbortSignal, region?: DesktopBounds): Promise<DesktopAnswer<DesktopCapture>> {
    const closed = this.closedRefusal<DesktopCapture>()
    if (closed !== null) return closed
    if (signal.aborted) return desktopAbortedAnswer()
    if (!Number.isInteger(display) || display < 0) return fail({ kind: 'display', note: `no display ${String(display)}` })
    const permissions = this.readPermissions()
    if (!permissions.ok) return fail(permissions.error)
    const refusal = captureRefusal(permissions.value)
    if (refusal !== null) return this.refuseAndRequestGrants(refusal)
    let raw: DesktopAddonCapture
    if (process.platform === 'darwin') {
      const captured = await this.captureThroughChild(display, region, signal)
      if (!captured.ok) return captured
      raw = captured.value
    } else {
      try {
        raw = await this.withCancel(signal, () => region ? this.addon.captureRegion!(display, region) : this.addon.capture(display))
      } catch (error) {
        return fail(classifyThrown(error))
      }
    }
    if (signal.aborted) return desktopAbortedAnswer()
    if (!pngSigned(raw.png)) return fail({ kind: 'defect', note: `the desktop addon answered a capture that is not a PNG — rebuild it: ${DESKTOP_BUILD_COMMAND}` })
    const numbers = [raw.width, raw.height, raw.scale, raw.display, raw.originX, raw.originY]
    if (!numbers.every(n => typeof n === 'number' && Number.isFinite(n)) || typeof raw.displayId !== 'string') return fail(contractDefect('capture', 'a record with a non-finite field'))
    const png = Buffer.isBuffer(raw.png) ? raw.png : Buffer.from(raw.png.buffer, raw.png.byteOffset, raw.png.byteLength)
    return {
      ok: true,
      value: {
        png,
        width: raw.width,
        height: raw.height,
        scale: raw.scale,
        display: raw.display,
        displayId: raw.displayId,
        originX: raw.originX,
        originY: raw.originY,
        capturedAt: Date.now(),
      },
    }
  }

  private captureInChild(display: number, region: DesktopBounds | undefined, signal: AbortSignal): Promise<CaptureChildOutcome> {
    return new Promise(resolve => {
      const child = execFile(process.execPath, ['-e', CAPTURE_CHILD_SCRIPT, this.addonPath], { timeout: CAPTURE_CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: subprocessEnv(), maxBuffer: CAPTURE_CHILD_BUFFER, encoding: 'buffer' }, (error, stdout) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) return resolve({ kind: 'failed', note: ABORTED_PREFIX })
        const answer = captureChildAnswer(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
        if (answer !== null && 'raw' in answer) return resolve({ kind: 'captured', raw: answer.raw })
        if (error?.killed) return resolve({ kind: 'deadline' })
        if (answer !== null) return resolve({ kind: 'failed', note: answer.error })
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ kind: 'failed', note: `the capture child answered more than ${CAPTURE_CHILD_BUFFER / (1024 * 1024)} MiB` })
        resolve({ kind: 'failed', note: error ? 'the capture child exited without an image' : 'the capture child answered an unreadable record' })
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(JSON.stringify({ display, ...(region ? { region } : {}) }))
      const onAbort = () => { child.kill('SIGKILL') }
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  private async captureThroughChild(display: number, region: DesktopBounds | undefined, signal: AbortSignal): Promise<DesktopAnswer<DesktopAddonCapture>> {
    const first = await this.captureInChild(display, region, signal)
    if (signal.aborted) return desktopAbortedAnswer()
    if (first.kind === 'captured') return { ok: true, value: first.raw }
    if (first.kind === 'failed') return fail(classifyThrown(new Error(first.note)))
    const wait = CAPTURE_CHILD_RETRY_WAIT_MS[0] + Math.floor(Math.random() * (CAPTURE_CHILD_RETRY_WAIT_MS[1] - CAPTURE_CHILD_RETRY_WAIT_MS[0]))
    await new Promise<void>(resolve => { const timer = setTimeout(done, wait); function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() } signal.addEventListener('abort', done, { once: true }) })
    if (signal.aborted) return desktopAbortedAnswer()
    const second = await this.captureInChild(display, region, signal)
    if (signal.aborted) return desktopAbortedAnswer()
    if (second.kind === 'captured') return { ok: true, value: second.raw }
    if (second.kind === 'failed') return fail(classifyThrown(new Error(second.note)))
    return fail({ kind: 'busy', note: captureHeldNote() })
  }

  async frontmostApplication(): Promise<DesktopAnswer<DesktopApplication>> {
    const closed = this.closedRefusal<DesktopApplication>()
    if (closed !== null) return closed
    try {
      const raw = process.platform === 'darwin'
        ? await new Promise<DesktopAddonApplication>((resolve, reject) => {
            const args = ['-e', 'const a=require(process.argv[1]); process.stdout.write(JSON.stringify(a.frontmostApplication()))', this.addonPath]
            execFile(process.execPath, args, { timeout: 5000, killSignal: 'SIGKILL', windowsHide: true, env: subprocessEnv(), maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
              if (error) return reject(new Error('the frontmost application could not be read from macOS — no cached application was used'))
              try {
                const answer: unknown = JSON.parse(stdout)
                if (answer === null || typeof answer !== 'object') return reject(new Error('macOS returned no application record'))
                resolve(answer as DesktopAddonApplication)
              } catch {
                reject(new Error('the frontmost application query returned an unreadable record'))
              }
            })
          })
        : this.addon.frontmostApplication()
      if (typeof raw.identity !== 'string' || raw.identity === '') return fail({ kind: 'display', note: raw.reason ?? 'no frontmost application' })
      return { ok: true, value: application(raw, raw.identity) }
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  async ownTerminalApplication(front?: DesktopApplication): Promise<DesktopAnswer<DesktopApplication | null>> {
    const closed = this.closedRefusal<DesktopApplication | null>()
    if (closed !== null) return closed
    let terminal: DesktopApplication | null = null
    let stillOwned: (() => boolean) | undefined
    if (flagEnv('MERCURY_CONCOURSE_WORKER') === '1') {
      const { getSessionId } = await import('../../bootstrap/state.js')
      const { readSessionWorkers, stampedTerminalPid } = await import('../../daemon/concourseWorkers.js')
      const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
      const record = Object.values(readSessionWorkers()).find(row => row.sessionId === String(getSessionId()) && row.endedAt === undefined)
      const pid = stampedTerminalPid(record?.focusedBy)
      const attached = record?.terminalApplication
      if (record?.focusedAt === undefined || pid === undefined || pid <= 1 || !isProcessAlive(pid) || attached == null || typeof attached.identity !== 'string' || attached.identity === '' || typeof attached.name !== 'string' || attached.name === '') return { ok: true, value: null }
      terminal = { identity: attached.identity, name: attached.name, pid: null, title: null, bounds: null, windowId: null, tty: attached.tty ?? null }
      stillOwned = () => {
        const current = readSessionWorkers()[record.runnerId]
        return current?.endedAt === undefined && current?.focusedAt === record.focusedAt && current?.focusedBy === record.focusedBy && current?.terminalApplication?.identity === attached.identity && current?.terminalApplication?.tty === attached.tty && isProcessAlive(pid)
      }
    } else {
      try {
        const raw = this.addon.ownTerminalApplication()
        if (typeof raw.identity === 'string' && raw.identity !== '') terminal = application(raw, raw.identity)
      } catch (error) {
        return fail(classifyThrown(error))
      }
      if (terminal === null) {
        const program = (process.env.TERM_PROGRAM ?? '').trim()
        const identity = process.platform === 'darwin' && Object.hasOwn(TERMINAL_IDENTITIES, program) ? TERMINAL_IDENTITIES[program] : undefined
        if (identity !== undefined) terminal = { identity, name: program, pid: null, title: null, bounds: null }
      }
    }
    if (terminal === null) return { ok: true, value: null }
    terminal.windowId = null
    if (process.platform !== 'darwin' || front?.identity !== terminal.identity || !terminal.tty || !['com.apple.Terminal', 'com.googlecode.iterm2'].includes(terminal.identity)) return { ok: true, value: terminal }
    const configured = Number(flagEnv('MERCURY_DESKTOP_OWNER_TIMEOUT_MS') ?? 1000)
    const timeout = Number.isInteger(configured) && configured > 0 && configured <= 5000 ? configured : 1000
    const args = ['-e', 'const a=require(process.argv[1]); process.stdout.write(JSON.stringify(a.ownTerminalApplication(process.argv[2],process.argv[3],Number(process.argv[4]))))', this.addonPath, terminal.identity, terminal.tty, front.windowId ?? '0']
    const raw = await new Promise<DesktopAddonApplication | null>(resolve => {
      execFile(process.execPath, args, { timeout, killSignal: 'SIGKILL', windowsHide: true, env: subprocessEnv(), maxBuffer: 64 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) return resolve(null)
        try {
          resolve(JSON.parse(stdout) as DesktopAddonApplication)
        } catch {
          resolve(null)
        }
      })
    })
    if (stillOwned !== undefined && !stillOwned()) return { ok: true, value: null }
    if (raw?.identity === terminal.identity && raw.tty === terminal.tty && typeof raw.windowId === 'string' && raw.windowId !== '') terminal = application(raw, terminal.identity)
    return { ok: true, value: terminal }
  }

  async focusedText(app: DesktopApplication, signal: AbortSignal): Promise<DesktopAnswer<DesktopFocusedText | null>> {
    const closed = this.closedRefusal<DesktopFocusedText | null>()
    if (closed) return closed
    if (signal.aborted) return desktopAbortedAnswer()
    if (process.platform !== 'darwin' || !this.addon.focusedText) return fail({ kind: 'unavailable', note: `terminal text needs the desktop pack's focusedText export — rebuild it: ${DESKTOP_BUILD_COMMAND}` })
    if (app.pid === null || !Number.isInteger(app.pid) || app.pid <= 0) return fail({ kind: 'input', note: `${app.name} has no process id` })
    const permissions = this.readPermissions()
    if (!permissions.ok) return fail(permissions.error)
    const refusal = inputRefusal(permissions.value)
    if (refusal) return this.refuseAndRequestGrants(refusal)
    try {
      const value = await new Promise<DesktopFocusedText | null>((resolve, reject) => {
        const child = execFile(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).focusedText(Number(process.argv[2]))))', this.addonPath, String(app.pid)], { timeout: TREE_SUBPROCESS_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: subprocessEnv(), maxBuffer: TREE_SUBPROCESS_BUFFER, encoding: 'utf8' }, (error, stdout) => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) return reject(new Error(ABORTED_PREFIX))
          if (error) return reject(new Error(`the focused terminal text could not be read: ${error.message}`))
          try { resolve(JSON.parse(stdout)) } catch { reject(new Error('the focused text query returned an unreadable record')) }
        })
        const onAbort = () => { child.kill('SIGKILL') }
        signal.addEventListener('abort', onAbort, { once: true })
      })
      if (value !== null && (typeof value.text !== 'string' || value.role !== 'AXTextArea')) return fail(contractDefect('focused text', 'invalid value or role'))
      return { ok: true, value }
    } catch (error) { return fail(classifyThrown(error)) }
  }

  private async queryDesktop<T>(method: DesktopQuery, args: unknown[], signal: AbortSignal, needsInput = false): Promise<DesktopAnswer<T>> {
    const closed = this.closedRefusal<T>()
    if (closed) return closed
    if (signal.aborted) return desktopAbortedAnswer()
    if (!QUERY_PLATFORMS[method].includes(process.platform)) return fail({ kind: 'unavailable', note: `${method} is unsupported on ${process.platform} in this release` })
    if (!this.addon[method]) return fail({ kind: 'unavailable', note: `${method} needs the desktop pack's ${method} export — rebuild it: ${DESKTOP_BUILD_COMMAND}` })
    const permissions = this.readPermissions()
    if (!permissions.ok) return fail(permissions.error)
    const refusal = needsInput ? inputRefusal(permissions.value) : sessionRefusal(permissions.value)
    if (refusal) return this.refuseAndRequestGrants(refusal)
    try {
      const value = await new Promise<T>((resolve, reject) => {
        const script = 'const a=require(process.argv[1]); new Promise(r=>r(a[process.argv[2]](...JSON.parse(require("node:fs").readFileSync(0,"utf8"))))).then(v=>process.stdout.write(JSON.stringify({value:v??null})),e=>{process.stdout.write(JSON.stringify({error:e instanceof Error?e.message:String(e)}));process.exitCode=1})'
        const child = execFile(process.execPath, ['-e', script, this.addonPath, method], { timeout: TREE_SUBPROCESS_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: subprocessEnv(), maxBuffer: TREE_SUBPROCESS_BUFFER, encoding: 'utf8' }, (error, stdout) => {
          signal.removeEventListener('abort', onAbort)
          if (signal.aborted) return reject(new Error(ABORTED_PREFIX))
          const answer = queryAnswer(stdout)
          if (answer !== null && 'error' in answer) return reject(new Error(answer.error))
          if (error) return reject(new Error(`${method} failed: ${readerExitWords(error)}`))
          if (answer === null) return reject(new Error(`${method} returned an unreadable record`))
          resolve(answer.value as T)
        })
        child.stdin?.on('error', () => {})
        child.stdin?.end(JSON.stringify(args))
        const onAbort = () => { child.kill('SIGKILL') }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      return signal.aborted ? desktopAbortedAnswer() : { ok: true, value }
    } catch (error) { return fail(classifyThrown(error)) }
  }

  async readElement(app: DesktopApplication, element: DesktopTreeElement, signal: AbortSignal): Promise<DesktopAnswer<DesktopFocusedText | null>> {
    if (!app.pid || !Number.isInteger(app.pid)) return fail({ kind: 'input', note: `${app.name} has no process id` })
    const answer = await this.queryDesktop<DesktopFocusedText | null>('readElement', [app.pid, bridgedElement(element)], signal, true)
    if (answer.ok && answer.value !== null && (typeof answer.value.text !== 'string' || typeof answer.value.role !== 'string')) return fail(contractDefect('read element', 'invalid text or role'))
    return answer
  }

  async scrollToVisible(app: DesktopApplication, element: DesktopTreeElement, signal: AbortSignal): Promise<DesktopAnswer<DesktopScrollReceipt>> {
    if (!app.pid || !Number.isInteger(app.pid)) return fail({ kind: 'input', note: `${app.name} has no process id` })
    const answer = await this.queryDesktop<DesktopAddonScroll | null>('scrollToVisible', [app.pid, bridgedElement(element), true], signal, true)
    if (!answer.ok) return answer
    const raw = answer.value
    if (!raw || typeof raw.scrolled !== 'boolean') return fail(contractDefect('scroll', JSON.stringify(raw)))
    return { ok: true, value: { scrolled: raw.scrolled, road: raw.road === 'action' || raw.road === 'wheel' ? raw.road : null, frame: boundsOf(raw.frame), note: noteOf(raw.reason) } }
  }

  async setValue(app: DesktopApplication, element: DesktopTreeElement, text: string, signal: AbortSignal): Promise<DesktopAnswer<DesktopValueReceipt>> {
    if (!app.pid || !Number.isInteger(app.pid)) return fail({ kind: 'input', note: `${app.name} has no process id` })
    if (typeof text !== 'string') return fail({ kind: 'input', note: 'the value to set must be a string' })
    const answer = await this.queryDesktop<DesktopAddonValue | null>('setValue', [app.pid, bridgedElement(element), text], signal, true)
    if (!answer.ok) return answer
    const raw = answer.value
    if (!raw || typeof raw.set !== 'boolean') return fail(contractDefect('value', JSON.stringify(raw)))
    return { ok: true, value: { set: raw.set, value: typeof raw.value === 'string' && raw.value !== '' ? raw.value : null, note: noteOf(raw.reason) } }
  }

  async clickablePoint(app: DesktopApplication, element: DesktopTreeElement, signal: AbortSignal): Promise<DesktopAnswer<DesktopClickablePoint>> {
    if (!app.pid || !Number.isInteger(app.pid)) return fail({ kind: 'input', note: `${app.name} has no process id` })
    const answer = await this.queryDesktop<DesktopAddonClickablePoint | null>('clickablePoint', [app.pid, bridgedElement(element)], signal, false)
    if (!answer.ok) return answer
    const raw = answer.value
    if (!raw || typeof raw !== 'object') return fail(contractDefect('clickablePoint', JSON.stringify(raw)))
    const point = typeof raw.x === 'number' && typeof raw.y === 'number' && Number.isFinite(raw.x) && Number.isFinite(raw.y) ? { x: raw.x, y: raw.y } : null
    return { ok: true, value: { point, road: raw.road === 'native' || raw.road === 'hit-test' ? raw.road : null, note: noteOf(raw.reason) } }
  }

  async readClipboard(signal: AbortSignal): Promise<DesktopAnswer<string>> {
    const answer = await this.queryDesktop<string>('readClipboard', [], signal)
    return answer.ok && typeof answer.value !== 'string' ? fail(contractDefect('clipboard', 'not text')) : answer
  }

  async findApplication(name: string): Promise<DesktopAnswer<DesktopApplication>> {
    const answer = await this.queryDesktop<DesktopAddonApplication>('findApplication', [name], new AbortController().signal)
    if (!answer.ok) return answer
    const raw = answer.value
    if (!raw || typeof raw.identity !== 'string' || !raw.identity) return fail({ kind: 'input', note: raw?.reason ?? `no running application named ${name}` })
    return { ok: true, value: application(raw, raw.identity) }
  }

  async activateApplication(app: DesktopApplication, signal: AbortSignal): Promise<DesktopAnswer<DesktopApplication>> {
    if (!app.pid || !Number.isInteger(app.pid)) return fail({ kind: 'input', note: `${app.name} has no process id` })
    const answer = await this.queryDesktop<null>('activateApplication', [app.pid, app.identity], signal, true)
    if (!answer.ok) return answer
    const deadline = Date.now() + 1500
    while (!signal.aborted) {
      const front = await this.frontmostApplication()
      if (signal.aborted) return desktopAbortedAnswer()
      if (front.ok && front.value.identity === app.identity && front.value.pid === app.pid) return front
      if (Date.now() >= deadline) break
      await new Promise<void>(resolve => { const timer = setTimeout(done, 50); function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() } signal.addEventListener('abort', done, { once: true }) })
    }
    return signal.aborted ? desktopAbortedAnswer() : fail({ kind: 'display', note: `${app.name} did not come to the front` })
  }

  async accessibilityTree(app: DesktopApplication, limits: DesktopTreeLimits, signal: AbortSignal): Promise<DesktopAnswer<DesktopTree>> {
    const closed = this.closedRefusal<DesktopTree>()
    if (closed !== null) return closed
    if (signal.aborted) return desktopAbortedAnswer()
    if (app.pid === null || !Number.isInteger(app.pid) || app.pid <= 0) return fail({ kind: 'input', note: `${app.name} has no process id to read the accessibility tree from` })
    if (!Number.isInteger(limits.depth) || limits.depth < 0 || !Number.isInteger(limits.count) || limits.count < 1) return fail({ kind: 'input', note: `the tree limits must be a whole depth and a count of at least one (got depth ${String(limits.depth)}, count ${String(limits.count)})` })
    const permissions = this.readPermissions()
    if (!permissions.ok) return fail(permissions.error)
    const refusal = inputRefusal(permissions.value)
    if (refusal !== null) return this.refuseAndRequestGrants(refusal)
    const requestKey = `${app.identity}:${app.pid}`
    const requestWeb = !limits.observation && !this.webRequests.has(requestKey)
    const scope = limits.scope ?? 'app'
    let raw: DesktopAddonTree
    try {
      raw = process.platform === 'darwin'
        ? await new Promise<DesktopAddonTree>((resolve, reject) => {
            const args = ['-e', 'const a=require(process.argv[1]); process.stdout.write(JSON.stringify(a.accessibilityTree(Number(process.argv[2]),Number(process.argv[3]),Number(process.argv[4]),process.argv[5],process.argv[6]==="true",process.argv[7]==="true")))', this.addonPath, String(app.pid), String(limits.depth), String(limits.count), scope, String(requestWeb), String(limits.observation === true)]
            const child = execFile(process.execPath, args, { timeout: TREE_SUBPROCESS_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, env: subprocessEnv(), maxBuffer: TREE_SUBPROCESS_BUFFER, encoding: 'utf8' }, (error, stdout) => {
              signal.removeEventListener('abort', onAbort)
              if (signal.aborted) return reject(new Error(ABORTED_PREFIX))
              if (error) return reject(new Error(`the accessibility tree of ${app.name} could not be read within ${TREE_SUBPROCESS_TIMEOUT_MS / 1000} seconds (the application may not be responding)`))
              try {
                const answer: unknown = JSON.parse(stdout)
                if (answer === null || typeof answer !== 'object') return reject(new Error('macOS returned no accessibility record'))
                resolve(answer as DesktopAddonTree)
              } catch {
                reject(new Error('the accessibility tree query returned an unreadable record'))
              }
            })
            const onAbort = (): void => {
              child.kill('SIGKILL')
            }
            signal.addEventListener('abort', onAbort, { once: true })
          })
        : this.addon.accessibilityTree(app.pid, limits.depth, limits.count, scope, requestWeb, limits.observation)
      if (requestWeb && raw.webAccessibility === true) this.webRequests.set(requestKey, Date.now())
    } catch (error) {
      return fail(classifyThrown(error))
    }
    if (signal.aborted) return desktopAbortedAnswer()
    if (!Array.isArray(raw.elements)) return fail(contractDefect('elements', typeof raw.elements))
    if (raw.elements.length === 0) return fail({ kind: 'display', note: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : `${app.name} answered no accessibility element` })
    const elements: DesktopTreeElement[] = []
    for (const e of raw.focused ? [...raw.elements, raw.focused] : raw.elements) {
      if (typeof e.role !== 'string' || typeof e.depth !== 'number' || !Number.isInteger(e.depth)) return fail(contractDefect('element', JSON.stringify(e)))
      const f = e.frame
      const frame: DesktopBounds | null = f && [f.x, f.y, f.width, f.height].every(n => Number.isFinite(n)) ? { x: f.x, y: f.y, width: f.width, height: f.height } : null
      elements.push({ depth: e.depth, role: e.role, title: typeof e.title === 'string' && e.title !== '' ? e.title : null, value: typeof e.value === 'string' && e.value !== '' ? e.value : null, frame, ...(typeof e.focused === 'boolean' ? { focused: e.focused } : {}), ...(typeof e.offscreen === 'boolean' ? { offscreen: e.offscreen } : {}) })
    }
    const stated = raw.webContent === 'available' && pageStillEmpty(raw.elements, limits.depth) ? 'pending' : raw.webContent
    const webContent = stated === 'absent' && Date.now() - (this.webRequests.get(requestKey) ?? 0) < 2000 ? 'pending' : stated
    const windowKey = raw.scope === 'window' && typeof raw.windowId === 'string' && raw.windowId !== '' ? `${requestKey}:${raw.windowId}` : null
    if (webContent === 'available' && (raw.scope === 'window' || raw.scope === 'app')) {
      this.pageApplications.add(requestKey)
      if (windowKey !== null) this.pageWindows.add(windowKey)
    }
    const shownPage = raw.scope === 'app' ? this.pageApplications.has(requestKey) : windowKey !== null && this.pageWindows.has(windowKey)
    return { ok: true, value: {
      elements, ...(raw.focused !== undefined ? { focused: raw.focused ? elements.pop()! : null } : {}), truncated: raw.truncated === true, reason: typeof raw.reason === 'string' && raw.reason !== '' ? raw.reason : null,
      ...(raw.scope === 'window' || raw.scope === 'app' ? { scope: raw.scope } : {}),
      ...(webContent === 'available' || webContent === 'absent' || webContent === 'pending' ? { webContent } : {}),
      ...(raw.webSurface === true || shownPage ? { webSurface: true } : {}),
    } }
  }

  async cursor(): Promise<DesktopAnswer<DesktopCursor>> {
    const closed = this.closedRefusal<DesktopCursor>()
    if (closed !== null) return closed
    try {
      const raw = this.addon.cursor()
      if (typeof raw.x !== 'number' || typeof raw.y !== 'number' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
        return fail({ kind: 'display', note: raw.reason ?? 'no cursor position' })
      }
      return { ok: true, value: { x: raw.x, y: raw.y, display: typeof raw.display === 'number' ? raw.display : null } }
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  async mouseMove(to: DesktopPoint, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!finitePoint(to)) return fail(pointRefusal(to))
    return this.act('move', to, signal, () => this.addon.mouseMove(to.x, to.y))
  }

  async mouseDown(button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!BUTTONS.includes(button)) return fail({ kind: 'input', note: `no such button: ${String(button)}` })
    return this.act('down', null, signal, () => this.addon.mouseDown(button))
  }

  async mouseUp(button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!BUTTONS.includes(button)) return fail({ kind: 'input', note: `no such button: ${String(button)}` })
    return this.act('up', null, signal, () => this.addon.mouseUp(button))
  }

  async click(at: DesktopPoint, button: DesktopButton, count: 1 | 2 | 3, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!finitePoint(at)) return fail(pointRefusal(at))
    if (!BUTTONS.includes(button)) return fail({ kind: 'input', note: `no such button: ${String(button)}` })
    if (count !== 1 && count !== 2 && count !== 3) return fail({ kind: 'input', note: `a click count is 1, 2 or 3 (got ${String(count)})` })
    return this.act('click', at, signal, () => this.addon.click(at.x, at.y, button, count))
  }

  async drag(from: DesktopPoint, to: DesktopPoint, button: DesktopButton, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!finitePoint(from)) return fail(pointRefusal(from))
    if (!finitePoint(to)) return fail(pointRefusal(to))
    if (!BUTTONS.includes(button)) return fail({ kind: 'input', note: `no such button: ${String(button)}` })
    return this.act('drag', to, signal, () => this.addon.drag(from.x, from.y, to.x, to.y, button))
  }

  async scroll(at: DesktopPoint, deltaX: number, deltaY: number, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!finitePoint(at)) return fail(pointRefusal(at))
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return fail({ kind: 'input', note: `scroll deltas must be finite (got ${String(deltaX)}, ${String(deltaY)})` })
    return this.act('scroll', at, signal, () => this.addon.scroll(at.x, at.y, deltaX, deltaY))
  }

  async keyTap(key: string, modifiers: DesktopModifier[], signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!isDesktopKey(key)) return fail({ kind: 'input', note: `no such key: ${key}` })
    for (const modifier of modifiers) {
      if (!MODIFIERS.includes(modifier)) return fail({ kind: 'input', note: `no such modifier: ${String(modifier)}` })
    }
    return this.act('keyTap', null, signal, () => this.addon.keyTap(key, [...modifiers]))
  }

  async keyDown(key: string, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!isDesktopKey(key)) return fail({ kind: 'input', note: `no such key: ${key}` })
    return this.act('keyDown', null, signal, () => this.addon.keyDown(key))
  }

  async keyUp(key: string, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (!isDesktopKey(key)) return fail({ kind: 'input', note: `no such key: ${key}` })
    return this.act('keyUp', null, signal, () => this.addon.keyUp(key))
  }

  async typeText(text: string, options: DesktopTypeOptions, signal: AbortSignal): Promise<DesktopAnswer<DesktopActReceipt>> {
    if (typeof text !== 'string') return fail({ kind: 'input', note: 'the text to type must be a string' })
    const gapMs = options.gapMs
    if (gapMs !== undefined && (!Number.isInteger(gapMs) || gapMs < 0 || gapMs > DESKTOP_TYPE_GAP_CAP_MS)) {
      return fail({ kind: 'input', note: `gapMs is a whole number of milliseconds up to ${DESKTOP_TYPE_GAP_CAP_MS} (got ${String(gapMs)})` })
    }
    if (text === '') {
      if (signal.aborted) return desktopAbortedAnswer()
      return { ok: true, value: { act: 'type', at: null, completedAt: Date.now() } }
    }
    return this.act('type', null, signal, () => this.addon.typeText(text, gapMs))
  }

  private decodeHeld(raw: { buttons: string[]; keys: string[] }): DesktopAnswer<DesktopHeld> {
    if (!Array.isArray(raw.buttons) || !Array.isArray(raw.keys)) return fail(contractDefect('held', JSON.stringify(raw)))
    const buttons: DesktopButton[] = []
    for (const button of raw.buttons) {
      if (!(BUTTONS as readonly string[]).includes(button)) return fail(contractDefect('held button', button))
      buttons.push(button as DesktopButton)
    }
    return { ok: true, value: { buttons, keys: raw.keys.map(k => String(k)) } }
  }

  async held(): Promise<DesktopAnswer<DesktopHeld>> {
    const closed = this.closedRefusal<DesktopHeld>()
    if (closed !== null) return closed
    try {
      return this.decodeHeld(this.addon.held())
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  async releaseAll(): Promise<DesktopAnswer<DesktopHeld>> {
    try {
      return this.decodeHeld(this.addon.releaseAll())
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      this.addon.releaseAll()
    } catch (error) {
      logForDebugging(`desktop driver: release at close threw: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (driverLoad !== null && driverLoad.state === 'ok' && driverLoad.driver === this) driverLoad = null
  }
}

let driverLoad: DesktopDriverLoad | null = null

export function resolveNativeDesktopDriver(): DesktopDriverLoad {
  if (driverLoad !== null) return driverLoad
  const load = loadDesktopAddon()
  if (load.state === 'unavailable') {
    return { state: 'unavailable', note: load.note, remedy: load.note.startsWith(DESKTOP_PACK_ABSENT_PREFIX) ? desktopPackAbsentNote() : null }
  }
  const facts: DesktopDriverFacts = { kind: 'native', version: load.manifest.version, platform: load.manifest.platform, source: load.source }
  driverLoad = { state: 'ok', driver: new NativeDesktopDriver(load.addon, facts, join(load.dir, load.manifest.addon)) }
  return driverLoad
}

export function resetNativeDesktopDriverForTest(): void {
  driverLoad = null
  resetDesktopAddonForTest()
}

function computerUseSwitchOn(): boolean {
  try {
    return flagEnabled('MERCURY_COMPUTER_USE')
  } catch {
    return false
  }
}

function sourceWords(source: 'override' | 'vendored' | 'workspace'): string {
  if (source === 'vendored') return 'beside the bundle'
  if (source === 'workspace') return 'the checkout'
  return 'MERCURY_DESKTOP_PACK_DIR'
}

async function drivingWords(): Promise<string> {
  try {
    const { claimAgeWords, probeDesktopLock } = await import('./desktopClaim.js')
    const holder = await probeDesktopLock()
    if (holder === null) return 'driving now: none'
    const since = new Date(holder.acquiredAt)
    const clock = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`
    return `driving now: pid ${holder.pid} since ${clock} (${claimAgeWords(Date.now() - holder.acquiredAt)})`
  } catch (error) {
    return `driving now: unknown — ${error instanceof Error ? error.message : String(error)}`
  }
}

export async function describeDesktopDriver(): Promise<DesktopHealthFacts> {
  const onWords = `computer use ${computerUseSwitchOn() ? `on · ${computerAccessWords()}` : 'off'}`
  const buildFix = voiceCheckoutRoot() !== null ? `Build the desktop driver pack: ${DESKTOP_BUILD_COMMAND}, then rebuild.` : undefined
  const driving = await drivingWords()
  const resolution = resolveDesktopPackDir()
  if (resolution.state === 'unavailable') {
    const absent = resolution.note.startsWith(DESKTOP_PACK_ABSENT_PREFIX)
    return {
      ready: false,
      line: `pack: ${absent ? desktopPackAbsentNote() : resolution.note} · ${onWords}`,
      detail: [`pack: ${resolution.note}`, desktopGrantWords(), driving].join('\n'),
      ...(buildFix ? { fix: buildFix } : {}),
    }
  }
  const packWords = `${resolution.manifest.version} ${resolution.manifest.platform} (${sourceWords(resolution.source)})`
  const load = resolveNativeDesktopDriver()
  if (load.state === 'unavailable') {
    return {
      ready: false,
      line: `pack: ${packWords} · ${load.note} · ${onWords}`,
      detail: [`pack: ${resolution.dir} (${sourceWords(resolution.source)})`, load.note, desktopGrantWords(), driving].join('\n'),
      ...(buildFix ? { fix: buildFix } : {}),
    }
  }
  const driver = load.driver
  const permissions = await driver.permissions()
  const displays = await driver.displays()
  const frontmost = await driver.frontmostApplication()
  const p = permissions.ok ? permissions.value : null
  const line = `pack: ${packWords} · screen: ${p?.screenCapture ?? 'unknown'} · input: ${p?.input ?? 'unknown'} · session: ${p?.session ?? 'unknown'} · ${onWords}`
  const displayWords = displays.ok
    ? `${displays.value.displays.length} display${displays.value.displays.length === 1 ? '' : 's'}: ${displays.value.displays
        .map(d => `${d.width}×${d.height}@${d.scale}${d.primary ? ' primary' : ''} at ${d.originX},${d.originY}`)
        .join('; ')}`
    : `displays: ${displays.error.note}`
  const frontmostWords = frontmost.ok ? `frontmost: ${frontmost.value.name} (${frontmost.value.identity})` : `frontmost: ${frontmost.error.note}`
  const permissionWords = p
    ? `screen capture ${p.screenCapture} · input ${p.input} · session ${p.session}${p.reason ? ` — ${p.reason}` : ''}`
    : `permissions: ${permissions.ok ? 'unknown' : permissions.error.note}`
  const detail = [`pack: ${resolution.dir} (${sourceWords(resolution.source)})`, displayWords, frontmostWords, permissionWords, desktopGrantWords(), driving].join('\n')
  const ready = p !== null && p.session === 'desktop' && granted(p.screenCapture) && granted(p.input) && computerUseSwitchOn()
  const denied = p !== null && (p.screenCapture === 'denied' || p.input === 'denied' || p.session !== 'desktop')
  return { ready, line, detail, ...(denied ? { fix: desktopGrantWords() } : {}) }
}
