#!/usr/bin/env bun
// ============================================================================
//  scripts/wards/prove-wards.ts
//  PROOF: the content-rule wards (MERCURY_WARDS, default-ON) — engine,
//  hook registration, and wiring.
//
//  Contract proven here:
//   1. GATE — fork+unset ⇒ enabled (default-on); =0 ⇒ register returns null
//      and adds NOTHING (the plain PreToolUse path); bare-stamp ⇒ null.
//   2. ENGINE — the builtin hard rules (wards.ts BUILTIN) deny exactly what they name:
//      NEW hex in a component (Edit delta-aware: moved hex passes; theme files
//      exempt; comment lines exempt), emoji in TUI source, force-push to
//      main/master (both flag orders; --force-with-lease and topic branches
//      pass). Benign calls pass. Project rules parse defensively.
//   3. HOOK — fixed id, PreToolUse matcher covers Edit|Write|NotebookEdit|
//      Bash|PowerShell, denial returns a TEACHING string naming the rule,
//      re-violation re-denies (hard-rule semantics), the session cap stands
//      down, idempotent re-register, live =0 re-read stands down mid-session.
//   4. WIRING — both registration chokepoints (REPL mount + QueryEngine) call
//      registerWardsHook, never mode-skipped.
//
//  Run:  ~/.bun/bin/bun run scripts/wards/prove-wards.ts
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  delete process.env.MERCURY_WARDS
  const {
    BUILTIN_WARDS,
    WARDS_TOOL_MATCHER,
    evaluateWards,
    parseProjectWards,
    buildWardDenial,
  } = await import('../../src/utils/wards/wards.js')
  const { registerWardsHook, resetWardsEngagedSessionsForTest, wardsEnabled, WARDS_HOOK_ID } =
    await import('../../src/utils/hooks/wardsHook.js')
  const { getSessionFunctionHooks } = await import('../../src/utils/hooks/sessionHooks.js')

  type AnyState = { sessionHooks: Map<string, unknown> } & Record<string, unknown>
  const makeStore = () => {
    let state: AnyState = { sessionHooks: new Map() }
    const setAppState = (updater: (prev: AnyState) => AnyState) => {
      state = updater(state)
    }
    return { setAppState: setAppState as never, get: () => state }
  }
  const edit = (file_path: string, new_string: string, old_string = '') => ({
    toolName: 'Edit',
    input: { file_path, old_string, new_string },
  })
  const write = (file_path: string, content: string) => ({
    toolName: 'Write',
    input: { file_path, content },
  })
  const bash = (command: string) => ({ toolName: 'Bash', input: { command } })
  const denies = (v: ReturnType<typeof evaluateWards>): boolean => v.allow === false

  console.log('============================================================')
  console.log(' content-rule wards (MERCURY_WARDS) — proof')
  console.log('============================================================')

  section('1. gate — default-on semantics')
  {
    check('unset ⇒ enabled', wardsEnabled() === true)
    const store = makeStore()
    resetWardsEngagedSessionsForTest()
    process.env.MERCURY_WARDS = '0'
    check('=0 ⇒ register returns null', registerWardsHook(store.setAppState, 'w-off') === null)
    check('nothing added to session hooks', store.get().sessionHooks.size === 0)
    delete process.env.MERCURY_WARDS
    const macroKey = 'MACRO'
    const saved = (globalThis as Record<string, unknown>)[macroKey]
    ;(globalThis as Record<string, unknown>)[macroKey] = { VERSION: '0.0.0-src' } // default-shaped stamp
    // wards register regardless of stamp.
    check('bare stamp ⇒ STILL registers (stamp-independence)', registerWardsHook(store.setAppState, 'w-bare') !== null)
    resetWardsEngagedSessionsForTest()
    ;(globalThis as Record<string, unknown>)[macroKey] = saved
  }

  section('2. engine — the builtin hard rules')
  {
    const rules = BUILTIN_WARDS
    check(
      'NEW hex in a component Edit ⇒ denied',
      denies(evaluateWards(rules, edit('src/components/Foo.tsx', "const c = '#AB12CD'"))),
    )
    check(
      'moved hex (present in old_string) ⇒ passes (delta-aware)',
      !denies(
        evaluateWards(
          rules,
          edit('src/components/Foo.tsx', "const c = '#AB12CD'", "let c = '#AB12CD'"),
        ),
      ),
    )
    check(
      'hex in mercuryPalette.ts ⇒ passes (sanctioned holder)',
      !denies(evaluateWards(rules, edit('src/components/mercuryPalette.ts', "terra: '#DD4444',"))),
    )
    check(
      'hex in sessionAccent.ts ⇒ passes (sanctioned holder)',
      !denies(
        evaluateWards(rules, edit('src/components/mercury-ui/sessionAccent.ts', "'#AA00AA'")),
      ),
    )
    check(
      'hex on a comment line ⇒ passes',
      !denies(
        evaluateWards(rules, edit('src/components/Foo.tsx', '// the accent is #DD4444 in mercuryPalette')),
      ),
    )
    check(
      'hex outside the UI trees ⇒ passes (scope-gated)',
      !denies(evaluateWards(rules, edit('src/utils/thing.ts', "const c = '#AB12CD'"))),
    )
    check(
      'Write with hex into a screen file ⇒ denied',
      denies(evaluateWards(rules, write('src/screens/Bar.tsx', "export const X = '#123456'\n"))),
    )
    check(
      'emoji in a component Edit ⇒ denied',
      denies(evaluateWards(rules, edit('src/components/Foo.tsx', "const s = '\u{1F389} done'"))),
    )
    check(
      'variation-selector emoji form ⇒ denied',
      denies(evaluateWards(rules, edit('src/components/Foo.tsx', "const s = '⚠️ warn'"))),
    )
    check(
      'sanctioned glyphs (dingbat/geometric) ⇒ pass',
      !denies(evaluateWards(rules, edit('src/components/Foo.tsx', "const g = '◐ ✶ ▸'"))),
    )
    check(
      'force-push main ⇒ denied (--force after ref)',
      denies(evaluateWards(rules, bash('git push origin main --force'))),
    )
    check(
      'force-push main ⇒ denied (-f before ref)',
      denies(evaluateWards(rules, bash('git push -f origin main'))),
    )
    check(
      '--force-with-lease ⇒ passes',
      !denies(evaluateWards(rules, bash('git push --force-with-lease origin main'))),
    )
    check(
      'force-push a topic branch ⇒ passes',
      !denies(evaluateWards(rules, bash('git push -f origin feature/wards'))),
    )
    check(
      'force-push a party/* lane branch ⇒ denied (federation FC4)',
      denies(evaluateWards(rules, bash('git push --force origin party/user1/recon'))),
    )
    check(
      'plain push a party/* lane ⇒ passes',
      !denies(evaluateWards(rules, bash('git push origin party/user1/recon'))),
    )
    check(
      'plain push main ⇒ passes',
      !denies(evaluateWards(rules, bash('git push origin main'))),
    )
    const denial = evaluateWards(rules, edit('src/components/Foo.tsx', "c = '#AB12CD'"))
    check(
      'denial text names the rule + teaches the alternative',
      denial.allow === false &&
        buildWardDenial(denial, 'Edit').includes('no-new-hex-outside-theme') &&
        buildWardDenial(denial, 'Edit').includes('mercuryPalette'),
    )
  }

  section('3. project rules — defensive parse')
  {
    const good = JSON.stringify([
      { name: 'no-todo-bombs', teach: 'No TODO bombs.', scope: 'edit', patterns: ['TODO\\(later\\)'] },
      { name: 'broken', teach: 'x', scope: 'edit' }, // missing patterns ⇒ dropped
      'garbage',
    ])
    const rules = parseProjectWards(good)
    check('valid entry parsed, invalid dropped', rules.length === 1 && rules[0]?.name === 'no-todo-bombs')
    check('malformed JSON ⇒ empty, never throws', parseProjectWards('{nope').length === 0)
    check(
      'project rule enforces (no pathPattern ⇒ every edit)',
      denies(evaluateWards(rules, edit('src/utils/x.ts', 'do TODO(later) now'))),
    )
  }

  section('3b. C7 disclosure — a wards-file problem lands on the notification channel')
  {
    const { parseProjectWardsDetailed } = await import('../../src/utils/wards/wards.js')
    const d1 = parseProjectWardsDetailed('{nope')
    check('invalid JSON ⇒ zero rules + the problem named', d1.rules.length === 0 && /not valid JSON/.test(d1.problem ?? ''))
    const d2 = parseProjectWardsDetailed('{"a":1}')
    check('non-array root ⇒ zero rules + the problem named', d2.rules.length === 0 && /not a JSON array/.test(d2.problem ?? ''))
    const d3 = parseProjectWardsDetailed(
      JSON.stringify([
        { name: 'ok', teach: 'x', scope: 'edit', patterns: ['a'] },
        { name: 'broken', teach: 'x', scope: 'edit' },
      ]),
    )
    check('partial drop ⇒ kept rules + the count named', d3.rules.length === 1 && /1 of 2 rules unreadable/.test(d3.problem ?? ''))
    check('a clean file carries NO problem', parseProjectWardsDetailed('[]').problem === undefined)

    // The REGISTRATION discloses: a scratch cwd with a broken wards.json and
    // a store carrying the notifications shape. The line must land DISPLAYED
    // (the channel door promotes) — a bare queue push would leave current
    // null until something else raised a notification.
    const { runWithCwdOverride } = await import('../../src/utils/cwd.js')
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join: joinPath } = await import('node:path')
    type NotifShown = { key?: string; text?: string } | null
    const makeNotifStore = () => {
      let state: {
        sessionHooks: Map<string, unknown>
        notifications: { current: NotifShown; queue: unknown[] }
      } = { sessionHooks: new Map(), notifications: { current: null, queue: [] } }
      const set = (updater: (prev: typeof state) => typeof state): void => {
        state = updater(state)
      }
      return { set: set as never, get: () => state }
    }
    const broken = mkdtempSync(joinPath(tmpdir(), 'wards-disclosure-'))
    mkdirSync(joinPath(broken, '.mercury'), { recursive: true })
    writeFileSync(joinPath(broken, '.mercury', 'wards.json'), '{nope')
    const bStore = makeNotifStore()
    resetWardsEngagedSessionsForTest()
    runWithCwdOverride(broken, () => registerWardsHook(bStore.set, 'w-disclose'))
    const shown = bStore.get().notifications.current
    check('the disclosure is DISPLAYED (promoted), not just queued', shown !== null && shown?.key === 'wards-file', JSON.stringify(shown))
    check(
      '…and names the file and the loss',
      /wards\.json/.test(shown?.text ?? '') && /not valid JSON/.test(shown?.text ?? '') && /OFF this session/.test(shown?.text ?? ''),
      shown?.text,
    )
    const clean = mkdtempSync(joinPath(tmpdir(), 'wards-clean-'))
    const cStore = makeNotifStore()
    resetWardsEngagedSessionsForTest()
    runWithCwdOverride(clean, () => registerWardsHook(cStore.set, 'w-clean'))
    check(
      'control: an absent wards file discloses nothing',
      cStore.get().notifications.current === null && cStore.get().notifications.queue.length === 0,
    )
    resetWardsEngagedSessionsForTest()
  }

  section('3c. FC-143 — a malformed deny never silently allows (forgive + name)')
  {
    let withReport: ((t: string) => { rules: unknown[]; problems: string[] }) | null = null
    try {
      const mod = (await import('../../src/utils/wards/wards.js')) as unknown as {
        parseProjectWardsWithReport?: (t: string) => { rules: never[]; problems: string[] }
      }
      withReport = mod.parseProjectWardsWithReport ?? null
    } catch {
      /* legs fail cleanly */
    }
    const one = (entry: Record<string, unknown>): { rules: ReturnType<typeof parseProjectWards>; problems: string[] } => {
      const text = JSON.stringify([entry])
      return withReport
        ? (withReport(text) as { rules: ReturnType<typeof parseProjectWards>; problems: string[] })
        : { rules: parseProjectWards(text), problems: [] }
    }
    const CANON = { name: 'w', teach: 't', scope: 'bash', patterns: ['FORBIDDEN-TOKEN'] }

    const control = one(CANON)
    check('canonical rule denies (control)', denies(evaluateWards(control.rules, bash('run FORBIDDEN-TOKEN now'))))
    check('… with zero problems', withReport !== null && control.problems.length === 0, JSON.stringify(control.problems))

    const caseScope = one({ ...CANON, scope: 'Bash' })
    check("scope 'Bash' folds and the deny STANDS", denies(evaluateWards(caseScope.rules, bash('run FORBIDDEN-TOKEN now'))))
    const padScope = one({ ...CANON, scope: ' bash ' })
    check("scope ' bash ' folds and the deny STANDS", denies(evaluateWards(padScope.rules, bash('run FORBIDDEN-TOKEN now'))))

    const padFlags = one({ ...CANON, flags: 'u ' })
    check("flags 'u ' clean and the deny STANDS (was: every pattern inert)", denies(evaluateWards(padFlags.rules, bash('run FORBIDDEN-TOKEN now'))))
    const spacedFlags = one({ ...CANON, flags: 'gi u' })
    check("flags 'gi u' clean and the deny STANDS", denies(evaluateWards(spacedFlags.rules, bash('run FORBIDDEN-TOKEN now'))))

    const noTeach = one({ name: 'w', scope: 'bash', patterns: ['FORBIDDEN-TOKEN'] })
    check('a missing teach is synthesized — the deny STANDS', denies(evaluateWards(noTeach.rules, bash('run FORBIDDEN-TOKEN now'))))
    const noName = one({ teach: 't', scope: 'bash', patterns: ['FORBIDDEN-TOKEN'] })
    check('a missing name is synthesized — the deny STANDS', denies(evaluateWards(noName.rules, bash('run FORBIDDEN-TOKEN now'))))

    const badScope = one({ ...CANON, scope: 'file' })
    check(
      'an unfoldable scope drops the rule WITH a problem naming it',
      badScope.rules.length === 0 && badScope.problems.some(p => p.includes('file')),
      JSON.stringify(badScope.problems),
    )
    const badPattern = one({ ...CANON, patterns: ['[unclosed'] })
    check(
      'an uncompilable pattern is named and the empty rule dropped',
      badPattern.rules.length === 0 && badPattern.problems.some(p => p.includes('does not compile') || p.includes('no usable pattern')),
      JSON.stringify(badPattern.problems),
    )
    const badJson = withReport ? withReport('{nope') : null
    check(
      'unparseable wards.json is a NAMED problem, not a silent nothing',
      badJson !== null && badJson.rules.length === 0 && badJson.problems.length > 0,
      badJson ? JSON.stringify(badJson.problems) : 'export missing',
    )
    {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const healthSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'healthReport.ts'), 'utf8')
      check(
        "doctor carries a wards row that names problems (call-shaped: id 'wards' + loadProjectWardsWithReport)",
        /id: 'wards'/.test(healthSrc) && /loadProjectWardsWithReport/.test(healthSrc),
      )
      const hookSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'hooks', 'wardsHook.ts'), 'utf8')
      check(
        'registration logs the problems (call-shaped)',
        /projectReport\.problems/.test(hookSrc),
      )
    }
  }

  section('4. armed hook — deny string, re-deny, cap, idempotent, live kill')
  {
    const store = makeStore()
    resetWardsEngagedSessionsForTest()
    const id = registerWardsHook(store.setAppState, 'w-live')
    check('register returns the fixed id', id === WARDS_HOOK_ID)
    const byEvent = getSessionFunctionHooks(
      { sessionHooks: store.get().sessionHooks } as never,
      'w-live',
      'PreToolUse',
    )
    const matchers = byEvent.get('PreToolUse' as never) ?? []
    check('matcher covers the five tools', matchers.some(m => m.matcher === WARDS_TOOL_MATCHER))
    const hooks = matchers.flatMap(
      (m: { hooks: Array<{ id?: string; callback: (mm: never[], s?: never, c?: unknown) => unknown }> }) => m.hooks,
    )
    check('exactly one wards hook armed', hooks.length === 1)
    const ctx = (toolName: string, input: Record<string, unknown>) => ({
      hookInput: { tool_name: toolName, tool_input: input },
    })
    const violating = ctx('Edit', { file_path: 'src/components/Foo.tsx', old_string: '', new_string: "c='#AB12CD'" })
    const r1 = await hooks[0]!.callback([], undefined as never, violating)
    check('violation ⇒ TEACHING string denial', typeof r1 === 'string' && r1.includes('no-new-hex-outside-theme'))
    const r2 = await hooks[0]!.callback([], undefined as never, violating)
    check('identical re-violation ⇒ re-denied (hard-rule, not deny-once)', typeof r2 === 'string')
    const benign = ctx('Bash', { command: 'git status' })
    check('benign call ⇒ allow', (await hooks[0]!.callback([], undefined as never, benign)) === true)
    check('shape surprise ⇒ fail-open allow', (await hooks[0]!.callback([], undefined as never, {})) === true)
    process.env.MERCURY_WARDS = '0'
    check('live =0 re-read ⇒ stands down mid-session', (await hooks[0]!.callback([], undefined as never, violating)) === true)
    delete process.env.MERCURY_WARDS
    // Cap: burn through the remaining denials, then expect allow.
    let last: unknown = 'x'
    for (let i = 0; i < 30; i++) last = await hooks[0]!.callback([], undefined as never, violating)
    check('session cap ⇒ stands down (never-wedge)', last === true)
    registerWardsHook(store.setAppState, 'w-live')
    const again = getSessionFunctionHooks(
      { sessionHooks: store.get().sessionHooks } as never,
      'w-live',
      'PreToolUse',
    )
    const hookCount = (again.get('PreToolUse' as never) ?? []).flatMap(m => m.hooks).length
    check('re-register is a no-op (one hook)', hookCount === 1)
  }

  section('5. wiring — the registration chokepoints, never mode-skipped')
  {
    // Law 9 hoisted the mount-effect estate: the ENGINE is the
    // one registration chokepoint for every session kind (interactive,
    // daemon-hosted, SDK/headless), and print.ts arms the print path. The
    // old REPL-mount spelling is the retired anchor — asserting it here is
    // asserting a fossil.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = (...p: string[]) =>
      readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
    const engine = src('QueryEngine.ts')
    const print = src('cli', 'print.ts')
    check('QueryEngine registers for EVERY session kind (the one chokepoint)', engine.includes('registerWardsHook(config.setAppState, sessionId)'))
    check('print path registers too (wards.registerWardsHook)', print.includes('wards.registerWardsHook('))
    check('flag registry carries the MERCURY_WARDS row', src('substrate', 'flagRegistry.ts').includes("env: 'MERCURY_WARDS'"))
  }

  section('6. the autonomous delete-ward (the incident class)')
  {
    const { AUTONOMOUS_WARDS } = await import('../../src/utils/wards/wards.js')
    const { deleteWardActive } = await import('../../src/utils/hooks/wardsHook.js')
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const bash = (command: string) => ({ toolName: 'Bash', input: { command } })
    const denied = (cmd: string) => !evaluateWards(AUTONOMOUS_WARDS, bash(cmd)).allow
    check('denies rm -rf of a /Users path', denied('rm -rf /Users/alice/Developer/some-repo'))
    check('denies flag-after-target order', denied('rm /Users/alice/x -r'))
    check('denies bare-tilde recursive rm', denied('rm -rf ~'))
    check('denies tilde-path recursive rm', denied('rm -fr ~/Developer/x'))
    check('denies $HOME recursive rm', denied('rm -rf $HOME/Developer'))
    check('denies find <home> -delete', denied('find /Users/alice/proj -name "*.log" -delete'))
    check('allows scratch recursive rm (/tmp)', !denied('rm -rf /tmp/ops-proof-x'))
    check('allows non-recursive home rm', !denied('rm /Users/alice/notes.txt'))
    check('allows rm --force single file (no recursion)', !denied('rm --force /Users/alice/a.txt'))
    check('allows relative worktree cleanup', !denied('rm -rf node_modules'))
    check('allows find without -delete', !denied('find /Users/alice/proj -name "*.ts"'))
    check(
      'BUILTIN set alone never wards home deletes (operator sessions stay free)',
      evaluateWards(BUILTIN_WARDS, bash('rm -rf /Users/alice/x')).allow,
    )
    delete process.env.MERCURY_SPAWNED_BY
    delete process.env.MERCURY_DELETE_WARD
    check('inactive in operator sessions (no MERCURY_SPAWNED_BY)', !deleteWardActive())
    process.env.MERCURY_SPAWNED_BY = 'proof:me#1'
    check('active in spawned sessions', deleteWardActive())
    process.env.MERCURY_DELETE_WARD = '0'
    check('MERCURY_DELETE_WARD=0 kills it', !deleteWardActive())
    delete process.env.MERCURY_DELETE_WARD
    delete process.env.MERCURY_SPAWNED_BY
    check(
      'flag registry carries the MERCURY_DELETE_WARD row',
      readFileSync(join(import.meta.dir, '..', '..', 'src', 'substrate', 'flagRegistry.ts'), 'utf-8')
        .includes("env: 'MERCURY_DELETE_WARD'"),
    )
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ ALL WARDS PROOFS PASS')
  // Explicit: the disclosure drive arms a real expiry timer (the channel's
  // own promote); without this the loop idles until it fires.
  process.exit(0)
}

void main()
