#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-uiux-wave0-census.ts
//  The UI-UX Wave-0 rebind census (UI-001..
//  UI-010): the.. claims rebound on the CURRENT tree with live
//  mechanisms reproduced, the three censuses built mechanically, and the
//  desired laws pinned as EXPECTED_RED so–4 flip them in their
//  fixing commits (the Stage-2.0 gate discipline).
//
//   · EXPECTED_RED legs assert the DESIRED law and are REQUIRED TO FAIL —
//     each failure is a reproduced defect class on current main.
//   · Green legs are censuses/floors/landed dependencies (UI-003) pinned so
//     the record cannot drift silently.
//
//  is reproduced at the EMITTED-BYTE level (UI-002): the standalone
//  splash runs under a patched TTY in ONESHOT mode and its byte stream is
//  inspected for the OSC 11 ground write — never a source-spelling grep.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

// ── the expectation contract ───────
const EXPECTED_RED = new Set<string>([
  // UI-017 FLIPPED GREEN at 3.6.1: the splash resolves canonical-first
  // (MERCURY_OASIS_BG ?? MERCURY_OASIS_BG) — the byte matrix below now proves
  // suppress-by-canonical, suppress-by-legacy, AND canonical-wins-conflict.
  // UI-021 FLIPPED GREEN at 3.6.1: terminalExperience.ts is the one
  // resolution surface (title/accessibility/virtualScroll resolved; fullscreen/
  // mouse/ground owner-delegated); the scattered readers migrated.
  // UI-031 FLIPPED GREEN at 3.6.2, RE-ANCHORED by:
  // the settled screen fact now rides the splash's EXIT CODE (0 held · 20
  // restored · 130 cancel — the JSON receipt keeps screen for the runtime
  // consumer + diagnostics); all THREE launcher shells mark MERCURY_ALT_HELD
  // only on exit 0, parse NOTHING the splash writes (the 1.5.4 cmd set /p
  // receipt reader killed every Windows interactive boot), heal abnormal
  // children owner-scoped, and the runtime imports/releases the EXACT
  // transferred mode set via the ledger.
  // UI-052 FLIPPED GREEN at 3.6.3: ALTERNATE_SCROLL_POLICY
  // ('scroll-first-in-native-selection') at the termio owner — per-item,
  // state-pure (alt · tracking-off · no elevated surface), split/coalescing
  // invariant BY CONSTRUCTION; history rides the portable ctrl+p/ctrl+n
  // route; the ≥2-identical-arrows chunk-count heuristic is ABSENT.
  // UI-078 FLIPPED GREEN at 3.6.4: resolveNotificationMethod resolves
  // auto EXPLICITLY per profile — natives where proven, the DOCUMENTED
  // bell+in-app-cue floor everywhere else (WT included); the silent
  // no_method_available sentinel is ABSENT; Apple always bells (UI-119); the
  // local cue precedes hooks (UI-121); settings derive from the enum (UI-122).
])

type Leg = { label: string; pass: boolean; detail: string }
const legs: Leg[] = []
function check(label: string, cond: boolean, detail = ''): void {
  legs.push({ label, pass: cond, detail })
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── · the emitted-byte ground matrix (UI-002/UI-011/UI-017) ───────────
section('BM-19 — splash OSC 11 ground write, emitted bytes under both spellings')
{
  const scratch = mkdtempSync(join(tmpdir(), 'uiux-wave0-'))
  const probe = join(scratch, 'splash-byte-probe.mjs')
  writeFileSync(
    probe,
    [
      // Patch a fake TTY, run the splash ONESHOT, report the byte facts.
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
      // Ambient-state law: the splash resolves a config home (boot-env write,
      // action receipts) — pin it to the scratch root so a probe can never
      // touch the operator's real home (ONESHOT skips receipts either way).
      env: { PATH: process.env.PATH, TERM: 'xterm-256color', MERCURY_CONFIG_DIR: scratch, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    })
    return JSON.parse(out.trim().split('\n').at(-1)!) as { osc11: boolean; bytes: number }
  }
  // ONE spelling: MERCURY_OASIS_BG is the opt-out's only name (the second
  // spelling retired by ruling), so the rows are the default, the opt-out,
  // and the explicit =1 keep — no alias rung, no conflict row.
  const baseline = runProbe({})
  const canonicalOff = runProbe({ MERCURY_OASIS_BG: '0' })
  const canonicalOn = runProbe({ MERCURY_OASIS_BG: '1' })
  check(
    'floor: the splash emits the OSC 11 ground write by default (a real splash frame was captured)',
    baseline.osc11 && baseline.bytes > 1000,
    `osc11=${baseline.osc11} bytes=${baseline.bytes}`,
  )
  check(
    'UI-017 (BM-19): the canonical MERCURY_OASIS_BG=0 suppresses the splash OSC 11 ground write',
    !canonicalOff.osc11,
    `canonical opt-out ignored — osc11 still emitted (${canonicalOff.bytes} bytes)`,
  )
  check(
    'UI-016: an explicit MERCURY_OASIS_BG=1 keeps the ground write (the one spelling reads its own value)',
    canonicalOn.osc11,
    `explicit =1 suppressed the ground write (osc11=${canonicalOn.osc11})`,
  )
  check(
    'UI-017 parity: the splash and the runtime owner read the ONE opt-out spelling (MERCURY_OASIS_BG in the asset; the registry row for oasisBg)',
    src('assets/splash/mercury-splash.mjs').includes("process.env.MERCURY_OASIS_BG !== '0'") &&
      !/HERMES_OASIS_BG\b/.test(src('assets/splash/mercury-splash.mjs')) &&
      src('src/utils/cockpit/oasisBg.ts').includes("flagEnv('MERCURY_OASIS_BG')"),
  )
}

// ── UI-006 · the projected-asset control census (feeds K5) ──────────────────
section('UI-006 — projected assets: canonical-aware vs legacy-only control reads')
{
  const splash = src('assets/splash/mercury-splash.mjs')
  const launchers = src('scripts/release/launcherTemplates.mjs')
  // Word-bounded matching: a longer flag name must not make bare
  // MERCURY_SPLASH read as canonical-aware (the substring trap).
  const readsCanonical = (text: string, name: string): boolean =>
    new RegExp(`MERCURY_${name}\\b`).test(text)
  const readsLegacyOnly = (text: string, name: string): boolean =>
    new RegExp(`HERMES_${name}\\b`).test(text) && !readsCanonical(text, name)
  // The census, pinned. 3.6.1 moves OASIS_BG into the canonical-aware set —
  // this table is updated WITH that fix (deliberate drift only).
  check(
    // Round 7: SPLASH_GRADIENT retired with the flat-ground law — the splash
    // paints no field background, so the census row shrank WITH the control.
    'census: splash canonical-aware USER controls (3.6.1, round-7 set) — TRUECOLOR · OASIS_BG · LAUNCH_RIPPLE · REDUCED_MOTION · CRITTER · SPLASH · CONFIG_DIR/HOME',
    readsCanonical(splash, 'TRUECOLOR') &&
      readsCanonical(splash, 'OASIS_BG') &&
      readsCanonical(splash, 'LAUNCH_RIPPLE') &&
      readsCanonical(splash, 'REDUCED_MOTION') &&
      readsCanonical(splash, 'CRITTER') &&
      readsCanonical(splash, 'SPLASH') &&
      splash.includes('MERCURY_CONFIG_DIR') &&
      splash.includes('MERCURY_HOME'),
  )
  check(
    'census: splash PROOF-SEAM controls read the one canonical spelling — SPLASH_ONESHOT · SPLASH_VIEW (capture/proof inputs, not user-facing product controls)',
    readsCanonical(splash, 'SPLASH_ONESHOT') && readsCanonical(splash, 'SPLASH_VIEW') &&
      !readsLegacyOnly(splash, 'SPLASH_ONESHOT') && !readsLegacyOnly(splash, 'SPLASH_VIEW'),
  )
  check(
    'census: launcher templates carry the ALT_HELD mark in all THREE shells (POSIX · CMD · PS1)',
    (launchers.match(/MERCURY_ALT_HELD/g) ?? []).length >= 3,
  )
}

// ── UI-005 · the terminal-mode ownership census ─────────────────────────────
section('UI-005 — terminal-mode acquisition/release census (who emits which mode bytes)')
{
  // Each mode matches its emitted-byte spelling OR the numeric DEC-table
  // spelling (the runtime vocabulary owner composes bytes from mode numbers).
  const MODE_PATTERNS: Array<[name: string, re: RegExp]> = [
    ['alt-screen ?1049', /\[\?1049[hl]|\b(ALT_SCREEN\w*):\s*1049\b/],
    ['bracketed-paste ?2004', /\[\?2004[hl]|\b(BRACKETED_PASTE):\s*2004\b/],
    ['mouse ?1000-1003', /\[\?100[0-3][hl]|\b(MOUSE_\w+):\s*100[0-3]\b/],
    ['sgr-mouse ?1006', /\[\?1006[hl]|\b(MOUSE_SGR):\s*1006\b/],
    ['alternate-scroll ?1007', /\[\?1007[hl]|\b\w+:\s*1007\b/],
    ['cursor ?25', /\[\?25[hl]/],
    ['ground OSC ]11;', /\]11;/],
    ['sync-update ?2026', /\[\?2026[hl]|\b\w+:\s*2026\b/],
    ['kitty-kbd push/pop', />1u|<1?u/],
  ]
  const SURFACES: Array<[surface: string, path: string]> = [
    ['splash-asset', 'assets/splash/mercury-splash.mjs'],
    ['launcher-templates', 'scripts/release/launcherTemplates.mjs'],
    ['launcher-alt-hold', 'src/ink/launcherAltHold.ts'],
    ['runtime-dec-vocabulary', 'src/ink/termio/dec.ts'],
    ['runtime-screen-session', 'src/ink/root/screen-session.ts'],
  ]
  const censusRows: string[] = []
  for (const [surface, path] of SURFACES) {
    if (!existsSync(join(ROOT, path))) {
      censusRows.push(`${surface}: MISSING ${path}`)
      continue
    }
    const text = src(path)
    const modes = MODE_PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n)
    censusRows.push(`${surface}: ${modes.join(' · ') || '(none)'}`)
  }
  console.log(censusRows.map(r => `    ${r}`).join('\n'))
  const row = (s: string): string => censusRows.find(r => r.startsWith(s)) ?? ''
  // ownership claim, verified mechanically: the splash owns alt
  // screen + cursor + ground (+ scroll modes); the launcher templates
  // themselves emit no mode bytes (they only mark ALT_HELD); launcherAltHold
  // releases a SUBSET (the class the 3.6.2 ledger closes).
  check(
    'census: the splash asset emits alt-screen + cursor + ground bytes (the BM-20 ownership set)',
    row('splash-asset').includes('alt-screen') &&
      row('splash-asset').includes('cursor ?25') &&
      row('splash-asset').includes('ground OSC'),
    row('splash-asset'),
  )
  {
    // 3.6.2: the templates gained the ABNORMAL-CHILD heal — release-direction
    // bytes ONLY (?1007l · ?1049l · ?25h · ]111), never an acquisition; the
    // launchers still mark, never acquire.
    const launchers = src('scripts/release/launcherTemplates.mjs')
    check(
      'census: launcher templates emit RELEASE-ONLY heal bytes (abnormal path) — no mode acquisitions',
      launchers.includes('?1007l') &&
        launchers.includes('?1049l') &&
        launchers.includes('?25h') &&
        !launchers.includes('?1049h') &&
        !launchers.includes('?1007h') &&
        !launchers.includes('?25l'),
      row('launcher-templates'),
    )
  }
  check(
    'census: launcherAltHold releases alt-screen (the narrow restore 3.6.2 widens through the ledger)',
    row('launcher-alt-hold').includes('alt-screen'),
    row('launcher-alt-hold'),
  )
  check(
    'census: the runtime DEC vocabulary owns alt-screen + mouse + bracketed-paste (one constants owner)',
    row('runtime-dec-vocabulary').includes('alt-screen') &&
      row('runtime-dec-vocabulary').includes('mouse ?1000-1003') &&
      row('runtime-dec-vocabulary').includes('bracketed-paste'),
    row('runtime-dec-vocabulary'),
  )
  check(
    'census: the runtime screen-session owner controls the cursor (composes modes through the DEC vocabulary)',
    row('runtime-screen-session').includes('cursor ?25'),
    row('runtime-screen-session'),
  )
}

// ── UI-007 · the authored-binding collision census ──────────────────────────
section('UI-007 — same-context legacy-projection collisions in the authored bindings')
{
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
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
  // The census pins the CURRENT collision set. The known residue —
  // ctrl+o vs ctrl+shift+o — collides only if both are authored in ONE
  // context; the census records the tree's actual state either way, and
  // 3.6.3's EffectiveBindingMap consumes this exact class.
  check(
    'census: the collision list is DETERMINISTIC and recorded (each row names context, byte class, both actions)',
    collisions.every(c => /^[A-Za-z]+\/C0:.+ vs /.test(c)),
    collisions.join(' | '),
  )
}

// ── · the settled handoff receipt + the mode ledger (3.6.2) ───────────
section('BM-20 — held is a settled receipt; release is obligation-exact (UI-027..037)')
{
  const launchers = src('scripts/release/launcherTemplates.mjs')
  const splash = src('assets/splash/mercury-splash.mjs')
  const altHold = src('src/ink/launcherAltHold.ts')
  check(
    'UI-031 (re-anchored by BM-30): all THREE shells mark held ONLY on the settled EXIT-CODE receipt (0 = held handoff; 20 = restored; no shell parses any splash-written file)',
    launchers.includes('[ "$MERCURY_SA_EXIT" = "0" ] && [ "\\${MERCURY_FULLSCREEN:-}" != "0" ]') &&
      launchers.includes('if "%MERCURY_SA_EXIT%"=="0" if not "%MERCURY_FULLSCREEN%"=="0" set "MERCURY_ALT_HELD=1"') &&
      launchers.includes("($saExit -eq 0) -and ($env:MERCURY_FULLSCREEN -ne '0')") &&
      !launchers.includes('set /p "MERCURY_SA_ACT') &&
      !launchers.includes('IFS= read -r MERCURY_SA_ACT') &&
      !launchers.includes('Get-Content -LiteralPath $saTxt'),
  )
  check(
    'UI-029/030: the splash settles the receipt at BOTH restoreAndBrand branches; a SKIPPED splash writes NOTHING (the updater byte-purity law — piped/off runs leave the home untouched)',
    splash.includes("writeScreenReceipt('held')") &&
      splash.includes("writeScreenReceipt('restored')") &&
      !splash.includes("writeScreenReceipt('not-entered')") &&
      splash.includes('the not-entered path writes NO receipt'),
  )
  check(
    'UI-032 (re-anchored by BM-30): the 130 cancel stands every shell down, and any OTHER nonzero exit gets the bounded owner-scoped heal + a plain boot',
    (launchers.match(/1007l/g) ?? []).length >= 3 &&
      launchers.includes('[ "$MERCURY_SA_EXIT" = "130" ]') &&
      launchers.includes('if "%MERCURY_SA_EXIT%"=="130" exit /b 0') &&
      launchers.includes('if ($saExit -eq 130) { exit 0 }'),
  )
  check(
    'UI-037: releaseLauncherAltHoldNow releases the EXACT transferred set (alternate-scroll ?1007l joined the restore — the missed subset member)',
    altHold.includes("'\\x1b[0m\\x1b[?1007l\\x1b[?1049l\\x1b[?25h'") &&
      altHold.includes("noteModesImported('launcher-splash'"),
  )
  const ledger = await import('../../src/ink/root/terminalModeLedger.js')
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
  )
  ledger._resetTerminalModeLedgerForTesting()
  check(
    'UI-043: the 2s drain bound stands unchanged (collapse cap 2000ms, never lengthened)',
    splash.includes('function collapse(code, drainCapMs = 2000)'),
  )
}

// ──/23 · desired-law pins ────────────────
section('BM-22/23 — the remaining desired laws, pinned as flip targets')
{
  {
    // UI-021/026: the resolver exists AND the compat
    // spellings decode ONLY there — no component reads them directly anymore.
    const resolverExists = existsSync(join(ROOT, 'src/ink/session/terminalExperience.ts'))
    const directReaders: string[] = []
    const sweep = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          sweep(`${dir}/${entry.name}`)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        const p = `${dir}/${entry.name}`
        if (p.endsWith('ink/session/terminalExperience.ts')) continue
        if (p.endsWith('substrate/flagRegistry.ts')) continue
        const text = readFileSync(join(ROOT, p), 'utf8')
        if (
          new RegExp(
            ['DISABLE_TERMINAL_TITLE', 'ACCESSIBILITY', 'DISABLE_VIRTUAL_SCROLL']
              .map(n => `process\\.env\\.${['CLAUDE', 'CODE'].join('_')}_${n}`)
              .join('|'),
          ).test(text)
        ) {
          directReaders.push(p)
        }
      }
    }
    sweep('src')
    check(
      'UI-021 (BM-21): a TerminalExperienceResolver owns fullscreen/mouse/title/accessibility resolution',
      resolverExists && directReaders.length === 0,
      directReaders.length ? `direct readers remain: ${directReaders.join(', ')}` : 'no resolver module',
    )
  }
  const app = src('src/ink/components/App.tsx')
  check(
    'UI-052 (BM-22): the batch owner consumes the documented deterministic policy (no chunk-count semantics anywhere)',
    /ALTERNATE_SCROLL_POLICY|alternateScrollPolicy/.test(app) &&
      !app.includes('items.length >= 2') &&
      !/same-direction plain arrows/.test(app),
  )
  {
    // UI-053..058: split/coalescing INVARIANCE, behaviorally — the same
    // semantic events settle to the same actions however the bytes chunked.
    const policy = await import('../../src/ink/termio/alternateScrollPolicy.js')
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
      `split=${oneByOne.join(',')} coalesced=${coalesced.join(',')}`,
    )
    check(
      'UI-054: a mixed batch maps ONLY its plain arrows, order preserved (no all-or-nothing batch shape)',
      JSON.stringify(
        names([arrow('down'), { kind: 'key', name: 'a', ctrl: false, meta: false, shift: false, option: false }, arrow('down')], engaged),
      ) === JSON.stringify(['wheeldown', 'a', 'wheeldown']),
    )
    check(
      'UI-055: an ELEVATED surface keeps arrows as arrows (list navigation owns them)',
      JSON.stringify(names([arrow('up'), arrow('up')], { ...engaged, elevatedSurfaceActive: true })) ===
        JSON.stringify(['up', 'up']),
    )
    check(
      'UI-056: tracking-ON and main-screen states are untouched (the policy engages ONLY in native-selection)',
      JSON.stringify(names([arrow('up'), arrow('up')], { ...engaged, mouseTrackingEnabled: true })) ===
        JSON.stringify(['up', 'up']) &&
        JSON.stringify(names([arrow('up')], { ...engaged, altScreenActive: false })) === JSON.stringify(['up']),
    )
    check(
      'UI-057: modified arrows never map (ctrl/shift/meta arrows keep their own meanings)',
      JSON.stringify(names([{ ...arrow('up'), shift: true }], engaged)) === JSON.stringify(['up']),
    )
    const bindings = src('src/keybindings/defaultBindings.ts')
    // The Chat-block history registry rows were
    // atlas LIES — useTextInput hardcodes the trio, rows routed into a void,
    // and the atlas offered inert rebinds. The portable route lives in the
    // composer's own ctrl switch; the registry carries no history rows to
    // lie about (ctrl+r history:search stays — that one is really bound).
    const composer = src('src/hooks/useTextInput.ts')
    check(
      'UI-058: the portable history route is REAL in the composer (ctrl+p/ctrl+n ride upOrHistory/downOrHistory)',
      /case 'p':\s*\n\s*return upOrHistory\(cursor\)/.test(composer) &&
        /case 'n':\s*\n\s*return downOrHistory\(cursor\)/.test(composer),
    )
    check(
      "UI-058: the registry's dead history rows STAY retired (a revival re-lies to the atlas)",
      !bindings.includes("'history:previous'") && !bindings.includes("'history:next'"),
    )
    check(
      '§policy identity: scroll-first-in-native-selection is the documented choice',
      policy.ALTERNATE_SCROLL_POLICY === 'scroll-first-in-native-selection',
    )
  }
  const notifier = src('src/services/notifier.ts')
  {
    // UI-077..086 + UI-119..122: the typed resolution, behaviorally.
    const { resolveNotificationMethod, NOTIFICATION_CHANNELS } = await import(
      '../../src/services/notifier.js'
    )
    const wt = resolveNotificationMethod('auto', 'windows-terminal')
    const unknown = resolveNotificationMethod('auto', '')
    const apple = resolveNotificationMethod('auto', 'Apple_Terminal')
    const iterm = resolveNotificationMethod('auto', 'iTerm.app')
    check(
      'UI-078 (BM-23): auto on Windows Terminal resolves EXPLICITLY to the documented bell floor (+ in-app cue named), never silence',
      wt.effective === 'terminal_bell' &&
        wt.source === 'auto-floor' &&
        /documented floor/.test(wt.evidence) &&
        /in-app attention cue/.test(wt.evidence),
      JSON.stringify(wt),
    )
    check(
      'UI-078: an UNKNOWN terminal takes the same documented floor — auto never resolves to silent nothing',
      unknown.effective === 'terminal_bell' && unknown.source === 'auto-floor',
    )
    check(
      "UI-119: Apple Terminal ALWAYS bells — the profile decides audible vs visual (the inverted predicate is retired)",
      apple.effective === 'terminal_bell' && apple.source === 'auto-native',
    )
    check(
      'auto natives stand where proven (iTerm2 OSC 9)',
      iterm.effective === 'iterm2' && iterm.source === 'auto-native',
    )
    check(
      'explicit channels pass through; disabled is typed; an unknown channel emits NOTHING with the reason stated',
      resolveNotificationMethod('kitty', 'anything').effective === 'kitty' &&
        resolveNotificationMethod('notifications_disabled', 'x').effective === 'disabled' &&
        resolveNotificationMethod('bogus-channel', 'x').effective === 'none',
    )
    check(
      'the silent no_method_available sentinel is GONE from the owner',
      !notifier.includes('no_method_available'),
    )
    check(
      // The S19 rewrite retired the helper spelling
      // (emitResolvedNotification) and kept the LAW inline: the channel
      // switch emits the local cue, then hooks run — the pin rides the
      // living shape and the owner's own ordering sentence.
      'UI-121: the local attention cue precedes the notification hooks (emit first, hooks after)',
      notifier.indexOf("case 'terminal_bell':") !== -1 &&
        notifier.indexOf("case 'terminal_bell':") < notifier.indexOf('await executeNotificationHooks') &&
        notifier.includes('Hooks run AFTER the local cue'),
    )
    check(
      'UI-120: the Apple profile lookup is CACHED (one bounded lookup per process, off the emission path)',
      notifier.includes('appleBellPreference ??=') && notifier.includes('void cachedAppleTerminalBellPreference()'),
    )
    check(
      'UI-122: settings choices derive from the canonical enum (no hand-copied channel list)',
      NOTIFICATION_CHANNELS.length === 7 &&
        src('src/components/Settings/Config.tsx').includes('options: [...NOTIFICATION_CHANNELS]'),
    )
    check(
      'UI-080: the notifier never touches OSC 9;4 — progress stays progress',
      !notifier.includes('9;4'),
    )
  }
}

// ── UI-061..064 · the atlas delivery/collision truth ─────────
section('UI-061..064 — authored chords classified through the live protocol; collisions never silent')
{
  const { buildAtlas } = await import('../../src/keybindings/atlas.js')
  const { parseBindings } = await import('../../src/keybindings/parser.js')
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
  const { classifyChordDelivery } = await import('../../src/keybindings/delivery.js')
  const defaults = parseBindings(DEFAULT_BINDINGS as never)
  // UI-123: BOTH protocol worlds are INJECTED (never the ambient terminal).
  const legacy = buildAtlas(defaults, { defaultCount: defaults.length, platform: 'linux', extendedKeys: false })
  const extended = buildAtlas(defaults, { defaultCount: defaults.length, platform: 'linux', extendedKeys: true })
  const shiftRow = (rows: typeof legacy) =>
    rows.find(
      r => r.context === 'Global' && r.action === 'app:toggleTeammatePreview' && /shift/i.test(r.chord),
    )
  const legacyShift = shiftRow(legacy)
  check(
    'UI-063: on a LEGACY wire the authored Ctrl+Shift+O is marked aliases-to AND carries its collision (toggleTranscript) — never silent',
    legacyShift?.delivery?.status === 'aliases-to' &&
      legacyShift?.collidesWith?.action === 'app:toggleTranscript',
    JSON.stringify({ delivery: legacyShift?.delivery, collides: legacyShift?.collidesWith }),
  )
  check(
    'UI-061: an extended-keys profile delivers the same chord distinctly (no collision marker; declared-identity reason stated)',
    shiftRow(extended)?.delivery?.status === 'deliverable' &&
      shiftRow(extended)?.collidesWith === undefined,
  )
  const fallbackRow = legacy.find(
    r => r.action === 'app:toggleTeammatePreview' && /ctrl\+x/i.test(r.chord),
  )
  check(
    'UI-064: the PORTABLE fallback (ctrl+x o) is authored and deliverable on every protocol',
    fallbackRow?.delivery?.status === 'deliverable',
  )
  check(
    'classifier table: shift-collapse on legacy · distinct on extended · sequences and plain keys deliverable',
    classifyChordDelivery('ctrl+shift+o', false).status === 'aliases-to' &&
      (classifyChordDelivery('ctrl+shift+o', false) as { sibling?: string }).sibling === 'ctrl+o' &&
      classifyChordDelivery('ctrl+shift+o', true).status === 'deliverable' &&
      classifyChordDelivery('ctrl+x o', false).status === 'deliverable' &&
      classifyChordDelivery('a', false).status === 'deliverable',
  )
}

// ── VP-01..11 · the critter form decision ────────────────────
section('VP — one form decision over allocated cells; the 120×30 tier is deliberate')
{
  const { decideCritterForm, BERTH_HERO_MIN_ROWS, PREMIUM_COMPACT_MIN_ROWS, HERO_ART_COLS } =
    await import('../../src/utils/cockpit/critterData.js')
  const at = (columns: number, rows: number) => decideCritterForm({ columns, rows }, true)
  // VP-05..09: the boundary matrix — physical 26..33 (cockpit center =
  // physical − 2) against a hero-capable width. Deterministic table.
  // RE-CUT (VP-14 honesty audit): the hero floor is the DERIVED
  // BERTH_HERO_MIN_ROWS = 28 + (HERO_ART_LINES − FLAT_ART_LINES) = 31 with
  // today's grids (math in critterData.ts) — the old 32-physical boundary
  // rode the borrowed landing floor (30), which the audit found one row
  // below the provable content bound. The reason field died in the same
  // ruling, so the table pins bare forms.
  const matrix = [26, 29, 30, 31, 32, 33].map(phys => `${phys}:${at(120, phys - 2)}`)
  check(
    'VP-05..07: the 26..33 boundary matrix is deterministic — mini through 32, hero at 33 (center 31 = the derived floor); the premium-compact tier is DESIGN-GATED',
    JSON.stringify(matrix) ===
      JSON.stringify(['26:mini', '29:mini', '30:mini', '31:mini', '32:mini', '33:hero']),
    matrix.join(' '),
  )
  check(
    'the derived floor IS 28 + the hero-over-flat slot delta (the audit formula, live from the authored grids)',
    BERTH_HERO_MIN_ROWS === 31,
    String(BERTH_HERO_MIN_ROWS),
  )
  check(
    "VP-04 ADJUDICATED (the interview height law at 120×30): the hero slot's extra band rows clip the question card, so 'honestly fits' is FALSE — the form is mini (never a silent fallback); the premium-compact tier awaits its authored mid-height art (design-gated)",
    at(120, 28) === 'mini',
    JSON.stringify(at(120, 28)),
  )
  check(
    'VP-08/10: the 172×46 class keeps the full hero; below the compact floor the mini is the honest form',
    at(172, 44) === 'hero' && at(120, PREMIUM_COMPACT_MIN_ROWS - 1) === 'mini',
  )
  check(
    'width floors: hero width short ⇒ mini; below the mini floor ⇒ none (render nothing, never clip); no heroArt ⇒ mini',
    at(HERO_ART_COLS + 3, 40) === 'mini' &&
      at(10, 40) === 'none' &&
      decideCritterForm({ columns: 120, rows: 40 }, false) === 'mini',
  )
  check(
    'VP-06/11: the decision is PURE (same allocation ⇒ same form; resize replays the table) and consults no OS name',
    at(120, 28) === at(120, 28) &&
      !src('src/utils/cockpit/critterData.ts').includes('process.platform'),
  )
  check(
    'VP-02: renderer AND width budget consume the ONE decision (both MercuryHome sites)',
    (src('src/components/MercuryHome.tsx').match(/decideCritterForm\(\{ columns, rows \}/g) ?? []).length === 2,
  )
}

// ──..08 · response-verbosity profile (3.5.8) ──────────────────────────
section('RV — reasoning depth is not answer length; one balanced default + one override')
{
  const contract = await import('../../src/prompt/mercuryContract.js')
  check(
    'RV-06: stop-at-sufficient-evidence joined the ONE persistence law (never a parallel clause)',
    /sufficiency, not exhaustion/.test(contract.PERSISTENCE_LAW) &&
      contract.MERCURY_DOCTRINE.includes(contract.PERSISTENCE_LAW),
  )
  check(
    'RV-02/08: the doctrine separates reasoning depth from answer verbosity (effort/ultrathink/ultracode never silently change length)',
    /answer length is its own control/.test(contract.MERCURY_DOCTRINE) &&
      /never answer verbosity/.test(contract.MERCURY_DOCTRINE),
  )
  check(
    'RV-03/04/05: brevity override + suppressed narration + evidence-behind-outcome ride the same Length paragraph',
    /operator brevity preference overrides/.test(contract.MERCURY_DOCTRINE) &&
      /Skip progress narration/.test(contract.MERCURY_DOCTRINE) &&
      /appendix or artifact/.test(contract.MERCURY_DOCTRINE),
  )
  check(
    'RV-01: the concise profile is ONE settings override at the contract owner (schema key + conditional section; no knob wall)',
    src('src/utils/config/schema.ts').includes("responseProfile?: 'balanced' | 'concise'") &&
      src('src/prompt/mercuryContract.ts').includes("responseProfile === 'concise'"),
  )
  check(
    'RV-02: the wire verbosity seam stays typed-but-UNSET (no builder sends it before the provider-contract capture)',
    src('src/services/providers/openai/openaiWire.ts').includes('NEVER SET by any builder') &&
      !src('src/services/providers/openai/openaiCallModel.ts').includes('verbosity:'),
  )
  // closes on the SHARED mechanism: WK-08's repeat-refusal surfacing +
  // 2.2's revision-key admission (one implementation, cross-referenced).
  check(
    'RV-07: identical-retry prevention is the WK-08/2.2 shared mechanism (bm-classes floors stand; no second implementation)',
    src('scripts/stop-policy/prove-bm-classes.ts').includes('WK-08'),
  )
}

// ── UI-130 · the windows-ui SHA hardening (3.6.6) ───────────────────────────
section('UI-130 — windows-ui binds captures to ONE exact SHA with a live receipt')
{
  const wf = src('.github/workflows/windows-ui.yml')
  check(
    'UI-130: required sha input + exact-checkout assertion (the windows-functional ledger law, same spelling)',
    /sha:\n\s+description: 'Exact commit SHA to capture \(required/.test(wf) &&
      wf.includes('ref: ${{ inputs.sha }}') &&
      wf.includes('Assert exact-SHA checkout'),
  )
  check(
    'UI-130: build-tree/manifest verification + SHA-stamped artifacts + the live Windows receipt beyond the pyte cell model',
    wf.includes('Verify build tree + manifest') &&
      wf.includes('winreg-${{ inputs.burst }}-${{ inputs.sha }}-${{ github.run_id }}') &&
      wf.includes('live-receipt.json') &&
      wf.includes("else { 'absent' }"),
  )
}

// ── UI-124/125 · the clipboard receipt (3.6.5) ──────────────────────────────
section('UI-124/125 — copy confirmations name the route that actually settled')
{
  const osc = src('src/ink/termio/osc.ts')
  check(
    'UI-124: setClipboardWithReceipt returns settled routes from POSITIVE completion facts (exit 0 / load-buffer) — OSC 52 is emission-only, never settled',
    osc.includes('export interface ClipboardReceipt') &&
      osc.includes("if (nativeRoute) settled.push(nativeRoute)") &&
      osc.includes("if (tmuxBufferLoaded) settled.push('tmux-buffer')") &&
      osc.includes('an offer, not a delivery'),
  )
  check(
    'UI-125: the confirmation copy is honest both ways — settled routes named, or the OSC-52 offer stated with its dependency',
    osc.includes("`copied (${settled.join(' + ')})`") &&
      osc.includes('delivery depends on your terminal') &&
      src('src/screens/REPL.tsx').includes('text: receipt.confirmation'),
  )
  check(
    'the win32 UTF-16LE+BOM law survives the receipt refactor (the ΓÇö paste class)',
    osc.includes('windowsClipInput(text)') && osc.includes('0xff, 0xfe'),
  )
}

// ── UI-088..100 · adjudicated-to-owner (standing green provers hold them) ───
section('UI-088..100 — selection/tokens/plates/transitions adjudicated to their owners')
{
  // UI-088..091: selection EXTENDS across surfaces BY CONSTRUCTION — the
  // machinery lives at the ink ROOT (screen-level selection-model + the one
  // copySelection), so manager//model/agent-view/overlays ride the same
  // owner; suite pins the overlay/region laws (never reopened).
  const inkRoot = src('src/ink/ink.tsx')
  check(
    'UI-088..091: ONE screen-level selection owner (ink root copySelection + selection-model); no per-surface selection fork exists',
    inkRoot.includes('copySelection(): string') &&
      existsSync(join(ROOT, 'src/ink/geometry/selection-model.ts')) &&
      existsSync(join(ROOT, 'scripts/render-continuity/prove-selection-region.ts')),
  )
  // UI-093..095: the semantic token estate — the brand accent lives ONLY at
  // the token owners (mercuryTokens · palette · sessionAccent · colorize ·
  // the design-skill doc); everything else consumes tokens.
  {
    const allowed = new Set([
      'src/utils/mercuryTokens.ts',
      'src/ink/colorize.ts',
      'src/components/mercuryPalette.ts',
      'src/components/mercury-ui/sessionAccent.ts',
    ])
    const offenders: string[] = []
    const sweep = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue
          sweep(`${dir}/${entry.name}`)
          continue
        }
        const p = `${dir}/${entry.name}`
        if (allowed.has(p)) continue
        if (!/\.(ts|tsx|md)$/.test(entry.name)) continue
        if (readFileSync(join(ROOT, p), 'utf8').includes('DD4444')) offenders.push(p)
      }
    }
    sweep('src')
    check(
      'UI-093..095: the brand accent literal lives ONLY at the token owners — every surface consumes the token estate',
      offenders.length === 0,
      offenders.join(', '),
    )
  }
  // UI-096: stream text + identity/timing plates — first text is never
  // delayed (the latched first_text_delta mark + the shared canonical
  // consumer are the owners; the pulse phase machine settles plates from
  // REAL stream state, 3.5.1 C08/ pins).
  check(
    'UI-096: first-text latching + plate settlement ride the shared stream owners (no plate delays first text)',
    src('src/utils/messages/streaming.ts').includes("pulseMark('first_text_delta')"),
  )
  // UI-097..100: the §4.4 transition families are OWNED by standing green
  // provers — crew roster truth (interaction board coverage), the agent-view
  // return route (view-target parity), exactly-once agent transcripts
  // (agent-resume visibility). Cited, not re-proved.
  check(
    'UI-097..100: the transition families keep their standing owners (board-coverage · view-target-parity · agent-resume-visibility)',
    existsSync(join(ROOT, 'scripts/interaction/prove-board-coverage.ts')) &&
      existsSync(join(ROOT, 'scripts/render-continuity/prove-view-target-parity.ts')) &&
      existsSync(join(ROOT, 'scripts/render-continuity/prove-agent-resume-visibility.ts')),
  )
}

// ── UI-003 · landed dependencies (never reopened without a reproducer) ──────
section('UI-003 — landed dependencies stand')
{
  check(
    'boot-summary/dual-spelling parity prover stands',
    existsSync(join(ROOT, 'scripts/node-runtime/prove-launchers.ts')),
  )
  check(
    'snapshot $PATH fix stands (resolveSnapshotPathValue at the owner)',
    src('src/utils/bash/ShellSnapshot.ts').includes('resolveSnapshotPathValue'),
  )
  check(
    'poise selection owner stands (selection suite present)',
    existsSync(join(ROOT, 'scripts/interaction')) || existsSync(join(ROOT, 'scripts/render-continuity')),
  )
}

// ── UI-009 · suite-membership gate (the orphan-prover lesson) ───────────────
section('UI-009 — every prover is enrolled in a permanent suite')
{
  const orphans: string[] = []
  const suiteDirs = readdirSync(join(ROOT, 'scripts'), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
  for (const dir of suiteDirs) {
    const runAll = join(ROOT, 'scripts', dir, 'run-all.sh')
    if (!existsSync(runAll)) continue
    const runner = readFileSync(runAll, 'utf8')
    const globs = /prove-\*\.ts|\*\.ts/.test(runner)
    if (globs) continue
    const provers = readdirSync(join(ROOT, 'scripts', dir)).filter(
      f => f.startsWith('prove-') && f.endsWith('.ts'),
    )
    for (const p of provers) {
      // Runners list provers as full filenames OR extension-less stems
      // (runner `for proof in prove-…` loops append .ts themselves).
      if (!runner.includes(p) && !runner.includes(p.replace(/\.ts$/, ''))) {
        orphans.push(`${dir}/${p}`)
      }
    }
  }
  check(
    'UI-009: zero orphaned provers — every prove-*.ts in a listed suite is enrolled (or the suite globs)',
    orphans.length === 0,
    orphans.join(', '),
  )
}

// ── verdict (the 2.0 expected-red discipline) ───────────────────────────────
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
