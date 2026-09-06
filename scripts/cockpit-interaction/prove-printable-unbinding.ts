#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  resolveKey,
  resolveKeyWithChordState,
  unboundConsumes,
} from '../../src/keybindings/resolver.ts'
import { parseBindings } from '../../src/keybindings/parser.ts'
import type { Key } from '../../src/ink.js'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()

const KEY = (over: Partial<Key> = {}): Key =>
  ({ ctrl: false, meta: false, shift: false, super: false, escape: false, return: false, tab: false, backspace: false, delete: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageUp: false, pageDown: false, wheelUp: false, wheelDown: false, home: false, end: false, ...over }) as Key

t.section('§1 — the decision table')
{
  t.check('space passes through', unboundConsumes(' ', KEY()) === false, 'Space types again')
  t.check('a printable letter passes through', unboundConsumes('a', KEY()) === false, 'a')
  t.check('shifted printable passes through', unboundConsumes('A', KEY({ shift: true })) === false, 'A')
  t.check('a pasted printable burst passes through', unboundConsumes('ab c', KEY()) === false, 'multi-char')
  t.check('wide/CJK printable passes through', unboundConsumes('漢', KEY()) === false, 'CJK')
  t.check('ctrl chord stays consumed', unboundConsumes(' ', KEY({ ctrl: true })) === true, 'ctrl+space')
  t.check('meta chord stays consumed', unboundConsumes('x', KEY({ meta: true })) === true, 'meta+x')
  t.check('empty input (named key) stays consumed', unboundConsumes('', KEY({ escape: true })) === true, 'escape')
  t.check('carriage return stays consumed', unboundConsumes('\r', KEY({ return: true })) === true, 'enter')
  t.check('tab stays consumed', unboundConsumes('\t', KEY({ tab: true })) === true, 'tab')
  t.check('DEL stays consumed', unboundConsumes('\x7f', KEY({ backspace: true })) === true, 'backspace')
}

t.section('§2 — the real parse + resolve path (a user null-unbind of space)')
{
  const bindings = parseBindings([
    { context: 'Chat', bindings: { space: 'voice:pushToTalk' } },
    { context: 'Chat', bindings: { space: null } },
  ] as Parameters<typeof parseBindings>[0])
  const r = resolveKey(' ', KEY(), ['Chat', 'Global'], bindings)
  t.check('the null override resolves to unbound (last wins)', r.type === 'unbound', r.type)
  t.check(
    'and an unbound SPACE is not consumed — it reaches the editor',
    unboundConsumes(' ', KEY()) === false,
    'the pair that fixes the trap',
  )

  const ctrlBindings = parseBindings([
    { context: 'Chat', bindings: { 'ctrl+t': 'app:toggleTasks' } },
    { context: 'Chat', bindings: { 'ctrl+t': null } },
  ] as Parameters<typeof parseBindings>[0])
  const rc = resolveKey('t', KEY({ ctrl: true }), ['Chat', 'Global'], ctrlBindings)
  t.check('a null-unbound modifier chord still resolves unbound', rc.type === 'unbound', rc.type)
  t.check(
    'and STAYS consumed — no leak to a lower-priority context',
    unboundConsumes('t', KEY({ ctrl: true })) === true,
    'ctrl+t masked',
  )
}

t.section('§3 — every consume site shares the decision, including the interceptor')
{
  const src = readFileSync('src/keybindings/useKeybinding.ts', 'utf8')
  const arms = src.split("case 'unbound':").length - 1
  t.check('the hook has exactly two unbound arms', arms === 2, `${arms}`)
  const guarded = src.split('if (unboundConsumes(input, key))').length - 1
  t.check('every unbound arm consults unboundConsumes', guarded === 2, `${guarded} guarded`)
  t.check(
    'no unconditional consume remains in an unbound arm',
    !/case 'unbound':[^]*?setPendingChord\(null\)\s*\n\s*event\.stopImmediatePropagation/.test(src),
    'ok',
  )

  const setup = readFileSync('src/keybindings/KeybindingProviderSetup.tsx', 'utf8')
  t.check(
    'the interceptor consults unboundConsumes too',
    /case "unbound":[^]*?if \(wasInChord \|\| unboundConsumes\(input, key\)\)/.test(setup),
    'the deciding site',
  )
  t.check(
    'and keeps consuming a disabled CHORD COMPLETION',
    setup.includes('wasInChord || unboundConsumes'),
    'a pending prefix owns its suffix',
  )
  t.check(
    'a chord-suffix MATCH is consumed even when its action has no mounted handler',
    /case "match":(?:(?!case ")[^])*?if \(wasInChord\) \{(?:(?!case ")[^])*?event\.stopImmediatePropagation\(\);\s*\n\s*\}\s*\n\s*break bb/.test(setup),
    'the suffix belongs to the chord',
  )
}

t.section('§4 — chord states are deterministic (pure resolution)')
{
  const bindings = parseBindings([
    { context: 'Chat', bindings: { 'ctrl+x p': 'app:commandPalette', 'ctrl+t': 'app:toggleTasks' } },
  ] as Parameters<typeof parseBindings>[0])
  const ctx = ['Chat', 'Global']

  const started = resolveKeyWithChordState('x', KEY({ ctrl: true }), ctx, bindings, null)
  t.check('a prefix opens a pending chord', started.type === 'chord_started', started.type)
  const pending = started.type === 'chord_started' ? started.pending : null
  t.check('carrying exactly one keystroke', pending?.length === 1, `${pending?.length}`)

  const completed = resolveKeyWithChordState('p', KEY(), ctx, bindings, pending)
  t.check(
    'the suffix completes it — and only it',
    completed.type === 'match' && completed.action === 'app:commandPalette',
    JSON.stringify(completed),
  )

  const escaped = resolveKeyWithChordState('', KEY({ escape: true }), ctx, bindings, pending)
  t.check('escape cancels a pending chord', escaped.type === 'chord_cancelled', escaped.type)

  const wrongSuffix = resolveKeyWithChordState('q', KEY(), ctx, bindings, pending)
  t.check('a suffix that completes nothing cancels', wrongSuffix.type === 'chord_cancelled', wrongSuffix.type)

  const both = parseBindings([
    { context: 'Chat', bindings: { 'ctrl+x': 'app:redraw', 'ctrl+x p': 'app:commandPalette' } },
  ] as Parameters<typeof parseBindings>[0])
  const prefersLong = resolveKeyWithChordState('x', KEY({ ctrl: true }), ctx, both, null)
  t.check('a live longer chord wins over the single key', prefersLong.type === 'chord_started', prefersLong.type)
  const releasedBinding = parseBindings([
    { context: 'Chat', bindings: { 'ctrl+x': 'app:redraw', 'ctrl+x p': 'app:commandPalette' } },
    { context: 'Chat', bindings: { 'ctrl+x p': null } },
  ] as Parameters<typeof parseBindings>[0])
  const released = resolveKeyWithChordState('x', KEY({ ctrl: true }), ctx, releasedBinding, null)
  t.check(
    'unbinding the long chord gives the prefix back its own action',
    released.type === 'match' && released.action === 'app:redraw',
    JSON.stringify(released),
  )

  const disabledChord = parseBindings([
    { context: 'Chat', bindings: { 'ctrl+x p': 'app:commandPalette' } },
    { context: 'Chat', bindings: { 'ctrl+x p': null } },
  ] as Parameters<typeof parseBindings>[0])
  const start2 = resolveKeyWithChordState('x', KEY({ ctrl: true }), ctx, disabledChord, null)
  t.check(
    'a chord whose only completion is unbound does not open',
    start2.type === 'none',
    start2.type,
  )
}

t.section('§5 — REAL BINARY: chord timing is deterministic in the product')
{
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const scratch = mkdtempSync(join(tmpdir(), 'hz-chord-'))
    const home = join(scratch, 'pty-home')
    const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-chord'
    spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
      env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
    })

    const drive = (
      name: string,
      sends: unknown[],
      readyText: string,
      total = 160,
    ): { status: number | null; text: string } => {
      const out = join(scratch, `${name}.json`)
      const cfgPath = join(scratch, `${name}-cfg.json`)
      writeFileSync(
        cfgPath,
        JSON.stringify({
          cols: 100, rows: 30, total,
          argv: ['node', BIN], out, cwd: process.cwd(),
          sends, readyText, readySettleTicks: 3,
        }),
      )
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
        timeout: vshotBudgetMs(180_000),
      })
      let text = ''
      try {
        const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
        text = payload.grid.map(row => row.map(c => c.c).join('')).join('\n')
      } catch {
      }
      return { status: r.status, text }
    }

    const FACE = { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' }
    const boot = { atTick: 60, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3 }

    const immediate = drive(
      'immediate',
      [FACE, { ...boot, data: '\x18' }, { afterPrevTicks: 2, atTick: 90, data: 'p' }],
      'run a command',
    )
    t.check(
      'ctrl+x p opens the palette',
      immediate.status === 0 && immediate.text.includes('run a command'),
      `exit=${immediate.status}`,
    )
    t.check(
      'and the prefix never leaked into the composer as text',
      !immediate.text.includes('❯ p'),
      'no stray p',
    )

    const late = drive(
      'late',
      [FACE, { ...boot, data: '\x18' }, { afterPrevTicks: 16, atTick: 120, data: 'p' }],
      'run a command',
      200,
    )
    t.check(
      'a suffix inside the grace window still completes the chord',
      late.status === 0 && late.text.includes('run a command'),
      `exit=${late.status}`,
    )

    const expired = drive(
      'expired',
      [FACE, { ...boot, data: '\x18' }, { afterPrevTicks: 26, atTick: 150, data: 'z' }],
      '❯ z',
      220,
    )
    t.check(
      'past the grace window the key types normally',
      expired.status === 0 && expired.text.includes('❯ z'),
      `exit=${expired.status}`,
    )
    rmSync(scratch, { recursive: true, force: true })
  }
}

t.finish('prove-printable-unbinding')
