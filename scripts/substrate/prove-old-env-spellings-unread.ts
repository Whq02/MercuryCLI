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

const CURRENT = { home: 'MERCURY_CREWS_DIR', surfaces: 'MERCURY_CREWMATES' }
const OLD = { home: 'MERCURY_TEAMS_DIR', surfaces: 'MERCURY_TEAMMATES' }
const NONSENSE = 'MERCURY_FROBNICATE_DIR'

function runWith(env: Record<string, string | undefined>, body: string): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = '/private/tmp/mw/crew-rename-home'
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    const reg = await import(${JSON.stringify(join(SRC, 'substrate/flagRegistry.ts'))})
    const envUtils = await import(${JSON.stringify(join(SRC, 'utils/envUtils.ts'))})
    const swarms = await import(${JSON.stringify(join(SRC, 'utils/crewEnabled.ts'))})
    const spec = (name) => reg.getFlagSpec(name)
    const read = (name) => { try { return reg.flagEnv(name) ?? null } catch (e) { return 'THROWS: ' + String(e.message ?? e) } }
    const spellings = (name) => { try { return reg.flagSpellings(name) } catch (e) { return 'THROWS: ' + String(e.message ?? e) } }
    ${body}
  `
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v
  for (const name of [...Object.values(CURRENT), ...Object.values(OLD), NONSENSE]) delete merged[name]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) merged[k] = v
  const r = spawnSync(BUN, ['-e', src], { encoding: 'utf8', env: merged, cwd: ROOT })
  const line = r.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop()
  if (line === undefined) return { error: `no verdict line; stderr: ${r.stderr.slice(0, 800)}` }
  return JSON.parse(line) as Record<string, unknown>
}

const facts = `
  console.log(JSON.stringify({
    home: read(${JSON.stringify(CURRENT.home)}),
    homeDir: envUtils.getCrewsDir(),
    surfaces: read(${JSON.stringify(CURRENT.surfaces)}),
    crewOn: swarms.isCrewEnabled(),
  }))
`

console.log('============================================================')
console.log(' the crew flags answer to one spelling each; an old one is as unknown as nonsense')
console.log('============================================================')

console.log('§1 the registry names one spelling per flag')
{
  const v = runWith({}, `
    console.log(JSON.stringify({
      rows: Object.values(${JSON.stringify(CURRENT)}).map(name => spec(name) ? Object.keys(spec(name)) : null),
      spellings: Object.values(${JSON.stringify(CURRENT)}).map(name => spellings(name)),
      oldRegistered: [...Object.values(${JSON.stringify(OLD)}), ${JSON.stringify(NONSENSE)}].filter(n => spec(n) !== undefined),
      everySpellingIsItsOwn: reg.FLAG_REGISTRY.every(row => JSON.stringify(reg.flagSpellings(row.env)) === JSON.stringify([row.env])),
    }))
  `)
  const rows = v.rows as Array<string[] | null>
  check('both crew flags are registered rows', Array.isArray(rows) && rows.every(r => r !== null), JSON.stringify(v))
  check('no row carries a second spelling', Array.isArray(rows) && rows.every(r => r !== null && !r.includes('formerly')))
  check('the spellings of each flag are the one registered name', JSON.stringify(v.spellings) === JSON.stringify([[CURRENT.home], [CURRENT.surfaces]]), JSON.stringify(v.spellings))
  check('every registered flag has exactly its own spelling', v.everySpellingIsItsOwn === true)
  check('the old names and a nonsense name are registered nowhere', Array.isArray(v.oldRegistered) && (v.oldRegistered as string[]).length === 0, JSON.stringify(v.oldRegistered))
}

const control = runWith({}, facts)
console.log('§2 a shell that sets only the old spellings is read like one that sets nonsense')
{
  const old = runWith({ [OLD.home]: '/private/tmp/mw/crew-rename-old-teams-home', [OLD.surfaces]: '0' }, facts)
  const nonsense = runWith({ [NONSENSE]: '/private/tmp/mw/crew-rename-old-teams-home' }, facts)
  check('nothing is read from the old spellings: the crews home and the surfaces read as with no variable at all', JSON.stringify(old) === JSON.stringify(control), `${JSON.stringify(old)} vs ${JSON.stringify(control)}`)
  check('…exactly as a nonsense variable reads', JSON.stringify(nonsense) === JSON.stringify(control), JSON.stringify(nonsense))
  check('the control itself is the default: no override, the surfaces on', control.home === null && control.surfaces === null && control.crewOn === true && typeof control.homeDir === 'string' && (control.homeDir as string).endsWith('/crews'), JSON.stringify(control))
}

console.log('§3 the current spellings are read')
{
  const v = runWith({ [CURRENT.home]: '/private/tmp/mw/crew-rename-new-crews-home', [CURRENT.surfaces]: '0' }, facts)
  check(`${CURRENT.home} sets the crews home`, v.home === '/private/tmp/mw/crew-rename-new-crews-home' && v.homeDir === '/private/tmp/mw/crew-rename-new-crews-home', JSON.stringify(v))
  check(`${CURRENT.surfaces}=0 turns the crewmate surfaces off`, v.surfaces === '0' && v.crewOn === false, JSON.stringify(v))
}

console.log('§4 a child env stamped through the registry carries the one spelling, and an old-spelled variable is left as any other')
{
  const v = runWith({}, `
    const pair = reg.flagPair(${JSON.stringify(CURRENT.surfaces)}, '1')
    const child = {}
    reg.stampFlagOnEnv(child, ${JSON.stringify(CURRENT.home)}, '/x')
    process.env[${JSON.stringify(OLD.surfaces)}] = '/z'
    reg.setFlagEnv(${JSON.stringify(CURRENT.surfaces)}, '/y')
    const before = { current: process.env[${JSON.stringify(CURRENT.surfaces)}] ?? null, old: process.env[${JSON.stringify(OLD.surfaces)}] ?? null }
    reg.deleteFlagEnv(${JSON.stringify(CURRENT.surfaces)})
    const after = { current: process.env[${JSON.stringify(CURRENT.surfaces)}] ?? null, old: process.env[${JSON.stringify(OLD.surfaces)}] ?? null }
    console.log(JSON.stringify({ pair, child, before, after }))
  `)
  check('flagPair stamps the one spelling', JSON.stringify(v.pair) === JSON.stringify({ [CURRENT.surfaces]: '1' }), JSON.stringify(v.pair))
  check('stampFlagOnEnv stamps the one spelling on a child env', JSON.stringify(v.child) === JSON.stringify({ [CURRENT.home]: '/x' }), JSON.stringify(v.child))
  check('setFlagEnv writes the current spelling and touches no other variable', JSON.stringify(v.before) === JSON.stringify({ current: '/y', old: '/z' }), JSON.stringify(v.before))
  check('deleteFlagEnv removes the current spelling and touches no other variable', JSON.stringify(v.after) === JSON.stringify({ current: null, old: '/z' }), JSON.stringify(v.after))
}

console.log(failures === 0 ? '\nold env spellings unread: ALL GREEN' : `\nold env spellings unread: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
