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
      if ((names.has('awaitText') || names.has('awaitRaw')) && !names.has('requireAwait') && !names.has('atTick') && !names.has('afterPrevTicks') && !spread) {
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

console.log(failures === 0 ? '\nvshot send hygiene: GREEN' : `\nvshot send hygiene: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
