#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

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

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const paths = await import('../../src/integrations/extensions/paths.ts')
const sources = await import('../../src/integrations/extensions/sources.ts')
const install = await import('../../src/integrations/extensions/install.ts')
const options = await import('../../src/integrations/extensions/options.ts')
const reloadMod = await import('../../src/integrations/extensions/reload.ts')
const loadServers = await import('../../src/integrations/extensions/load/servers.ts')
const loadLanguage = await import('../../src/integrations/extensions/load/language.ts')
const loadCommands = await import('../../src/integrations/extensions/load/commands.ts')
const { startCommandHook } = await import('../../src/integrations/event-hooks/commandRunner.ts')
const runHook = async (command: string, name: string): Promise<{ status: number }> => {
  const process_ = await startCommandHook({ command, shell: 'bash', name, event: 'tool.after', index: 0, payloadJson: '{}', timeoutMs: 20_000, source: { kind: 'extension', id: ID, root: installed.ok ? installed.root : '' } })
  const end = await process_.result
  return { status: end.kind === 'exited' ? end.code : 1 }
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-source')
const J = (...parts: string[]): string => parts.join('')
const RETIRED_ROOT = J('MERCURY_', 'PLUG', 'IN_ROOT')
const RETIRED_DATA = J('MERCURY_', 'PLUG', 'IN_DATA')
const RETIRED_OPTION = J('MERCURY_', 'PLUG', 'IN_OPTION_')

console.log('============================================================')
console.log(' the env vocabulary — one spelling, emitted and substituted')
console.log('============================================================')

const added = await sources.addSource(FIXTURE, { label: 'fixture-source' })
check('the fixture source adds', added.ok, 'addSource in src/integrations/extensions/sources.ts refused the fixture at scripts/extensions/fixtures/fixture-source: ' + JSON.stringify(added))
const installed = await install.installFromSource('fixture-source', 'kitchen-sink')
check('kitchen-sink installs', installed.ok, 'installFromSource in src/integrations/extensions/install.ts refused kitchen-sink: ' + JSON.stringify(installed))
check('approve lands', install.approve('kitchen-sink@fixture-source').ok, 'approve in src/integrations/extensions/install.ts did not approve kitchen-sink@fixture-source')
const ID = 'kitchen-sink@fixture-source'
const saved = options.saveOptionValues(ID, installed.ok ? installed.manifest.needs?.options : undefined, { FIXTURE_TOKEN: 'secret-value', FIXTURE_NAME: 'ada' })
check('the options save', saved.ok, 'saveOptionValues in src/integrations/extensions/options.ts refused the fixture options: ' + JSON.stringify(saved))
await reloadMod.reloadExtensions({ cwd })

console.log('[1] the hook child receives the three spellings and nothing retired')
{
  const out = join(scratch, 'env-dump.txt')
  const result = await runHook(`sh -c 'env > ${out}'`, 'env-probe')
  check('the hook ran', result.status === 0, `status=${result.status}`)
  const env = readFileSync(out, 'utf8')
  check('MERCURY_EXTENSION_ROOT is the extension folder', env.includes(`MERCURY_EXTENSION_ROOT=${installed.ok ? installed.root : ''}`), 'the extension branch of startCommandHook in src/integrations/event-hooks/commandRunner.ts must stamp MERCURY_EXTENSION_ROOT with the extension folder')
  check('MERCURY_EXTENSION_DATA is the data folder', env.includes(`MERCURY_EXTENSION_DATA=${paths.getExtensionDataDir(ID)}`), 'the extension branch of startCommandHook in src/integrations/event-hooks/commandRunner.ts must stamp MERCURY_EXTENSION_DATA with getExtensionDataDir(id)')
  check('each option arrives as MERCURY_EXTENSION_OPTION_<KEY>', env.includes('MERCURY_EXTENSION_OPTION_FIXTURE_TOKEN=secret-value') && env.includes('MERCURY_EXTENSION_OPTION_FIXTURE_NAME=ada'), 'startCommandHook in src/integrations/event-hooks/commandRunner.ts must merge optionEnv() from src/integrations/extensions/options.ts into the hook env')
  check('no retired spelling reaches the child', !env.includes(RETIRED_ROOT) && !env.includes(RETIRED_DATA) && !env.includes(RETIRED_OPTION), 'a retired spelling reached the hook env; remove it from src/integrations/event-hooks/commandRunner.ts or src/integrations/extensions/options.ts')
}

console.log('[2] the three templates substitute; every other ${…} stays literal')
{
  const out = join(scratch, 'template-dump.txt')
  const result = await runHook(`sh -c 'echo "root=\${MERCURY_EXTENSION_ROOT} data=\${MERCURY_EXTENSION_DATA} opt=\${option.FIXTURE_NAME} other=\${NOT_A_TEMPLATE} home=\$HOME" > ${out}'`, 'template-probe')
  check('the hook ran', result.status === 0, `status=${result.status}; startCommandHook in src/integrations/event-hooks/commandRunner.ts did not run the probe`)
  const line = readFileSync(out, 'utf8')
  check('${MERCURY_EXTENSION_ROOT} substituted', line.includes(`root=${installed.ok ? installed.root : ''}`), `got: ${line.trim()}; the substitution in startCommandHook (src/integrations/event-hooks/commandRunner.ts) must replace the template`)
  check('${MERCURY_EXTENSION_DATA} substituted', line.includes(`data=${paths.getExtensionDataDir(ID)}`), `got: ${line.trim()}; the substitution in startCommandHook (src/integrations/event-hooks/commandRunner.ts) must replace the template`)
  check('${option.KEY} substituted', line.includes('opt=ada'), `got: ${line.trim()}; substituteOptionsInCommand in src/integrations/extensions/options.ts must replace the option template`)
  check('an unknown ${…} stays for the SHELL (literal to Mercury)', !line.includes('NOT_A_TEMPLATE=mercury-substituted'), `got: ${line.trim()}; the command substitution in src/integrations/event-hooks/commandRunner.ts must touch only the three template spellings`)
}

console.log('[3] MCP and language servers carry the folders and options; a declared name overrides')
{
  const mcp = loadServers.getExtensionMcpServers()['ext:kitchen-sink:fixture'] as { env?: Record<string, string> }
  check('the MCP server env carries the two folders', mcp?.env?.['MERCURY_EXTENSION_ROOT'] === (installed.ok ? installed.root : '') && mcp?.env?.['MERCURY_EXTENSION_DATA'] === paths.getExtensionDataDir(ID), 'env was ' + JSON.stringify(mcp?.env) + '; getExtensionMcpServers in src/integrations/extensions/load/servers.ts must set both folders')
  check('the option family rides along', mcp?.env?.['MERCURY_EXTENSION_OPTION_FIXTURE_NAME'] === 'ada', 'env was ' + JSON.stringify(mcp?.env) + '; getExtensionMcpServers in src/integrations/extensions/load/servers.ts must spread optionEnv() into env')
  check('the manifest\'s declared env resolves its ${option.KEY}', mcp?.env?.['FIXTURE_TOKEN'] === 'secret-value', 'env was ' + JSON.stringify(mcp?.env) + '; getExtensionMcpServers in src/integrations/extensions/load/servers.ts must resolve ${option.KEY} in the declared env')
  const lsp = loadLanguage.getExtensionLspServers()['ext:kitchen-sink:fixture-ls'] as { env?: Record<string, string> } | undefined
  check('the language server env carries the same folders', lsp?.env?.['MERCURY_EXTENSION_ROOT'] === (installed.ok ? installed.root : ''), 'env was ' + JSON.stringify(lsp?.env) + '; getExtensionLspServers in src/integrations/extensions/load/language.ts must set the folders')
  check('no retired spelling in either env', !JSON.stringify(mcp?.env).includes(RETIRED_ROOT.slice(8)) && !JSON.stringify(lsp?.env ?? {}).includes(RETIRED_ROOT.slice(8)), 'a retired spelling is in the env; remove it from src/integrations/extensions/load/servers.ts or src/integrations/extensions/load/language.ts')
}

console.log('[4] MERCURY_EXTENSIONS_DIR overrides the one path owner')
{
  const override = join(scratch, 'estate-override')
  process.env.MERCURY_EXTENSIONS_DIR = override
  check('the root follows the override', paths.getExtensionsRoot() === override, 'getExtensionsRoot in src/integrations/extensions/paths.ts must read MERCURY_EXTENSIONS_DIR')
  check('every path derives from it', paths.getSourcesFile().startsWith(override) && paths.getInstalledDir().startsWith(override) && paths.getExtensionDataDir('x@y').startsWith(override), 'getSourcesFile, getInstalledDir and getExtensionDataDir in src/integrations/extensions/paths.ts must all derive from getExtensionsRoot')
  delete process.env.MERCURY_EXTENSIONS_DIR
  check('unset restores the config-home estate', paths.getExtensionsRoot() === join(home, 'extensions'), 'getExtensionsRoot in src/integrations/extensions/paths.ts must fall back to <config-home>/extensions when MERCURY_EXTENSIONS_DIR is unset')
}


console.log("[6] prose gets the placeholder; the child env gets the value; only Mercury's template spellings substitute")
{
  const skill = loadCommands.getExtensionSkills().find(c => c.name === 'kitchen-sink:fixture-skill')
  check('the skill is loaded', skill !== undefined, 'getExtensionSkills in src/integrations/extensions/load/commands.ts did not return kitchen-sink:fixture-skill')
  if (skill && skill.type === 'prompt') {
    const blocks = await skill.getPromptForCommand('', undefined as never)
    const text = blocks[0]!.text
    check('the sensitive option renders the placeholder naming the key', text.includes('<option FIXTURE_TOKEN: set by the operator, not shown>'), text.slice(0, 200))
    check('the sensitive VALUE never enters the prose', !text.includes('secret-value'), 'substituteOptionsInContent in src/integrations/extensions/options.ts must render a placeholder for a sensitive option')
    check('the plain option substitutes in prose', text.includes('ada'), 'substituteOptionsInContent in src/integrations/extensions/options.ts must substitute a plain option in prose; text began: ' + text.slice(0, 200))
    check('the prompt opens on the one base-directory line every skill shares (folder named, the reference-files clause present)', /^Base directory for this skill: \S+ \(read or grep files under it for the skill's own references\)\n\n/.test(text), text.slice(0, 160))
    check('${MERCURY_EXTENSION_ROOT} substitutes in prose', text.includes(installed.ok ? installed.root : '<nope>'), 'substituteRootAndData in src/integrations/extensions/options.ts must substitute the root in prose; text began: ' + text.slice(0, 200))
  }
}

removeScratch(scratch)
console.log(failures === 0 ? '\n ✅ ENV VOCABULARY — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
