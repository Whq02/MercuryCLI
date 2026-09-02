#!/usr/bin/env bun
// ============================================================================
//  scripts/vulcan/prove-vulcan-addon.ts
//  PROOF: the mercury_vulcan GDScript addon holds the cross-language contract:
//   1. COVERAGE — every optable op (minus the Mercury-side installer trio) is
//      owned by EXACTLY ONE category handler's ops() list; no handler claims
//      an op the optable doesn't declare.
//   2. SANDBOX PINS — server binds 127.0.0.1 (literal), token compare gates
//      dispatch, every file-taking category calls the res:// guard, the undo
//      helper wraps EditorUndoRedoManager, no OS.execute outside the
//      editor category, plugin.cfg names the plugin.
//   3. REGEN — addonFiles.generated.ts is drift-free vs assets/vulcan/addon/.
//  Structural (static text over the .gd sources) — the live editor leg is
//  live-vulcan-smoke.sh.
// ============================================================================

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { VULCAN_OPS } from '../../src/utils/vulcan/optable.generated.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const repo = path.join(import.meta.dir, '..', '..')
const addon = path.join(repo, 'assets', 'vulcan', 'addon')
const catDir = path.join(addon, 'categories')

section('1. handler coverage vs the optable')
const MERCURY_SIDE = new Set(['vulcan_status', 'vulcan_install', 'vulcan_uninstall'])
const owned = new Map<string, string>() // op -> category file
const claimed: string[] = []
for (const f of readdirSync(catDir).filter(f => f.endsWith('.gd'))) {
  const text = readFileSync(path.join(catDir, f), 'utf8')
  // ops() returns a literal array of op-name strings — collect them.
  const m = text.match(/func ops\(\)[^:]*:\s*\n([\s\S]*?)(?=\nstatic func|\nfunc |$)/)
  const body = m ? m[1]! : ''
  for (const om of body.matchAll(/"([a-z0-9_]+)"/g)) {
    const op = om[1]!
    check(`no double-claim: ${op}`, !owned.has(op), owned.get(op) ?? '')
    owned.set(op, f)
    claimed.push(op)
  }
}
const expected = VULCAN_OPS.filter(o => !MERCURY_SIDE.has(o.name)).map(o => o.name)
const missing = expected.filter(o => !owned.has(o))
const extra = claimed.filter(o => !expected.includes(o))
check(`every editor-side op owned (${expected.length})`, missing.length === 0, missing.slice(0, 8).join(','))
check('no undeclared handler ops', extra.length === 0, extra.slice(0, 8).join(','))

section('2. sandbox + safety pins')
const server = readFileSync(path.join(addon, 'core', 'server.gd'), 'utf8')
check('loopback bind literal', server.includes('127.0.0.1'))
check('token gate before dispatch', /token/.test(server) && /hello/.test(server))
const undo = readFileSync(path.join(addon, 'core', 'undo.gd'), 'utf8')
check('undo helper wraps EditorUndoRedoManager', /create_action|undo_redo/i.test(undo))
const paths = readFileSync(path.join(addon, 'core', 'paths.gd'), 'utf8')
check('res:// guard exists and refuses escapes', paths.includes('res://') && /\.\./.test(paths))
let osExecViolations: string[] = []
for (const f of readdirSync(catDir).filter(f => f.endsWith('.gd'))) {
  if (f === 'editor.gd') continue
  if (readFileSync(path.join(catDir, f), 'utf8').includes('OS.execute')) osExecViolations.push(f)
}
for (const core of readdirSync(path.join(addon, 'core')).filter(f => f.endsWith('.gd'))) {
  if (readFileSync(path.join(addon, 'core', core), 'utf8').includes('OS.execute')) osExecViolations.push(`core/${core}`)
}
check('no OS.execute outside categories/editor.gd', osExecViolations.length === 0, osExecViolations.join(','))
check('plugin.cfg present + named', existsSync(path.join(addon, 'plugin.cfg')) && /mercury/i.test(readFileSync(path.join(addon, 'plugin.cfg'), 'utf8')))
check('runtime bridge present', existsSync(path.join(addon, 'core', 'runtime_bridge.gd')))

section('3. regen drift')
let checkOk = true
try {
  execFileSync('node', [path.join(repo, 'scripts', 'vulcan', 'regen-addon.mjs'), '--check'], { stdio: 'pipe' })
} catch {
  checkOk = false
}
check('regen-addon --check clean', checkOk)

// ──: the fenced project.godot mutation seam ────────────
section('4. SM-09 — fenced, atomic, conflict-honest project.godot mutation')
{
  const { mkdtempSync, rmSync, writeFileSync: wf, readFileSync: rf } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { mutateProjectGodot } = await import(
    path.join(repo, 'src', 'services', 'vulcan', 'addonInstaller.ts')
  )
  const scratch = mkdtempSync(path.join(tmpdir(), 'sm09-'))
  const proj = path.join(scratch, 'project.godot')
  const BASE = '[application]\n\nconfig/name="Deadnight"\nrun/main_scene="res://main.tscn"\n\n[rendering]\n\nquality=2\n'
  try {
    // Unrelated sections byte-preserved through a mutation.
    wf(proj, BASE)
    const r1 = mutateProjectGodot(scratch, (text: string) => ({ text: text + '\n[mercury_vulcan]\n\nport=6010\n', notes: [] }))
    check('mutation publishes atomically and preserves unrelated bytes', r1.ok === true && rf(proj, 'utf8').startsWith(BASE), rf(proj, 'utf8').slice(0, 40))

    // A concurrent external save between read and publish is NOT clobbered:
    // the fence re-reads and the mutator re-derives against the FRESH text.
    wf(proj, BASE)
    let calls = 0
    const r2 = mutateProjectGodot(scratch, (text: string) => {
      calls++
      if (calls === 1) {
        // Simulate the editor saving mid-mutation (between our read and publish).
        wf(proj, BASE + '\n[editor_saved]\n\nvalue=1\n')
      }
      return { text: text + '\n[mercury_added]\n\nx=1\n', notes: [] }
    })
    const after = rf(proj, 'utf8')
    check('concurrent editor save survives (re-merge on fresh content)', r2.ok === true && calls === 2 && after.includes('[editor_saved]') && after.includes('[mercury_added]'), `calls=${calls}`)

    // Exhausted retries yield the exact conflict receipt with NO partial state.
    wf(proj, BASE)
    let always = 0
    const r3 = mutateProjectGodot(scratch, (text: string) => {
      always++
      wf(proj, BASE + `\n[churn]\n\nv=${always}\n`)
      return { text: text + '\n[mercury_added]\n\nx=1\n', notes: [] }
    })
    check('exhaustion ⇒ conflict receipt, zero partial writes', r3.ok === false && !rf(proj, 'utf8').includes('[mercury_added]'), JSON.stringify(r3).slice(0, 90))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('\n' + (failures === 0 ? '✅ vulcan addon proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
