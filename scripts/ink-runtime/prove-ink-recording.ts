#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { playScene, SCENES } from './inkRecordingScenes.ts'

const SELF = 'scripts/ink-runtime/prove-ink-recording.ts'
const UNIT = 'Ink'
const RECORDING = join(import.meta.dir, 'recordings', 'ink.txt')
const RECORDING_NAME = 'scripts/ink-runtime/recordings/ink.txt'
const AT_ONCE = 4
const CHILD_LIMIT_MS = 60_000
const NOT_OF_A_RECORDING: ReadonlyArray<[what: string, found: RegExp]> = [
  ['a path of this machine', /\/Users\/|\/private\/|\/tmp\/|\/home\/|[A-Za-z]:\\\\/],
  ['a signal by its name', /\bSIG[A-Z]{3,}\b/],
]

if (process.platform === 'win32') {
  console.log(`  [SKIP] ${SELF}: the recording holds the arms ${UNIT} takes on darwin and Linux, and win32 takes its own; nothing is played or compared on win32`)
  process.exit(0)
}

const argOf = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}

const sceneAsked = argOf('--scene')
if (sceneAsked !== undefined && argOf('--out') !== undefined) {
  const lines = await playScene(sceneAsked, argOf('--fd1') ?? null, argOf('--tees') ?? tmpdir())
  writeFileSync(argOf('--out')!, `${lines.join('\n')}\n`)
  process.exit(0)
}

type Recorded = Map<string, string[]>

const scratch = mkdtempSync(join(tmpdir(), 'ink-recording-'))

function playInChild(name: string, round: number, at: number): Promise<string[]> {
  const stem = join(scratch, `${round}-${at}`)
  const tees = `${stem}.tees`
  mkdirSync(tees)
  const fd1 = openSync(`${stem}.fd1`, 'w')
  return new Promise((done, refuse) => {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.path, '--scene', name, '--out', `${stem}.txt`, '--fd1', `${stem}.fd1`, '--tees', tees, '--log-stderr'], {
      stdio: ['ignore', fd1, 'pipe'],
      env: process.env,
    })
    let said = ''
    child.stderr!.on('data', chunk => {
      said += String(chunk)
    })
    const limit = setTimeout(() => child.kill('SIGKILL'), CHILD_LIMIT_MS)
    child.on('error', refuse)
    child.on('close', (code, signal) => {
      clearTimeout(limit)
      closeSync(fd1)
      if (code !== 0 || !existsSync(`${stem}.txt`)) {
        refuse(new Error(`the scene "${name}" did not record: its process ended ${signal === null ? `with code ${code}` : 'by a signal'}\n${said.trim().split('\n').slice(-12).join('\n')}`))
        return
      }
      done(readFileSync(`${stem}.txt`, 'utf8').replace(/\n$/, '').split('\n'))
    })
  })
}

let stopped = false

async function record(round: number, names: readonly string[], seen: (name: string, lines: string[]) => void = () => {}): Promise<Recorded> {
  const out: Recorded = new Map()
  let next = 0
  const worker = async (): Promise<void> => {
    while (!stopped) {
      const at = next++
      const name = names[at]
      if (name === undefined) return
      const lines = await playInChild(name, round, at)
      out.set(name, lines)
      seen(name, lines)
    }
  }
  const ended = await Promise.allSettled(Array.from({ length: AT_ONCE }, worker))
  for (const end of ended) if (end.status === 'rejected') throw end.reason
  return new Map(names.filter(name => out.has(name)).map(name => [name, out.get(name)!]))
}

function written(recording: Recorded): string {
  let text = ''
  for (const [name, lines] of recording) text += `## ${name}\n${lines.join('\n')}\n\n`
  return text
}

function read(text: string): Recorded {
  const out: Recorded = new Map()
  let held: string[] | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      held = []
      out.set(line.slice(3), held)
    } else if (held !== null) held.push(line)
  }
  for (const lines of out.values()) while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return out
}

function around(line: string | undefined, at: number): string {
  if (line === undefined) return '(no line)'
  const from = Math.max(0, at - 60)
  const cut = line.slice(from, from + 200)
  return `${from > 0 ? '…' : ''}${cut}${from + 200 < line.length ? '…' : ''}`
}

function firstDifference(stood: string[], stands: string[]): string | null {
  const reach = Math.max(stood.length, stands.length)
  for (let at = 0; at < reach; at++) {
    const a = stood[at]
    const b = stands[at]
    if (a === b) continue
    let column = 0
    while (a !== undefined && b !== undefined && column < a.length && a[column] === b[column]) column++
    return `line ${at + 1}, column ${column + 1}\n      stood:  ${around(a, column)}\n      stands: ${around(b, column)}`
  }
  return null
}

let failures = 0
const fail = (line: string): void => {
  failures++
  console.log(`  [FAIL] ${line}`)
}

const only = sceneAsked === undefined ? null : SCENES.filter(scene => scene.name.includes(sceneAsked)).map(scene => scene.name)
const names = only ?? SCENES.map(scene => scene.name)
if (new Set(names).size !== names.length) fail('two scenes carry one name: give each its own in scripts/ink-runtime/inkRecordingScenes.ts')

const source = Bun.resolveSync('../../src/screen/renderer/screenInstance.js', import.meta.dir)
if (source.replaceAll('\\', '/').endsWith('/src/screen/renderer/screenInstance.tsx')) console.log(`  [PASS] the class recorded is the product's own ${UNIT} of src/screen/renderer/screenInstance.tsx: no module is replaced; the terminal, the keys, the clock and the timers are scripted, and each scene plays in a process of its own`)
else fail(`the module under the recording is not src/screen/renderer/screenInstance.tsx: it is ${source}`)

const once = process.argv.includes('--once')
const firstRed = process.argv.includes('--first-red')
const stoodNow = existsSync(RECORDING) ? read(readFileSync(RECORDING, 'utf8')) : new Map<string, string[]>()

let first: Recorded = new Map()
let second: Recorded = new Map()
try {
  first = await record(1, names, (name, lines) => {
    if (firstRed && firstDifference(stoodNow.get(name) ?? [], lines) !== null) stopped = true
  })
  second = once || stopped ? first : await record(2, names)
} catch (error) {
  stopped = true
  fail(error instanceof Error ? error.message : String(error))
} finally {
  try {
    removeScratch(scratch)
  } catch (error) {
    console.log(`  [NOTE] the scratch of this run was not removed — ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
  }
}
if (once) console.log('  [NOTE] --once: each scene was recorded once, so nothing says that two recordings of this tree are equal')
if (stopped) console.log(`  [NOTE] the run stopped at the first scene that differs: ${first.size} of ${names.length} scenes were recorded`)

for (const [name, lines] of first) {
  const twice = firstDifference(lines, second.get(name) ?? [])
  if (twice !== null) fail(`${name}: two recordings of one tree differ, so nothing can be compared with it: ${twice}`)
  for (const [what, found] of NOT_OF_A_RECORDING) {
    const at = lines.findIndex(line => found.test(line))
    if (at >= 0) fail(`${name}: the recording holds ${what} at line ${at + 1}: ${around(lines[at], Math.max(0, lines[at]!.search(found)))}`)
  }
}

if (process.argv.includes('--print')) {
  console.log(written(first))
  process.exit(failures === 0 ? 0 : 1)
}

if (process.argv.includes('--write')) {
  if (failures === 0) {
    const stood = existsSync(RECORDING) ? read(readFileSync(RECORDING, 'utf8')) : new Map<string, string[]>()
    const kept = only === null ? first : new Map([...stood, ...first])
    for (const [name, lines] of first) {
      const moved = firstDifference(stood.get(name) ?? [], lines)
      if (moved !== null) console.log(`  wrote ${name}: ${stood.has(name) ? moved : `${lines.length} lines, new`}`)
    }
    for (const name of stood.keys()) if (!kept.has(name)) console.log(`  dropped ${name}: no scene records it`)
    mkdirSync(dirname(RECORDING), { recursive: true })
    writeFileSync(RECORDING, written(kept))
    console.log(`\n${kept.size} scenes, ${[...kept.values()].reduce((n, lines) => n + lines.length, 0)} lines written to ${RECORDING_NAME}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

if (!existsSync(RECORDING)) fail(`no recording stands at ${RECORDING_NAME}: run \`bun run ${SELF} --write\` on a tree whose behaviour is the one to hold, and commit it`)
else {
  const stood = read(readFileSync(RECORDING, 'utf8'))
  for (const [name, lines] of first) {
    const held = stood.get(name)
    if (held === undefined) {
      fail(`${name}: the scene has no recording; run \`bun run ${SELF} --write\` and commit the recording with the scene`)
      continue
    }
    const moved = firstDifference(held, lines)
    if (moved === null) console.log(`  [PASS] ${name} (${lines.length} lines)`)
    else fail(`the recorded behaviour of ${UNIT} changed in "${name}" at ${moved}\n      if nobody asked for the change, the change is the fault: mend src/screen/renderer/screenInstance.tsx or its parts in src/screen/renderer/instance/ until the scene is equal; if it was asked for, run \`bun run ${SELF} --write\`, read the difference it prints, and commit the recording with the change`)
  }
  if (only === null && !stopped) for (const name of stood.keys()) if (!first.has(name)) fail(`${name}: a recording stands that no scene records; run \`bun run ${SELF} --write\` to drop it`)
}

console.log(`\n${failures === 0 ? 'green' : 'RED'}: prove-ink-recording — ${first.size} scenes, ${failures === 0 ? 'equal to the recording' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
