import { deleteFlagEnv, flagEnv } from '../../substrate/flagRegistry.js'
import {
  applyKitEdit,
  materializedWholeConfigKit,
  validateSessionKit,
  type SessionKitEditV1,
  type SessionKitV1,
} from '../../daemon/sessionKit.js'
import { appendSessionReceipt } from '../switchboard/sessionReceipts.js'
import { logForDebugging } from '../../utils/debug.js'

export type SessionKitPinReceipt =
  | { outcome: 'none' }
  | { outcome: 'pinned'; kit: SessionKitV1 }
  | { outcome: 'refused'; reason: string; kit: SessionKitV1 }

function emptySessionKit(): SessionKitV1 {
  return { schema: 1, mcp: [], skills: [], invocable: [] }
}

let latched: SessionKitPinReceipt | null = null

export function consumeSessionKitPin(): SessionKitPinReceipt {
  const raw = flagEnv('MERCURY_SESSION_KIT')
  deleteFlagEnv('MERCURY_SESSION_KIT')
  if (latched !== null) return latched
  if (raw === undefined || raw.trim() === '') {
    latched = { outcome: 'none' }
    return latched
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    latched = refuse('the pin is not JSON')
    return latched
  }
  const validated = validateSessionKit(parsed)
  latched = validated.ok ? { outcome: 'pinned', kit: validated.kit } : refuse(validated.reason)
  return latched
}

function refuse(reason: string): SessionKitPinReceipt {
  const line = `kit refused — ${reason}; this session loads no extensions`
  try {
    process.stderr.write(`${line}\n`)
  } catch {
  }
  logForDebugging(`[kit] ${line}`)
  return { outcome: 'refused', reason, kit: emptySessionKit() }
}

export function sessionKitOf(): SessionKitV1 | undefined {
  return latched !== null && latched.outcome !== 'none' ? latched.kit : undefined
}

export function completeProcessSessionKit(resolved: SessionKitV1): boolean {
  if (latched === null || latched.outcome !== 'pinned' || latched.kit.resolved !== false) return false
  const validated = validateSessionKit(resolved)
  if (!validated.ok || validated.kit.resolved === false) {
    logForDebugging(`[kit] completion refused — ${validated.ok ? 'the composed kit is still unresolved' : validated.reason}`)
    return false
  }
  latched = { outcome: 'pinned', kit: validated.kit }
  return true
}

export function setProcessSessionKit(kit: SessionKitV1): { ok: true; kit: SessionKitV1 } | { ok: false; reason: string } {
  const validated = validateSessionKit(kit)
  if (!validated.ok) return { ok: false, reason: validated.reason }
  latched = { outcome: 'pinned', kit: validated.kit }
  return { ok: true, kit: validated.kit }
}

export function applyProcessSessionKitEdit(
  edit: SessionKitEditV1,
  standingOffNames: readonly string[],
): { outcome: 'applied' | 'noop' | 'refused'; kit?: SessionKitV1; detail?: string } {
  const standing = sessionKitOf()
  const materialized = standing === undefined
  const base = standing ?? materializedProcessKit(standingOffNames)
  const next = applyKitEdit(base, edit)
  if (next === base && !materialized) return { outcome: 'noop', detail: 'the kit already reads so' }
  const set = setProcessSessionKit(next === base ? base : next)
  if (!set.ok) return { outcome: 'refused', detail: `kit refused — ${set.reason}` }
  return { outcome: 'applied', kit: set.kit }
}

function materializedProcessKit(standingOffNames: readonly string[]): SessionKitV1 {
  return materializedWholeConfigKit(standingOffNames)
}

export function processKitExtensionOn(name: string): boolean {
  const kit = sessionKitOf()
  if (kit === undefined) return true
  if (kit.resolved === false) return !(kit.deltas?.extensionsOff ?? []).includes(name)
  return (kit.extensions?.[name] ?? 'on') !== 'off'
}

let refusalNoted = false

export function noteRefusedKitOnSessionReceipt(home: string, sessionId: string): boolean {
  if (refusalNoted || latched === null || latched.outcome !== 'refused') return false
  refusalNoted = true
  try {
    appendSessionReceipt(home, sessionId, {
      at: new Date().toISOString(),
      by: 'runner',
      kind: 'kit-refused',
      summary: `kit refused — ${latched.reason}; this session loads no extensions`,
      details: { reason: latched.reason },
    })
    return true
  } catch (err) {
    logForDebugging(`[kit] refusal receipt failed for ${sessionId}: ${err}`)
    return false
  }
}

export function _resetSessionKitPinForTesting(): void {
  latched = null
  refusalNoted = false
}
