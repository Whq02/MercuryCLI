// ============================================================================
// capacityCheck — the machine's seat reading and the first-boot capacity ask.
//
//  Sessions run concurrently, as many as the machine can carry — the only
//  cap is the MACHINE's (the operator's line-6 ruling; an artificial
//  ceiling never). The reading has two tiers:
//   · the CONSENTED probe (asked once): cores, free memory, and other agent
//    CLIs already running (the `ps` scan is the consented part); its ladder
//    result is stored durably (switchboardCapacity) and honoured as-is;
//   · a DECLINED probe stores no number: the ceiling reads the machine's
//     LOCAL facts live — cores + free memory only, no process scan.
//  One ladder serves both tiers: monotone in cores and memory, floored at
//  two (one seat would make the switchboard pointless on any machine that
//  can boot it), unbounded above.
// ============================================================================
import { freemem, totalmem } from 'node:os'
import { availableCores } from '../../utils/availableCores.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'

/** The machine's own seat reading from its LOCAL facts (no process scan):
 *  one seat per two cores, one per two GB of free memory, whichever is
 *  scarcer — monotone in both, floored at two, unbounded above. */
export function machineSeatReading(
  cores: number = availableCores(),
  freeMemBytes: number = freemem(),
): number {
  const freeGb = freeMemBytes / 2 ** 30
  return Math.max(2, Math.min(Math.floor(cores / 2), Math.floor(freeGb / 2)))
}

/** The refusal's own sentence when the machine cap bites: the reading and
 *  where it came from — never a bare number. A LIVE reading speaks in the
 *  present tense; a STORED consented recommendation is a RECORDING, not a
 *  reading of this moment, and says when it was taken (the never-stale
 *  law, w5-f04-04: a stored consented reading was narrated in the present
 *  tense as this machine's reading). */
export function describeSeatReading(ceiling: number): string {
  const decision = getGlobalConfig().switchboardCapacity
  const stored = decision?.allowed === true ? decision.recommendedSeats : undefined
  if (
    typeof stored === 'number' &&
    Number.isFinite(stored) &&
    Math.max(1, Math.floor(stored)) === ceiling
  ) {
    const askedAt = decision?.askedAt
    const when =
      typeof askedAt === 'number' && Number.isFinite(askedAt) && askedAt > 0
        ? ` from ${new Date(askedAt).toISOString().slice(0, 10)}`
        : ''
    return `the consented capacity reading${when}: ${ceiling} seat${ceiling === 1 ? '' : 's'} (stored at the first-boot ask)`
  }
  return `this machine's reading: ${ceiling} seat${ceiling === 1 ? '' : 's'} (cores/memory)`
}

export interface CapacityProbe {
  cores: number
  totalMemBytes: number
  freeMemBytes: number
  /** Best-effort count of OTHER running agent CLIs (claude / mercury /
   *  codex / gemini command names; this process excluded). Fail-soft 0 —
   *  the probe never blocks or throws for it. */
  otherAgentClis: number
}

const AGENT_CLI_NAMES = new Set(['claude', 'mercury', 'codex', 'gemini'])
const SCRIPT_HOSTS = new Set(['node', 'bun', 'deno'])

function basenameOf(token: string): string {
  const clean = token.replace(/"/g, '')
  const cut = clean.lastIndexOf('/')
  return (cut >= 0 ? clean.slice(cut + 1) : clean).toLowerCase()
}

/** One `ps` line → is it an agent CLI? The executable token decides; a
 *  script host (node/bun) counts when its first script argument names one
 *  (dist bundles run as `node …/mercury.mjs`). Best-effort by design. */
export function looksLikeAgentCli(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  if (tokens.length === 0 || tokens[0] === undefined) return false
  const exe = basenameOf(tokens[0])
  if (AGENT_CLI_NAMES.has(exe)) return true
  if (!SCRIPT_HOSTS.has(exe)) return false
  return tokens
    .slice(1)
    .filter(t => !t.startsWith('-'))
    .some(t => {
      const base = basenameOf(t)
      const stem = base.replace(/\.(mjs|cjs|js|ts)$/, '')
      return AGENT_CLI_NAMES.has(stem)
    })
}

async function countOtherAgentClis(): Promise<number> {
  try {
    // The first-boot capacity ask NAMES this input — "other agent CLIs
    // already running" — so win32 must SCAN, not answer 0 before trying
    // (FC-085: consenting stored the no-probe number and the seat gate held
    // every later dispatch to it). PowerShell's CIM listing is the one
    // win32 source that carries COMMAND LINES (tasklist has exe names
    // only, so a `node claude.mjs` host would hide); execFileNoThrow
    // spawns with windowsHide, per the spawn discipline. Both platforms
    // emit `<pid> <command>` lines into ONE parser.
    const r =
      process.platform === 'win32'
        ? await execFileNoThrow(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }",
            ],
            { useCwd: false, timeout: 8000 },
          )
        : await execFileNoThrow('ps', ['-axo', 'pid=,command='], {
            useCwd: false,
            timeout: 3000,
          })
    if (r.code !== 0) return 0
    let n = 0
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = Number(m[1])
      if (pid === process.pid || pid === process.ppid) continue
      if (looksLikeAgentCli(m[2]!)) n++
    }
    return n
  } catch {
    return 0
  }
}

/** Pure machine facts; the only async part is the fail-soft process scan. */
export async function probeCapacity(): Promise<CapacityProbe> {
  return {
    cores: availableCores(),
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    otherAgentClis: await countOtherAgentClis(),
  }
}

/**
 * The consented probe's seats: the machine's own reading, shaved by one
 * when two or more OTHER agent CLIs already work (they hold real
 * cores/RAM). Same ladder, same floor of two, no upper clamp.
 */
export function recommendSeats(probe: CapacityProbe): number {
  const reading = machineSeatReading(probe.cores, probe.freeMemBytes)
  return Math.max(2, probe.otherAgentClis >= 2 ? reading - 1 : reading)
}

/** The one-time ask's RECEIPT line (FC-135): the number each arm exists
 *  to deliver rides the TAIL, because the coordinator pane's note slot
 *  truncates its MIDDLE — the consent receipt used to read
 *  capacity check don…ts fit this machine, the seats count exactly the
 *  token the ellipsis ate, while the decline arm's number survived only
 *  because it happened to sit in the tail. */
export function capacityDecisionReceipt(allowed: boolean, recommendedSeats: number): string {
  return allowed
    ? `capacity check done — this machine fits ${recommendedSeats} seats`
    : `no probe — the machine's own reading decides — right now ${recommendedSeats} seats`
}

/** True exactly while no decision was ever recorded — the ask fires once. */
export function needsCapacityAsk(): boolean {
  return getGlobalConfig().switchboardCapacity === undefined
}

/**
 * Record the operator's one-time answer. Consent → probe + ladder, stored;
 * decline → the durable never-ask-again marker WITHOUT a number, so the
 * ceiling reads the machine live from then on. Returns what the asking
 * surface should speak.
 */
export async function recordCapacityDecision(
  allowed: boolean,
): Promise<{ allowed: boolean; recommendedSeats: number }> {
  if (!allowed) {
    saveGlobalConfig(c => ({
      ...c,
      switchboardCapacity: { askedAt: Date.now(), allowed: false },
    }))
    return { allowed: false, recommendedSeats: machineSeatReading() }
  }
  const recommendedSeats = recommendSeats(await probeCapacity())
  saveGlobalConfig(c => ({
    ...c,
    switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats },
  }))
  return { allowed: true, recommendedSeats }
}

/** The admission input: a CONSENTED probe's stored recommendation is
 *  honoured AS-IS (floored at one against junk state, never clamped above);
 *  otherwise — the probe declined, or never asked — the machine's live
 *  reading answers. A declined record that still carries a number (the
 *  older shape stored the default cap beside allowed:false) reads the
 *  machine too: no artificial cap survives an upgrade. */
export function resolveSeatCeiling(): number {
  const decision = getGlobalConfig().switchboardCapacity
  const stored = decision?.allowed === true ? decision.recommendedSeats : undefined
  if (typeof stored === 'number' && Number.isFinite(stored)) {
    return Math.max(1, Math.floor(stored))
  }
  return machineSeatReading()
}
