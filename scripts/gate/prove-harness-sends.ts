#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = relative(ROOT, import.meta.path)
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}

console.log('a harness sends a key of its own only to the Boot face, through one helper, and never drops a send from the record')

const helper = await import('../lib/bootFace.ts').catch(() => null)
const fires = (line: string): boolean => helper !== null && helper.paintsBootFaceReady(line)
const NEEDLE = '↑↓ choose'
const NEEDLE_LOOSE = /↑↓\s*choose/
const FACE_LOCKUP = /^\s*>_ ready {2}· {2}↵ (?:start|open) {2}·(?: {2}m menu {2}·)? {2}↑↓ choose\s*$/
const FACE_COMPACT = /^\s*│ ↵ (?:start|open) · ↑↓ choose(?: · m menu)?\s*│\s*$/
const isBootFaceLine = (line: string): boolean => FACE_LOCKUP.test(line) || FACE_COMPACT.test(line)

function filesUnder(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) filesUnder(path, keep, out)
    else if (keep(path)) out.push(path)
  }
  return out
}
function stringsOf(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(...value.split('\n'))
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringsOf(item, out)
}
function rowsOf(path: string): string[] {
  const text = readFileSync(path, 'utf8')
  if (!path.endsWith('.json')) return text.split('\n')
  const rows: string[] = []
  try {
    stringsOf(JSON.parse(text), rows)
  } catch {
    rows.push(...text.split('\n'))
  }
  return rows
}

console.log('\n§1 the words the helper waits for')
{
  check('one helper owns the pattern (scripts/lib/bootFace.ts)', helper !== null && typeof helper.BOOT_FACE_READY === 'string' && typeof helper.paintsBootFaceReady === 'function' && typeof helper.arenaBootFacePass === 'function')
  for (const [label, line, expected] of [
    ['the lockup with the menu key', '>_ ready  ·  ↵ start  ·  m menu  ·  ↑↓ choose', true],
    ['the lockup without it', '>_ ready  ·  ↵ start  ·  ↑↓ choose', true],
    ['the lockup on a row that opens', '>_ ready  ·  ↵ open  ·  m menu  ·  ↑↓ choose', true],
    ['the compact face', '│ ↵ start · ↑↓ choose · m menu │', true],
    ['the same words with their gaps skipped by the painter', '>_ready·↵start·↑↓choose', true],
    ['the face before its card is up', '>_ ready  ·  ↵ start', false],
    ["the board's SESSIONS legend", '↑↓ choose · ↵ enter · n new · p pause', false],
    ['a permission card', '↑↓ choose · ↵ confirm · esc cancel · tab amend', false],
    ['the contract card', '↑↓ choose · ↵ confirm · esc starts it plain', false],
    ['a setup card', '↑↓ choose · ↵ pick · esc keeps your model', false],
  ] as const) check(`${label}: ${expected ? 'fires' : 'does not fire'}`, fires(line) === expected, line)
}

console.log('\n§2 every stored frame and every legend in the tree')
{
  const frames = [
    ...filesUnder(join(ROOT, 'design-system', 'live', 'grids'), path => path.endsWith('.json')),
    ...filesUnder(join(ROOT, 'scripts'), path => /\.(?:txt|json|ans)$/.test(path) && (path.includes('/fixtures/') || /frames[^/]*\.json$/.test(path))),
  ]
  const stored = frames.flatMap(path => rowsOf(path).filter(line => NEEDLE_LOOSE.test(line)).map(line => ({ path: relative(ROOT, path), line })))
  const face = stored.filter(row => isBootFaceLine(row.line))
  const other = stored.filter(row => !isBootFaceLine(row.line))
  check(`the stored frames hold both kinds of line, so the next two checks have something to read (${face.length} Boot face, ${other.length} other, ${frames.length} files)`, face.length >= 5 && other.length >= 10, `${face.length} / ${other.length}`)
  const missed = face.filter(row => !fires(row.line))
  check('every stored Boot face ready line with its card up is one the helper fires on', missed.length === 0, missed.map(row => `${row.path}: ${row.line.trim()}`).join(' · '))
  const strays = other.filter(row => fires(row.line))
  check('no other stored line fires it: a board legend, a permission card, a commit card', strays.length === 0, strays.map(row => `${row.path}: ${row.line.trim()}`).join(' · '))
  const legends = filesUnder(join(ROOT, 'src'), path => /\.tsx?$/.test(path)).flatMap(path => readFileSync(path, 'utf8').split('\n').filter(line => line.includes(NEEDLE)).map(line => ({ path: relative(ROOT, path), line })))
  const firing = legends.filter(row => fires(row.line))
  check(`no legend written in src fires it (${legends.length} lines spell ${NEEDLE})`, legends.length >= 8 && firing.length === 0, firing.map(row => `${row.path}: ${row.line.trim()}`).join(' · '))
}

console.log('\n§3 the harnesses under scripts')
{
  const scripts = filesUnder(join(ROOT, 'scripts'), path => /\.(?:ts|tsx|mjs|py|sh)$/.test(path) && !path.includes('/fixtures/')).map(path => ({ rel: relative(ROOT, path), text: readFileSync(path, 'utf8') })).filter(file => file.rel !== SELF)
  const typescript = scripts.filter(file => /\.tsx?$/.test(file.rel))
  const isProof = (rel: string): boolean => /^(?:prove|drive|bench|measure|probe|capture)-/.test(basename(rel))
  const harnesses = typescript.filter(file => !isProof(file.rel) && file.text.includes('ptydrive.py') && file.text.includes("'--send'"))
  check(`the harnesses that hand sends to a pty driver are found (${harnesses.map(file => file.rel).join(', ')})`, harnesses.some(file => file.rel === 'scripts/streaming/artifactArena.ts') && harnesses.some(file => file.rel === 'scripts/render-continuity/lib/pulseArena.ts'))
  const CALLER_SEND = /for \(const s of opts\.sends\) (?:if \(typeof s === 'string'\) )?sendArgs\.push\('--send', s\)/
  const ownSends = harnesses.flatMap(file => file.text.split('\n').filter(line => line.includes("'--send'") && !CALLER_SEND.test(line)).map(line => `${file.rel}: ${line.trim()}`))
  check("every '--send' a harness passes is one the proof wrote", ownSends.length === 0, ownSends.join(' · '))
  const passFlag = ['--arena', 'send'].join('-')
  const passers = typescript.filter(file => file.text.includes(passFlag)).map(file => file.rel)
  check('a send a harness adds on its own has one door, and the helper alone holds it', passers.length === 1 && passers[0] === 'scripts/lib/bootFace.ts', passers.join(', '))
  const viaHelper = harnesses.filter(file => /\.\.\.arenaBootFacePass\(\)/.test(file.text)).map(file => file.rel)
  check('the two arenas pass the Boot face through that helper', viaHelper.includes('scripts/streaming/artifactArena.ts') && viaHelper.includes('scripts/render-continuity/lib/pulseArena.ts'), viaHelper.join(', '))
  const logs = harnesses.filter(file => file.text.includes('sendLog'))
  const underived = logs.filter(file => !file.text.includes('sendsByAuthor(') || !/^\s+sends,$/m.test(file.text) || !/^\s+sent,$/m.test(file.text)).map(file => file.rel)
  check(`a harness that keeps a send log returns the whole log beside it, split by the author mark (${logs.length} keep one)`, logs.length >= 2 && underived.length === 0, underived.join(', '))
  const drives = typescript.filter(file => file.text.includes('ptydrive.py') || /from '[^']*(?:artifactArena|pulseArena)\.ts'/.test(file.text))
  const dropped = drives.flatMap(file => file.text.split('\n').filter(line => /\.after\s*!==/.test(line)).map(line => `${file.rel}: ${line.trim().slice(0, 120)}`))
  check(`no reader of a pty drive's log drops a send by the words it waited for (${drives.length} files read)`, drives.length >= 80 && dropped.length === 0, dropped.join(' · '))
  const spelled = scripts.flatMap(file => file.text.split('\n').filter(line => line.includes(`after:${NEEDLE}`)).map(line => `${file.rel}: ${line.trim().slice(0, 100)}`))
  const held = harnesses.flatMap(file => file.text.split('\n').filter(line => line.includes(NEEDLE)).map(line => `${file.rel}: ${line.trim().slice(0, 100)}`))
  check(`no harness holds the bare ${NEEDLE}, which four kinds of screen paint, and no script spells a pty send that waits on it`, spelled.length === 0 && held.length === 0, [...held, ...spelled].join(' · '))
}

console.log(`\nprove-harness-sends: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
