#!/usr/bin/env bun
// ============================================================================
//  scripts/aseprite/prove-aseprite-tool.ts
//  PROOF: the `Aseprite` tool's grammar against a FAKE aseprite (an sh shim
//  recording argv and answering canned output) — no real app anywhere.
//
//   §1  permission classes: status/info allow (reads) · export asks naming
//       source → destination(s) · create asks naming the file + dimensions
//       · run-script asks ALWAYS carrying byte count + first line.
//   §2  tool identity: capability declaration structurally valid, ops match
//       the schema enum, the gate names the registered flag, read/
//       concurrency probes honest.
//   §3  unavailable teaching: nothing resolved ⇒ every op answers the
//       install roads by name, status carries the full verdict.
//   §4  argv truth (the shim records): the -b law on every run · export
//       composition order (selection flags → file → --scale → --save-as /
//       the sheet block) · info rides the bundled probe via --script ·
//       create rides --script-param before --script · run-script carries
//       params and the sprite file · fence refusals for out-of-tree paths ·
//       arg-shape teaching (dataFormat without dataOutput, bad create
//       dimensions, missing source) · lua temp dirs cleaned.
//   §5  result honesty: an export whose bytes never landed SAYS so; one
//       whose file landed carries its byte count; provenance names the
//       version and the resolution rung.
//
//  Run:  ~/.bun/bin/bun run scripts/aseprite/prove-aseprite-tool.ts
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Aseprite tool grammar — proof (shim-driven, hermetic)')
console.log('============================================================')

const { AsepriteTool } = await import('../../src/tools/AsepriteTool/AsepriteTool.ts')
const { validateToolCapability } = await import('../../src/utils/capability/contract.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const { _resetAsepriteVersionProbeForTesting } = await import('../../src/services/aseprite/asepriteApp.ts')

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  delete process.env.MERCURY_ASEPRITE
  delete process.env.MERCURY_ASEPRITE_BIN
  process.env.MERCURY_ASEPRITE_NO_DISCOVERY = '1' // ambient installs stay out
  _resetAsepriteVersionProbeForTesting()
}

const scratch = mkdtempSync(path.join(tmpdir(), 'ase-tool-'))
const tree = path.join(scratch, 'tree')
mkdirSync(tree, { recursive: true })
// The fence realpaths every path (symlinked tmp roots included) — the
// expectations must speak the same spelling.
const treeReal = realpathSync(tree)
writeFileSync(path.join(tree, 'hero.aseprite'), '')
const argvLog = path.join(scratch, 'argv.log')

/** The canned shim: --version answers a version line; -b runs append their
 *  argv to the log (one --END-- terminated block per run) and answer one
 *  JSON line (the probe/create parse road). */
const shim = path.join(scratch, 'fake-aseprite')
writeFileSync(
  shim,
  `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Aseprite 9.8.7-fake"; exit 0; fi
printf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}
printf -- '--END--\\n' >> ${JSON.stringify(argvLog)}
echo '{"width":8,"height":8,"colorMode":"rgb","frames":1}'
exit 0
`,
)
chmodSync(shim, 0o755)

/** argv blocks the shim recorded (each an array), oldest first. */
function recordedRuns(): string[][] {
  let raw = ''
  try {
    raw = readFileSync(argvLog, 'utf8')
  } catch {
    return []
  }
  return raw
    .split('--END--\n')
    .map(b => b.split('\n').filter(Boolean))
    .filter(b => b.length > 0)
}
function clearRuns(): void {
  writeFileSync(argvLog, '')
}

type ToolInput = Parameters<typeof AsepriteTool.call>[0]
const ctx = {} as Parameters<typeof AsepriteTool.call>[1]
async function run(input: ToolInput): Promise<string> {
  const { data } = await AsepriteTool.call(input, ctx)
  return data.result
}
async function perm(input: Partial<ToolInput>): Promise<{ behavior: string; message?: string }> {
  return (await AsepriteTool.checkPermissions(input as ToolInput, ctx)) as { behavior: string; message?: string }
}

// ── §1 permission classes ───────────────────────────────────────────────────
section('§1 · permission classes')
{
  restore()
  check('status is allow (a read)', (await perm({ op: 'status' })).behavior === 'allow')
  check('info is allow (a read)', (await perm({ op: 'info', file: 'hero.aseprite' })).behavior === 'allow')
  const exp = await perm({ op: 'export', file: 'hero.aseprite', output: 'out/hero.png', dataOutput: 'out/hero.json', sheetType: 'packed', scale: 2 })
  check('export asks', exp.behavior === 'ask')
  check(
    'export ask names source → destination(s) + options',
    (exp.message ?? '').includes('hero.aseprite') &&
      (exp.message ?? '').includes('out/hero.png') &&
      (exp.message ?? '').includes('out/hero.json') &&
      (exp.message ?? '').includes('sheet packed') &&
      (exp.message ?? '').includes('scale 2'),
    exp.message,
  )
  const cre = await perm({ op: 'create', output: 'art/new.aseprite', width: 32, height: 32, colorMode: 'indexed' })
  check('create asks naming file + dimensions', cre.behavior === 'ask' && (cre.message ?? '').includes('art/new.aseprite') && (cre.message ?? '').includes('32x32 indexed'), cre.message)
  const scr = await perm({ op: 'run-script', source: 'local s = app.activeSprite\nprint(s)' })
  check('run-script asks ALWAYS', scr.behavior === 'ask')
  check(
    'run-script ask carries byte count + first line + the authority sentence',
    (scr.message ?? '').includes('bytes') &&
      (scr.message ?? '').includes('local s = app.activeSprite') &&
      (scr.message ?? '').includes('full script authority'),
    scr.message,
  )
}

// ── §2 tool identity ────────────────────────────────────────────────────────
section('§2 · tool identity + declared capability')
{
  restore()
  check('name is Aseprite', AsepriteTool.name === 'Aseprite')
  const cap = (AsepriteTool as unknown as { capability: unknown }).capability
  const v = validateToolCapability(cap)
  check('capability declaration structurally valid', v.ok, v.problems.join('; '))
  const declaredOps = (cap as { operations: string[] }).operations.slice().sort().join(',')
  check('declared ops match the schema enum', declaredOps === 'create,export,info,run-script,status', declaredOps)
  check('gate names the registered flag', (cap as { gate?: string }).gate === 'MERCURY_ASEPRITE')
  check('proof names this suite', (cap as { proof?: string }).proof === 'scripts/aseprite/run-all.sh')
  check('reads probe read-only', AsepriteTool.isReadOnly({ op: 'status' } as ToolInput) === true && AsepriteTool.isReadOnly({ op: 'info' } as ToolInput) === true)
  check('writers probe mutating', AsepriteTool.isReadOnly({ op: 'export' } as ToolInput) === false && AsepriteTool.isReadOnly({ op: 'run-script' } as ToolInput) === false)
  check(
    'concurrency: reads safe, writers not',
    AsepriteTool.isConcurrencySafe({ op: 'info' } as ToolInput) === true && AsepriteTool.isConcurrencySafe({ op: 'export' } as ToolInput) === false,
  )
  const hint = (AsepriteTool as unknown as { searchHint: string }).searchHint
  check('searchHint speaks the discovery vocabulary', hint.includes('pixel art') && hint.includes('sprite sheet') && hint.includes('lua'), hint)
}

// ── §3 unavailable teaching ─────────────────────────────────────────────────
section('§3 · unavailable teaching (nothing resolves)')
{
  restore()
  await runWithCwdOverride(tree, async () => {
    const status = await run({ op: 'status' } as ToolInput)
    check('status: UNAVAILABLE verdict + roads + remedies', status.includes('UNAVAILABLE') && status.includes('PATH') && status.includes('remedies'), status)
    check('status still censuses the sprite context', status.includes('1 sprite file'), status)
    const info = await run({ op: 'info', file: 'hero.aseprite' } as ToolInput)
    check('info teaches the install roads', info.includes('unavailable') && info.includes('aseprite.org'), info)
    const exp = await run({ op: 'export', file: 'hero.aseprite', output: 'x.png' } as ToolInput)
    check('export teaches too (never a spawn attempt)', exp.includes('unavailable'), exp)
  })
}

// ── §4 argv truth ───────────────────────────────────────────────────────────
section('§4 · argv truth (shim-recorded)')
{
  restore()
  process.env.MERCURY_ASEPRITE_BIN = shim
  await runWithCwdOverride(tree, async () => {
    // export, plain road — the full composed order.
    clearRuns()
    let r = await run({
      op: 'export',
      file: 'hero.aseprite',
      output: 'hero.png',
      scale: 2,
      layer: 'Body',
      tag: 'walk',
      frameRange: '0,3',
      trim: true,
    } as ToolInput)
    let runs = recordedRuns()
    check('export spawned exactly one -b run', runs.length === 1 && runs[0]![0] === '-b', JSON.stringify(runs))
    const plain = runs[0]!.join(' ')
    check(
      'export order: selection → file → --scale → --save-as',
      plain ===
        `-b --layer Body --tag walk --frame-range 0,3 --trim ${path.join(treeReal, 'hero.aseprite')} --scale 2 --save-as ${path.join(treeReal, 'hero.png')}`,
      plain,
    )
    check('export result says when nothing landed', r.includes('NOTHING LANDED'), r)

    // export, sheet road.
    clearRuns()
    r = await run({
      op: 'export',
      file: 'hero.aseprite',
      output: 'sheet.png',
      sheetType: 'rows',
      sheetColumns: 4,
      dataOutput: 'sheet.json',
      ignoreEmpty: true,
    } as ToolInput)
    runs = recordedRuns()
    const sheet = runs[0]!.join(' ')
    check(
      'sheet order: … file → sheet block → --data --format → --sheet',
      sheet ===
        `-b --ignore-empty ${path.join(treeReal, 'hero.aseprite')} --sheet-type rows --sheet-columns 4 --data ${path.join(treeReal, 'sheet.json')} --format json-hash --sheet ${path.join(treeReal, 'sheet.png')}`,
      sheet,
    )

    // info rides the bundled probe.
    clearRuns()
    r = await run({ op: 'info', file: 'hero.aseprite' } as ToolInput)
    runs = recordedRuns()
    const info = runs[0]!
    check(
      'info: -b file --script <tmp probe.lua>',
      info[0] === '-b' && info[1] === path.join(treeReal, 'hero.aseprite') && info[2] === '--script' && (info[3] ?? '').endsWith('program.lua'),
      info.join(' '),
    )
    check('info parses the probe JSON + provenance', r.includes('"width": 8') && r.includes('Aseprite 9.8.7-fake') && r.includes('pin rung'), r)

    // create rides --script-param BEFORE --script.
    clearRuns()
    r = await run({ op: 'create', output: 'born.aseprite', width: 16, height: 24, colorMode: 'gray' } as ToolInput)
    runs = recordedRuns()
    const create = runs[0]!.join(' ')
    check(
      'create: params then --script',
      create ===
        `-b --script-param output=${path.join(treeReal, 'born.aseprite')} --script-param width=16 --script-param height=24 --script-param mode=gray --script ${runs[0]![runs[0]!.length - 1]}`,
      create,
    )

    // run-script carries the sprite + params.
    clearRuns()
    r = await run({ op: 'run-script', source: 'print("hi")', file: 'hero.aseprite', params: { who: 'tester' } } as ToolInput)
    runs = recordedRuns()
    const scr = runs[0]!.join(' ')
    check(
      'run-script: file → params → --script',
      // run-script's file is resolved but NOT fence-realpathed (the ask is
      // its fence) — the raw tree spelling is the honest expectation.
      scr === `-b ${path.join(tree, 'hero.aseprite')} --script-param who=tester --script ${runs[0]![runs[0]!.length - 1]}`,
      scr,
    )

    // fences + teaching.
    clearRuns()
    const out = await run({ op: 'export', file: '../outside.aseprite', output: 'x.png' } as ToolInput)
    check('fence: out-of-tree file refuses naming the tree + the remedy', out.includes('must stay inside the working tree') && out.includes('run-script'), out)
    const outOut = await run({ op: 'export', file: 'hero.aseprite', output: '/tmp/elsewhere.png' } as ToolInput)
    check('fence: out-of-tree output refuses', outOut.includes('must stay inside the working tree'), outOut)
    check('fences refused before any spawn', recordedRuns().length === 0)
    const df = await run({ op: 'export', file: 'hero.aseprite', output: 'x.png', dataFormat: 'json-array' } as ToolInput)
    check('dataFormat without dataOutput teaches', df.includes('dataFormat rides dataOutput'), df)
    const dims = await run({ op: 'create', output: 'x.aseprite', width: 0, height: 5 } as ToolInput)
    check('create refuses bad dimensions', dims.includes('1..65535'), dims)
    const noSrc = await run({ op: 'run-script' } as ToolInput)
    check('run-script without source teaches', noSrc.includes('needs source'), noSrc)

    // lua temp dirs cleaned.
    const leftovers = readdirSync(tmpdir()).filter(n => n.startsWith('mercury-aseprite-'))
    check('lua temp dirs removed after runs', leftovers.length === 0, leftovers.join(', '))
  })
}

// ── §5 landed-bytes honesty ─────────────────────────────────────────────────
section('§5 · landed-bytes honesty')
{
  restore()
  // A writer shim that actually creates the --save-as target.
  const writer = path.join(scratch, 'writer-aseprite')
  writeFileSync(
    writer,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Aseprite 9.8.7-fake"; exit 0; fi
for a in "$@"; do out="$a"; done
printf 'PNGBYTES' > "$out"
exit 0
`,
  )
  chmodSync(writer, 0o755)
  process.env.MERCURY_ASEPRITE_BIN = writer
  await runWithCwdOverride(tree, async () => {
    const r = await run({ op: 'export', file: 'hero.aseprite', output: 'landed.png' } as ToolInput)
    check('landed bytes verified + counted', r.includes('landed.png (8 bytes)'), r)
    check('provenance names version + rung', r.includes('Aseprite 9.8.7-fake') && r.includes('pin rung'), r)
  })
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ ALL CHECKS PASS')
