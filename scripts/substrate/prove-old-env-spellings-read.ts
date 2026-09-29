#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const ROOT = join(import.meta.dir, '..', '..')
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(ROOT, 'src')

const CURRENT = { home: 'MERCURY_CREWS_DIR', surfaces: 'MERCURY_CREWMATES', command: 'MERCURY_CREWMATE_COMMAND' }
const FORMER = { home: 'MERCURY_TEAMS_DIR', surfaces: 'MERCURY_TEAMMATES', command: 'MERCURY_TEAMMATE_COMMAND' }

function runWith(env: Record<string, string | undefined>, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = '/private/tmp/mw/crew-rename-home'
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    const reg = await import(${JSON.stringify(join(SRC, 'substrate/flagRegistry.ts'))})
    const envUtils = await import(${JSON.stringify(join(SRC, 'utils/envUtils.ts'))})
    const swarms = await import(${JSON.stringify(join(SRC, 'utils/agentSwarmsEnabled.ts'))})
    const spec = (name) => reg.getFlagSpec(name)
    const read = (name) => { try { return reg.flagEnv(name) ?? null } catch (e) { return 'THROWS: ' + String(e.message ?? e) } }
    const spellings = (name) => { try { return reg.flagSpellings(name) } catch (e) { return 'THROWS: ' + String(e.message ?? e) } }
    ${body}
  `
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v
  for (const name of [...Object.values(CURRENT), ...Object.values(FORMER)]) delete merged[name]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v
  const r = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: merged, cwd: ROOT })
  const line = r.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop()
  if (line === undefined) return { error: `no verdict line; stderr: ${r.stderr.slice(0, 800)}` }
  return JSON.parse(line) as Record<string, unknown>
}

console.log('============================================================')
console.log(' old env spellings are honoured: MERCURY_TEAMS_DIR, MERCURY_TEAMMATES, MERCURY_TEAMMATE_COMMAND')
console.log('============================================================')

console.log('§1 the crew spellings are the registered flags and name their former spellings')
{
  const v = runWith({}, `
    console.log(JSON.stringify({
      home: spec(${JSON.stringify(CURRENT.home)}) ? { formerly: spec(${JSON.stringify(CURRENT.home)}).formerly ?? null, spellings: spellings(${JSON.stringify(CURRENT.home)}) } : null,
      surfaces: spec(${JSON.stringify(CURRENT.surfaces)}) ? { formerly: spec(${JSON.stringify(CURRENT.surfaces)}).formerly ?? null, spellings: spellings(${JSON.stringify(CURRENT.surfaces)}) } : null,
      command: spec(${JSON.stringify(CURRENT.command)}) ? { formerly: spec(${JSON.stringify(CURRENT.command)}).formerly ?? null, spellings: spellings(${JSON.stringify(CURRENT.command)}) } : null,
      oldRegistered: [${JSON.stringify(FORMER.home)}, ${JSON.stringify(FORMER.surfaces)}, ${JSON.stringify(FORMER.command)}].filter(n => spec(n) !== undefined),
      crewDirReader: typeof envUtils.getCrewsDir === 'function',
    }))
  `)
  const home = v.home as { formerly: string | null; spellings: string[] } | null
  const surfaces = v.surfaces as { formerly: string | null; spellings: string[] } | null
  const command = v.command as { formerly: string | null; spellings: string[] } | null
  check(`${CURRENT.home} is a registered flag whose former spelling is ${FORMER.home}`, home !== null && home.formerly === FORMER.home, JSON.stringify(v))
  check(`${CURRENT.surfaces} is a registered flag whose former spelling is ${FORMER.surfaces}`, surfaces !== null && surfaces.formerly === FORMER.surfaces)
  check(`${CURRENT.command} is a registered flag whose former spelling is ${FORMER.command}`, command !== null && command.formerly === FORMER.command)
  check('the spellings of each flag list the current one first and the former one second', [home, surfaces, command].every((s, i) => s !== null && s.spellings.length === 2 && s.spellings[0] === Object.values(CURRENT)[i] && s.spellings[1] === Object.values(FORMER)[i]))
  check('the former spellings are not registered rows of their own', Array.isArray(v.oldRegistered) && (v.oldRegistered as string[]).length === 0)
  check('the saved-crews home reader is getCrewsDir', v.crewDirReader === true)
}

console.log('§2 a shell that sets only the old spellings is honoured')
{
  const v = runWith({ [FORMER.home]: '/private/tmp/mw/crew-rename-old-teams-home', [FORMER.surfaces]: '0', [FORMER.command]: '/private/tmp/mw/crew-rename-old-command' }, `
    console.log(JSON.stringify({
      home: read(${JSON.stringify(CURRENT.home)}),
      homeDir: typeof envUtils.getCrewsDir === 'function' ? envUtils.getCrewsDir() : null,
      surfaces: read(${JSON.stringify(CURRENT.surfaces)}),
      swarmsOn: (() => { try { return swarms.isAgentSwarmsEnabled() } catch (e) { return 'THROWS: ' + String(e.message ?? e) } })(),
      command: read(${JSON.stringify(CURRENT.command)}),
    }))
  `)
  check(`${FORMER.home} alone sets the saved-crews home`, v.home === '/private/tmp/mw/crew-rename-old-teams-home' && v.homeDir === '/private/tmp/mw/crew-rename-old-teams-home', JSON.stringify(v))
  check(`${FORMER.surfaces}=0 alone turns the crewmate surfaces off`, v.surfaces === '0' && v.swarmsOn === false)
  check(`${FORMER.command} alone names the crewmate launch command`, v.command === '/private/tmp/mw/crew-rename-old-command')
}

console.log('§3 the current spelling wins when both are set')
{
  const v = runWith({ [FORMER.home]: '/private/tmp/mw/crew-rename-old-teams-home', [CURRENT.home]: '/private/tmp/mw/crew-rename-new-crews-home' }, `
    console.log(JSON.stringify({ home: read(${JSON.stringify(CURRENT.home)}), homeDir: typeof envUtils.getCrewsDir === 'function' ? envUtils.getCrewsDir() : null }))
  `)
  check('the current spelling is read first', v.home === '/private/tmp/mw/crew-rename-new-crews-home' && v.homeDir === '/private/tmp/mw/crew-rename-new-crews-home', JSON.stringify(v))
}

console.log('§4 a child env stamped through the registry carries both spellings')
{
  const v = runWith({}, `
    const pair = reg.flagPair(${JSON.stringify(CURRENT.surfaces)}, '1')
    const child = {}
    reg.stampFlagOnEnv(child, ${JSON.stringify(CURRENT.home)}, '/x')
    reg.setFlagEnv(${JSON.stringify(CURRENT.command)}, '/y')
    const before = { current: process.env[${JSON.stringify(CURRENT.command)}] ?? null, former: process.env[${JSON.stringify(FORMER.command)}] ?? null }
    process.env[${JSON.stringify(FORMER.command)}] = '/z'
    reg.deleteFlagEnv(${JSON.stringify(CURRENT.command)})
    const after = { current: process.env[${JSON.stringify(CURRENT.command)}] ?? null, former: process.env[${JSON.stringify(FORMER.command)}] ?? null }
    console.log(JSON.stringify({ pair, child, before, after }))
  `)
  const pair = v.pair as Record<string, string>
  const child = v.child as Record<string, string>
  check('flagPair stamps the current and the former spelling', pair !== undefined && pair[CURRENT.surfaces] === '1' && pair[FORMER.surfaces] === '1', JSON.stringify(v))
  check('stampFlagOnEnv stamps both spellings on a child env', child !== undefined && child[CURRENT.home] === '/x' && child[FORMER.home] === '/x')
  check('setFlagEnv writes the current spelling only', JSON.stringify(v.before) === JSON.stringify({ current: '/y', former: null }))
  check('deleteFlagEnv removes both spellings', JSON.stringify(v.after) === JSON.stringify({ current: null, former: null }))
}

console.log(failures === 0 ? '\nold env spellings: ALL GREEN' : `\nold env spellings: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
