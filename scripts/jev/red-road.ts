#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { JevEvalInput } from '../../src/tools/JevEvalTool/jevEvalSchema.js'

export const RED_ROAD_CONFIDENT_FLOOR = 0.6
export const RED_ROAD_KILLED_REAL_CEILING = 0.06
export const RED_ROAD_STARVED_REAL_CEILING = 0.09
export const RED_ROAD_TAIL_LINES = 60
export const RED_ROAD_LINE_CLIP = 220
export const RED_ROAD_SIGNATURE_LINES = 40
export const RED_ROAD_RERUN_TAIL_LINES = 40
export const RED_ROAD_USAGE = "usage: bun run scripts/jev/red-road.ts <prover> <log> [--row '<results.tsv row>'] [--rc N] [--secs N] [--no-rerun] [--tree <dir>] [--receipt <path>] [--floor 0.6] [--home <config home: the JEV setting and key; default the operator's own ~/.mercury, a pinned scratch kept>] [--json] [-- <rerun command...>]"
export const PROOF_HOME_PREFIX = 'mercury-proof-home-'

export function roadHome(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const pinned = env.MERCURY_CONFIG_DIR?.trim()
  if (pinned && !basename(pinned).startsWith(PROOF_HOME_PREFIX)) return pinned
  return join(homedir(), '.mercury')
}

export const RED_ROAD_QUESTIONS: JevEvalInput['questions'] = [
  {
    id: 'killed',
    kind: 'noul',
    ask: 'The run described in `run` and `tail` was ended from OUTSIDE — a kill signal (exit code 137 or 143, `Killed`, `SIGKILL`, `terminated`), an out-of-memory kill, or the harness’s whole-run timeout (a tree-kill sidecar or a `__SUITE_TIMEOUT` line) — so it stopped without its own verdict line, rather than failing one of its own checks.',
  },
  {
    id: 'starved',
    kind: 'noul',
    ask: 'The run described in `tail` and `signatures` was STARVED by contention on a loaded box — a capture deadline exceeded, a screen that never settled within the ceiling, undelivered or unfired sends, a capture slot wait, `exit=null`, zero frames, a frame that never painted or a seat that never exited — rather than the product answering with the wrong words, rows or timing.',
  },
]

const KILL_SIGNATURE = /(\bKilled\b|SIGKILL|SIGTERM|\bterminated\b|__SUITE_TIMEOUT|\bTIMEOUT\b|tree-kill|out of memory|\bOOM\b|rc=13[47]|rc=143|KILLED)/i
const STARVE_SIGNATURE = /(capture deadline exceeded|never settled|UNDELIVERED-SENDS|UNFIRED-SENDS|first stuck|exit=null|\bslot\b|zero frames|frames: 0|never painted|never exited|last frame EMPTY|could not run)/i
const VERDICT_LINE = /(\d+\s*(?:\/|of)\s*\d+ checks? (?:passed|failed)|checks? (?:passed|failed)|\bFAILED\b|\bGREEN\b|── .* rc=\d+|^rc=\d+|all checks pass)/i
const SIGNALS: Readonly<Record<number, string>> = { 129: 'SIGHUP', 130: 'SIGINT', 131: 'SIGQUIT', 134: 'SIGABRT', 137: 'SIGKILL', 139: 'SIGSEGV', 141: 'SIGPIPE', 143: 'SIGTERM' }
const SIGNAL_CODES: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGABRT: 134, SIGKILL: 137, SIGSEGV: 139, SIGPIPE: 141, SIGTERM: 143 }

export type RedRoadVerdict = 'KILLED' | 'STARVED' | 'REAL' | 'UNSURE'
export interface RedRoadRun {
  rc: number | null
  secs: number | null
  hangSecs: number | null
  retry: { rc: number; secs: number } | null
}
export interface RedRoadEvidence {
  run: string
  tail: string
  signatures: string
}

export function signalWords(rc: number | null): string {
  if (rc === null || rc <= 128) return 'no signal'
  return `${SIGNALS[rc] ?? `signal ${rc - 128}`} (${rc - 128})`
}

function clipLine(line: string): string {
  return line.length > RED_ROAD_LINE_CLIP ? `${line.slice(0, RED_ROAD_LINE_CLIP - 1)}…` : line
}

export function redRoadEvidence(logText: string, run: RedRoadRun): RedRoadEvidence {
  const lines = logText.replace(/\r/g, '').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  const tail = lines.slice(-RED_ROAD_TAIL_LINES).map(clipLine)
  const matched = lines.filter(line => KILL_SIGNATURE.test(line) || STARVE_SIGNATURE.test(line)).map(clipLine)
  const signatures = matched.length === 0 ? 'none matched' : matched.slice(-RED_ROAD_SIGNATURE_LINES).join('\n')
  const closing = lines.slice(-5).some(line => VERDICT_LINE.test(line))
  const retry = run.retry === null ? '' : ` · the harness’s own retry ended rc ${run.retry.rc} in ${run.retry.secs}s`
  const runLine = [
    `exit code ${run.rc ?? 'unknown'}`,
    signalWords(run.rc),
    `wall ${run.secs === null ? 'unknown' : `${run.secs}s`}`,
    `tree-kill sidecar ${run.hangSecs === null ? 'absent' : `present (${run.hangSecs}s)`}`,
    `own verdict line ${closing ? 'present' : 'absent'}`,
    `${lines.length} lines`,
  ].join(' · ')
  return { run: `${runLine}${retry}`, tail: tail.join('\n'), signatures }
}

export function redRoadVerdict(nouls: { killed: number; starved: number }, floor: number = RED_ROAD_CONFIDENT_FLOOR): RedRoadVerdict {
  if (nouls.killed >= floor || nouls.starved >= floor) return nouls.starved > nouls.killed ? 'STARVED' : 'KILLED'
  if (nouls.killed <= RED_ROAD_KILLED_REAL_CEILING && nouls.starved <= RED_ROAD_STARVED_REAL_CEILING) return 'REAL'
  return 'UNSURE'
}

export function parseResultsRow(row: string): { rc: number | null; secs: number | null; retry: { rc: number; secs: number } | null } {
  const cells = row.includes('\t') ? row.split('\t') : row.trim().split(/\s+/)
  const int = (cell: string | undefined): number | null => (cell !== undefined && /^\d+$/.test(cell.trim()) ? Number(cell.trim()) : null)
  const rc = int(cells[2])
  const secs = int(cells[3])
  const retryRc = int(cells[4])
  const retrySecs = int(cells[5])
  return { rc, secs, retry: retryRc === null ? null : { rc: retryRc, secs: retrySecs ?? 0 } }
}

function sidecar(log: string, ext: string): number | null {
  const stem = basename(log).replace(/\.[^.]+$/, '')
  const path = join(dirname(log), `${stem}.${ext}`)
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8').trim()
  return /^\d+$/.test(text) ? Number(text) : null
}

interface Args {
  prover: string
  log: string
  row?: string
  rc?: number
  secs?: number
  noRerun: boolean
  tree: string
  receipt?: string
  floor: number
  home?: string
  json: boolean
  rerun: string[]
}

function parseArgs(argv: readonly string[]): Args | string {
  const positional: string[] = []
  const args: Args = { prover: '', log: '', noRerun: false, tree: process.cwd(), floor: RED_ROAD_CONFIDENT_FLOOR, json: false, rerun: [] }
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at]!
    const value = (): string | undefined => argv[++at]
    if (word === '--') {
      args.rerun = argv.slice(at + 1)
      break
    } else if (word === '--row') args.row = value()
    else if (word === '--rc') args.rc = Number(value())
    else if (word === '--secs') args.secs = Number(value())
    else if (word === '--no-rerun') args.noRerun = true
    else if (word === '--tree') args.tree = resolve(value() ?? '.')
    else if (word === '--receipt') args.receipt = value()
    else if (word === '--floor') args.floor = Number(value())
    else if (word === '--home') args.home = value()
    else if (word === '--json') args.json = true
    else if (word.startsWith('--')) return `unknown flag ${word}`
    else positional.push(word)
  }
  if (positional.length !== 2) return 'a prover and its log are the two arguments'
  args.prover = positional[0]!
  args.log = resolve(positional[1]!)
  if (!existsSync(args.log)) return `no such log ${args.log}`
  if (!Number.isFinite(args.floor) || args.floor <= 0 || args.floor > 1) return 'the floor is a probability in (0, 1]'
  if (args.rc !== undefined && !Number.isInteger(args.rc)) return '--rc wants a whole number'
  if (args.secs !== undefined && !Number.isInteger(args.secs)) return '--secs wants a whole number'
  return args
}

function defaultRerun(prover: string): string[] {
  if (prover.endsWith('.sh')) return ['bash', prover]
  if (!prover.includes('/') && !prover.includes('.')) return ['bash', `scripts/${prover}/run-all.sh`]
  return [process.execPath, prover]
}

function uptime(): string {
  const result = spawnSync('uptime', { encoding: 'utf8' })
  return (result.stdout ?? '').trim() || 'uptime unavailable'
}

function p(value: number): string {
  return value.toFixed(2)
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    console.error(`${RED_ROAD_USAGE}\n${parsed}`)
    return 4
  }
  const args = parsed
  const fromRow = args.row === undefined ? null : parseResultsRow(args.row)
  const run: RedRoadRun = {
    rc: fromRow?.rc ?? args.rc ?? sidecar(args.log, 'rc'),
    secs: fromRow?.secs ?? args.secs ?? sidecar(args.log, 'secs'),
    hangSecs: sidecar(args.log, 'hang'),
    retry: fromRow?.retry ?? null,
  }
  const evidence = redRoadEvidence(readFileSync(args.log, 'utf8'), run)
  process.env.MERCURY_CONFIG_DIR = roadHome(args.home)
  const { askJev } = await import('./lib/jevAsk.ts')
  const ask = await askJev({ goal: 'the chain red road: was this red killed from outside or starved by the box?', evidence: { ...evidence }, questions: RED_ROAD_QUESTIONS })
  const stem = basename(args.log).replace(/\.[^.]+$/, '')
  const receipt = args.receipt !== undefined ? resolve(args.receipt) : join(dirname(args.log), `${stem}.red-road.log`)
  const record: Record<string, unknown> = { prover: args.prover, log: args.log, rc: run.rc, secs: run.secs, hangSecs: run.hangSecs, signal: run.rc !== null && run.rc > 128 ? (SIGNALS[run.rc] ?? `signal ${run.rc - 128}`) : null, floor: args.floor }
  const say = (line: string, exit: number): number => {
    console.log(args.json ? JSON.stringify({ ...record, line, exit }) : line)
    return exit
  }
  if (!ask.ok) {
    Object.assign(record, { verdict: 'UNAVAILABLE', kind: ask.kind, words: ask.words })
    return say(`UNAVAILABLE — ${ask.words} → a seat with the log`, 3)
  }
  const killed = ask.nouls.killed
  const starved = ask.nouls.starved
  Object.assign(record, { model: ask.model, inputTokens: ask.usage.input_tokens, chargeUsd: ask.chargeUsd, ...(ask.usage.cost !== undefined ? { statedCostUsd: ask.usage.cost } : {}), ...(ask.requestId !== undefined ? { requestId: ask.requestId } : {}) })
  if (killed === undefined || starved === undefined) {
    Object.assign(record, { verdict: 'UNAVAILABLE', kind: 'parse-failed', words: 'the answer carried no number for killed or starved' })
    return say('UNAVAILABLE — the answer carried no number for killed or starved → a seat with the log', 3)
  }
  const verdict = redRoadVerdict({ killed, starved }, args.floor)
  Object.assign(record, { verdict, killed, starved })
  if (verdict === 'REAL') return say(`REAL — killed ${p(killed)} · starved ${p(starved)} → a seat with the log`, 1)
  if (verdict === 'UNSURE') return say(`UNSURE — killed ${p(killed)} · starved ${p(starved)} → a seat with the log`, 2)
  const head = verdict === 'KILLED' ? `KILLED p=${p(killed)} · starved ${p(starved)}` : `STARVED p=${p(starved)} · killed ${p(killed)}`
  if (args.noRerun) {
    record.rerun = 'skipped'
    return say(`${head} · rerun skipped`, 0)
  }
  const command = args.rerun.length > 0 ? args.rerun : defaultRerun(args.prover)
  const before = uptime()
  const started = Date.now()
  const result = spawnSync(command[0]!, command.slice(1), { cwd: args.tree, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env })
  const secs = Math.round((Date.now() - started) / 1000)
  const rc = result.status ?? (result.signal ? (SIGNAL_CODES[result.signal] ?? 128) : 127)
  const after = uptime()
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}\n` : ''}`
  const rerunLog = `${receipt.replace(/\.log$/, '')}.rerun.log`
  writeFileSync(rerunLog, output)
  const cleared = rc === 0
  const closing = cleared ? `closed: base-red/${verdict.toLowerCase()} — the solo rerun went green; no model read the log` : `still red — a real red: the solo rerun ended rc=${rc}; hand the log to a seat`
  const outputTail = output.split('\n').slice(-RED_ROAD_RERUN_TAIL_LINES).join('\n')
  writeFileSync(receipt, [
    `red road — ${args.prover}`,
    `log: ${args.log}`,
    `verdict: ${head}`,
    `run: ${evidence.run}`,
    `uptime before: ${before}`,
    `rerun: ${command.join(' ')} (in ${args.tree})`,
    `rerun rc=${rc} in ${secs}s`,
    `uptime after: ${after}`,
    closing,
    `--- rerun tail (last ${RED_ROAD_RERUN_TAIL_LINES} lines; whole output in ${rerunLog}) ---`,
    outputTail,
    '',
  ].join('\n'))
  record.rerun = { rc, secs, receipt, cleared, uptimeBefore: before, uptimeAfter: after }
  return say(`${head} · solo rerun rc=${rc} in ${secs}s → ${cleared ? `base-red/${verdict.toLowerCase()}` : 'real red'} · receipt ${receipt}`, cleared ? 0 : 1)
}

if (import.meta.main) process.exit(await main())
