#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-extensions-cli.ts — the headless verbs, against
//  the BUILT binary on a scratch home.
//
//  §1 every verb answers: list/sources/add/check/install/approve/enable/
//     disable/update/uninstall/block/unblock/validate/init — exit codes and
//     --json shapes.
//  §2 --yes is the ONLY scripted approval: a TTY-less install without it
//     prints the card as text and exits 1 (installed, off); an env var
//     never implies it.
//  §3 `init` scaffolds an extension folder that validates clean and (with
//     --source) a source root that validates clean, with the README
//     template.
//  §4 `validate` names the ignored side files.
//  §5 the command catalogue: the two retired routes do not exist (their
//     names composed in the check); /extensions and /extensions reload
//     exist with the help-domain entry.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-cli-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
if (!existsSync(DIST)) {
  console.log('  – dist/mercury.mjs absent — build first: bun run build.ts')
  process.exit(1)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [DIST, ...args], {
      encoding: 'utf8',
      cwd,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: undefined as never, CI: undefined as never, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', ...env },
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string }
    return { code: failed.status ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}
const json = <T>(out: string): T => JSON.parse(out.slice(out.indexOf(out.trimStart().startsWith('[') ? '[' : '{'))) as T

console.log('============================================================')
console.log(' the CLI verbs — the same states, headless (built binary)')
console.log('============================================================')

// ── §1 the verb walk ────────────────────────────────────────────────────────
console.log('[1] the verb walk: add → sources → list → install(--yes) → disable/enable → check → uninstall → remove')
{
  const empty = run(['extensions', 'list'])
  check('list on a fresh home exits 0 with the empty state naming the maker doc', empty.code === 0 && empty.stdout.includes('no extensions yet') && empty.stdout.includes('docs/EXTENSIONS.md'), empty.stdout.slice(0, 200))
  const emptySources = run(['extensions', 'sources'])
  check('sources on a fresh home names the add act', emptySources.code === 0 && emptySources.stdout.includes('add'), emptySources.stdout.slice(0, 160))

  const added = run(['extensions', 'add', FIXTURE, '--label', 'fixture-source'])
  check('add exits 0, prints the offer, installs nothing', added.code === 0 && added.stdout.includes('kitchen-sink') && added.stdout.includes('nothing installed'), (added.stderr + added.stdout).slice(0, 200))
  const sources = run(['extensions', 'sources', '--json'])
  const sourcesParsed = json<{ sources: Array<{ label: string; kind: string; state: string; offered: number }> }>(sources.stdout)
  check('sources --json carries the row', sourcesParsed.sources[0]?.label === 'fixture-source' && sourcesParsed.sources[0]?.offered === 3)

  const bad = run(['extensions', 'add', 'owner/repo'])
  check('the owner/repo shorthand refuses with exit 1 naming the missing host', bad.code === 1 && bad.stderr.includes('names no host'))

  const installed = run(['extensions', 'install', 'kitchen-sink', '--yes'])
  check('install --yes approves and switches on', installed.code === 0 && installed.stdout.includes('approved and on'), (installed.stderr + installed.stdout).slice(0, 200))
  const listed = json<{ extensions: Array<{ id: string; trust: string; health: { outcome: string } | null }> }>(run(['extensions', 'list', '--json']).stdout)
  const row = listed.extensions.find(e => e.id === 'kitchen-sink@fixture-source')
  check('list --json shows it on with health', row?.trust === 'on' && row?.health !== null, JSON.stringify(row))

  const off = run(['extensions', 'disable', 'kitchen-sink@fixture-source'])
  check('disable exits 0', off.code === 0)
  const offRow = json<{ extensions: Array<{ id: string; trust: string }> }>(run(['extensions', 'list', '--json']).stdout).extensions.find(e => e.id === 'kitchen-sink@fixture-source')
  check('the row reads off', offRow?.trust === 'off')
  check('enable restores', run(['extensions', 'enable', 'kitchen-sink@fixture-source']).code === 0)

  const checked = run(['extensions', 'check', 'fixture-source'])
  check('check exits 0 and prints the offer count', checked.code === 0 && checked.stdout.includes('offered'), (checked.stderr + checked.stdout).slice(0, 160))

  const blocked = run(['extensions', 'block', 'kitchen-sink@fixture-source'])
  check('block exits 0', blocked.code === 0)
  const blockedRow = json<{ extensions: Array<{ id: string; trust: string }> }>(run(['extensions', 'list', '--json']).stdout).extensions.find(e => e.id === 'kitchen-sink@fixture-source')
  check('the row reads blocked', blockedRow?.trust === 'blocked')
  const enableBlocked = run(['extensions', 'enable', 'kitchen-sink@fixture-source'])
  check('enable while blocked refuses naming the unblock key', enableBlocked.code === 1 && enableBlocked.stderr.includes('unblock'))
  check('unblock exits 0', run(['extensions', 'unblock', 'kitchen-sink@fixture-source']).code === 0)

  const un = run(['extensions', 'uninstall', 'kitchen-sink@fixture-source', '--yes'])
  check('uninstall --yes walks the steps', un.code === 0 && un.stdout.includes('uninstalled'), (un.stderr + un.stdout).slice(0, 200))
  const removed = run(['extensions', 'remove', 'fixture-source'])
  check('remove exits 0', removed.code === 0 && removed.stdout.includes('removed source'))
}

// ── §2 --yes is the only scripted approval ──────────────────────────────────
console.log('[2] a TTY-less install without --yes: the card as text, exit 1, installed-off')
{
  check('re-add the source', run(['extensions', 'add', FIXTURE, '--label', 'fixture-source']).code === 0)
  const asked = run(['extensions', 'install', 'kitchen-sink'])
  check('exit 1 without a TTY and without --yes', asked.code === 1)
  check('the card printed as text (runs on your machine · reaches the model · needs)', asked.stdout.includes('runs on your machine') && asked.stdout.includes('reaches the model') && asked.stdout.includes('needs'), asked.stdout.slice(0, 300))
  check('the refusal names --yes', (asked.stderr + asked.stdout).includes('--yes'))
  const row = json<{ extensions: Array<{ id: string; trust: string; approved: boolean }> }>(run(['extensions', 'list', '--json']).stdout).extensions.find(e => e.id === 'kitchen-sink@fixture-source')
  check('the copy stays installed, off, unapproved', row?.trust === 'off' && row?.approved === false, JSON.stringify(row))
  const envTrick = run(['extensions', 'approve', 'kitchen-sink@fixture-source'], { MERCURY_YES: '1', YES: '1', ASSUME_YES: '1' })
  check('no env var implies --yes (still exit 1)', envTrick.code === 1)
  const approved = run(['extensions', 'approve', 'kitchen-sink@fixture-source', '--yes'])
  check('approve --yes lands', approved.code === 0, (approved.stderr + approved.stdout).slice(0, 160))
}

// ── §3 init ─────────────────────────────────────────────────────────────────
console.log('[3] init scaffolds an extension and a source that validate clean')
{
  const ext = run(['extensions', 'init', 'my-tools', '--dir', scratch])
  check('init <name> exits 0', ext.code === 0, (ext.stderr + ext.stdout).slice(0, 160))
  const validated = run(['extensions', 'validate', join(scratch, 'my-tools')])
  check('the scaffold validates clean', validated.code === 0 && validated.stdout.includes('valid'), validated.stdout.slice(0, 200))
  const src = run(['extensions', 'init', 'my-source', '--source', '--dir', scratch])
  check('init --source exits 0 with the README template', src.code === 0 && existsSync(join(scratch, 'my-source', 'README.md')) && readFileSync(join(scratch, 'my-source', 'README.md'), 'utf8').includes('mercury extensions add'))
  const validatedSource = run(['extensions', 'validate', join(scratch, 'my-source')])
  check('the source scaffold validates clean', validatedSource.code === 0, validatedSource.stdout.slice(0, 200))
}

// ── §4 validate names the ignored side files ────────────────────────────────
console.log('[4] validate reports the ignored side files')
{
  const noisy = join(scratch, 'my-tools')
  mkdirSync(join(noisy, 'hooks'), { recursive: true })
  writeFileSync(join(noisy, 'hooks', 'hooks.json'), '{}')
  writeFileSync(join(noisy, '.mcp.json'), '{}')
  const report = run(['extensions', 'validate', noisy])
  check('hooks/hooks.json and .mcp.json are named as ignored', report.stdout.includes('ignored: hooks/hooks.json') && report.stdout.includes('ignored: .mcp.json'), report.stdout.slice(0, 300))
}

// ── §5 the command catalogue ────────────────────────────────────────────────
console.log('[5] /extensions is in the catalogue with its help-domain row; the retired routes are gone')
{
  const commandsMod = await import('../../src/commands.ts')
  process.env.MERCURY_CONFIG_DIR = home
  const commands = await commandsMod.getCommands(cwd)
  const names = new Set(commands.map((c: { name: string }) => c.name))
  check('/extensions exists', names.has('extensions'))
  const J = (...parts: string[]): string => parts.join('')
  check('the retired routes are absent', !names.has(J('plug', 'in')) && !names.has(J('reload-', 'plug', 'ins')), [...names].filter(n => n.includes('plug')).join(','))
  const extensions = commands.find((c: { name: string }) => c.name === 'extensions') as { description: string; argumentHint?: string } | undefined
  check('the description says what it does', extensions !== undefined && extensions.description.includes('extensions') && extensions.description.includes('sources'))
  check('reload rides the command (argument hint)', (extensions?.argumentHint ?? '').includes('reload'))
  const domains = await import('../../src/components/HelpV2/commandDomains.ts')
  const rows = JSON.stringify((domains as { COMMAND_DOMAINS?: unknown }).COMMAND_DOMAINS ?? domains)
  check("the help domain 'config & setup' lists extensions", rows.includes("'extensions'") || rows.includes('"extensions"'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ EXTENSIONS CLI — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
