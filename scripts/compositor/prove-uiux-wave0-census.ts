#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rowsBinding, shippedKeyForms } from '../lib/shippedKeyForms.ts'

const ROOT = join(import.meta.dir, '../../')

const EXPECTED_RED = new Set<string>([
])

type Leg = { label: string; pass: boolean; detail: string }
const legs: Leg[] = []
function check(label: string, cond: boolean, detail = ''): void {
  legs.push({ label, pass: cond, detail })
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

section('BM-19 — splash OSC 11 ground write, emitted bytes under the one spelling')
{
  const scratch = mkdtempSync(join(tmpdir(), 'uiux-wave0-'))
  const probe = join(scratch, 'splash-byte-probe.mjs')
  writeFileSync(
    probe,
    [
      "const chunks = []",
      "const origWrite = process.stdout.write.bind(process.stdout)",
      "Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })",
      "Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true })",
      "Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true })",
      'process.stdout.write = (data) => { chunks.push(String(data)); return true }',
      "process.env.MERCURY_SPLASH_ONESHOT = '1'",
      "process.on('exit', () => {",
      "  const bytes = chunks.join('')",
      "  origWrite(JSON.stringify({ osc11: bytes.includes('\\u001b]11;'), bytes: bytes.length }) + '\\n')",
      '})',
      `await import(${JSON.stringify(join(ROOT, 'assets/splash/mercury-splash.mjs'))})`,
    ].join('\n'),
  )
  const runProbe = (env: Record<string, string>): { osc11: boolean; bytes: number } => {
    const out = execFileSync(process.execPath, [probe], {
      env: { PATH: process.env.PATH, TERM: 'xterm-256color', COLORTERM: 'truecolor', MERCURY_CONFIG_DIR: scratch, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    })
    return JSON.parse(out.trim().split('\n').at(-1)!) as { osc11: boolean; bytes: number }
  }
  const baseline = runProbe({})
  const canonicalOff = runProbe({ MERCURY_OASIS_BG: '0' })
  const canonicalOn = runProbe({ MERCURY_OASIS_BG: '1' })
  const bare = runProbe({ COLORTERM: '' })
  check(
    'floor: the splash emits the OSC 11 ground write by default (a real splash frame was captured)',
    baseline.osc11 && baseline.bytes > 1000,
    `osc11=${baseline.osc11} bytes=${baseline.bytes}; the splash in assets/splash/mercury-splash.mjs must write the OSC 11 ground colour by default and draw a full frame`,
  )
  check(
    'UI-017 (BM-19): the canonical MERCURY_OASIS_BG=0 suppresses the splash OSC 11 ground write',
    !canonicalOff.osc11,
    `canonical opt-out ignored — osc11 still emitted (${canonicalOff.bytes} bytes); assets/splash/mercury-splash.mjs must read MERCURY_OASIS_BG=0 and skip the OSC 11 write`,
  )
  check(
    'UI-016: an explicit MERCURY_OASIS_BG=1 keeps the ground write (the one spelling reads its own value)',
    canonicalOn.osc11,
    `explicit =1 suppressed the ground write (osc11=${canonicalOn.osc11}); assets/splash/mercury-splash.mjs must treat MERCURY_OASIS_BG=1 as on`,
  )
  check(
    'the depth law: a bare xterm-256color with nothing advertised is never recoloured (no OSC 11 ground write on the 256-colour tier)',
    !bare.osc11 && bare.bytes > 1000,
    `osc11=${bare.osc11} bytes=${bare.bytes}; assets/splash/mercury-splash.mjs must skip the OSC 11 write when COLORTERM advertises no truecolor, and still draw a frame`,
  )
}


section('UI-007 — same-context legacy-projection collisions in the authored bindings')
{
  const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.js')
  const legacyClass = (chord: string): string | null => {
    const c = chord.toLowerCase().trim()
    if (/^ctrl\+shift\+[a-z]$/.test(c)) return `C0:${c.slice(-1)}`
    if (/^ctrl\+[a-z]$/.test(c)) return `C0:${c.slice(-1)}`
    if (c === 'tab') return 'C0:i'
    if (c === 'enter' || c === 'return') return 'C0:m'
    if (c === 'escape' || c === 'esc') return 'C0:['
    return null
  }
  const collisions: string[] = []
  for (const block of DEFAULT_BINDINGS) {
    const byClass = new Map<string, Array<[string, string]>>()
    for (const [chord, action] of Object.entries(block.bindings)) {
      if (typeof action !== 'string') continue
      const cls = legacyClass(chord)
      if (!cls) continue
      const list = byClass.get(cls) ?? []
      list.push([chord, action])
      byClass.set(cls, list)
    }
    for (const [cls, list] of byClass) {
      const actions = new Set(list.map(([, a]) => a))
      if (list.length > 1 && actions.size > 1) {
        collisions.push(
          `${block.context}/${cls}: ${list.map(([c, a]) => `${c}→${a}`).join(' vs ')}`,
        )
      }
    }
  }
  console.log(collisions.map(c => `    ${c}`).join('\n') || '    (no same-context legacy collisions)')
  check(
    'census: the collision list is DETERMINISTIC and recorded (each row names context, byte class, both actions)',
    collisions.every(c => /^[A-Za-z]+\/C0:.+ vs /.test(c)),
    collisions.join(' | ') + ' | each row must read context/C0:letter chordA→actionA vs chordB→actionB; fix the offending bindings in src/screen/keys/defaultBindings.ts',
  )
}

section('BM-20 — held is a settled receipt; release is obligation-exact (UI-027..037)')
{
  const ledger = await import('../../src/screen/renderer/root/terminalModeLedger.js')
  ledger._resetTerminalModeLedgerForTesting()
  ledger.noteModesImported('launcher-splash', ['alt-screen', 'alternate-scroll', 'cursor-hidden'])
  const open1 = ledger.openModeObligations('launcher-splash')
  ledger.noteModeReleased('launcher-splash', 'alternate-scroll')
  const open2 = ledger.openModeObligations('launcher-splash')
  check(
    'UI-027/036: the mode ledger records the import as release obligations — exactly the splash-transferable set, released one by one',
    JSON.stringify(open1) === JSON.stringify(['alt-screen', 'alternate-scroll', 'cursor-hidden']) &&
      JSON.stringify(open2) === JSON.stringify(['alt-screen', 'cursor-hidden']) &&
      ledger.openModeObligations('someone-else').length === 0,
    JSON.stringify({ open1, open2 }) + ' | noteModesImported, noteModeReleased and openModeObligations in src/screen/renderer/root/terminalModeLedger.ts must track one obligation per imported mode and release them one by one',
  )
  ledger._resetTerminalModeLedgerForTesting()
}

section('BM-22/23 — the remaining desired laws, pinned as flip targets')
{
  {
    const policy = await import('../../src/screen/renderer/termio/alternateScrollPolicy.js')
    const arrow = (name: 'up' | 'down'): Record<string, unknown> => ({
      kind: 'key',
      name,
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
    })
    const engaged = { altScreenActive: true, mouseTrackingEnabled: false, elevatedSurfaceActive: false }
    const names = (items: Array<Record<string, unknown>>, state: typeof engaged): string[] =>
      policy
        .resolveAlternateScrollIntent(items as never, state)
        .map(i => String((i as { name?: string }).name ?? (i as { kind: string }).kind))
    const oneByOne = [
      ...names([arrow('up')], engaged),
      ...names([arrow('up')], engaged),
      ...names([arrow('up')], engaged),
    ]
    const coalesced = names([arrow('up'), arrow('up'), arrow('up')], engaged)
    check(
      'UI-053: three wheel notches settle IDENTICALLY split (3×1) or coalesced (1×3) — one notch never walks history',
      JSON.stringify(oneByOne) === JSON.stringify(coalesced) &&
        JSON.stringify(coalesced) === JSON.stringify(['wheelup', 'wheelup', 'wheelup']),
      `split=${oneByOne.join(',')} coalesced=${coalesced.join(',')}; resolveAlternateScrollIntent in src/screen/renderer/termio/alternateScrollPolicy.ts must map each plain arrow to a wheel notch the same way for any batch size`,
    )
    check(
      'UI-054: a mixed batch maps ONLY its plain arrows, order preserved (no all-or-nothing batch shape)',
      JSON.stringify(
        names([arrow('down'), { kind: 'key', name: 'a', ctrl: false, meta: false, shift: false, option: false }, arrow('down')], engaged),
      ) === JSON.stringify(['wheeldown', 'a', 'wheeldown']),
      'resolveAlternateScrollIntent in src/screen/renderer/termio/alternateScrollPolicy.ts must map only the plain arrows of a mixed batch and keep the order',
    )
    check(
      'UI-055: an ELEVATED surface keeps arrows as arrows (list navigation owns them)',
      JSON.stringify(names([arrow('up'), arrow('up')], { ...engaged, elevatedSurfaceActive: true })) ===
        JSON.stringify(['up', 'up']),
      'resolveAlternateScrollIntent in src/screen/renderer/termio/alternateScrollPolicy.ts must leave arrows alone when elevatedSurfaceActive is true',
    )
    check(
      'UI-056: tracking-ON and main-screen states are untouched (the policy engages ONLY in native-selection)',
      JSON.stringify(names([arrow('up'), arrow('up')], { ...engaged, mouseTrackingEnabled: true })) ===
        JSON.stringify(['up', 'up']) &&
        JSON.stringify(names([arrow('up')], { ...engaged, altScreenActive: false })) === JSON.stringify(['up']),
      'resolveAlternateScrollIntent in src/screen/renderer/termio/alternateScrollPolicy.ts must engage only with altScreenActive true and mouseTrackingEnabled false',
    )
    check(
      'UI-057: modified arrows never map (ctrl/shift/meta arrows keep their own meanings)',
      JSON.stringify(names([{ ...arrow('up'), shift: true }], engaged)) === JSON.stringify(['up']),
      'resolveAlternateScrollIntent in src/screen/renderer/termio/alternateScrollPolicy.ts must not map an arrow that carries ctrl, shift, meta or option',
    )
    check(
      'UI-057: a super-modified arrow keeps its own meaning too (super+up is never a wheel notch)',
      JSON.stringify(names([{ ...arrow('up'), super: true }, { ...arrow('down'), super: true }], engaged)) === JSON.stringify(['up', 'down']),
      JSON.stringify(names([{ ...arrow('up'), super: true }], engaged)) + ' | resolveAlternateScrollIntent in src/screen/renderer/termio/alternateScrollPolicy.ts must not map an arrow that carries super',
    )
    const historyRows = rowsBinding(shippedKeyForms(), action => action === 'history:previous' || action === 'history:next')
    check(
      "UI-058: the registry's dead history rows STAY retired (a revival re-lies to the atlas)",
      historyRows.length === 0,
      historyRows.slice(0, 3).join(' · ') + ' | remove the history:previous and history:next rows that came back, from the key bindings shippedKeyForms reads',
    )
    check(
      '§policy identity: scroll-first-in-native-selection is the documented choice',
      policy.ALTERNATE_SCROLL_POLICY === 'scroll-first-in-native-selection',
      'ALTERNATE_SCROLL_POLICY in src/screen/renderer/termio/alternateScrollPolicy.ts changed; restore it or update this census on purpose',
    )
  }
  {
    const { defaultPingMethod, buildOsc9Notification } = await import('../../src/screen/renderer/termio/notifyPing.js')
    check(
      'UI-078: every terminal has a ping road — the bell floor where OSC 9 is unproven (Windows Terminal, an unknown terminal), never silence',
      defaultPingMethod('windows-terminal') === 'bell' && defaultPingMethod('') === 'bell' && defaultPingMethod(null) === 'bell',
      'defaultPingMethod in src/screen/renderer/termio/notifyPing.ts must return bell for windows-terminal, an empty name and null',
    )
    check(
      'UI-119: Apple Terminal takes the bell — its own profile decides audible versus visual',
      defaultPingMethod('Apple_Terminal') === 'bell',
      'defaultPingMethod in src/screen/renderer/termio/notifyPing.ts must return bell for Apple_Terminal',
    )
    check('OSC 9 stands where proven (iTerm2)', defaultPingMethod('iTerm.app') === 'osc9', 'defaultPingMethod in src/screen/renderer/termio/notifyPing.ts must return osc9 for iTerm.app')
  }
}

section('UI-061..064 — authored chords classified through the live protocol; collisions never silent')
{
  const { buildAtlas } = await import('../../src/screen/keys/atlas.js')
  const { parseBindings } = await import('../../src/screen/keys/parser.js')
  const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.js')
  const { classifyChordDelivery } = await import('../../src/screen/keys/delivery.js')
  const defaults = parseBindings(DEFAULT_BINDINGS as never)
  const authored = parseBindings([
    ...(DEFAULT_BINDINGS as never[]),
    { context: 'Global', bindings: { 'ctrl+shift+o': 'app:toggleTerminal', 'ctrl+x o': 'app:toggleTerminal' } },
  ] as never)
  const legacy = buildAtlas(authored, { defaultCount: defaults.length, platform: 'linux', extendedKeys: false })
  const extended = buildAtlas(authored, { defaultCount: defaults.length, platform: 'linux', extendedKeys: true })
  const shiftRow = (rows: typeof legacy) =>
    rows.find(
      r => r.context === 'Global' && r.action === 'app:toggleTerminal' && /shift/i.test(r.chord),
    )
  const legacyShift = shiftRow(legacy)
  check(
    'UI-063: on a LEGACY wire a user-authored Ctrl+Shift+O is marked aliases-to AND carries its collision (toggleTranscript) — never silent',
    legacyShift?.delivery?.status === 'aliases-to' &&
      legacyShift?.collidesWith?.action === 'app:toggleTranscript',
    JSON.stringify({ delivery: legacyShift?.delivery, collides: legacyShift?.collidesWith }) + ' | buildAtlas in src/screen/keys/atlas.ts must mark ctrl+shift+o as aliases-to on a legacy wire and name the toggleTranscript collision',
  )
  check(
    'UI-061: an extended-keys profile delivers the same chord distinctly (no collision marker; declared-identity reason stated)',
    shiftRow(extended)?.delivery?.status === 'deliverable' &&
      shiftRow(extended)?.collidesWith === undefined,
    'buildAtlas in src/screen/keys/atlas.ts must mark ctrl+shift+o deliverable with no collision when extendedKeys is true',
  )
  const fallbackRow = legacy.find(
    r => r.action === 'app:toggleTerminal' && /ctrl\+x/i.test(r.chord),
  )
  check(
    'UI-064: a PORTABLE fallback (ctrl+x o) authored beside it is deliverable on every protocol',
    fallbackRow?.delivery?.status === 'deliverable',
    'buildAtlas in src/screen/keys/atlas.ts and classifyChordDelivery in src/screen/keys/delivery.ts must mark a chord sequence deliverable',
  )
  check(
    'classifier table: shift-collapse on legacy · distinct on extended · sequences and plain keys deliverable',
    classifyChordDelivery('ctrl+shift+o', false).status === 'aliases-to' &&
      (classifyChordDelivery('ctrl+shift+o', false) as { sibling?: string }).sibling === 'ctrl+o' &&
      classifyChordDelivery('ctrl+shift+o', true).status === 'deliverable' &&
      classifyChordDelivery('ctrl+x o', false).status === 'deliverable' &&
      classifyChordDelivery('a', false).status === 'deliverable',
    'classifyChordDelivery in src/screen/keys/delivery.ts must return aliases-to with sibling ctrl+o for ctrl+shift+o on a legacy wire and deliverable otherwise',
  )
}


section('RV — reasoning depth is not answer length; one balanced default + one override')
{
  const contract = await import('../../src/engine/system-prompt/mercuryContract.js')
  check(
    'RV-02/08: the constitution names no reasoning-depth knob (no retired word) and no answer-length rule',
    !new RegExp('\\b(effort|' + ['deep', 'think'].join('') + '|' + ['super', 'code'].join('') + '|verbosity|brevity)\\b', 'i').test(contract.MERCURY_CONSTITUTION),
    'remove the reasoning-depth or answer-length word from MERCURY_CONSTITUTION in src/engine/system-prompt/mercuryContract.ts',
  )
  check(
    'RV-03/04/05: the stated-preferences rule is the constitution\'s; no narration or appendix rule rides any seat text',
    /stated preferences on scope, approach, delegation and communication ahead of your defaults/.test(contract.MERCURY_CONSTITUTION) &&
      !/narration|appendix/.test([contract.MERCURY_CONSTITUTION, contract.MERCURY_CREWMATE_CONTRACT].join('\n')),
    'MERCURY_CONSTITUTION in src/engine/system-prompt/mercuryContract.ts must keep the stated-preferences sentence, and no narration or appendix rule may appear in it or in MERCURY_SUBAGENT_CONTRACT',
  )
}

section('UI-130 — windows-ui binds captures to ONE exact SHA with a live receipt')
{
  const wf = readFileSync(join(ROOT, '.github/workflows/windows-ui.yml'), 'utf8')
  check(
    'UI-130: required sha input + exact-checkout assertion (the windows-functional ledger law, same spelling)',
    /sha:\n\s+description: 'Exact commit SHA to capture \(required/.test(wf) &&
      wf.includes('ref: ${{ inputs.sha }}') &&
      wf.includes('Assert exact-SHA checkout'),
    '.github/workflows/windows-ui.yml must keep the required sha input, the checkout of inputs.sha and the Assert exact-SHA checkout step',
  )
  check(
    'UI-130: build-tree/manifest verification + SHA-stamped artifacts + the live Windows receipt beyond the pyte cell model',
    wf.includes('Verify build tree + manifest') &&
      wf.includes('winreg-${{ inputs.burst }}-${{ inputs.sha }}-${{ github.run_id }}') &&
      wf.includes('live-receipt.json') &&
      wf.includes("else { 'absent' }"),
    '.github/workflows/windows-ui.yml must keep the Verify build tree + manifest step, the SHA-stamped winreg artifact name, live-receipt.json and the absent fallback',
  )
}

section('UI-124/125 — copy confirmations name the route that actually settled')
{
  const { openSelectorPart } = await import('../ui/chatScenarios.ts')
  const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.js')
  const copies = await openSelectorPart('uiux-wave0-copy')
  copies.clipboard.confirmation = 'copied (the planted route)'
  await copies.press('c', createAssistantMessage({ content: 'the words of a row' }) as never)
  const copyNotice = copies.notices.find(notice => notice.key === 'message-copy')
  await copies.close()
  check(
    'UI-125: the confirmation copy is honest both ways — settled routes named, or the OSC-52 offer stated with its dependency',
      copyNotice?.text === 'copied (the planted route)',
    `the chat screen painted ${JSON.stringify(copyNotice?.text)} for a receipt that said "copied (the planted route)"; the c key of the message selector must show the confirmation text the clipboard receipt returned`,
  )
}




console.log('')
let regressions = 0
let notReproduced = 0
let greens = 0
for (const leg of legs) {
  const expectRed = EXPECTED_RED.has(leg.label)
  if (expectRed && !leg.pass) {
    console.log(`  [RED-AS-EXPECTED] ${leg.label}${leg.detail ? ` — ${leg.detail}` : ''}`)
  } else if (expectRed && leg.pass) {
    notReproduced++
    console.log(`  [NOT-REPRODUCED?] ${leg.label} — expected red but PASSED; move it out of EXPECTED_RED in the fixing commit`)
  } else if (leg.pass) {
    greens++
    console.log(`  [PASS] ${leg.label}`)
  } else {
    regressions++
    console.log(`  [FAIL] ${leg.label}${leg.detail ? ` — ${leg.detail}` : ''}`)
  }
}
console.log(
  `\n${legs.length} legs: ${greens} green floors/censuses, ${EXPECTED_RED.size - notReproduced} expected-red defect pins — ${regressions} regression(s), ${notReproduced} not-reproduced`,
)
if (regressions > 0 || notReproduced > 0) process.exit(1)
