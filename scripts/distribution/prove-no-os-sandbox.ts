#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'no-os-sandbox-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) out.push(full)
  }
  return out
}

console.log('prove-no-os-sandbox — the OS sandbox has left the product whole: its import, its dependency, its build output, its command, its settings and its wire kind')

section('(a) no file under src/ imports @anthropic-ai/sandbox-runtime and package.json does not list it')
{
  const importers = walk(join(ROOT, 'src')).filter(file => readFileSync(file, 'utf8').includes('@anthropic-ai/sandbox-runtime')).map(file => relative(ROOT, file))
  check('no src file names the package', importers.length === 0, importers.join(', '))
  const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  check('package.json lists no @anthropic-ai/sandbox-runtime', !('@anthropic-ai/sandbox-runtime' in (pkg.dependencies ?? {})) && !('@anthropic-ai/sandbox-runtime' in (pkg.devDependencies ?? {})))
  check('bun.lock carries no sandbox-runtime entry', !read('bun.lock').includes('sandbox-runtime'))
  check('no src/utils/sandbox folder', !existsSync(join(ROOT, 'src', 'utils', 'sandbox')))
}

section('(b) the build vendors no vendor/seccomp and the notices carry no socket-filter paragraph')
{
  const build = read('build.ts')
  check('build.ts has no seccomp seam and no MERCURY_BUILD_NO_VENDOR_SECCOMP switch', !/seccomp|MERCURY_BUILD_NO_VENDOR_SECCOMP|sandbox-runtime/.test(build))
  const manifestPath = join(ROOT, 'dist', 'manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown> & { degraded?: string[] }
    check('dist/manifest.json records no seccomp and no seccomp-filter degradation', !('seccomp' in manifest) && !(manifest.degraded ?? []).includes('seccomp-filter'), JSON.stringify(manifest.seccomp))
    check('dist/vendor/seccomp does not exist', !existsSync(join(ROOT, 'dist', 'vendor', 'seccomp')))
  } else {
    console.log('  [SKIP] no dist/manifest.json here — the dist rows read a built tree (bun run build.ts)')
  }
  const generator = read('scripts/distribution/generate-third-party-notices.ts')
  check('the notices generator names no sandbox socket-filter helper and no sandbox-runtime package', !/socket-filter|sandbox-runtime|sandboxMeta/.test(generator))
  const notices = read('THIRD_PARTY_NOTICES.md')
  check('THIRD_PARTY_NOTICES.md carries no socket-filter paragraph and no sandbox-runtime row', !/socket-filter|sandbox-runtime/.test(notices))
}

section('(c) /sandbox is not a command: the unknown-command sentence')
{
  const { builtinCommands, findCommand } = await import('../../src/commands.ts')
  const { resolveUnknownSlashName, unknownCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
  const commands = [...builtinCommands()]
  check('no built-in command is named sandbox', findCommand('sandbox', commands) === undefined)
  check('/sandbox resolves as an unknown slash name', resolveUnknownSlashName('/sandbox', commands) === 'sandbox')
  const line = unknownCommandLine('sandbox', commands)
  check('the screen answers with the unknown-command sentence', line.startsWith('Unknown command: /sandbox') && line.endsWith('/help lists commands'), line)
  const nosuch = unknownCommandLine('nosuchcommand', commands)
  check('…the same sentence shape any unknown name gets', nosuch.startsWith('Unknown command: /nosuchcommand') && nosuch.endsWith('/help lists commands'), nosuch)
}

section('(d) a settings file carrying guardrails.sandbox.enabled is answered as an unknown key, the same way as any other unknown key')
{
  const { validateSettingsFileContent, unknownKeyWarnings } = await import('../../src/utils/settings/validation.ts')
  const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
  const retired = { guardrails: { sandbox: { enabled: true } } }
  const arbitrary = { guardrails: { nosuchgroup: { enabled: true } } }
  const shape = (SettingsSchema().shape.guardrails as { unwrap?: () => { shape?: Record<string, unknown> } }).unwrap?.().shape ?? {}
  check('the settings schema declares no guardrails.sandbox', !('sandbox' in shape), Object.keys(shape).join(','))
  const editRetired = validateSettingsFileContent(JSON.stringify(retired))
  const editArbitrary = validateSettingsFileContent(JSON.stringify(arbitrary))
  const sameEdit = JSON.stringify(editRetired).replaceAll('sandbox', 'KEY') === JSON.stringify(editArbitrary).replaceAll('nosuchgroup', 'KEY')
  check('edit-time validation answers the retired key exactly as an arbitrary unknown key', sameEdit, JSON.stringify([editRetired, editArbitrary]).slice(0, 300))
  const loadRetired = unknownKeyWarnings(retired, 'settings.json').map(w => ({ ...w, message: w.message.replaceAll('sandbox', 'KEY'), path: w.path.replaceAll('sandbox', 'KEY') }))
  const loadArbitrary = unknownKeyWarnings(arbitrary, 'settings.json').map(w => ({ ...w, message: w.message.replaceAll('nosuchgroup', 'KEY'), path: w.path.replaceAll('nosuchgroup', 'KEY') }))
  check('load-time warnings for the retired key equal those for an arbitrary unknown key', JSON.stringify(loadRetired) === JSON.stringify(loadArbitrary), JSON.stringify([loadRetired, loadArbitrary]).slice(0, 300))
  const topRetired = validateSettingsFileContent(JSON.stringify({ sandbox: { enabled: true } }))
  const topArbitrary = validateSettingsFileContent(JSON.stringify({ nosuchgroup: { enabled: true } }))
  check('a top-level sandbox key is refused exactly as any top-level unknown key', !topRetired.isValid && !topArbitrary.isValid && JSON.stringify(topRetired).replaceAll('sandbox', 'KEY') === JSON.stringify(topArbitrary).replaceAll('nosuchgroup', 'KEY'), JSON.stringify([topRetired, topArbitrary]).slice(0, 300))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify(retired))
  const { getSettingsWithErrors } = await import('../../src/utils/settings/settings.ts')
  const loaded = getSettingsWithErrors()
  const sandboxWords = loaded.errors.filter(e => /sandbox/i.test(`${e.path} ${e.message}`)).filter(e => !/^Unrecognized field/.test(e.message))
  check('loading that file raises no sandbox-specific line (no alias, no migration, no special refusal)', sandboxWords.length === 0, JSON.stringify(sandboxWords))
  const readers = walk(join(ROOT, 'src')).filter(file => /guardrails\??\.sandbox|sandbox\??\.enabled/.test(readFileSync(file, 'utf8'))).map(file => relative(ROOT, file))
  check('no src file reads a guardrails.sandbox switch', readers.length === 0 && loaded.settings !== undefined, readers.join(', '))
}

section("(e) PermissionRequestParamsSchema refuses kind: 'network'")
{
  const { PermissionRequestParamsSchema } = await import('../../src/runner/wire/methods.ts')
  const schema = PermissionRequestParamsSchema()
  const network = schema.safeParse({ kind: 'network', host: 'example.com' })
  check("kind: 'network' is refused", !network.success, JSON.stringify(network.success ? network.data : undefined))
  const tool = schema.safeParse({ kind: 'tool', tool_use_id: 'tu_1', tool_name: 'Bash', input: { command: 'ls' } })
  check("kind: 'tool' still parses", tool.success, tool.success ? '' : JSON.stringify(tool.error.issues).slice(0, 200))
  const bogus = schema.safeParse({ kind: 'nosuchkind', host: 'example.com' })
  check("…and the refusal is the ordinary one: the same verdict an unknown kind gets", !bogus.success && !network.success)
  const sources = ['src/cli/headless/runnerAsks.ts', 'src/daemon/permissionAsks.ts', 'src/daemon/roster.ts', 'src/daemon/runnerFrames.ts', 'src/services/acp/childSession.ts', 'src/services/acp/acpServer.ts'].filter(path => existsSync(join(ROOT, path)))
  const leftovers = sources.filter(path => /SANDBOX_NETWORK_ACCESS_TOOL_NAME|createSandboxAskCallback|kind === 'network'|onNetworkAsk/.test(read(path)))
  check('no runner, daemon or ACP file keeps the network road', leftovers.length === 0, leftovers.join(', '))
  check('docs/AUTOMATION.md describes one ask kind', !/kind: "network"/.test(read('docs/AUTOMATION.md')))
}

section('(f) bun scripts/sdk/generate.ts --check exits 0')
{
  let code = 0
  let out = ''
  try {
    out = execFileSync('bun', ['scripts/sdk/generate.ts', '--check'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: HOME }, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    code = (error as { status?: number }).status ?? 1
    out = String((error as { stdout?: string }).stdout ?? '') + String((error as { stderr?: string }).stderr ?? '')
  }
  check('the SDK door is current', code === 0, out.slice(-300))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-no-os-sandbox: all green' : `\nprove-no-os-sandbox: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
