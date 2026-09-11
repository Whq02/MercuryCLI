import { flagEnabled, flagEnv } from '../../substrate/flagRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { voiceCheckoutRoot } from '../voice/voicePack.js'
import { computerAccessWords } from './computerAccess.js'
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
  type DesktopTypeOptions,
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
} from './pack.js'

export type DesktopDriverLoad =
  | { state: 'ok'; driver: DesktopDriver }
  | { state: 'unavailable'; note: string; remedy: string | null }

export interface DesktopDoctorFacts {
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
export const DESKTOP_TYPE_GAP_CAP_MS = 1_000

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
  return {
    identity,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : identity,
    pid: typeof raw.pid === 'number' && Number.isFinite(raw.pid) ? raw.pid : null,
    title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : null,
    bounds,
  }
}

function pngSigned(png: unknown): png is Uint8Array {
  if (!(png instanceof Uint8Array) || png.length < 8) return false
  return png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
}

class NativeDesktopDriver implements DesktopDriver {
  private closed = false
  private grantsRequested = false

  constructor(
    private readonly addon: DesktopAddon,
    private readonly facts: DesktopDriverFacts,
  ) {}

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
        displays.push({ index: d.index, id: d.id, originX: d.originX, originY: d.originY, width: d.width, height: d.height, scale: d.scale, primary: d.primary === true })
      }
      return { ok: true, value: { displays, fingerprint: displaysFingerprint(displays) } }
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  async capture(display: number, signal: AbortSignal): Promise<DesktopAnswer<DesktopCapture>> {
    const closed = this.closedRefusal<DesktopCapture>()
    if (closed !== null) return closed
    if (signal.aborted) return desktopAbortedAnswer()
    if (!Number.isInteger(display) || display < 0) return fail({ kind: 'display', note: `no display ${String(display)}` })
    const permissions = this.readPermissions()
    if (!permissions.ok) return fail(permissions.error)
    const refusal = captureRefusal(permissions.value)
    if (refusal !== null) return this.refuseAndRequestGrants(refusal)
    let raw: DesktopAddonCapture
    try {
      raw = await this.withCancel(signal, () => this.addon.capture(display))
    } catch (error) {
      return fail(classifyThrown(error))
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

  async frontmostApplication(): Promise<DesktopAnswer<DesktopApplication>> {
    const closed = this.closedRefusal<DesktopApplication>()
    if (closed !== null) return closed
    try {
      const raw = this.addon.frontmostApplication()
      if (typeof raw.identity !== 'string' || raw.identity === '') return fail({ kind: 'display', note: raw.reason ?? 'no frontmost application' })
      return { ok: true, value: application(raw, raw.identity) }
    } catch (error) {
      return fail(classifyThrown(error))
    }
  }

  async ownTerminalApplication(): Promise<DesktopAnswer<DesktopApplication | null>> {
    const closed = this.closedRefusal<DesktopApplication | null>()
    if (closed !== null) return closed
    if (flagEnv('MERCURY_CONCOURSE_WORKER') === '1') {
      const { getSessionId } = await import('../../bootstrap/state.js')
      const { readSessionWorkers, stampedTerminalPid } = await import('../../daemon/concourseSupervisor.js')
      const { isProcessAlive } = await import('../../daemon/ownerWatch.js')
      const record = Object.values(readSessionWorkers()).find(row => row.sessionId === String(getSessionId()) && row.endedAt === undefined)
      const pid = stampedTerminalPid(record?.focusedBy)
      const terminal = record?.terminalApplication
      if (record?.focusedAt === undefined || pid === undefined || pid <= 1 || !isProcessAlive(pid) || terminal == null || typeof terminal.identity !== 'string' || terminal.identity === '' || typeof terminal.name !== 'string' || terminal.name === '') return { ok: true, value: null }
      return { ok: true, value: { identity: terminal.identity, name: terminal.name, pid: null, title: null, bounds: null } }
    }
    try {
      const raw = this.addon.ownTerminalApplication()
      if (typeof raw.identity === 'string' && raw.identity !== '') return { ok: true, value: application(raw, raw.identity) }
    } catch (error) {
      return fail(classifyThrown(error))
    }
    const program = (process.env.TERM_PROGRAM ?? '').trim()
    const identity = process.platform === 'darwin' && Object.hasOwn(TERMINAL_IDENTITIES, program) ? TERMINAL_IDENTITIES[program] : undefined
    if (identity === undefined) return { ok: true, value: null }
    return { ok: true, value: { identity, name: program, pid: null, title: null, bounds: null } }
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
  driverLoad = { state: 'ok', driver: new NativeDesktopDriver(load.addon, facts) }
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

export async function describeDesktopDriver(): Promise<DesktopDoctorFacts> {
  const onWords = `computer use ${computerUseSwitchOn() ? `on (${computerAccessWords()})` : 'off'}`
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
