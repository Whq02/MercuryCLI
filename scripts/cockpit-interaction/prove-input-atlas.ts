#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  actionAffordance,
  atlasMatches,
  buildAtlas,
  describeAction,
  explainResolution,
  suggestFreeChords,
} from '../../src/keybindings/atlas.ts'
import { KEYBINDING_ACTIONS } from '../../src/keybindings/actionGraph.ts'
import { DEFAULT_BINDINGS } from '../../src/keybindings/defaultBindings.ts'
import { parseBindings, parseChord } from '../../src/keybindings/parser.ts'
import { resolveKeyWithChordState, unboundConsumes } from '../../src/keybindings/resolver.ts'
import {
  claimKeyCapture,
  currentKeyCapture,
  resetKeyCaptureForTesting,
} from '../../src/keybindings/keyCapture.ts'
import { applyBindingEdit } from '../../src/keybindings/writeBindings.ts'
import type { Key } from '../../src/ink.js'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'hz-atlas-'))

const KEY = (over: Partial<Key> = {}): Key =>
  ({ ctrl: false, meta: false, shift: false, super: false, escape: false, return: false, tab: false, backspace: false, delete: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageUp: false, pageDown: false, wheelUp: false, wheelDown: false, home: false, end: false, ...over }) as Key

const defaults = parseBindings(DEFAULT_BINDINGS)
const DEFAULT_COUNT = defaults.length
const OPTS = { defaultCount: DEFAULT_COUNT, platform: 'linux' } as const
const user = (blocks: { context: string; bindings: Record<string, string | null> }[]) => [
  ...defaults,
  ...parseBindings(blocks as Parameters<typeof parseBindings>[0]),
]

t.section('§1 — the effective table is derived from the live bindings')
{
  const plain = buildAtlas(defaults, OPTS)
  const palette = plain.find(r => r.action === 'app:commandPalette')
  t.check('a default-bound action reports its chord', palette?.state === 'bound', `${palette?.chord}`)
  t.check('and names the layer that wrote it', palette?.origin === 'default', `${palette?.origin}`)
  t.check(
    'meaning comes from the Action Graph, not the panel',
    palette?.description === 'Open the command palette',
    `${palette?.description}`,
  )

  const rebound = buildAtlas(
    user([{ context: 'Global', bindings: { 'alt+j': 'app:toggleTasks' } }]),
    OPTS,
  )
  const mine = rebound.find(r => r.action === 'app:toggleTasks' && r.chord === 'alt+j')
  t.check('a user rebind appears as its own row', mine !== undefined, 'alt+j')
  t.check('marked as the operator\'s, not a default', mine?.origin === 'user', `${mine?.origin}`)

  const unbound = buildAtlas(
    user([{ context: 'Chat', bindings: { 'ctrl+s': null } }]),
    OPTS,
  )
  const stashRow = unbound.find(r => r.context === 'Chat' && r.state === 'disabled')
  t.check('the unbound chord reads disabled', stashRow !== undefined, JSON.stringify(unbound.filter(r => r.context === 'Chat').map(r => `${r.chord}:${r.state}`).slice(0, 8)))
  t.check(
    'and records what it shadowed, in resolver order',
    stashRow?.shadowed.at(-1)?.action === 'chat:stash',
    JSON.stringify(stashRow?.shadowed),
  )
  const stash = unbound.find(r => r.action === 'chat:stash' && r.state === 'unbound')
  t.check('the orphaned action is reported unreachable', stash !== undefined, 'chat:stash')
  t.check(
    'with the operator\'s own configuration named as the cause',
    stash?.reason?.includes('your configuration unbinds') === true,
    `${stash?.reason}`,
  )

  const rebindOnly = plain.find(r => r.action === 'app:toggleTerminal')
  t.check('a rebind-only action is listed', rebindOnly?.state === 'unbound', `${rebindOnly?.state}`)
  t.check(
    'with the graph\'s authored reason',
    rebindOnly?.reason?.includes('IDE-integration niche') === true,
    `${rebindOnly?.reason}`,
  )

  const reserved = plain.find(r => r.reserved !== undefined)
  t.check('reserved chords carry their warning', reserved !== undefined, `${reserved?.chord}`)

  t.check(
    'every graph action reaches the table, and no (context, chord) row repeats',
    (() => {
      const seen = new Set<string>()
      const rowKeys = new Set<string>()
      let rows = 0
      for (const r of plain) {
        if (r.action === null || r.action.startsWith('command:')) continue
        seen.add(r.action)
        rowKeys.add(`${r.action}|${r.context}|${r.chord}`)
        rows++
      }
      return (
        KEYBINDING_ACTIONS.every(a => seen.has(a)) &&
        seen.size === KEYBINDING_ACTIONS.length &&
        rowKeys.size === rows
      )
    })(),
    `${plain.length} rows over ${KEYBINDING_ACTIONS.length} actions`,
  )

  t.check('search finds an action by what it does', atlasMatches(palette!, 'palette'), 'by name')
  t.check('and by its description', atlasMatches(palette!, 'command pal'), 'by meaning')
  t.check('a command binding describes itself', describeAction('command:sessions') === 'Run /sessions', 'ok')
  t.check(
    'a loose subsequence over prose no longer matches — the id is the handle',
    !atlasMatches(plain.find(r => r.action === 'chat:cancel')!, 'stash'),
    'chat:cancel is not a stash hit',
  )

  const mac = buildAtlas(defaults, { defaultCount: DEFAULT_COUNT, platform: 'macos' })
  const lin = buildAtlas(defaults, { defaultCount: DEFAULT_COUNT, platform: 'linux' })
  const macPick = mac.find(r => r.action === 'chat:modelPicker')
  const linPick = lin.find(r => r.action === 'chat:modelPicker')
  t.check('macOS renders the option key as opt', macPick?.chord === 'opt+p', `${macPick?.chord}`)
  t.check('every other host renders it as alt', linPick?.chord === 'alt+p', `${linPick?.chord}`)
  t.check(
    'and both spellings parse back to the same keystroke',
    JSON.stringify(parseChord('opt+p')) === JSON.stringify(parseChord('alt+p')),
    'round-trip',
  )
  t.check(
    'the two hosts differ ONLY in that name — same rows, same order',
    mac.length === lin.length &&
      mac.every((r, i) => r.action === lin[i]?.action && r.context === lin[i]?.context),
    `${mac.length} rows`,
  )
}

t.section('§2 — the reverse lookup runs the runtime resolver')
{
  const explain = (input: string, key: Key, bindings = defaults, pending = null) => {
    const result = resolveKeyWithChordState(input, key, ['Chat', 'Global'], bindings, pending)
    return explainResolution(input, key, ['Chat', 'Global'], bindings, pending, result, {
      defaultCount: DEFAULT_COUNT,
      platform: 'linux',
      passesThroughToEditor: !unboundConsumes(input, key),
    })
  }

  const todos = explain('t', KEY({ ctrl: true }))
  t.check('a bound chord names its action', todos.outcome === 'match' && todos.action === 'app:toggleTasks', todos.verdict)
  t.check('and the context that owns it', todos.context === 'Global', `${todos.context}`)

  const prefix = explain('x', KEY({ ctrl: true }))
  t.check('a prefix reports chord_started', prefix.outcome === 'chord_started', prefix.verdict)
  t.check('and says a key is awaited', prefix.verdict.includes('waiting'), prefix.verdict)

  const unclaimed = explain('q', KEY({ ctrl: true }))
  t.check('an unclaimed chord says so', unclaimed.outcome === 'none', unclaimed.verdict)

  const disabled = explain(' ', KEY(), user([{ context: 'Chat', bindings: { space: null } }]))
  t.check('a disabled printable reports the passthrough', disabled.outcome === 'unbound', disabled.outcome)
  t.check(
    'in the words of the behaviour it actually gets',
    disabled.verdict.includes('types into the editor'),
    disabled.verdict,
  )

  const shadowed = explain(
    't',
    KEY({ ctrl: true }),
    user([{ context: 'Global', bindings: { 'ctrl+t': 'command:sessions' } }]),
  )
  t.check('a shadowing rebind wins', shadowed.action === 'command:sessions', `${shadowed.action}`)
  t.check('and the shadowed default is named', shadowed.candidates.length === 2, JSON.stringify(shadowed.candidates))
  t.check(
    'in resolver order — the last candidate is the winner',
    shadowed.candidates.at(-1)?.action === 'command:sessions' &&
      shadowed.candidates.at(0)?.action === 'app:toggleTasks',
    JSON.stringify(shadowed.candidates.map(c => c.action)),
  )
  t.check('with the layer that wrote it', shadowed.candidates.at(-1)?.origin === 'user', 'user')

  const reserved = explain('z', KEY({ ctrl: true }))
  t.check('a terminal-reserved chord carries its reason', reserved.reserved?.reason.includes('suspend') === true, `${reserved.reserved?.reason}`)
}

t.section('§3 — a lookup is a table read: nothing is stored, logged or sent')
{
  const src = readFileSync('src/keybindings/atlas.ts', 'utf8')
  for (const forbidden of ['logEvent', 'analytics', 'writeFile', 'appendFile', 'fetch(']) {
    t.check(`atlas.ts does not ${forbidden}`, !src.includes(forbidden), forbidden)
  }
  t.check(
    'and holds no module state to accumulate into',
    !/^let\s/m.test(src) && !/^var\s/m.test(src),
    'pure functions only',
  )
  const panel = readFileSync('src/components/MercuryInputAtlas.tsx', 'utf8')
  t.check('the panel logs no keystroke', !panel.includes('logEvent'), 'ok')
  t.check(
    'and releases the keyboard on every terminal outcome',
    (panel.match(/setPending\(null\)\n\s*setMode\('browse'\)/g) ?? []).length >= 2,
    'single-answer capture in both callbacks',
  )
}

t.section('§4 — the write half produces exact, deterministic bytes')
{
  const wb = readFileSync('src/keybindings/writeBindings.ts', 'utf8')
  t.check(
    'the rebind write is ATOMIC (published through the durable owner)',
    wb.includes("from '../substrate/durablePublish.js'") && wb.includes('await durableAtomicPublish(path, next.content)'),
  )
  const atlasSrc = readFileSync('src/components/MercuryInputAtlas.tsx', 'utf8')
  t.check(
    'a failed write reports into the panel notice slot',
    atlasSrc.includes('rebind failed —'),
  )
  const template = readFileSync('src/keybindings/template.ts', 'utf8')
  t.check(
    'the template points editors at NO foreign schema ($docs, never $schema)',
    !template.includes("'$schema'") && !template.includes('"$schema"') && template.includes('$docs'),
  )
  const fresh = applyBindingEdit(null, { context: 'Chat', chord: 'alt+j', action: 'app:toggleTasks' })
  t.check('a first rebind creates the file shape', fresh.ok, fresh.ok ? '' : fresh.error)
  if (fresh.ok) {
    const parsed = JSON.parse(fresh.content) as { bindings: { context: string; bindings: Record<string, string> }[] }
    t.check('with one block for the context', parsed.bindings.length === 1, `${parsed.bindings.length}`)
    t.check('carrying the binding', parsed.bindings[0]?.bindings['alt+j'] === 'app:toggleTasks', 'ok')
    t.check('and ending in a newline', fresh.content.endsWith('}\n'), 'trailing newline')

    const second = applyBindingEdit(fresh.content, { context: 'Chat', chord: 'alt+k', action: 'chat:stash' })
    t.check('a second rebind merges into the same block', second.ok, second.ok ? '' : second.error)
    if (second.ok) {
      const p2 = JSON.parse(second.content) as { bindings: { bindings: Record<string, string> }[] }
      t.check('one block still', p2.bindings.length === 1, `${p2.bindings.length}`)
      t.check('with both bindings', Object.keys(p2.bindings[0]!.bindings).length === 2, 'alt+j + alt+k')
    }
    const again = applyBindingEdit(null, { context: 'Chat', chord: 'alt+j', action: 'app:toggleTasks' })
    t.check('the same edit is byte-identical', again.ok && again.content === fresh.content, 'deterministic')
  }

  const unbind = applyBindingEdit(null, { context: 'Chat', chord: 'space', action: null })
  t.check('an unbind writes JSON null', unbind.ok && unbind.content.includes('"space": null'), 'null')

  const broken = applyBindingEdit('{ not json', { context: 'Chat', chord: 'alt+j', action: 'chat:stash' })
  t.check('an unparseable file is REFUSED, never overwritten', !broken.ok, broken.ok ? 'overwrote' : broken.error)

}

t.section('§5 — suggested chords are free, reserved-aware and stable')
{
  const free = suggestFreeChords(defaults, 'Chat', { limit: 5 })
  t.check('five suggestions come back', free.length === 5, free.join(' · '))
  t.check(
    'the same call gives the same answer',
    suggestFreeChords(defaults, 'Chat', { limit: 5 }).join('|') === free.join('|'),
    'deterministic',
  )
  const taken = new Set(
    defaults
      .filter(b => b.context === 'Chat' || b.context === 'Global')
      .map(b => b.chord.map(k => `${k.ctrl ? 'ctrl+' : ''}${k.alt || k.meta ? 'alt+' : ''}${k.key}`).join(' ')),
  )
  t.check('none of them is already bound here', free.every(c => !taken.has(c)), free.join(' · '))
  t.check('and none is a reserved chord', !free.some(c => c.includes('ctrl+z') || c.includes('ctrl+c')), 'ok')

  const bound = actionAffordance('app:toggleTasks', 'Global', defaults)
  t.check('a bound action reports its chord', bound.kind === 'bound', JSON.stringify(bound))
  const stolen = actionAffordance(
    'app:toggleTasks',
    'Global',
    user([{ context: 'Global', bindings: { 'ctrl+t': 'command:sessions' } }]),
  )
  t.check(
    'an action whose chord was reassigned reads disabled, not bound',
    stolen.kind === 'disabled',
    JSON.stringify(stolen),
  )
  t.check(
    'and says who took it',
    stolen.kind === 'disabled' && stolen.reason.includes('command:sessions'),
    JSON.stringify(stolen),
  )
  const never = actionAffordance('app:toggleTerminal', 'Global', defaults)
  t.check('a rebind-only action reports its authored reason', never.kind === 'unbound', JSON.stringify(never))
}

t.section('§6 — the capture claim, and the interceptor that honours it')
{
  resetKeyCaptureForTesting()
  t.check('no claim by default — the runtime owns the keyboard', currentKeyCapture() === null, 'null')
  const seen: string[] = []
  const release = claimKeyCapture(input => seen.push(input))
  t.check('a claim takes the slot', currentKeyCapture() !== null, 'claimed')
  currentKeyCapture()?.('x', KEY())
  t.check('and receives the raw keystroke', seen.join('') === 'x', seen.join(''))
  release()
  t.check('release hands the keyboard back', currentKeyCapture() === null, 'released')
  release()
  t.check('a double release is harmless', currentKeyCapture() === null, 'idempotent')

  const setup = readFileSync('src/keybindings/KeybindingProviderSetup.tsx', 'utf8')
  t.check(
    'the interceptor consults the claim BEFORE resolving',
    setup.indexOf('currentKeyCapture()') !== -1 && setup.indexOf('currentKeyCapture()') < setup.indexOf('resolveKeyWithChordState(input'),
    'first statement in the handler',
  )
  t.check(
    'and acts on nothing while a claim is held',
    /const capture = currentKeyCapture\(\);[^]*?capture\(input, key\);[^]*?return;/.test(setup),
    'delivers and returns',
  )
}

t.section('§7 — REAL BINARY: /keys renders the live table')
{
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const home = join(scratch, 'pty-home')
    const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-atlas'
    spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
      env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
    })
    writeFileSync(
      join(home, 'keybindings.json'),
      JSON.stringify({ bindings: [{ context: 'Global', bindings: { 'alt+j': 'app:toggleTasks' } }] }),
    )
    const expectChord = process.platform === 'darwin' ? 'opt+j' : 'alt+j'
    const out = join(scratch, 'keys.json')
    const cfg = {
      cols: 120, rows: 40, total: 200,
      argv: ['node', BIN], out, cwd: process.cwd(),
      sends: [
        { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { atTick: 60, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: '/keys\r' },
        { atTick: 110, awaitText: 'input atlas', minTick: 5, awaitSettleTicks: 8, data: 'toggleTa' },
      ],
      readyText: expectChord, readySettleTicks: 4,
    }
    const cfgPath = join(scratch, 'keys-cfg.json')
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
      timeout: vshotBudgetMs(180_000),
    })
    let text = ''
    try {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
      text = payload.grid.map(row => row.map(c => c.c).join('')).join('\n')
    } catch {
    }
    t.check('the panel opens in the built product', r.status === 0 && text.includes('input atlas'), `exit=${r.status}`)
    t.check('showing the Chat context it defaults to', text.includes('Chat'), 'context line')
    t.check(
      'and the mode rail it offers',
      text.includes('look up') && text.includes('rebind'),
      'footer',
    )
    t.check(
      'the rows carry live action ids from the graph',
      text.includes('chat:') || text.includes('app:'),
      'action ids',
    )
    t.check(
      'the operator\'s own rebind is on screen — the table is resolved, not printed',
      text.includes(expectChord),
      `${expectChord} → app:toggleTasks; screen: ${text.replace(/\s+/g, ' ').slice(Math.max(0, text.replace(/\s+/g, ' ').indexOf('input atlas') - 100), Math.max(0, text.replace(/\s+/g, ' ').indexOf('input atlas') - 100) + 1400)}`,
    )
  }
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-input-atlas')
