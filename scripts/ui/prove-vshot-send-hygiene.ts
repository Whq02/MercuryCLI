#!/usr/bin/env bun
import * as ts from 'typescript'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { resolveCaptureDriver } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

type Hit = { file: string; line: number; text: string }
const OBSERVED_WALK_KEYS = ['text', 'awaitAbsent', 'arrivedText', 'arrivedAbsent', 'targetHeader', 'afterPrevMs']
export function blindAwaitSends(src: string, file: string): Hit[] {
  const hits: Hit[] = []
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const names = new Set<string>()
      let spread = false
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) names.add(p.name.getText(sf).replace(/^['"]|['"]$/g, ''))
        else if (ts.isSpreadAssignment(p)) spread = true
      }
      const observedWalk = !names.has('data') && OBSERVED_WALK_KEYS.some(k => names.has(k))
      if ((names.has('awaitText') || names.has('awaitRaw')) && !names.has('requireAwait') && !names.has('atTick') && !names.has('afterPrevTicks') && !spread && !observedWalk) {
        hits.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf).replace(/\s+/g, ' ').slice(0, 120) })
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

const files: string[] = []
const walk = (d: string): void => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx)$/.test(e)) files.push(p)
  }
}
walk(join(REPO, 'scripts'))

console.log('§1 the ratchet: no blind await send under scripts/')
const hits: Hit[] = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  if (!/awaitText|awaitRaw/.test(src)) continue
  for (const h of blindAwaitSends(src, f)) hits.push({ ...h, file: relative(REPO, f) })
}
for (const h of hits) console.log(`    ${h.file}:${h.line} ${h.text}`)
check(`every awaitText/awaitRaw send carries requireAwait or an explicit deadline (${files.length} files walked)`, hits.length === 0, `${hits.length} blind send(s)`)

console.log('§2 the poison: a bare awaitText literal is flagged')
const poison = `const sends = [\n  { data: '\\t', awaitText: 'SESSIONS', awaitSettleTicks: 2 },\n  { data: 's', afterPrevTicks: 2, mark: 'x' },\n  { data: '', awaitText: 'FOCUSED CHAT', requireAwait: true, mark: 'y' },\n  { atTick: 40, awaitText: 'gate', data: '\\r' },\n]\n`
const flagged = blindAwaitSends(poison, 'poison.ts')
check('exactly the bare literal is flagged (requireAwait and an atTick deadline both pass)', flagged.length === 1 && flagged[0]!.line === 2, JSON.stringify(flagged))
const walkSteps = `const sends = [\n  { awaitText: 'SESSION CONCOURSE', targetHeader: 'STATUS & TITLE', targetText: 'CMA Alpha' },\n  { awaitText: ['alpha-live body', 'Type a prompt'], awaitAbsent: 'SESSION CONCOURSE', text: '\\x1b[1;2D' },\n  { awaitText: 'Boot Settings opened', text: '' },\n  { awaitText: 'Type a prompt', data: '', text: '' },\n]\n`
const walkFlagged = blindAwaitSends(walkSteps, 'walk.ts')
check("an observed-walk step (a text payload, the walk's own gate keys, no data) is not a vshot send; a literal carrying data is read as one", walkFlagged.length === 1 && walkFlagged[0]!.line === 5, JSON.stringify(walkFlagged))

console.log('§3 the live-seat rule: a board with a live seat refuses whole-grid stability gates by name')
{
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') {
    check(`the POSIX capture engine is on this host (${driver.kind}) — the rule's refusal cannot be driven here`, false)
  } else {
    const scratch = mkdtempSync(join(tmpdir(), 'vshot-live-seat-'))
    const run = (name: string, cfg: Record<string, unknown>): { status: number | null; stderr: string } => {
      const cfgPath = join(scratch, `${name}.json`)
      writeFileSync(cfgPath, JSON.stringify({ argv: ['true'], cols: 20, rows: 4, total: 2, out: join(scratch, `${name}.grid.json`), ...cfg }))
      const r = spawnSync(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, VSHOT_SLOTS: '0' } })
      return { status: r.status, stderr: r.stderr ?? '' }
    }
    const spoken = (r: { stderr: string }): boolean => r.stderr.includes('LIVE-SEAT-STABILITY')
    const whole = run('whole-grid-send', { liveSeat: true, sends: [{ requireAwait: true, awaitText: 'x', awaitStableTicks: 2, data: '' }] })
    check('a live-seat board refuses a send gated on whole-grid stability, by name (exit 7)', whole.status === 7 && spoken(whole), `exit ${whole.status}: ${whole.stderr.slice(0, 200)}`)
    const end = run('whole-grid-end', { liveSeat: true, requireStable: true, stableTicks: 2 })
    check('…and a capture that requires whole-grid stability of itself (exit 7)', end.status === 7 && spoken(end), `exit ${end.status}: ${end.stderr.slice(0, 200)}`)
    const region = run('region-send', { liveSeat: true, sends: [{ requireAwait: true, awaitText: 'x', awaitStableTicks: 2, awaitStableRegion: [0, 0, 10, 2], data: '' }] })
    check('a send that names its region passes the rule', region.status !== 7 && !spoken(region), `exit ${region.status}: ${region.stderr.slice(0, 200)}`)
    const settle = run('settle-send', { liveSeat: true, sends: [{ requireAwait: true, awaitText: 'x', awaitSettleTicks: 2, data: '' }] })
    check('a send gated on settle ticks passes the rule', settle.status !== 7 && !spoken(settle), `exit ${settle.status}: ${settle.stderr.slice(0, 200)}`)
    const plain = run('plain-board', { sends: [{ requireAwait: true, awaitText: 'x', awaitStableTicks: 2, data: '' }] })
    check('a board that declares no live seat keeps its whole-grid gates (the rule is declared, never guessed)', plain.status !== 7 && !spoken(plain), `exit ${plain.status}: ${plain.stderr.slice(0, 200)}`)
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('§4 the held key: a strict send repeats its bytes on the clock until its needle paints, then fires once')
{
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') {
    check(`the POSIX capture engine is on this host (${driver.kind}) — the held key cannot be driven here`, false)
  } else {
    const scratch = mkdtempSync(join(tmpdir(), 'vshot-held-key-'))
    const echoThenNeedle = ['python3', '-u', '-c', "import os, select, sys, time\nt = time.monotonic()\nwhile time.monotonic() - t < 1.5:\n    r, _, _ = select.select([0], [], [], 0.05)\n    if r:\n        os.read(0, 64)\nsys.stdout.write('NEEDLE\\n')\nsys.stdout.flush()\nt = time.monotonic()\nwhile time.monotonic() - t < 1.0:\n    r, _, _ = select.select([0], [], [], 0.05)\n    if r:\n        os.read(0, 64)\n"]
    const run = (name: string, cfg: Record<string, unknown>): { status: number | null; stderr: string; payload: Record<string, unknown> | null } => {
      const cfgPath = join(scratch, `${name}.json`)
      const out = join(scratch, `${name}.grid.json`)
      writeFileSync(cfgPath, JSON.stringify({ argv: echoThenNeedle, cols: 40, rows: 6, total: 25, out, ...cfg }))
      const r = spawnSync(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, VSHOT_SLOTS: '0', MERCURY_VSHOT_BUDGET_SCALE: '1' } })
      let payload: Record<string, unknown> | null = null
      try { payload = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown> } catch { payload = null }
      return { status: r.status, stderr: r.stderr ?? '', payload }
    }
    const held = run('held-key', { sends: [{ atTick: 1, data: 'k' }, { requireAwait: true, awaitText: 'NEEDLE', repeatEveryTicks: 2, mark: 'seen', data: 'k' }] })
    const repeats = (held.payload?.holdRepeats as Array<{ send: number; atTick: number }> | undefined) ?? []
    const receipts = (held.payload?.sendReceipts as Array<{ atTick: number }> | undefined) ?? []
    const marks = (held.payload?.marks as Array<{ label: string; atTick: number; grid: Array<Array<{ c: string }>> }> | undefined) ?? []
    const gaps = repeats.map((r, i) => r.atTick - (i === 0 ? receipts[0]?.atTick ?? 0 : repeats[i - 1]!.atTick))
    check('the held key delivered both sends and ended on the needle (exit 0, two receipts, the mark fired)', held.status === 0 && receipts.length === 2 && marks.length === 1 && marks[0]!.label === 'seen', `exit ${held.status}; receipts ${JSON.stringify(receipts)}; marks ${marks.map(m => m.label).join(',')}; ${held.stderr.slice(0, 200)}`)
    check('the key repeated on the clock while the needle was absent (the child paints it 1.5 s in: at least 3 repeats, each 2 ticks apart)', repeats.length >= 3 && repeats.every(r => r.send === 1) && gaps.every(g => g === 2), `repeats ${JSON.stringify(repeats)} gaps ${JSON.stringify(gaps)}`)
    const firedAt = receipts[1]?.atTick ?? -1
    check('no repeat came after the fire, and the fire came on the needle, not the clock', repeats.every(r => r.atTick <= firedAt) && marks[0] !== undefined && marks[0].grid.some(row => row.map(c => c.c).join('').includes('NEEDLE')), `fired at tick ${firedAt}; last repeat ${repeats.at(-1)?.atTick}`)
    check('the repeats are not receipts: sendReceipts counts the sends alone', receipts.length === 2 && repeats.length > 0, `${receipts.length} receipts, ${repeats.length} repeats`)
    const refusedShape = (cfg: Record<string, unknown>, name: string): { status: number | null; stderr: string } => {
      const cfgPath = join(scratch, `${name}.json`)
      writeFileSync(cfgPath, JSON.stringify({ argv: ['true'], cols: 20, rows: 4, total: 2, out: join(scratch, `${name}.grid.json`), ...cfg }))
      const r = spawnSync(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, VSHOT_SLOTS: '0' } })
      return { status: r.status, stderr: r.stderr ?? '' }
    }
    const clockEnded = refusedShape({ sends: [{ afterPrevTicks: 12, awaitText: 'x', repeatEveryTicks: 2, data: ' ' }] }, 'clock-ended-hold')
    check('a held key whose send ends on a clock deadline is refused by name before the child boots (BLIND-REPEAT, exit 8)', clockEnded.status === 8 && clockEnded.stderr.includes('BLIND-REPEAT'), `exit ${clockEnded.status}: ${clockEnded.stderr.slice(0, 200)}`)
    const needleless = refusedShape({ sends: [{ requireAwait: true, repeatEveryTicks: 2, data: ' ' }] }, 'needleless-hold')
    check('…and a strict held key with no needle to end on (exit 8)', needleless.status === 8 && needleless.stderr.includes('BLIND-REPEAT'), `exit ${needleless.status}: ${needleless.stderr.slice(0, 200)}`)
    const plainStrict = refusedShape({ sends: [{ requireAwait: true, awaitText: 'x', data: ' ' }] }, 'plain-strict')
    check('a strict send without the held key is untouched by the rule', plainStrict.status !== 8 && !plainStrict.stderr.includes('BLIND-REPEAT'), `exit ${plainStrict.status}: ${plainStrict.stderr.slice(0, 200)}`)
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nvshot send hygiene: GREEN' : `\nvshot send hygiene: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
