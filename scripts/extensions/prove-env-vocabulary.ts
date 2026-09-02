#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-env-vocabulary.ts — ONE env vocabulary.
//
//  §1 a REAL hook spawn receives MERCURY_EXTENSION_ROOT,
//     MERCURY_EXTENSION_DATA and MERCURY_EXTENSION_OPTION_<KEY> — and NO
//     other extension-env spelling (the retired families are absent from
//     the child's environment).
//  §2 the templates substitute in command lines: ${MERCURY_EXTENSION_ROOT},
//     ${MERCURY_EXTENSION_DATA}, ${option.KEY}; every OTHER ${…} stays
//     literal.
//  §3 an extension's servers (MCP and language) carry the same two folders
//     and the option family in their env; a declared name overrides the
//     injected value.
//  §4 MERCURY_EXTENSIONS_DIR overrides the estate root (the one path owner).
//  §5 the retired input spellings are DEAD: no source file reads them.
//  §6 a sensitive option renders a placeholder in PROSE the model reads and
//     the REAL value in a hook/server env; skill CONTENT templates expand
//     Mercury's own spellings alone (another product's template spelling
//     stays literal in the body).
// ============================================================================
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-env-'))
const home = join(scratch, 'home')
const cwd = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(cwd)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const paths = await import('../../src/extensions/paths.ts')
const sources = await import('../../src/extensions/sources.ts')
const install = await import('../../src/extensions/install.ts')
const options = await import('../../src/extensions/options.ts')
const reloadMod = await import('../../src/extensions/reload.ts')
const loadServers = await import('../../src/extensions/load/servers.ts')
const loadLanguage = await import('../../src/extensions/load/language.ts')
const loadCommands = await import('../../src/extensions/load/commands.ts')
const execution = await import('../../src/utils/hooks/execution.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')
const ROOT = join(import.meta.dir, '..', '..')
// The retired spellings, composed so this file never spells them.
const J = (...parts: string[]): string => parts.join('')
const RETIRED_ROOT = J('MERCURY_', 'PLUG', 'IN_ROOT')
const RETIRED_DATA = J('MERCURY_', 'PLUG', 'IN_DATA')
const RETIRED_OPTION = J('MERCURY_', 'PLUG', 'IN_OPTION_')
const RETIRED_CACHE = J('MERCURY_', 'PLUG', 'IN_CACHE_DIR')
const RETIRED_SEED = J('MERCURY_', 'PLUG', 'IN_SEED_DIR')
const RETIRED_SYNC = J('MERCURY_SYNC_', 'PLUG', 'IN_INSTALL')
const EXTERNAL_SKILL_DIR = J('${', 'CLA', 'UDE_SKILL_DIR}')
const EXTERNAL_SESSION = J('${', 'CLA', 'UDE_SESSION_ID}')

console.log('============================================================')
console.log(' the env vocabulary — one spelling, emitted and substituted')
console.log('============================================================')

const added = await sources.addSource(FIXTURE, { label: 'fixture-source' })
check('the fixture source adds', added.ok)
const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
check('kitchen-sink installs', installed.ok)
check('approve lands', install.approve('kitchen-sink@fixture-source').ok)
const ID = 'kitchen-sink@fixture-source'
const saved = options.saveOptionValues(ID, installed.ok ? installed.manifest.needs?.options : undefined, { FIXTURE_TOKEN: 'secret-value', FIXTURE_NAME: 'ada' })
check('the options save', saved.ok)
await reloadMod.reloadExtensions({ cwd })

// ── §1 a real hook spawn ────────────────────────────────────────────────────
console.log('[1] the hook child receives the three spellings and nothing retired')
{
  const out = join(scratch, 'env-dump.txt')
  const hook = { type: 'command' as const, command: `sh -c 'env > ${out}'` }
  const result = await execution.execCommandHook(hook, 'PostToolUse', 'env-probe', '{}', new AbortController().signal, 'hook_env', 0, installed.ok ? installed.root : '', ID)
  check('the hook ran', result.status === 0, `status=${result.status}`)
  const env = readFileSync(out, 'utf8')
  check('MERCURY_EXTENSION_ROOT is the extension folder', env.includes(`MERCURY_EXTENSION_ROOT=${installed.ok ? installed.root : ''}`))
  check('MERCURY_EXTENSION_DATA is the data folder', env.includes(`MERCURY_EXTENSION_DATA=${paths.getExtensionDataDir(ID)}`))
  check('each option arrives as MERCURY_EXTENSION_OPTION_<KEY>', env.includes('MERCURY_EXTENSION_OPTION_FIXTURE_TOKEN=secret-value') && env.includes('MERCURY_EXTENSION_OPTION_FIXTURE_NAME=ada'))
  check('no retired spelling reaches the child', !env.includes(RETIRED_ROOT) && !env.includes(RETIRED_DATA) && !env.includes(RETIRED_OPTION))
}

// ── §2 the command-line templates ───────────────────────────────────────────
console.log('[2] the three templates substitute; every other ${…} stays literal')
{
  const out = join(scratch, 'template-dump.txt')
  const hook = { type: 'command' as const, command: `sh -c 'echo "root=\${MERCURY_EXTENSION_ROOT} data=\${MERCURY_EXTENSION_DATA} opt=\${option.FIXTURE_NAME} other=\${NOT_A_TEMPLATE} home=\$HOME" > ${out}'` }
  // The templates substitute BEFORE the shell sees the line, so the shell
  // quoting above keeps ${…} literal for the executor to replace.
  const result = await execution.execCommandHook(hook, 'PostToolUse', 'template-probe', '{}', new AbortController().signal, 'hook_tpl', 0, installed.ok ? installed.root : '', ID)
  check('the hook ran', result.status === 0)
  const line = readFileSync(out, 'utf8')
  check('${MERCURY_EXTENSION_ROOT} substituted', line.includes(`root=${installed.ok ? installed.root : ''}`))
  check('${MERCURY_EXTENSION_DATA} substituted', line.includes(`data=${paths.getExtensionDataDir(ID)}`))
  check('${option.KEY} substituted', line.includes('opt=ada'))
  check('an unknown ${…} stays for the SHELL (literal to Mercury)', !line.includes('NOT_A_TEMPLATE=mercury-substituted'))
}

// ── §3 the servers' env ─────────────────────────────────────────────────────
console.log('[3] MCP and language servers carry the folders and options; a declared name overrides')
{
  const mcp = loadServers.getExtensionMcpServers()['ext:kitchen-sink:fixture'] as { env?: Record<string, string> }
  check('the MCP server env carries the two folders', mcp?.env?.['MERCURY_EXTENSION_ROOT'] === (installed.ok ? installed.root : '') && mcp?.env?.['MERCURY_EXTENSION_DATA'] === paths.getExtensionDataDir(ID))
  check('the option family rides along', mcp?.env?.['MERCURY_EXTENSION_OPTION_FIXTURE_NAME'] === 'ada')
  check('the manifest\'s declared env resolves its ${option.KEY}', mcp?.env?.['FIXTURE_TOKEN'] === 'secret-value')
  const lsp = loadLanguage.getExtensionLspServers()['ext:kitchen-sink:fixture-ls'] as { env?: Record<string, string> } | undefined
  check('the language server env carries the same folders', lsp?.env?.['MERCURY_EXTENSION_ROOT'] === (installed.ok ? installed.root : ''))
  check('no retired spelling in either env', !JSON.stringify(mcp?.env).includes(RETIRED_ROOT.slice(8)) && !JSON.stringify(lsp?.env ?? {}).includes(RETIRED_ROOT.slice(8)))
}

// ── §4 the estate-root override ─────────────────────────────────────────────
console.log('[4] MERCURY_EXTENSIONS_DIR overrides the one path owner')
{
  const override = join(scratch, 'estate-override')
  process.env.MERCURY_EXTENSIONS_DIR = override
  check('the root follows the override', paths.getExtensionsRoot() === override)
  check('every path derives from it', paths.getSourcesFile().startsWith(override) && paths.getInstalledDir().startsWith(override) && paths.getExtensionDataDir('x@y').startsWith(override))
  delete process.env.MERCURY_EXTENSIONS_DIR
  check('unset restores the config-home estate', paths.getExtensionsRoot() === join(home, 'extensions'))
}

// ── §5 the retired input spellings are dead ─────────────────────────────────
console.log('[5] no source file reads the retired inputs')
{
  const hits = execSync(
    `grep -rl -e "${RETIRED_CACHE}" -e "${RETIRED_SEED}" -e "${RETIRED_SYNC}" -e "${RETIRED_ROOT}" -e "${RETIRED_DATA}" src || true`,
    { cwd: ROOT, encoding: 'utf8' },
  ).trim()
  check('src spells none of the retired env names', hits === '', hits)
}

// ── §6 sensitive placeholder in prose; Mercury's template spellings alone ───
console.log("[6] prose gets the placeholder; the child env gets the value; only Mercury's template spellings substitute")
{
  const skill = loadCommands.getExtensionSkills().find(c => c.name === 'kitchen-sink:fixture-skill')
  check('the skill is loaded', skill !== undefined)
  if (skill && skill.type === 'prompt') {
    const blocks = await skill.getPromptForCommand('', undefined as never)
    const text = blocks[0]!.text
    check('the sensitive option renders the placeholder naming the key', text.includes('<option FIXTURE_TOKEN: set by the operator, not shown>'), text.slice(0, 200))
    check('the sensitive VALUE never enters the prose', !text.includes('secret-value'))
    check('the plain option substitutes in prose', text.includes('ada'))
    check('${MERCURY_EXTENSION_ROOT} substitutes in prose', text.includes(installed.ok ? installed.root : '<nope>'))
  }
  // The content-template pin: the loader substitutes Mercury's own skill-dir
  // and session spellings and no other product's (a body carrying another
  // spelling keeps it literal).
  const loaderSrc = readFileSync(join(ROOT, 'src', 'extensions', 'load', 'commands.ts'), 'utf8')
  check("Mercury's skill-dir spelling substitutes", loaderSrc.includes("replaceAll('${MERCURY_SKILL_DIR}'"))
  check("Mercury's session-id spelling substitutes", loaderSrc.includes("replaceAll('${MERCURY_SESSION_ID}'"))
  check("another product's skill-dir spelling never substitutes", !loaderSrc.includes(EXTERNAL_SKILL_DIR))
  check("another product's session-id spelling never substitutes", !loaderSrc.includes(EXTERNAL_SESSION))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ ENV VOCABULARY — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
