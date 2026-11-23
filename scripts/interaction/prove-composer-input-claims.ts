#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'input-claims-home-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const claimsKeyHint = ' · fix the Atlas, Global or Chat bindings in src/screen/keys/defaultBindings.ts, or resolveKey in src/screen/keys/resolver.ts'
const claimsDisplayHint = ' · fix getBindingDisplayText in src/screen/keys/resolver.ts (or the chat:modelPicker and app:toggleTranscript entries in src/screen/keys/defaultBindings.ts)'
const claimsEarlyHint = ' · fix seedEarlyInput and consumeEarlyInput in src/boot/earlyInput.ts, or initSession in src/screen/composer/input-core/pending-input.ts'
const claimsRefHint = 'fix danglingReferences in src/sessions/promptHistory.ts'
console.log('============================================================')
console.log(' composer input claims — atlas · dialect · boot seed (PTY)')
console.log('============================================================')

console.log('\n── §1 resolver + seed truths ────────────────────────────────')
{
  const { resolveKey, getBindingDisplayText } = await import('../../src/screen/keys/resolver.ts')
  const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.ts')
  const { parseBindings } = await import('../../src/screen/keys/parser.ts')
  const bindings = parseBindings(DEFAULT_BINDINGS)
  const key = (ctrl: boolean) =>
    ({ ctrl, alt: false, shift: false, meta: false, super: false }) as never

  const globalOnly = resolveKey('l', key(true), ['Global'], bindings)
  check(
    'without the atlas, ctrl+l is the Global redraw',
    globalOnly.type === 'match' && globalOnly.action === 'app:redraw',
    JSON.stringify(globalOnly) + claimsKeyHint,
  )
  const atlasL = resolveKey('l', key(true), ['Atlas', 'Global'], bindings)
  check(
    'with the Atlas context active, ctrl+l resolves to the atlas lookup (the advertised key reaches the atlas)',
    atlasL.type === 'match' && atlasL.action === 'atlas:lookup',
    JSON.stringify(atlasL) + claimsKeyHint,
  )
  const atlasR = resolveKey('r', key(true), ['Atlas', 'Global'], bindings)
  check(
    'with the Atlas context active, ctrl+r resolves to the atlas rebind (shadows history:search)',
    atlasR.type === 'match' && atlasR.action === 'atlas:rebind',
    JSON.stringify(atlasR) + claimsKeyHint,
  )

  const linux = getBindingDisplayText('chat:modelPicker', 'Chat', bindings, 'linux')
  const mac = getBindingDisplayText('chat:modelPicker', 'Chat', bindings, 'macos')
  check("the display dialect collapses meta → 'alt+p' off-mac", linux === 'alt+p', String(linux) + claimsDisplayHint)
  check("… and → 'opt+p' on macOS", mac === 'opt+p', String(mac) + claimsDisplayHint)
  const ctrlChord = getBindingDisplayText('app:toggleTranscript', 'Global', bindings)
  check('ctrl chords render unchanged in the dialect', ctrlChord === 'ctrl+o', String(ctrlChord) + claimsDisplayHint)
}
{
  const early = await import('../../src/boot/earlyInput.ts')
  const pending = await import('../../src/screen/composer/input-core/pending-input.ts')
  pending.resetPendingInputForTests()
  early.seedEarlyInput('typed during boot')
  const consumed = early.consumeEarlyInput()
  check('consumeEarlyInput returns the captured buffer once', consumed === 'typed during boot', consumed + claimsEarlyHint)
  check('… and clears it', early.consumeEarlyInput() === '', 'consumeEarlyInput must empty the buffer in src/boot/earlyInput.ts')
  pending.initSession('input-claims-session', consumed)
  check(
    "initSession seeds the composer draft from the early input ('early input wins')",
    pending.text() === 'typed during boot',
    pending.text() + claimsEarlyHint,
  )
  pending.resetPendingInputForTests()
}
{
  const { danglingReferences } = await import('../../src/sessions/promptHistory.ts')
  const store = {
    1: { id: 1, type: 'text', content: 'body one' },
    2: { id: 2, type: 'image', content: 'x', mediaType: 'image/png', filename: 'a.png' },
  } as never
  check(
    'a resolvable text reference is not dangling',
    danglingReferences('see [Pasted text #1 +3 lines]', store).length === 0,
    claimsRefHint,
  )
  check(
    'an aged-out reference is dangling (bare-placeholder shipping refused)',
    danglingReferences('see [Pasted text #9 +3 lines]', store).map(r => r.id).join() === '9',
    claimsRefHint,
  )
  check(
    'an image reference resolves only against an IMAGE entry',
    danglingReferences('[Image #2]', store).length === 0 &&
      danglingReferences('[Image #1]', store).length === 1,
    claimsRefHint,
  )
  check(
    'a type-mismatched entry is dangling — never the wrong data',
    danglingReferences('[Pasted text #2]', store).length === 1,
    claimsRefHint,
  )
  check(
    'the dotted truncated form resolves through its text entry',
    danglingReferences('[...Truncated text #1 +12 lines...]', store).length === 0,
    claimsRefHint,
  )
}

  const { openDraftPart } = await import('../ui/chatScenarios.ts')
  const boot = await openDraftPart('composer-claims-boot-seed', { keepHome: true, earlyInput: 'keys typed while the screen booted' })
  const bootSeed = boot.pending.text()
  await boot.close()
  check(
    'the Chat boot seed consumes the early-input capture (a hardcoded empty seed discarded boot keystrokes)',
    bootSeed === 'keys typed while the screen booted',
    JSON.stringify(bootSeed) + ' · the Chat boot seed must read consumeEarlyInput from src/boot/earlyInput.ts and hand it to initSession in src/screen/composer/input-core/pending-input.ts',
  )

console.log('\n── §3 PTY journeys ──────────────────────────────────────────')
const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')

function capture(
  tag: string,
  scenarioName: string,
  cols: number,
  rows: number,
  sends: Array<Record<string, unknown> & { data: string }>,
  total: number,
): string[] | null {
  const envBefore = { ...process.env }
  const cfg = scenario(scenarioName, cols, rows)
  const gridPath = `/tmp/input-claims-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/input-claims-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, sends, total, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: { ...process.env, MERCURY_LIVE_GLYPHS: '0' },
  })
  cleanupScenario(scenarioName)
  for (const k of Object.keys(process.env)) {
    if (!(k in envBefore)) delete process.env[k]
  }
  Object.assign(process.env, envBefore)
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, (res.stderr?.slice(0, 200) ?? '') + ' (the vshot.py PTY run in scripts/ui/vshot.py exited ' + res.status + ' for scenario ' + scenarioName + ')')
    try {
      const g = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: { c: string }[][] }).grid
      console.log(g.slice(-6).map(r => `      | ${r.map(c => c.c).join('').trimEnd()}`).join('\n'))
    } catch {
    }
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: { c: string }[][] }).grid
  return grid.map(r => r.map(c => c.c).join(''))
}

{
  const a = capture(
    'conleak',
    'concourse',
    80,
    38,
    [
      { awaitText: 'for shortcuts', minTick: 5, atTick: 60, awaitSettleTicks: 3, data: 'zqxw' },
      { afterPrevTicks: 10, data: '\u001b' },
      { afterPrevTicks: 14, data: '' },
    ],
    120,
  )
  if (a) {
    check(
      'concourse keystrokes never land in the parked root composer',
      !a.some(l => l.includes('zqxw')),
      (a.find(l => l.includes('zqxw')) ?? '') + ' · keystrokes typed in the concourse screen must not reach the parked Chat composer; fix the input owner handoff between the concourse screen and the Chat composer',
    )
    check('esc returned to the root Chat (composer sigil present)', a.some(l => l.includes('❯')), 'esc in the concourse screen must return to the root Chat; the scenario is concourse in scripts/ui/renderScenarios.ts')
  }
}
{
  const body = Array.from({ length: 20 }, (_, i) => `const bangRow${i} = ${i}`).join('\n')
  const b = capture(
    'bangpaste',
    'resume-2turn',
    120,
    38,
    [
      {
        awaitText: '\u276f',
        minTick: 5,
        atTick: 60,
        awaitSettleTicks: 3,
        data: `\u001b[200~!${body}\u001b[201~`,
      },
      { afterPrevTicks: 14, data: '' },
    ],
    110,
  )
  if (b) {
    check(
      "the bang paste rendered a chip ('[Pasted text #1 …')",
      b.some(l => l.includes('[Pasted text #1')),
      (b.find(l => l.includes('Pasted')) ?? '(no chip row)') + ' · a bracketed paste starting with ! must become a Pasted text chip in the Chat composer, not shell mode',
    )
    check(
      'the composer did not flip to shell mode',
      !b.some(l => l.includes('for shell mode')),
      'a paste that starts with ! must not switch the Chat composer to shell mode',
    )
  }
}
{
  const c = capture('help-narrow', 'help', 80, 22, [{ atTick: 30, data: '?' }], 46)
  if (c) {
    const saysWhatItCut = c.some(l => l.includes('more · /help lists every shortcut'))
    check('the clipped narrow help overlay says what it cut', saysWhatItCut, c.slice(-8).join(' | ') + ' · the clipped help overlay must end with a more · /help lists every shortcut row; the help scenario is in scripts/ui/renderScenarios.ts')
    if (!saysWhatItCut) {
      console.log('      ┌ the 60×24 frame — no remainder row')
      c.forEach((line, index) => {
        const row = line.trimEnd()
        if (row !== '') console.log(`      │ ${String(index).padStart(2, ' ')} ${row}`)
      })
      console.log('      └')
    }
  }
  const d = capture('help-tall', 'help', 80, 38, [{ atTick: 30, data: '?' }], 46)
  if (d) {
    check(
      'the 60×38 control shows the whole list (no remainder row)',
      !d.some(l => l.includes('more · /help lists every shortcut')),
      'a tall terminal must show the whole help list without a remainder row',
    )
    check(
      "… including the tail entries the narrow overlay used to clip silently ('stash prompt')",
      d.some(l => l.includes('stash prompt')),
      'the tall help overlay must list the stash prompt entry',
    )
  }
}

console.log(failures === 0 ? '\n✅ prove-composer-input-claims — all checks pass' : `\n❌ prove-composer-input-claims — ${failures} failing`)
process.exit(failures === 0 ? 0 : 1)
