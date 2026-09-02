#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-keybinding-ga.ts — keybinding customization is
//  Mercury-owned and generally available, and
//  the passthrough journey is REACHABLE in the product.
//
//  The guarded gaps, per section: availability hanging off an
//  analytics gate (external users never load user bindings), no project
//  layer, and a space-unbind journey that cannot be driven
//  because the loader refuses the file that carries it.
//
//    §1  the gate is retired — availability is unconditional and the loader
//        imports no analytics machinery;
//    §2  the user layer loads through the real loader (scratch config home);
//    §3  the PROJECT layer loads through Mercury's project-config seam and
//        overrides the user layer (.mercury wins);
//    §4  REAL BINARY: a user file null-unbinding space boots the product and
//        Space TYPES — the contract, end to end in the shipped app.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'mercury-kb-ga-'))

t.section('§1 — the pre-fork analytics gate is retired')
{
  const src = readFileSync('src/keybindings/loadUserBindings.ts', 'utf8')
  t.check('no growthbook import remains', !src.includes('growthbook'), 'analytics dependency gone')
  t.check('no analytics event logging remains', !src.includes('logEvent'), 'telemetry gone')
  t.check(
    'config routes through the project-config seam',
    src.includes("resolveProjectConfigPath") && src.includes("projectConfigDirs"),
    'src/utils/projectConfig.ts',
  )
}

t.section('§2 + §3 — user layer + project layer through the REAL loader')
{
  // Env must be pinned BEFORE the module loads (config home is read lazily
  // but cwd/state modules snapshot at import) — drive a bun CHILD with the
  // scratch homes so the prover itself stays env-clean.
  const home = join(scratch, 'home')
  const proj = join(scratch, 'proj')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(proj, '.mercury'), { recursive: true })
  writeFileSync(
    join(home, 'keybindings.json'),
    JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+t': 'chat:userlayer' } }] }),
  )
  writeFileSync(
    join(proj, '.mercury', 'keybindings.json'),
    JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'ctrl+t': 'chat:projectlayer' } }] }),
  )
  const driver = join(scratch, 'driver.ts')
  writeFileSync(
    driver,
    `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
const { loadKeybindingsSyncWithWarnings, isKeybindingCustomizationEnabled, getProjectKeybindingsPath } =
  await import('${join(process.cwd(), 'src/keybindings/loadUserBindings.ts')}')
const { resolveKey } = await import('${join(process.cwd(), 'src/keybindings/resolver.ts')}')
const r = loadKeybindingsSyncWithWarnings()
const key = { ctrl: true, meta: false, shift: false, super: false } as never
const hit = resolveKey('t', key, ['Chat', 'Global'], r.bindings)
console.log(JSON.stringify({
  enabled: isKeybindingCustomizationEnabled(),
  projectPath: getProjectKeybindingsPath(),
  resolved: hit,
  warnings: r.warnings.length,
}))`,
  )
  const r = spawnSync(process.execPath, ['run', driver], {
    cwd: proj,
    env: { ...process.env, MERCURY_CONFIG_DIR: home },
    encoding: 'utf8',
    timeout: vshotBudgetMs(60_000),
  })
  let out: { enabled?: boolean; projectPath?: string | null; resolved?: { type: string; action?: string }; warnings?: number } = {}
  try {
    out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    /* fall through to failing checks */
  }
  t.check('availability is unconditional', out.enabled === true, String(out.enabled))
  t.check(
    'the project file resolves through .mercury',
    (out.projectPath ?? '').includes(join('.mercury', 'keybindings.json')),
    out.projectPath ?? 'null',
  )
  t.check(
    'the PROJECT layer overrides the user layer (last wins)',
    out.resolved?.type === 'match' && out.resolved.action === 'chat:projectlayer',
    JSON.stringify(out.resolved),
  )
}

t.section('§4 — REAL BINARY: null-unbound Space TYPES (the HZ-02 journey)')
{
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const home = join(scratch, 'pty-home')
    const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-kb-ga'
    spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
      env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
    })
    // The user file that would otherwise make Space a dead key: null-unbind the
    // hold-to-talk binding.
    writeFileSync(
      join(home, 'keybindings.json'),
      JSON.stringify({ bindings: [{ context: 'Chat', bindings: { space: null } }] }),
    )
    const out = join(scratch, 'g.json')
    const cfg = {
      cols: 100, rows: 30, total: 200,
      argv: ['node', BIN], out, cwd: process.cwd(),
      // DISCRETE keystrokes, deliberately. Sending "a b" as one burst proves
      // nothing about the unbind: a 3-character chunk has no keystroke to
      // resolve (getKeyName returns null above length 1), so it reaches the
      // editor whatever the keybinding layer decides. The Space must arrive on
      // its own to meet the resolver — and it did NOT survive that until
      // ChordInterceptor learned the same passthrough rule as the hooks.
      sends: [
        // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
        { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { atTick: 60, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: 'a' },
        { afterPrevTicks: 3, atTick: 80, awaitText: '❯ a', minTick: 3, awaitSettleTicks: 2, data: ' ' },
        { afterPrevTicks: 3, atTick: 100, data: 'b' },
      ],
      readyText: 'a b', readySettleTicks: 3,
    }
    const cfgPath = join(scratch, 'c.json')
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: FIXTURE_KEY,
        MERCURY_BOOT_PREFLIGHT: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
        MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      },
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
    })
    let text = ''
    try {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
      text = payload.grid.map(row => row.map(c => c.c).join('')).join('\n')
    } catch {
      /* empty */
    }
    t.check(
      'the composer shows "a b" — the null-unbound Space typed a space',
      r.status === 0 && text.includes('a b'),
      `exit=${r.status} (pre-fix: NEVER-READY — Space was swallowed and the needle read "ab")`,
    )
    t.check('no dead-key artifact "ab" row without the space', !text.includes('❯ ab'), 'ok')
  }
}

t.section('§5 — a syntactically broken keybindings.json cannot kill the product')
{
  // The loader's promise is "a broken layer degrades to ABSENT, never
  // poisons the merge" — and it runs inside a React useState initializer at
  // boot, so the promise has to hold for INVALID JSON too, not only for
  // valid-JSON-wrong-shape. Found in the re-audit: jsonParse threw
  // straight through parseLayer and a hand-mangled config file was a dead
  // product at next boot.
  const home = join(scratch, 'broken-home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'keybindings.json'), '{ this is not json')
  const driver = join(scratch, 'broken-driver.ts')
  writeFileSync(
    driver,
    `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
const { loadKeybindingsSyncWithWarnings } =
  await import('${join(process.cwd(), 'src/keybindings/loadUserBindings.ts')}')
const r = loadKeybindingsSyncWithWarnings()
console.log(JSON.stringify({
  loaded: true,
  parseErrors: r.warnings.filter(w => w.type === 'parse_error').length,
  bindingCount: r.bindings.length,
}))`,
  )
  const r = spawnSync(process.execPath, ['run', driver], {
    env: { ...process.env, MERCURY_CONFIG_DIR: home },
    encoding: 'utf8',
    timeout: vshotBudgetMs(60_000),
  })
  let out: { loaded?: boolean; parseErrors?: number; bindingCount?: number } = {}
  try {
    out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    /* fall through */
  }
  t.check(
    'the loader survives invalid JSON instead of throwing at boot',
    out.loaded === true,
    `exit=${r.status} stderr: ${(r.stderr ?? '').slice(-200)}`,
  )
  t.check('and says WHY as a parse_error warning', (out.parseErrors ?? 0) >= 1, `${out.parseErrors}`)
  t.check(
    'defaults still resolve — the broken layer is ABSENT, not poisonous',
    (out.bindingCount ?? 0) > 50,
    `${out.bindingCount} bindings`,
  )

  // And the SHIPPED BINARY boots with that file in place: pre-fix this is
  // NEVER-READY (the SyntaxError escaped a useState initializer at first
  // render).
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const bootHome = join(scratch, 'broken-boot-home')
    const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-kb-ga'
    spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', bootHome, process.cwd()], {
      env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
    })
    writeFileSync(join(bootHome, 'keybindings.json'), '{ this is not json')
    const out2 = join(scratch, 'broken-boot.json')
    const cfgPath2 = join(scratch, 'broken-boot-cfg.json')
    writeFileSync(
      cfgPath2,
      JSON.stringify({
        cols: 100, rows: 30, total: 160,
        argv: ['node', BIN], out: out2, cwd: process.cwd(),
        sends: [
          // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
          { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
          { atTick: 60, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: 'ok' },
        ],
        readyText: '❯ ok', readySettleTicks: 3,
      }),
    )
    const r2 = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath2], {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: bootHome,
        ANTHROPIC_API_KEY: FIXTURE_KEY,
        MERCURY_BOOT_PREFLIGHT: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor-broken'),
        MERCURY_DAEMON_DIR: join(scratch, 'daemon-broken'),
      },
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
    })
    t.check(
      'the product boots and types with the broken file in place',
      r2.status === 0,
      `exit=${r2.status} (pre-fix: SyntaxError at first render, NEVER-READY)`,
    )
  }
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-keybinding-ga')
