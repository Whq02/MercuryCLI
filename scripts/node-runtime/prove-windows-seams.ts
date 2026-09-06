#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

section('(1) `mercury mcp add` is registered BEFORE the parser looks for it')
{
  const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
  check('registerSubcommands is awaited before parseAsync', /await registerSubcommands\(program\)\n\n\s*profileCheckpoint\('run_before_parse'\)/.test(main))
  check('registerSubcommands is async (it can await the owning modules)', /async function registerSubcommands\(program: CommanderCommand\): Promise<void>/.test(main))
  const addIdx = main.indexOf('registerMcpAddCommand(mcp')
  check('the add command is registered by its owning module', addIdx !== -1)
  const guardIdx = main.lastIndexOf("if (process.argv.includes('mcp'))", addIdx)
  check('the registration is gated on argv naming mcp (the general boot pays nothing)', guardIdx !== -1 && addIdx - guardIdx < 600)
  check('the registration is AWAITED, not a fire-and-forget IIFE', !/void \(async \(\) => \{[\s\S]{0,400}registerMcpAddCommand/.test(main))
  check('the IdP command rides the same awaited path', main.indexOf('registerMcpXaaIdpCommand(mcp') > guardIdx)

  const dist = join(ROOT, 'dist', 'mercury.mjs')
  const { whichSync: whichExe } = await import('../../src/utils/which.js')
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
    const { createReadRuleSuggestion } = await import('../../src/utils/permissions/PermissionUpdate.js')
    const { rootForPattern } = await import('../../src/utils/permissions/filesystem.js')
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
  const { normalizePathForConfigKey } = await import('../../src/utils/path.js')
  check('a lower-case drive letter folds to the canonical upper case', normalizePathForConfigKey('c:\\proj\\sub') === 'C:/proj/sub')
  check('an upper-case drive letter is unchanged', normalizePathForConfigKey('C:\\proj') === 'C:/proj')
  check('backslashes become forward slashes (the key spelling)', normalizePathForConfigKey('C:\\Users\\op\\.mercury') === 'C:/Users/op/.mercury')
  check('a POSIX path is untouched by the fold', normalizePathForConfigKey('/home/op/proj') === '/home/op/proj')
  check('the two spellings of one folder derive ONE key', normalizePathForConfigKey('c:/proj') === normalizePathForConfigKey('C:\\proj'))
  const trust = readFileSync(join(ROOT, 'src', 'components', 'TrustDialog', 'TrustDialog.tsx'), 'utf8')
  check('the trust card compares the grant root against the cwd KEY, not the raw cwd', trust.includes('if (grantRoot === normalizePathForConfigKey(getFsImplementation().cwd())) return null;'))
  check('no raw cwd compare survives on the card', !trust.includes('if (grantRoot === getFsImplementation().cwd()) return null;'))
  check('the card imports the one key owner', /import \{[^}]*normalizePathForConfigKey[^}]*\} from ['"][^'"]*utils\/path\.js['"]/.test(trust))
}

section('(4) executable probes ride the one PATHEXT-aware owner')
{
  const health = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  check("the repo-host row asks whichSync('gh')", health.includes("const ghOnPath = whichSync('gh') !== null"))
  check('no bare-name gh PATH walk survives in the health report', !/existsSync\(nodePath\.join\(d, 'gh'\)\)/.test(health))
  const debug = readFileSync(join(ROOT, 'src', 'tools', 'DebugTool', 'DebugTool.ts'), 'utf8')
  check("DebugTool's lldb-dap probe asks whichSync('lldb-dap')", debug.includes("return whichSync('lldb-dap') !== null"))
  check('no bare-name lldb-dap PATH walk survives', !/existsSync\(path\.join\(dir, 'lldb-dap'\)\)/.test(debug))
  const { whichSync } = await import('../../src/utils/which.js')
  check('the owner resolves a real executable on this host', whichSync('node') !== null || whichSync('bun') !== null)
  check('the owner answers null for a name that is not on PATH', whichSync('winseams-no-such-binary-7f3a') === null)
}

section('(5) one config home, one spelling')
{
  const { canonicalHomeSpelling } = await import('../../src/utils/envUtils.js')
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
  const env = readFileSync(join(ROOT, 'src', 'utils', 'envUtils.ts'), 'utf8')
  check('getMercuryHome rides the canonical spelling', env.includes('return canonicalHomeSpelling(resolved)'))
}

section('(6) the build-tree stamp rides the staleness sweep')
{
  const build = readFileSync(join(ROOT, 'build.ts'), 'utf8')
  const sweep = build.slice(build.indexOf("rmSync(resolve(OUT, 'manifest.json')"), build.indexOf('SELF-CONTAINMENT TRIPWIRE'))
  check('the sweep removes the stale build-tree stamp beside the manifest', sweep.includes("rmSync(resolve(OUT, '.build-tree'), { force: true })"))
  check('the stamp is still written on success (after the sweep, not before)', build.indexOf("rmSync(resolve(OUT, '.build-tree')") !== -1 && build.indexOf("writeFileSync(resolve(OUT, '.build-tree')") > build.indexOf("rmSync(resolve(OUT, '.build-tree')"))
}

section('(7) a signed-out boot stays silent on the wire — the API warm-up needs a credential')
{
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0' }
  const { decidePreconnect } = await import('../../src/utils/apiPreconnect.js')
  const signedOut = decidePreconnect(false, {})
  check('no credential ⇒ skip, reason signed-out', !signedOut.go && signedOut.reason === 'signed-out')
  check('a credential with a plain environment ⇒ go', decidePreconnect(true, {}).go)
  for (const spelling of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) {
    const d = decidePreconnect(true, { [spelling]: '' })
    check(`${spelling} PRESENT (even empty) ⇒ skip, reason proxy`, !d.go && d.reason === 'proxy')
  }
  const sock = decidePreconnect(true, { ANTHROPIC_UNIX_SOCKET: '/tmp/x' })
  check('a unix socket ⇒ skip, reason unix-socket', !sock.go && sock.reason === 'unix-socket')
  const cert = decidePreconnect(true, { MERCURY_CLIENT_KEY: '/k' })
  check('a client key ⇒ skip, reason client-cert', !cert.go && cert.reason === 'client-cert')
  check('an extra-CA variable is deliberately NOT a skip', decidePreconnect(true, { NODE_EXTRA_CA_CERTS: '/ca.pem' }).go)
  check('signed-out outranks every transport skip (the reason names the privacy law first)', decidePreconnect(false, { HTTPS_PROXY: 'x' }).reason === 'signed-out')
  const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
  check('the root action passes the credential fact into the warm-up', main.includes('preconnectAnthropicApi({ credentialed: hasFirstPartyCredential() })'))
  check('no unconditioned warm-up call survives', !/preconnectAnthropicApi\(\)/.test(main))
  const pre = readFileSync(join(ROOT, 'src', 'utils', 'apiPreconnect.ts'), 'utf8')
  check('the performer consults the pure decision before any fetch', pre.indexOf('decidePreconnect(opts.credentialed)') !== -1 && pre.indexOf('decidePreconnect(opts.credentialed)') < pre.indexOf('doFetch(target'))
  const auth = readFileSync(join(ROOT, 'src', 'utils', 'auth.ts'), 'utf8')
  check('hasFirstPartyCredential reads the three legs auth status calls logged in', /getAuthTokenSource\(\)\.hasToken \|\|\s*getAnthropicApiKeyWithSource\(\)\.source !== 'none' \|\|\s*Boolean\(process\.env\.ANTHROPIC_API_KEY\)/.test(auth))
}

section('(8) every honest engine-unavailable code the providers spell is on the health allowlist')
{
  const { readdirSync, statSync } = await import('node:fs')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(name)) out.push(p)
    }
    return out
  }
  const spelled = new Set<string>()
  for (const root of [join(ROOT, 'src', 'utils', 'router', 'providers'), join(ROOT, 'src', 'services', 'providers')]) {
    for (const file of walk(root)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/reason: ?[`'"]([a-z-]+:)/g)) spelled.add(m[1] as string)
    }
  }
  const health = readFileSync(join(ROOT, 'src', 'utils', 'healthReport.ts'), 'utf8')
  const listSrc = /const ENGINE_UNAVAILABLE_CODES = \[([\s\S]*?)\]/.exec(health)?.[1] ?? ''
  const allowed = new Set([...listSrc.matchAll(/'([a-z-]+:)'/g)].map(m => m[1] as string))
  check('the provider trees spell at least the three codes the audit found missing', ['not-configured:', 'no-server:', 'no-credential:'].every(c => spelled.has(c)), [...spelled].join(' '))
  const missing = [...spelled].filter(c => !allowed.has(c))
  check('every spelled reason prefix is on the allowlist (a new code lands there or goes red)', missing.length === 0, `missing: ${missing.join(' ')}`)
  check('the allowlist keeps its earlier codes', ['discovery-pending:', 'no-executable:', 'no-auth:', 'no-api-key:', 'no-account:'].every(c => allowed.has(c)))
}

section('(9) the Windows default editor is an executable, never a cmd builtin')
{
  const editor = readFileSync(join(ROOT, 'src', 'utils', 'editor.ts'), 'utf8')
  const def = /const WINDOWS_DEFAULT_EDITOR = '([^']+)'/.exec(editor)?.[1] ?? ''
  check("the default is bare 'notepad'", def === 'notepad', JSON.stringify(def))
  check('no cmd builtin (start) is spelled as the executable', !/^start\b/.test(def))
  check('the classifier still knows notepad as a GUI editor', /GUI_EDITORS = \[[\s\S]*?'notepad'[\s\S]*?\]/.test(editor))
  const launcher = readFileSync(join(ROOT, 'src', 'utils', 'promptEditor.ts'), 'utf8')
  check('the launcher still runs the line through a shell with a re-quoted executable (the law the default must survive)', /spawn\(commandLine, \{ shell: true,[^)\n]*stdio: 'inherit'/.test(launcher))
}

section('(10) the starter keybindings.json passes the product\'s own validator')
{
  const { generateKeybindingsTemplate } = await import('../../src/keybindings/template.js')
  const { validateUserConfig, checkReservedShortcuts, isUserConfigContext } = await import('../../src/keybindings/validate.js')
  const { parseKeybindings } = await import('../../src/keybindings/loadUserBindings.js').catch(() => ({ parseKeybindings: undefined as undefined }))
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

section('(11) the swallowed-prompt guard fires on the inferred print shape and knows --file')
{
  const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
  const guard = main.slice(main.indexOf('A print run with NO input anywhere'), main.indexOf('const variadicCandidates') + 900)
  check('the guard fires for -p OR a non-TTY stdout (the inferred print shape)', guard.includes('(printMode || !process.stdout.isTTY) &&'))
  check('the guard still spares resume/continue/from-pr and stream-json input', guard.includes('!opts.resume &&') && guard.includes('!opts.continue &&') && guard.includes("inputFormat !== 'stream-json' &&"))
  check('--file is a candidate', guard.includes("['--file', opts.file]"))
  check('the six earlier candidates are kept', ['--allowed-tools', '--disallowed-tools', '--tools', '--mcp-config', '--add-dir', '--betas'].every(f => guard.includes(`['${f}',`)))
}

section('(12) the reserved-shortcut table knows Windows')
{
  const { reservedShortcutsFor, WINDOWS_RESERVED, NON_REBINDABLE, MACOS_RESERVED } = await import('../../src/keybindings/reservedShortcuts.js')
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

section('(13) the Windows install guide tells the tree\'s truth (a ratchet on the audited claims)')
{
  const doc = readFileSync(join(ROOT, 'docs', 'INSTALL-WINDOWS-FROM-SOURCE.md'), 'utf8')
  check('no "refuses to draw narrower than 100" claim', !/refuses to draw narrower/.test(doc))
  const { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS } = await import('../../src/ink/viewportFloor.ts')
  check(`the real floor is stated (${VIEWPORT_FLOOR_COLS} columns and ${VIEWPORT_FLOOR_ROWS} rows)`, doc.includes(`${VIEWPORT_FLOOR_COLS} columns and ${VIEWPORT_FLOOR_ROWS} rows`))
  const layout = readFileSync(join(ROOT, 'src', 'components', 'concourse', 'ConcourseLayout.tsx'), 'utf8')
  check("…and it is the tree's floor (ConcourseLayout reads the viewport floor's owner)", layout.includes('cols < VIEWPORT_FLOOR_COLS || rows < VIEWPORT_FLOOR_ROWS'))
  check('the winget id is the LTS line', doc.includes('winget install --id OpenJS.NodeJS.LTS --source winget') && !/--id OpenJS\.NodeJS --source/.test(doc))
  check('no "spaces break some build tooling" claim', !/spaces break/.test(doc))
  check('the splash tip says a bare direct node start paints it before the face', /a bare `node dist\\mercury\.mjs` runs it before the\s+face/.test(doc) && !/no effect on\s+a direct `node dist\\mercury\.mjs` start/.test(doc))
  check('no stale "blank screen after the splash" row', !/blank screen after the splash/.test(doc))
  check('the degraded-build row names the manifest tell, not a build error line', /lists names under `degraded`/.test(doc) && !/ends with `dist\/manifest\.json missing`/.test(doc))
  check('the code-page sentence no longer pins one mojibake spelling', /437/.test(doc) && /850/.test(doc))
  check('step 1 names Windows Terminal as the HOST and PowerShell 7 as the SHELL, not as alternatives', /Windows Terminal is the\s+host/.test(doc) && /PowerShell 7 \(`pwsh`\) is the shell/.test(doc) && !/Use \*\*Windows Terminal\*\* or \*\*PowerShell 7\*\*/.test(doc))
  check('the standalone console is told about the terminal-check card and that its first row, 1, continues', /terminal-check card first, and its first row — `1`, Continue anyway —/.test(doc))
}

section('(14) a deep probe\'s scratch sweep never outranks its verdict')
{
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0' }
  const { sweepProbeDir } = await import('../../src/utils/healthDeepProbes.js')
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
  const probes = readFileSync(join(ROOT, 'src', 'utils', 'healthDeepProbes.ts'), 'utf8')
  const outsideOwner = probes
    .replace(/remover: \(path: string\) => void = path => rmSync\(path, \{ recursive: true, force: true \}\)/, '')
    .replace(/import \{ mkdtempSync, rmSync \} from 'node:fs'/, '')
  check('no rmSync call survives anywhere in the probe file outside the sweep owner', !/\brmSync\(/.test(outsideOwner))
  check('every scratch finally rides sweepProbeDir (both scratch spellings)', (probes.match(/sweepProbeDir\(dir\)/g) ?? []).length >= 8 && (probes.match(/sweepProbeDir\(root\)/g) ?? []).length >= 3)
  check('the structure probes dispose their owner BEFORE the sweep (a held handle is the sweep\'s own enemy)', (probes.match(/await disposeOwner\(owner\)\n\s*sweepProbeDir\(root\)/g) ?? []).length >= 3)
}

section('(15) an invalid Grep pattern is a refusal, never "no matches"')
{
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '0.0.0' }
  const { ripGrep, RipgrepUsageError, resolveRipgrep } = await import('../../src/utils/ripgrep.js')
  const rg = resolveRipgrep()
  const { whichSync: whichRg } = await import('../../src/utils/which.js')
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
    const { isRipgrepUsageDiagnostic, ripGrepAnswer } = await import('../../src/utils/ripgrep.js')
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
    const src = readFileSync(join(ROOT, 'src', 'utils', 'ripgrep.ts'), 'utf8')
    check('the refusal fires only for exit 2 with nothing found and a USAGE-shaped diagnostic', src.includes('if (code === 2 && salvaged.length === 0 && isRipgrepUsageDiagnostic(outcome.stderr)) {'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('(16) MERCURY_SPLASH=static exits the splash asset like off')
{
  const asset = readFileSync(join(ROOT, 'assets', 'splash', 'mercury-splash.mjs'), 'utf8')
  check('the asset exits on static exactly where it exits on off', asset.includes("if (process.env.MERCURY_SPLASH === 'off' || process.env.MERCURY_SPLASH === 'static' || !out.isTTY) process.exit(0)"))
  const launchers = readFileSync(join(ROOT, 'scripts', 'release', 'launcherTemplates.mjs'), 'utf8')
  check('all three launcher shells skip the asset under static (the contract the asset now matches)', /!= "static"/.test(launchers) && /=="static"/.test(launchers) && /-ne 'static'/.test(launchers))
}

section('(17) raw-spelling credential + principal continuity (the F-11 aftermath)')
{
  const savedConfigDir = process.env.MERCURY_CONFIG_DIR
  const savedHome = process.env.MERCURY_HOME
  const savedUser = process.env.USER
  try {
    process.env.MERCURY_CONFIG_DIR = '/h/op/.mercury/'
    process.env.USER = 'op'
    const { createHash } = await import('node:crypto')
    const helpers = await import('../../src/utils/secureStorage/macOsKeychainHelpers.js')
    const identity = await import('../../src/substrate/identity/identity.js')
    const rawName = helpers.getRawSpellingKeychainStorageServiceName('-credentials')
    const expectedHash = createHash('sha256').update('/h/op/.mercury/').digest('hex').slice(0, 8)
    check('a trailing-separator pin derives the raw-spelling service name from the RAW hash', rawName !== null && rawName.startsWith('Mercury') && rawName.endsWith(`-${expectedHash}`), String(rawName))
    check('…and it differs from the canonical service name', rawName !== helpers.getMacOsKeychainStorageServiceName('-credentials'))
    const rawId = identity.rawPinOperatorPrincipalId()
    const expectedRawId = `op-${createHash('sha256').update('/h/op/.mercury/|op').digest('hex').slice(0, 12)}`
    check('the raw-pin principal id is the PRE-fold derivation', rawId === expectedRawId, String(rawId))
    const legacyId = identity.legacyOperatorPrincipalId()
    check('the legacy canonical hash differs (the fold moved it)', legacyId !== rawId && /^op-[0-9a-f]{12}$/.test(legacyId))
    const realHome = mkdtempSync(join(tmpdir(), 'winseams-id-'))
    process.env.MERCURY_CONFIG_DIR = `${realHome}/`
    process.env.USER = 'op'
    const keyedId = identity.operatorPrincipal().id
    const rawId2 = identity.rawPinOperatorPrincipalId()
    const legacyId2 = identity.legacyOperatorPrincipalId()
    check('the keyed id is op-<12 hex> and equals NEITHER legacy generation', /^op-[0-9a-f]{12}$/.test(keyedId) && keyedId !== rawId2 && keyedId !== legacyId2, keyedId)
    check('the operator owns records keyed by the CURRENT id and BOTH legacy generations', rawId2 !== null && identity.principalIdOwnsRecord(keyedId, keyedId) && identity.principalIdOwnsRecord(keyedId, legacyId2) && identity.principalIdOwnsRecord(keyedId, rawId2))
    check('a different principal claims none, and an ownerless record is nobody\'s', !identity.principalIdOwnsRecord('op-ffffffffffff', rawId2!) && !identity.principalIdOwnsRecord(keyedId, 'op-ffffffffffff') && !identity.principalIdOwnsRecord(keyedId, null))
    process.env.MERCURY_CONFIG_DIR = realHome
    check('a CANONICAL pin has no raw twin — no fallback exists, nothing to migrate', helpers.getRawSpellingKeychainStorageServiceName('-credentials') === null && identity.rawPinOperatorPrincipalId() === null)
    check('the keyed id is STABLE across the spelling change (same home, same key)', identity.operatorPrincipal().id === keyedId)
    rmSync(realHome, { recursive: true, force: true })
  } finally {
    if (savedConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = savedConfigDir
    if (savedHome === undefined) delete process.env.MERCURY_HOME
    else process.env.MERCURY_HOME = savedHome
    if (savedUser === undefined) delete process.env.USER
    else process.env.USER = savedUser
  }
  const store = readFileSync(join(ROOT, 'src', 'utils', 'secureStorage', 'macOsKeychainStorage.ts'), 'utf8')
  check('the store MIGRATES a raw-keyed read: the canonical write precedes the raw delete', store.includes('function migrateRawKeyedEntry(') && store.includes('macOsKeychainStorage.update(data)') && store.indexOf('macOsKeychainStorage.update(data)') < store.indexOf("runSecurity(['delete-generic-password', '-a', getUsername(), '-s', rawServiceName])"))
  check('a failed canonical write never deletes the raw entry (the one surviving copy stays)', store.includes('if (!written.success) return'))
  check('logout sweeps the raw-keyed entry beside the two named spellings', store.includes('...(rawService !== null ? [rawService] : [])'))
  check('both read paths carry the raw fallback', (store.match(/getRawSpellingKeychainStorageServiceName\(CREDENTIALS_SERVICE_SUFFIX\)/g) ?? []).length >= 3)
  const prefetch = readFileSync(join(ROOT, 'src', 'utils', 'secureStorage', 'keychainPrefetch.ts'), 'utf8')
  check('the prefetch reads the raw spelling (a raw-keyed home must not boot signed-out for a TTL)', prefetch.includes('getRawSpellingKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)'))
}

section("(18) the shell-mode '!' is consumed by exactly one owner (w2-f13-02 — the appended-bang class)")
{
  const prompt = readFileSync(join(ROOT, 'src', 'components', 'PromptInput', 'PromptInput.tsx'), 'utf8')
  const bashEntry = prompt.slice(prompt.indexOf('// Bash-mode entry.'), prompt.indexOf('// Typing side effects'))
  const singleBang = bashEntry.slice(0, bashEntry.indexOf("setMode('bash')"))
  check("the single-'!'-at-offset-0 branch writes the draft through pendingInput.edit before the mode flips", singleBang.includes('pendingInput.edit(input)'))
  check('…and marks the write as its own, so the reconciliation cannot re-import the retained !', singleBang.includes('lastSelfWriteRef.current = input'))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ WINDOWS SEAMS PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
