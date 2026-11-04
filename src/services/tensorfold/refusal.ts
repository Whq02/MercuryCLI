import type { TensorFoldLadderRung } from './contracts.js'
import { LOWER_OR_SMALLER, gibOf, wiredLimitOfferFor, type TensorFoldMachineTruth, type WiredLimitOffer } from './fit.js'
import { GIB } from './starting.js'
import { tokensWords } from '../localServer/localServerMemory.js'

type TensorFoldRefusalKind = 'port' | 'memory' | 'gpu-limit' | 'cache-cap' | 'not-pulled' | 'driver' | 'family' | 'exited' | 'other'

export type TensorFoldRefusal = {
  kind: TensorFoldRefusalKind
  line: string
  port?: number
  host?: string
  needGib?: number
  leftGib?: number
  window?: number
  nextWindow?: number
  cacheGibAt?: number
  wired?: { usableGib: number; ramGib: number; limitMib: number; needGib: number; offer: WiredLimitOffer | null }
  signal?: string
  code?: number
}

export function lastStderrLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter(line => line !== '' && !line.startsWith('warning:') && !/^\[tensorfold\] /.test(line))
  return lines[lines.length - 1] ?? ''
}

function stripEnginePrefix(line: string): string {
  return line.replace(/^tensorfold(?:-native)?:\s*/, '').trim()
}

const GIBS = /(\d+(?:\.\d+)?)\s*GiB/g

function gibsOf(line: string): number[] {
  return [...line.matchAll(GIBS)].map(match => Number(match[1]))
}

export function readTensorFoldRefusal(stderr: string, context: { window?: number; ladder?: readonly TensorFoldLadderRung[]; needBytes?: number; machine?: TensorFoldMachineTruth; exit?: { code: number | null; signal: string | null } } = {}): TensorFoldRefusal {
  const raw = lastStderrLine(stderr)
  const line = stripEnginePrefix(raw)
  const port = /cannot listen on ([^\s:]+):(\d+) \(AddressInUse\)/.exec(line)
  if (port) return { kind: 'port', line, host: port[1]!, port: Number(port[2]) }
  if (/is not in the Hugging Face cache/.test(line)) return { kind: 'not-pulled', line }
  if (/this NVIDIA driver/.test(line)) return { kind: 'driver', line }
  if (/no backend for|no registered Zig family/.test(line)) return { kind: 'family', line }
  if (/--prompt-cache-gib \S+ would take this server past 70%/.test(line)) return { kind: 'cache-cap', line }
  const memory = /does not fit|more than the .* left under the load limit|remains beside the weights|lower --context|lower --parallel|CUDA memory budget/.test(line)
  if (memory) {
    const gibs = gibsOf(line)
    const needGib = gibs[0]
    const remains = /(\d+(?:\.\d+)?) GiB remains beside the weights/.exec(line)
    const leftGib = remains !== null ? Number(remains[1]) : gibs.length > 1 ? gibs[1] : undefined
    const window = Number(/(\d+)-token/.exec(line)?.[1]) || context.window
    const next = nextWindowUnder(context.ladder, context.window, leftGib)
    const base: TensorFoldRefusal = {
      kind: 'memory',
      line,
      ...(needGib !== undefined ? { needGib } : {}),
      ...(leftGib !== undefined ? { leftGib } : {}),
      ...(window !== undefined ? { window } : {}),
      ...(next !== undefined ? { nextWindow: next.window, cacheGibAt: next.cacheGib } : {}),
    }
    const wired = wiredReading(context)
    return wired === undefined ? base : { ...base, kind: 'gpu-limit', wired }
  }
  const spoken = /^tensorfold(?:-native)?:/.test(raw) ? line : ''
  if (context.exit !== undefined && (context.exit.signal !== null || spoken === '')) {
    return { kind: 'exited', line: spoken === '' ? exitWords(context.exit) : spoken, ...(context.exit.signal !== null ? { signal: context.exit.signal } : {}), ...(context.exit.code !== null ? { code: context.exit.code } : {}) }
  }
  return { kind: 'other', line: spoken === '' ? exitWords(context.exit) : spoken }
}

function exitWords(exit: { code: number | null; signal: string | null } | undefined): string {
  if (exit === undefined) return 'the engine stopped without a word'
  if (exit.signal !== null) return `signal ${signalNumber(exit.signal)} (${signalName(exit.signal)})`
  return `exit ${exit.code ?? 'unknown'}`
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGABRT: 6, SIGBUS: 10, SIGKILL: 9, SIGSEGV: 11, SIGTERM: 15 }
const SIGNAL_WORDS: Record<string, string> = { SIGKILL: 'killed', SIGTERM: 'terminated', SIGINT: 'interrupted', SIGSEGV: 'crashed', SIGABRT: 'aborted', SIGBUS: 'crashed', SIGILL: 'crashed', SIGHUP: 'hung up', SIGQUIT: 'quit' }

function signalNumber(signal: string): number | string {
  return SIGNALS[signal] ?? signal
}

function signalName(signal: string): string {
  return SIGNAL_WORDS[signal] ?? signal.toLowerCase()
}

function nextWindowUnder(ladder: readonly TensorFoldLadderRung[] | undefined, window: number | undefined, leftGib: number | undefined): { window: number; cacheGib: number } | undefined {
  if (ladder === undefined || window === undefined || leftGib === undefined) return undefined
  const below = ladder.filter(rung => rung.window < window && rung.fit.parts !== undefined && rung.fit.parts.cacheGib <= leftGib)
  const pick = below[below.length - 1]
  return pick === undefined ? undefined : { window: pick.window, cacheGib: pick.fit.parts!.cacheGib }
}

function wiredReading(context: { needBytes?: number; machine?: TensorFoldMachineTruth }): TensorFoldRefusal['wired'] | undefined {
  const machine = context.machine
  if (machine === undefined || machine.platform !== 'darwin' || context.needBytes === undefined) return undefined
  if (context.needBytes <= machine.usableBytes) return undefined
  return { usableGib: gibOf(machine.usableBytes), ramGib: gibOf(machine.ramBytes), limitMib: machine.wiredLimitMib ?? 0, needGib: gibOf(context.needBytes), offer: wiredLimitOfferFor(context.needBytes, machine) }
}

const gib1 = (value: number): string => value.toFixed(1)

export function refusedWords(refusal: TensorFoldRefusal, name: string): string {
  if (refusal.kind === 'gpu-limit' && refusal.wired !== undefined) {
    const w = refusal.wired
    return `TensorFold refused ${name}${refusal.window !== undefined ? ` at ${tokensWords(refusal.window)}` : ''} · macOS lets the GPU wire ${gib1(w.usableGib)} of ${gib1(w.ramGib)} GiB (iogpu.wired_limit_mb ${w.limitMib}) · it needs ${gib1(w.needGib)} GiB`
  }
  return refusal.line
}

export function wiredLimitCommand(offer: WiredLimitOffer): string {
  return `sudo sysctl iogpu.wired_limit_mb=${offer.limitMib}`
}

export function wiredLimitCostWords(offer: WiredLimitOffer): string {
  return `asks for your password (sudo) · leaves ${gib1(offer.leavesBytes / GIB)} GiB for macOS · resets at reboot; restart the engine after it${offer.tight ? ' · tight — quit other apps first' : ''}`
}

export function refusalNextStep(refusal: TensorFoldRefusal): string {
  switch (refusal.kind) {
    case 'port':
      return 'the next free port is taken next time'
    case 'memory':
      return refusal.nextWindow !== undefined ? `↵ serves it at ${tokensWords(refusal.nextWindow)}` : LOWER_OR_SMALLER
    case 'gpu-limit':
      return refusal.wired?.offer ? 'w shows the command that raises the limit' : LOWER_OR_SMALLER
    case 'cache-cap':
      return 'the prompt cache is left to its default next time'
    case 'not-pulled':
      return '↵ pulls it first'
    case 'driver':
      return 'install the newer driver, then /tensorfold again'
    case 'family':
      return 'choose a checkpoint TensorFold serves'
    case 'exited':
    case 'other':
      return '/tensorfold starts it again'
  }
}
