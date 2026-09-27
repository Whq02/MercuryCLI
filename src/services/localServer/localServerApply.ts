import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { FIT_REMEDY, LOCAL_SERVER_KNOBS, chosenKnobs, fitVerdict, memoryFactsOf, settingsAsEnv, type FitVerdict, type LocalServerSettings } from './localServerKnobs.js'
import { fetchWithProviderDeadline } from '../providers/fetchDeadline.js'
import { resolveLocalServerIo, type LaunchFormKind, type LocalServerIo, type LocalServerTruth } from './localServerTruth.js'

export interface LocalServerChange {
  name: string
  before?: string
  after: string
}

export interface LocalServerRestart {
  argv: string[][]
  words: string
}

export const APP_NAME = 'Ollama'
export const APP_QUIT_ARGV = ['osascript', '-e', `tell application "${APP_NAME}" to quit`]
export const APP_OPEN_ARGV = ['open', '-a', APP_NAME]
export const APP_CLOSE_WAIT_MS = 20_000
export const APP_UP_WAIT_MS = 60_000
export const APP_POLL_MS = 500

export type LocalServerApplyPlan =
  | { kind: 'nothing'; form: LaunchFormKind; changes: LocalServerChange[]; note: string }
  | { kind: 'refused'; form: LaunchFormKind; changes: LocalServerChange[]; fit: FitVerdict; note: string }
  | { kind: 'restart'; form: LaunchFormKind; path: string; root?: string; changes: LocalServerChange[]; restart: LocalServerRestart; note: string }
  | { kind: 'write'; form: LaunchFormKind; path: string; backupPath: string; before: string; after: string; changes: LocalServerChange[]; lines: string[]; restart: LocalServerRestart; note: string }
  | { kind: 'app'; form: 'app'; root: string; changes: LocalServerChange[]; previous: Record<string, string | undefined>; lines: string[]; steps: string[]; revert: string[]; restart: LocalServerRestart; note: string }
  | { kind: 'by-hand'; form: LaunchFormKind; changes: LocalServerChange[]; lines: string[]; note: string }

export type LocalServerApplyOutcome =
  | { outcome: 'refused'; reason: string }
  | { outcome: 'stale'; reason: string }
  | { outcome: 'failed'; reason: string; backupPath?: string; revert?: string[] }
  | { outcome: 'applied'; backupPath?: string; restarted: boolean; restartWords: string; revert?: string[] }

const PLIST_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

export function plistEscape(value: string): string {
  return value.replace(/[&<>]/g, ch => PLIST_ESCAPES[ch] ?? ch)
}

function indentOf(line: string): string {
  return /^(\s*)/.exec(line)?.[1] ?? ''
}

export interface Rewrite {
  text: string
  lines: string[]
}

export function rewritePlistEnvironment(text: string, env: Record<string, string>): Rewrite {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(newline)
  const names = Object.keys(env).sort()
  const shown: string[] = []
  const keyAt = lines.findIndex(line => /^\s*<key>EnvironmentVariables<\/key>\s*$/.test(line))
  if (keyAt < 0) {
    const topDict = lines.findIndex(line => /^\s*<dict>\s*$/.test(line))
    if (topDict < 0) return { text, lines: [] }
    const indent = `${indentOf(lines[topDict]!)}${text.includes('\t') ? '\t' : '  '}`
    const inner = `${indent}${text.includes('\t') ? '\t' : '  '}`
    const block = [`${indent}<key>EnvironmentVariables</key>`, `${indent}<dict>`, ...names.flatMap(name => [`${inner}<key>${name}</key>`, `${inner}<string>${plistEscape(env[name]!)}</string>`]), `${indent}</dict>`]
    lines.splice(topDict + 1, 0, ...block)
    return { text: lines.join(newline), lines: block.map(line => `+${line}`) }
  }
  let dictAt = keyAt + 1
  if (/^\s*<dict\s*\/>\s*$/.test(lines[dictAt] ?? '')) {
    const indent = indentOf(lines[dictAt]!)
    lines.splice(dictAt, 1, `${indent}<dict>`, `${indent}</dict>`)
  }
  if (!/^\s*<dict>\s*$/.test(lines[dictAt] ?? '')) return { text, lines: [] }
  const dictIndent = indentOf(lines[dictAt]!)
  let endAt = -1
  for (let i = dictAt + 1; i < lines.length; i++) {
    if (lines[i] === `${dictIndent}</dict>` || /^\s*<\/dict>\s*$/.test(lines[i]!) && indentOf(lines[i]!) === dictIndent) {
      endAt = i
      break
    }
  }
  if (endAt < 0) return { text, lines: [] }
  const inner = lines[dictAt + 1] !== undefined && dictAt + 1 < endAt ? indentOf(lines[dictAt + 1]!) : `${dictIndent}${text.includes('\t') ? '\t' : '  '}`
  for (const name of names) {
    const value = `${inner}<string>${plistEscape(env[name]!)}</string>`
    let placed = false
    for (let i = dictAt + 1; i < endAt; i++) {
      const key = /^\s*<key>([^<]+)<\/key>\s*$/.exec(lines[i]!)?.[1]
      if (key === undefined) continue
      if (key === name) {
        if (lines[i + 1] !== value) {
          shown.push(` ${lines[i]!}`, `-${lines[i + 1] ?? ''}`, `+${value}`)
          lines[i + 1] = value
        }
        placed = true
        break
      }
      if (key > name) {
        lines.splice(i, 0, `${inner}<key>${name}</key>`, value)
        shown.push(`+${inner}<key>${name}</key>`, `+${value}`)
        endAt += 2
        placed = true
        break
      }
    }
    if (!placed) {
      lines.splice(endAt, 0, `${inner}<key>${name}</key>`, value)
      shown.push(`+${inner}<key>${name}</key>`, `+${value}`)
      endAt += 2
    }
  }
  return { text: lines.join(newline), lines: shown }
}

export function rewriteSystemdOverride(text: string, env: Record<string, string>): Rewrite {
  const lines = text === '' ? ['[Service]'] : text.replace(/\n$/, '').split('\n')
  const names = Object.keys(env).sort()
  const shown: string[] = []
  let serviceAt = lines.findIndex(line => /^\s*\[Service\]\s*$/.test(line))
  if (serviceAt < 0) {
    lines.push('[Service]')
    serviceAt = lines.length - 1
  }
  let sectionEnd = lines.findIndex((line, i) => i > serviceAt && /^\s*\[/.test(line))
  if (sectionEnd < 0) sectionEnd = lines.length
  for (const name of names) {
    const wanted = `Environment="${name}=${env[name]!}"`
    let placed = false
    for (let i = serviceAt + 1; i < sectionEnd; i++) {
      const match = new RegExp(`^\\s*Environment\\s*=\\s*"?${name}=`).exec(lines[i]!)
      if (!match) continue
      if (lines[i] !== wanted) {
        shown.push(`-${lines[i]!}`, `+${wanted}`)
        lines[i] = wanted
      }
      placed = true
      break
    }
    if (!placed) {
      lines.splice(sectionEnd, 0, wanted)
      shown.push(`+${wanted}`)
      sectionEnd += 1
    }
  }
  return { text: `${lines.join('\n')}\n`, lines: shown }
}

export function backupPathFor(path: string, exists: (candidate: string) => boolean): string {
  const base = `${path}.bak`
  if (!exists(base)) return base
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base}.${n}`
    if (!exists(candidate)) return candidate
  }
  return `${base}.${Date.now()}`
}

export function changesBetween(current: Record<string, string>, desired: Record<string, string>): LocalServerChange[] {
  const changes: LocalServerChange[] = []
  for (const knob of LOCAL_SERVER_KNOBS) {
    const after = desired[knob.envName]
    if (after === undefined) continue
    const before = current[knob.envName]
    if (before === after) continue
    changes.push({ name: knob.envName, ...(before !== undefined ? { before } : {}), after })
  }
  return changes
}

export function byHandLines(form: LaunchFormKind, desired: Record<string, string>): string[] {
  const names = Object.keys(desired).sort()
  if (form === 'app') return [...names.map(name => `launchctl setenv ${name} ${desired[name]!}`), 'then quit the Ollama app and open it again']
  if (form === 'windows') return [...names.map(name => `setx ${name} "${desired[name]!}"`), 'then quit Ollama from the tray and start it again']
  if (form === 'systemd') return ['sudo systemctl edit ollama.service', '[Service]', ...names.map(name => `Environment="${name}=${desired[name]!}"`), 'sudo systemctl daemon-reload && sudo systemctl restart ollama.service']
  if (form === 'launch-agent' || form === 'homebrew') return names.map(name => `<key>${name}</key> <string>${plistEscape(desired[name]!)}</string>`)
  return [`${names.map(name => `${name}=${desired[name]!}`).join(' ')} ollama serve`]
}

export function appRevertLines(previous: Record<string, string | undefined>): string[] {
  return Object.keys(previous)
    .sort()
    .map(name => (previous[name] === undefined ? `launchctl unsetenv ${name}` : `launchctl setenv ${name} ${previous[name]!}`))
}

export function planLocalServerApply(truth: LocalServerTruth, settings: LocalServerSettings, seam: LocalServerIo = {}): LocalServerApplyPlan {
  const io = resolveLocalServerIo(seam)
  const desired = settingsAsEnv(settings)
  const form = truth.launchForm
  const runningEnv = truth.process?.env ?? {}
  if (Object.keys(desired).length === 0) return { kind: 'nothing', form: form.kind, changes: [], note: 'no knob is set; ←/→ on a knob row chooses a value first' }
  const fileChanges = changesBetween(form.env ?? {}, desired)
  const runningChanges = changesBetween(runningEnv, desired)
  const fit = fitVerdict(memoryFactsOf(truth), chosenKnobs(truth, settings))
  if (!fit.fits) return { kind: 'refused', form: form.kind, changes: runningChanges.length ? runningChanges : fileChanges, fit, note: fit.words }
  if (truth.server && truth.server.kind !== 'ollama') {
    return { kind: 'by-hand', form: 'unknown', changes: runningChanges, lines: byHandLines('unknown', desired), note: `${truth.server.label} takes these as start-up flags; Mercury shows the values, the server is started by hand` }
  }
  if (form.kind === 'app') {
    const root = truth.server?.root ?? 'http://127.0.0.1:11434'
    const restart: LocalServerRestart = { argv: [APP_QUIT_ARGV, APP_OPEN_ARGV], words: `${APP_QUIT_ARGV.join(' ')} · wait for ${root.replace(/^https?:\/\//, '')} to close · ${APP_OPEN_ARGV.join(' ')} · wait for /api/version` }
    if (fileChanges.length === 0) {
      if (runningChanges.length === 0 || !truth.process) return { kind: 'nothing', form: 'app', changes: [], note: `launchctl already carries every set value${truth.process ? ' and the running app has them' : ''}` }
      return { kind: 'restart', form: 'app', path: 'launchctl setenv', root, changes: runningChanges, restart, note: 'launchctl already carries the values; the running app does not — quit and open it again' }
    }
    const previous: Record<string, string | undefined> = {}
    for (const change of fileChanges) previous[change.name] = change.before
    const lines = fileChanges.map(change => `launchctl setenv ${change.name} ${change.after}`)
    return {
      kind: 'app',
      form: 'app',
      root,
      changes: fileChanges,
      previous,
      lines,
      steps: [...lines, APP_QUIT_ARGV.join(' '), `wait for ${root.replace(/^https?:\/\//, '')} to close`, APP_OPEN_ARGV.join(' '), 'wait for /api/version to answer'],
      revert: appRevertLines(previous),
      restart,
      note: 'launchctl setenv holds for this login session (the FAQ road for the app); the loaded models unload when the app restarts',
    }
  }
  if (form.kind === 'launch-agent' || form.kind === 'homebrew') {
    if (!form.path) return { kind: 'by-hand', form: form.kind, changes: fileChanges, lines: byHandLines(form.kind, desired), note: form.note }
    const label = form.label ?? ''
    const restart: LocalServerRestart = {
      argv: io.uid !== undefined && label ? [['launchctl', 'bootout', `gui/${io.uid}/${label}`], ['launchctl', 'bootstrap', `gui/${io.uid}`, form.path]] : [],
      words: io.uid !== undefined && label ? `launchctl bootout gui/${io.uid}/${label} && launchctl bootstrap gui/${io.uid} ${form.path}` : 'restart the agent by hand (no label read)',
    }
    if (fileChanges.length === 0) {
      if (runningChanges.length === 0 || !truth.process) return { kind: 'nothing', form: form.kind, changes: [], note: `${form.path} already carries every set value${truth.process ? ' and the running server has them' : ''}` }
      return { kind: 'restart', form: form.kind, path: form.path, changes: runningChanges, restart, note: `${form.path} already carries the values; the running server does not — a restart applies them` }
    }
    const before = io.readText(form.path)
    if (before === undefined || form.writable === false) return { kind: 'by-hand', form: form.kind, changes: fileChanges, lines: byHandLines(form.kind, desired), note: `${form.path} is not writable by Mercury; put these inside its EnvironmentVariables dict, then ${restart.words}` }
    const rewrite = rewritePlistEnvironment(before, desired)
    if (rewrite.lines.length === 0 || rewrite.text === before) return { kind: 'by-hand', form: form.kind, changes: fileChanges, lines: byHandLines(form.kind, desired), note: `${form.path} has no EnvironmentVariables dict Mercury can edit; add these by hand, then ${restart.words}` }
    return {
      kind: 'write',
      form: form.kind,
      path: form.path,
      backupPath: backupPathFor(form.path, io.pathExists),
      before,
      after: rewrite.text,
      changes: fileChanges,
      lines: rewrite.lines,
      restart,
      note: form.kind === 'homebrew' ? 'brew services restart or a brew upgrade rewrites this file; re-apply after either' : 'the loaded models unload on the restart; a session on them ingests its prompt again',
    }
  }
  if (form.kind === 'systemd') {
    const path = form.path ?? '/etc/systemd/system/ollama.service.d/override.conf'
    const restart: LocalServerRestart = { argv: [['systemctl', 'daemon-reload'], ['systemctl', 'restart', 'ollama.service']], words: 'systemctl daemon-reload && systemctl restart ollama.service' }
    if (fileChanges.length === 0) {
      if (runningChanges.length === 0 || !truth.process) return { kind: 'nothing', form: form.kind, changes: [], note: `${path} already carries every set value` }
      return { kind: 'restart', form: form.kind, path, changes: runningChanges, restart, note: `${path} already carries the values; the running server does not — a restart applies them` }
    }
    if (form.writable === false) return { kind: 'by-hand', form: form.kind, changes: fileChanges, lines: byHandLines('systemd', desired), note: `${path} needs root; run these by hand` }
    const before = io.readText(path) ?? ''
    const rewrite = rewriteSystemdOverride(before, desired)
    return { kind: 'write', form: form.kind, path, backupPath: backupPathFor(path, io.pathExists), before, after: rewrite.text, changes: fileChanges, lines: rewrite.lines, restart, note: 'the loaded models unload on the restart' }
  }
  return { kind: 'by-hand', form: form.kind, changes: runningChanges.length ? runningChanges : fileChanges, lines: byHandLines(form.kind, desired), note: form.note }
}

export interface LocalServerApplyIo {
  readText?: (path: string) => string | undefined
  writeText?: (path: string, text: string) => void
  copyFile?: (from: string, to: string) => void
  run?: (file: string, args: string[]) => Promise<string | undefined>
  sleep?: (ms: number) => Promise<void>
  probe?: (url: string) => Promise<boolean>
  now?: () => number
}

function defaultWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function defaultReadText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const response = await fetchWithProviderDeadline(resolveLocalServerIo({}).fetchImpl, 'local', 900, url, { method: 'GET' })
    return response.ok
  } catch {
    return false
  }
}

export const RESTART_ATTEMPTS = 4
export const RESTART_RETRY_MS = 1_500

async function waitUntil(io: { sleep: (ms: number) => Promise<void>; now: () => number }, condition: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const deadline = io.now() + budgetMs
  while (true) {
    if (await condition()) return true
    if (io.now() >= deadline) return false
    await io.sleep(APP_POLL_MS)
  }
}

type ApplyRuntime = { run: (file: string, args: string[]) => Promise<string | undefined>; sleep: (ms: number) => Promise<void>; probe: (url: string) => Promise<boolean>; now: () => number }

async function restartApp(io: ApplyRuntime, root: string, words: string): Promise<{ restarted: boolean; restartWords: string }> {
  const version = `${root}/api/version`
  const quit = await io.run(APP_QUIT_ARGV[0]!, APP_QUIT_ARGV.slice(1))
  if (quit === undefined) return { restarted: false, restartWords: `the variables are set; quitting ${APP_NAME} failed — quit and open the app by hand` }
  const closed = await waitUntil(io, async () => !(await io.probe(version)), APP_CLOSE_WAIT_MS)
  if (!closed) return { restarted: false, restartWords: `the variables are set; ${APP_NAME} did not close within ${APP_CLOSE_WAIT_MS / 1000} s — quit and open the app by hand` }
  const opened = await io.run(APP_OPEN_ARGV[0]!, APP_OPEN_ARGV.slice(1))
  if (opened === undefined) return { restarted: false, restartWords: `the variables are set and ${APP_NAME} quit; open -a ${APP_NAME} failed — open the app by hand` }
  const up = await waitUntil(io, () => io.probe(version), APP_UP_WAIT_MS)
  return { restarted: up, restartWords: up ? words : `the variables are set and ${APP_NAME} was opened; /api/version has not answered within ${APP_UP_WAIT_MS / 1000} s — it may still be starting` }
}

async function applyAppPlan(plan: Extract<LocalServerApplyPlan, { kind: 'app' }>, io: ApplyRuntime): Promise<LocalServerApplyOutcome> {
  for (const change of plan.changes) {
    const set = await io.run('launchctl', ['setenv', change.name, change.after])
    if (set === undefined) return { outcome: 'failed', reason: `launchctl setenv ${change.name} failed; nothing restarted`, revert: plan.revert }
  }
  return { outcome: 'applied', ...(await restartApp(io, plan.root, plan.restart.words)), revert: plan.revert }
}

export async function applyLocalServerPlan(plan: LocalServerApplyPlan, confirmation: { confirmed: boolean }, seam: LocalServerApplyIo = {}): Promise<LocalServerApplyOutcome> {
  if (plan.kind === 'refused') return { outcome: 'refused', reason: plan.fit.words }
  if (confirmation.confirmed !== true) return { outcome: 'refused', reason: 'not confirmed: nothing was written and nothing restarted' }
  if (plan.kind === 'nothing') return { outcome: 'refused', reason: plan.note }
  if (plan.kind === 'by-hand') return { outcome: 'refused', reason: `Mercury cannot write this launch form: ${plan.note}` }
  const io = {
    readText: seam.readText ?? defaultReadText,
    writeText: seam.writeText ?? defaultWriteText,
    copyFile: seam.copyFile ?? ((from: string, to: string) => copyFileSync(from, to)),
    run: seam.run ?? resolveLocalServerIo({}).run,
    sleep: seam.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))),
    probe: seam.probe ?? defaultProbe,
    now: seam.now ?? Date.now,
  }
  if (plan.kind === 'app') return applyAppPlan(plan, io)
  if (plan.kind === 'restart' && plan.form === 'app') return { outcome: 'applied', ...(await restartApp(io, plan.root ?? 'http://127.0.0.1:11434', plan.restart.words)) }
  let backupPath: string | undefined
  if (plan.kind === 'write') {
    const onDisk = io.readText(plan.path)
    if (onDisk !== plan.before && !(onDisk === undefined && plan.before === '')) return { outcome: 'stale', reason: `${plan.path} changed since the plan was made; review it again` }
    try {
      if (onDisk !== undefined) {
        io.copyFile(plan.path, plan.backupPath)
        backupPath = plan.backupPath
      }
      io.writeText(plan.path, plan.after)
    } catch (error) {
      return { outcome: 'failed', reason: `writing ${plan.path} failed: ${error instanceof Error ? error.message : String(error)}`, ...(backupPath ? { backupPath } : {}) }
    }
  }
  if (plan.restart.argv.length === 0) return { outcome: 'applied', ...(backupPath ? { backupPath } : {}), restarted: false, restartWords: plan.restart.words }
  let restarted = true
  for (const [index, command] of plan.restart.argv.entries()) {
    let output: string | undefined
    const attempts = index === plan.restart.argv.length - 1 ? RESTART_ATTEMPTS : 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      output = await io.run(command[0]!, command.slice(1))
      if (output !== undefined) break
      if (attempt < attempts - 1) await io.sleep(RESTART_RETRY_MS)
    }
    if (output === undefined) {
      restarted = false
      break
    }
  }
  return { outcome: 'applied', ...(backupPath ? { backupPath } : {}), restarted, restartWords: restarted ? plan.restart.words : `restart did not complete; run by hand: ${plan.restart.words}` }
}

export function planWords(plan: LocalServerApplyPlan): string {
  const count = plan.changes.length
  const change = `${count} change${count === 1 ? '' : 's'}`
  if (plan.kind === 'nothing') return plan.note
  if (plan.kind === 'refused') return `${plan.fit.short} — ${FIT_REMEDY}`
  if (plan.kind === 'restart') return `${change} — a restart applies them · → reviews`
  if (plan.kind === 'by-hand') return `${change} by hand — → shows the lines`
  if (plan.kind === 'app') return `${change} + the app restarts · → reviews the lines first`
  return `${change} + a restart · → reviews the file before anything is written`
}
