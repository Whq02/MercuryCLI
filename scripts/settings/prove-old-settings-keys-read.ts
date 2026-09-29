#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const ROOT = join(HERE, '..', '..')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(ROOT, 'src')

function scratchHome(): string {
  const home = join(mkdtempSync(join(tmpdir(), 'old-settings-keys-')), 'home')
  mkdirSync(home, { recursive: true })
  return home
}

function runIn(home: string, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const fs = await import('node:fs')
    const path = await import('node:path')
    const env = await import(${JSON.stringify(join(SRC, 'utils/env.ts'))})
    const g = await import(${JSON.stringify(join(SRC, 'utils/config/globalConfig.ts'))})
    const s = await import(${JSON.stringify(join(SRC, 'utils/settings/settings.ts'))})
    const mc = await import(${JSON.stringify(join(SRC, 'migrations/migrateConfigSpellings.ts'))})
    const ms = await import(${JSON.stringify(join(SRC, 'migrations/migrateSettingsSpellings.ts'))})
    ${body}
  `
  const r = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: { ...process.env, MERCURY_CONFIG_DIR: home }, cwd: ROOT })
  const line = r.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop()
  if (line === undefined) return { error: `no verdict line; stderr: ${r.stderr.slice(0, 600)}` }
  return JSON.parse(line) as Record<string, unknown>
}

console.log('============================================================')
console.log(' old settings keys are read: teammateMode, teammateDefaultModel, hooks.TeammateIdle')
console.log('============================================================')

console.log('§1 the retired-key tables carry the crew spellings')
{
  const home = scratchHome()
  const v = runIn(home, `
    const cfg = mc.rewriteRetiredGlobalConfigKeys({ teammateMode: 'in-process', teammateDefaultModel: 'claude-sonnet-5' })
    const st = ms.rewriteRetiredSettingsSpellings({ hooks: { TeammateIdle: [{ hooks: [{ type: 'command', command: 'true' }] }] } })
    console.log(JSON.stringify({
      crewmateMode: cfg.crewmateMode ?? null,
      crewmateDefaultModel: cfg.crewmateDefaultModel ?? null,
      oldModeGone: !('teammateMode' in cfg),
      crewmateIdle: Array.isArray(st.hooks?.CrewmateIdle) ? st.hooks.CrewmateIdle.length : null,
      oldIdleGone: !('TeammateIdle' in (st.hooks ?? {})),
    }))
  `)
  check('a global config with teammateMode reads as crewmateMode', v.crewmateMode === 'in-process', JSON.stringify(v))
  check('a global config with teammateDefaultModel reads as crewmateDefaultModel', v.crewmateDefaultModel === 'claude-sonnet-5')
  check('the old global-config key is retired after the rewrite', v.oldModeGone === true)
  check('settings hooks under TeammateIdle read as hooks.CrewmateIdle with every entry', v.crewmateIdle === 1)
  check('the old hook event key is retired after the rewrite', v.oldIdleGone === true)
}

console.log('§2 a saved global config written under the old keys boots and its values apply')
{
  const home = scratchHome()
  writeFileSync(join(home, '.config.json'), JSON.stringify({ teammateMode: 'in-process', teammateDefaultModel: 'claude-sonnet-5', numStartups: 3 }, null, 2))
  const v = runIn(home, `
    g.enableConfigs()
    const cfg = g.getGlobalConfig()
    console.log(JSON.stringify({ file: env.getGlobalMercuryFile(), crewmateMode: cfg.crewmateMode ?? null, crewmateDefaultModel: cfg.crewmateDefaultModel ?? null, numStartups: cfg.numStartups }))
  `)
  check('the config file under the scratch home was the one read', typeof v.file === 'string' && (v.file as string).startsWith(home), String(v.file))
  check('crewmateMode carries the saved teammateMode value', v.crewmateMode === 'in-process', JSON.stringify(v))
  check('crewmateDefaultModel carries the saved teammateDefaultModel value', v.crewmateDefaultModel === 'claude-sonnet-5')
  check('the rest of the file still applies', v.numStartups === 3)
}

console.log('§3 a settings file with hooks under TeammateIdle is read as CrewmateIdle and rewritten once')
{
  const home = scratchHome()
  const settingsPath = join(home, 'settings.json')
  writeFileSync(settingsPath, JSON.stringify({ hooks: { TeammateIdle: [{ hooks: [{ type: 'command', command: 'true' }] }] } }, null, 2))
  const v = runIn(home, `
    const parsed = s.parseSettingsFile(${JSON.stringify(settingsPath)})
    const hooks = parsed.settings?.hooks ?? {}
    console.log(JSON.stringify({ crewmateIdle: Array.isArray(hooks.CrewmateIdle) ? hooks.CrewmateIdle.length : null, teammateIdle: 'TeammateIdle' in hooks, errors: parsed.errors.filter(e => e.severity !== 'warning').length, text: fs.readFileSync(${JSON.stringify(settingsPath)}, 'utf8') }))
  `)
  check('the parsed settings carry the hook under CrewmateIdle', v.crewmateIdle === 1, JSON.stringify({ ...v, text: undefined }))
  check('no TeammateIdle key survives in the parsed settings', v.teammateIdle === false)
  check('the file validates with no error', v.errors === 0)
  check('the file was rewritten once to the current spelling', typeof v.text === 'string' && (v.text as string).includes('CrewmateIdle') && !(v.text as string).includes('TeammateIdle'))
}

console.log('§4 the schema names the crew spellings')
{
  const schema = readFileSync(join(ROOT, 'scripts/settings/settings-schema.json'), 'utf8')
  check('the generated settings schema lists CrewmateIdle among the hook events', schema.includes('"CrewmateIdle"'))
  check('the generated settings schema no longer lists TeammateIdle', !schema.includes('"TeammateIdle"'))
}

console.log(failures === 0 ? '\nold settings keys: ALL GREEN' : `\nold settings keys: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
