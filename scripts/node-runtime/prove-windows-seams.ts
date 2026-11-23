#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let seamWhere = ''
const seamPointers: Record<string, string> = {
  '(1)': 'change registerMcpAddCommand in src/commands/mcp/addCommand.ts, or where the mcp command calls it, so add is registered before parsing',
  '(2)': 'change createReadRuleSuggestion in src/permissions/rules/permissionUpdate.ts (the writer) or rootForPattern in src/permissions/rules/filesystem.ts (the reader) so both use one drive spelling',
  '(3)': 'change normalizePathForConfigKey in src/platform/files/path.ts',
  '(4)': 'change the gh probe in src/platform/health/sections/coding-loop-fast.ts or whichSync in src/platform/processes/which.ts',
  '(5)': 'change canonicalHomeSpelling in src/platform/environment/envUtils.ts',
  '(10)': 'change the starter file in src/screen/keys/template.ts (generateKeybindingsTemplate) or the rules in src/screen/keys/validate.ts',
  '(12)': 'change the reserved-shortcut tables in src/screen/keys/reservedShortcuts.ts',
  '(14)': 'change sweepProbeDir in src/platform/health/healthDeepProbes.ts',
  '(15)': 'change ripGrep, ripGrepAnswer or isRipgrepUsageDiagnostic in src/platform/shell/ripgrep.ts',
  '(17)': 'change getRawSpellingKeychainStorageServiceName in src/platform/secure-storage/macOsKeychainHelpers.ts or operatorPrincipal in src/platform/substrate/identity/identity.ts',
}
const check = (name: string, cond: boolean, detail = ''): void => {
  const hint = [detail, seamWhere].filter(part => part !== '').join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !hint ? '' : ` — ${hint}`}`)
  if (!cond) failures++
}
const section = (s: string): void => {
  seamWhere = seamPointers[s.slice(0, s.indexOf(')') + 1)] ?? ''
  console.log(`\n── ${s} ──`)
}

section('(1) `mercury mcp add` is registered BEFORE the parser looks for it')
{
  const { builtHelp } = await import('../lib/builtProduct.ts')
  const { registerMcpAddCommand } = await import('../../src/commands/mcp/addCommand.ts')
  const { Command } = await import('@commander-js/extra-typings')
  const owned = new Command('mcp')
  registerMcpAddCommand(owned as never)
  const add = owned.commands.find(command => command.name() === 'add')
  check('the add command is registered by its owning module', add !== undefined && builtHelp('mcp').includes(` add ${add.usage()} ${add.description()} `), `the owning module registers: add ${add?.usage()} ${add?.description()}`)

  const dist = join(ROOT, 'dist', 'mercury.mjs')
  const { whichSync: whichExe } = await import('../../src/platform/processes/which.js')
  const nodeExe = whichExe('node')
  if (existsSync(dist) && nodeExe !== null) {
    const home = mkdtempSync(join(tmpdir(), 'winseams-mcp-'))
    const env = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_SPLASH: 'off' }
    try {
      const help = spawnSync(nodeExe, [dist, 'mcp', 'add', '--help'], { encoding: 'utf8', timeout: 60_000, env })
      check('`mcp add --help` answers with the add usage (exit 0)', help.status === 0 && /add/.test(help.stdout) && /Usage/i.test(help.stdout), `status ${help.status} stdout ${JSON.stringify(help.stdout.slice(0, 200))} stderr ${JSON.stringify(help.stderr.slice(0, 200))}`)
      const bad = spawnSync(nodeExe, [dist, 'mcp', 'nonesuch-verb'], { encoding: 'utf8', timeout: 60_000, env })
      check('an unknown mcp verb is still refused (the fix did not widen the roster)', bad.status !== 0 && /unknown command/i.test(bad.stderr + bad.stdout))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  } else {
    console.log(nodeExe === null
      ? '  [SKIP] no node on PATH — the artifact drill needs the real runtime it targets'
      : '  [SKIP] dist/mercury.mjs absent — the pooled gate prebuilds it')
  }
}

section('(2) path-scoped permission rules match on Windows — the writer and the reader agree on one spelling')
{
  const scratchHome = mkdtempSync(join(tmpdir(), 'winseams-perm-'))
  process.env.MERCURY_CONFIG_DIR = scratchHome
  try {
    const { createReadRuleSuggestion } = await import('../../src/permissions/rules/permissionUpdate.js')
    const { rootForPattern } = await import('../../src/permissions/rules/filesystem.js')
    const content = (u: unknown): string | undefined => (u as { rules?: Array<{ ruleContent?: string }> } | undefined)?.rules?.[0]?.ruleContent
    check('the writer anchors a backslash drive path at the drive: C:\\proj ⇒ //C/proj/**', content(createReadRuleSuggestion('C:\\proj')) === '//C/proj/**')
    check('…and a forward-slash drive path the same way, upper-casing the letter', content(createReadRuleSuggestion('c:/proj/sub')) === '//C/proj/sub/**')
    check('a bare drive root is too broad (like /) — no suggestion', createReadRuleSuggestion('C:\\') === undefined && createReadRuleSuggestion('/') === undefined)
    check('a POSIX absolute path keeps the root-anchored form', content(createReadRuleSuggestion('/home/op/proj')) === '//home/op/proj/**')
    const sep = process.platform === 'win32' ? '\\' : '/'
    const canonical = rootForPattern('//C/proj/**', 'userSettings', 'windows')
    check('the reader anchors the canonical //C/proj/** at the drive root', canonical.root === `C:${sep}` && canonical.relative === 'proj/**')
    for (const spelling of ['C:/proj/**', 'c:/proj/**', 'C:\\proj\\**', '/C:/proj/**']) {
      const r = rootForPattern(spelling, 'userSettings', 'windows')
      check(`the reader anchors the drive spelling ${JSON.stringify(spelling)} at the drive root too`, r.root === `C:${sep}` && r.relative === 'proj/**', JSON.stringify(r))
    }
    const posixRead = rootForPattern('C:/proj/**', 'userSettings', 'macos')
    check('off Windows a drive-shaped pattern stays a relative pattern (no false anchor)', posixRead.root === null && posixRead.relative === 'C:/proj/**')
    const relative = rootForPattern('src/**', 'userSettings', 'windows')
    check('a relative pattern stays relative on Windows', relative.root === null && relative.relative === 'src/**')
    const home = rootForPattern('~/proj/**', 'userSettings', 'windows')
    check('the ~ spelling is untouched by the drive arm', home.root !== null && home.relative === '/proj/**')
    const written = content(createReadRuleSuggestion('C:\\Users\\op\\proj'))
    const read = rootForPattern(written ?? '', 'session', 'windows')
    check('round trip: the written grant anchors at C: with the folder relative', written === '//C/Users/op/proj/**' && read.root === `C:${sep}` && read.relative === 'Users/op/proj/**')
  } finally {
    rmSync(scratchHome, { recursive: true, force: true })
  }
}

section('(3) one folder, one config key; the trust card compares keys')
{
  const { normalizePathForConfigKey } = await import('../../src/platform/files/path.js')
  check('a lower-case drive letter folds to the canonical upper case', normalizePathForConfigKey('c:\\proj\\sub') === 'C:/proj/sub')
  check('an upper-case drive letter is unchanged', normalizePathForConfigKey('C:\\proj') === 'C:/proj')
  check('backslashes become forward slashes (the key spelling)', normalizePathForConfigKey('C:\\Users\\op\\.mercury') === 'C:/Users/op/.mercury')
  check('a POSIX path is untouched by the fold', normalizePathForConfigKey('/home/op/proj') === '/home/op/proj')
  check('the two spellings of one folder derive ONE key', normalizePathForConfigKey('c:/proj') === normalizePathForConfigKey('C:\\proj'))
}

section('(4) executable probes ride the one PATHEXT-aware owner')
{
  const { codingLoopFastChecks } = await import('../../src/platform/health/sections/coding-loop-fast.ts')
  const { whichSync: lookup } = await import('../../src/platform/processes/which.ts')
  const workbench = codingLoopFastChecks().find(row => row.id === 'anvil-workbench-fast')
  const repoLineOf = (detail: string | undefined): string => detail?.split('\n')[0] ?? ''
  const workbenchHere = repoLineOf((await workbench?.run())?.detail)
  const ghHere = lookup('gh') !== null
  const pathNow = process.env.PATH
  process.env.PATH = join(ROOT, 'scripts', 'node-runtime')
  let workbenchNowhere = ''
  try {
    workbenchNowhere = repoLineOf((await workbench?.run())?.detail)
  } finally {
    process.env.PATH = pathNow
  }
  check("the repo-host row asks whichSync('gh')", workbenchHere.startsWith('repo host: OFF') || workbenchHere === `repo host: ${ghHere ? 'gh on PATH (mercury://repo live)' : 'gh ABSENT — context unavailable (remedy: install gh + gh auth login)'}`, workbenchHere)
  check('no bare-name gh PATH walk survives in the health report', workbenchHere.startsWith('repo host: OFF') || workbenchNowhere.startsWith('repo host: gh ABSENT'), workbenchNowhere)
  const { whichSync } = await import('../../src/platform/processes/which.js')
  check('the owner resolves a real executable on this host', whichSync('node') !== null || whichSync('bun') !== null)
  check('the owner answers null for a name that is not on PATH', whichSync('winseams-no-such-binary-7f3a') === null)
}

section('(5) one config home, one spelling')
{
  const { canonicalHomeSpelling } = await import('../../src/platform/environment/envUtils.js')
  check('win32: a trailing backslash is dropped', canonicalHomeSpelling('C:\\Users\\op\\.mercury\\', 'win32') === 'C:\\Users\\op\\.mercury')
  check('win32: forward slashes become the OS spelling', canonicalHomeSpelling('C:/Users/op/.mercury', 'win32') === 'C:\\Users\\op\\.mercury')
  check('win32: the drive letter is upper-cased', canonicalHomeSpelling('c:\\h', 'win32') === 'C:\\h')
  check('win32: three spellings of one home are one home', new Set(['C:\\h\\', 'C:/h', 'c:\\h'].map(s => canonicalHomeSpelling(s, 'win32'))).size === 1)
  check('win32: a bare drive root keeps its separator', canonicalHomeSpelling('C:\\', 'win32') === 'C:\\')
  check('win32: a UNC root is untouched', canonicalHomeSpelling('\\\\box\\share\\', 'win32') === '\\\\box\\share\\')
  check('posix: a trailing slash is dropped', canonicalHomeSpelling('/home/op/.mercury/', 'linux') === '/home/op/.mercury')
  check('posix: the root stays the root', canonicalHomeSpelling('/', 'darwin') === '/')
  check('posix: backslashes are ordinary characters', canonicalHomeSpelling('/home/op/a\\b', 'linux') === '/home/op/a\\b')
  check('a relative pin keeps its meaning (never resolved against the cwd)', canonicalHomeSpelling('scratch/home/', 'linux') === 'scratch/home')
  check('NFC still applies', canonicalHomeSpelling('/h/e\u0301', 'linux') === '/h/\u00e9')
}



section('(10) the starter keybindings.json passes the product\'s own validator')
{
  const { generateKeybindingsTemplate } = await import('../../src/screen/keys/template.js')
  const { validateUserConfig, checkReservedShortcuts, isUserConfigContext } = await import('../../src/screen/keys/validate.js')
  const { parseKeybindings } = await import('../../src/screen/keys/loadUserBindings.js').catch(() => ({ parseKeybindings: undefined as undefined }))
  const text = generateKeybindingsTemplate()
  const parsed = JSON.parse(text) as { bindings: Array<{ context: string; bindings: Record<string, string | null> }> }
  check('the template parses as JSON with a bindings list', Array.isArray(parsed.bindings) && parsed.bindings.length > 0)
  const findings = validateUserConfig(parsed.bindings)
  check('no error-severity finding on the starter file', findings.filter(f => f.severity === 'error').length === 0, JSON.stringify(findings.filter(f => f.severity === 'error').slice(0, 3)))
  check('no invalid_context finding (the gated contexts stay out)', !findings.some(f => f.type === 'invalid_context'), JSON.stringify(findings.filter(f => f.type === 'invalid_context')))
  check('every written context is on the closed user list', parsed.bindings.every(b => isUserConfigContext(b.context)))
  check('the gated contexts are absent by name', !parsed.bindings.some(b => b.context === 'Scroll' || b.context === 'MessageActions'))
  const chords = parsed.bindings.flatMap(b => Object.keys(b.bindings))
  check('ctrl+z (a reserved chord on every platform) is not written', !chords.includes('ctrl+z'))
  check('ctrl+c / ctrl+d (non-rebindable) are not written', !chords.includes('ctrl+c') && !chords.includes('ctrl+d'))
  void parseKeybindings
  void checkReservedShortcuts
}


section('(12) the reserved-shortcut table knows Windows')
{
  const { reservedShortcutsFor, WINDOWS_RESERVED, NON_REBINDABLE, MACOS_RESERVED } = await import('../../src/screen/keys/reservedShortcuts.js')
  const win = reservedShortcutsFor('windows')
  const keys = new Set(win.map(s => s.key))
  check('Windows Terminal copy/paste chords are reserved', keys.has('ctrl+shift+c') && keys.has('ctrl+shift+v'))
  check('tab and pane chords are reserved (ctrl+tab · ctrl+shift+tab · ctrl+shift+t/w · alt+shift+d)', ['ctrl+tab', 'ctrl+shift+tab', 'ctrl+shift+t', 'ctrl+shift+w', 'alt+shift+d'].every(k => keys.has(k)))
  const ctrlZ = win.filter(s => s.key === 'ctrl+z')
  check('ctrl+z carries ONE reason on Windows, and it is not the Unix suspend', ctrlZ.length === 1 && !/Unix/.test(ctrlZ[0]!.reason) && /end-of-input/.test(ctrlZ[0]!.reason))
  check('the non-rebindable trio leads on every platform', NON_REBINDABLE.every(n => win[win.indexOf(n)] === n) && reservedShortcutsFor('linux').slice(0, NON_REBINDABLE.length).every((s, i) => s === NON_REBINDABLE[i]))
  check('macOS keeps its set and gains no Windows row', reservedShortcutsFor('macos').some(s => s.key === 'cmd+q') && !reservedShortcutsFor('macos').some(s => WINDOWS_RESERVED.includes(s)))
  check('linux carries neither platform set', !reservedShortcutsFor('linux').some(s => WINDOWS_RESERVED.includes(s) || MACOS_RESERVED.includes(s)))
  check('every Windows row is a warning (the host may or may not eat it), never an error', WINDOWS_RESERVED.every(s => s.severity === 'warning'))
}

section('(14) a deep probe\'s scratch sweep never outranks its verdict')
{
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0' }
  const { sweepProbeDir } = await import('../../src/platform/health/healthDeepProbes.js')
  let calls = 0
  const flakyTwice = (): void => {
    calls++
    if (calls < 3) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
  }
  check('a sweep that fails twice then succeeds returns true (the handle-release lag is covered)', sweepProbeDir('/scratch/x', flakyTwice, 4, 1) === true && calls === 3)
  let always = 0
  const alwaysThrows = (): void => {
    always++
    throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
  }
  check('a sweep that never succeeds returns false and NEVER throws (the verdict stands)', sweepProbeDir('/scratch/y', alwaysThrows, 3, 1) === false && always === 3)
  check('a clean sweep is one call', (() => { let n = 0; return sweepProbeDir('/scratch/z', () => { n++ }, 4, 1) === true && n === 1 })())
  let structural = 0
  const structuralThrows = (): void => {
    structural++
    throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
  }
  check('a STRUCTURAL refusal yields after ONE attempt — the transient-class law, never a blind ladder', sweepProbeDir('/scratch/s', structuralThrows, 4, 1) === false && structural === 1)
}

section('(15) an invalid Grep pattern is a refusal, never "no matches"')
{
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0' }
  const { ripGrep, RipgrepUsageError, resolveRipgrep } = await import('../../src/platform/shell/ripgrep.js')
  const rg = resolveRipgrep()
  const { whichSync: whichRg } = await import('../../src/platform/processes/which.js')
  const rgPresent = rg.mode === 'system' ? whichRg(rg.config.rgPath) !== null : existsSync(rg.config.rgPath)
  const scratch = mkdtempSync(join(tmpdir(), 'winseams-rg-'))
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(scratch, 'a.txt'), 'alpha\nbeta\n')
    let refused: unknown = null
    try {
      await ripGrep(['-e', '(unclosed'], scratch, new AbortController().signal)
    } catch (error) {
      refused = error
    }
    if (!rgPresent) {
      console.log('  [SKIP] ripgrep unavailable on this host — the refusal leg needs the vendored binary')
    } else {
      check('an unclosed group is refused with ripgrep\'s own diagnostic', refused instanceof RipgrepUsageError && /regex|parse|unclosed/i.test((refused as Error).message), String(refused))
    }
    const found = !rgPresent ? [] : await ripGrep(['-n', 'beta'], scratch, new AbortController().signal)
    check('a valid search still returns its matches', !rgPresent || found.some(line => line.includes('beta')), JSON.stringify(found))
    const { isRipgrepUsageDiagnostic, ripGrepAnswer } = await import('../../src/platform/shell/ripgrep.js')
    check(
      'usage shapes read as usage (regex parse error · the error:-led argument refusal · an unrecognized flag)',
      isRipgrepUsageDiagnostic('rg: regex parse error:\n    (unclosed\n    ^\nerror: unclosed group') &&
        isRipgrepUsageDiagnostic("error: unexpected argument '--frob' found") &&
        isRipgrepUsageDiagnostic("rg: unrecognized flag '--zzz'"),
    )
    check(
      'I/O lines never read as usage — the POSIX and win32 locked-file spellings both pass through',
      !isRipgrepUsageDiagnostic('rg: /scratch/x.db: Permission denied (os error 13)') &&
        !isRipgrepUsageDiagnostic('rg: C:\\t\\x.ldb: The process cannot access the file because it is being used by another process. (os error 32)'),
    )
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0 && rgPresent) {
      const lockedDir = join(scratch, 'locked-walk')
      const { mkdirSync, chmodSync } = await import('node:fs')
      mkdirSync(lockedDir, { recursive: true })
      writeFileSync(join(lockedDir, 'a.txt'), 'alpha\n')
      writeFileSync(join(lockedDir, 'sealed.txt'), 'sealed\n')
      chmodSync(join(lockedDir, 'sealed.txt'), 0o000)
      try {
        const none = await ripGrep(['-n', 'zzz9-no-such-needle'], lockedDir, new AbortController().signal)
        check(
          'an unreadable file beside zero matches REFUSES from the plain door (a partial walk never reads as a completed empty search)',
          false,
          `answered ${JSON.stringify(none)} — the plain door must throw`,
        )
      } catch (error) {
        check(
          'an unreadable file beside zero matches REFUSES from the plain door (a partial walk never reads as a completed empty search)',
          /search engine failed/.test(String(error)) && !isRipgrepUsageDiagnostic(String(error)),
          String(error),
        )
      }
      try {
        const answered = await ripGrepAnswer(['-n', 'zzz9-no-such-needle'], lockedDir, new AbortController().signal)
        check(
          'the answer door reports the same walk INCOMPLETE with the failure named',
          answered.lines.length === 0 && answered.complete === false && String(answered.reason ?? '').length > 0,
          JSON.stringify(answered),
        )
      } finally {
        chmodSync(join(lockedDir, 'sealed.txt'), 0o600)
      }
    } else {
      console.log('  [SKIP] the unreadable-file leg needs a POSIX non-root host with the vendored rg')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}


section('(17) raw-spelling credential continuity + the one keyed principal (the F-11 aftermath)')
{
  const savedConfigDir = process.env.MERCURY_CONFIG_DIR
  const savedHome = process.env.MERCURY_HOME
  const savedUser = process.env.USER
  const savedUsername = process.env.USERNAME
  try {
    process.env.MERCURY_CONFIG_DIR = '/h/op/.mercury/'
    process.env.USER = 'op'
    const { createHash } = await import('node:crypto')
    const helpers = await import('../../src/platform/secure-storage/macOsKeychainHelpers.js')
    const identity = await import('../../src/platform/substrate/identity/identity.js')
    const rawName = helpers.getRawSpellingKeychainStorageServiceName('-credentials')
    const expectedHash = createHash('sha256').update('/h/op/.mercury/').digest('hex').slice(0, 8)
    check('a trailing-separator pin derives the raw-spelling service name from the RAW hash', rawName !== null && rawName.startsWith('Mercury') && rawName.endsWith(`-${expectedHash}`), String(rawName))
    check('…and it differs from the canonical service name', rawName !== helpers.getMacOsKeychainStorageServiceName('-credentials'))
    check('the identity module derives no id from the pin spelling', Object.keys(identity).sort().join(',') === 'assistantPrincipal,operatorPrincipal', Object.keys(identity).join(','))
    const realHome = mkdtempSync(join(tmpdir(), 'winseams-id-'))
    process.env.MERCURY_CONFIG_DIR = `${realHome}/`
    process.env.USER = 'op'
    const keyedId = identity.operatorPrincipal().id
    check('the keyed id is op-<12 hex>', /^op-[0-9a-f]{12}$/.test(keyedId), keyedId)
    process.env.MERCURY_CONFIG_DIR = realHome
    check('a CANONICAL pin has no raw twin — no fallback exists, nothing to migrate', helpers.getRawSpellingKeychainStorageServiceName('-credentials') === null)
    check('the keyed id is STABLE across the spelling change (same home, same key)', identity.operatorPrincipal().id === keyedId)
    process.env.USERNAME = 'windows-operator'
    check('USER keeps precedence when both login variables exist', identity.operatorPrincipal().name === 'op')
    delete process.env.USER
    check('the Windows USERNAME supplies the principal name without changing its id', identity.operatorPrincipal().name === 'windows-operator' && identity.operatorPrincipal().id === keyedId)
    delete process.env.USERNAME
    check('an absent login keeps the non-throwing operator fallback', identity.operatorPrincipal().name === 'operator' && identity.operatorPrincipal().id === keyedId)
    rmSync(realHome, { recursive: true, force: true })
  } finally {
    if (savedConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = savedConfigDir
    if (savedHome === undefined) delete process.env.MERCURY_HOME
    else process.env.MERCURY_HOME = savedHome
    if (savedUser === undefined) delete process.env.USER
    else process.env.USER = savedUser
    if (savedUsername === undefined) delete process.env.USERNAME
    else process.env.USERNAME = savedUsername
  }
}


console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ WINDOWS SEAMS PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
