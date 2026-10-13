#!/usr/bin/env bun
// gate-watch: src/utils/wards/wards* src/guards/wardsGuard* src/guards/guards* src/utils/cwd* src/utils/path*
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const spelledHome = (path: string): boolean => path.startsWith('/Users/') || path.startsWith('/home/')

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

if (process.argv[2] !== '--home') {
  const configScratch = realpathSync(mkdtempSync(join(tmpdir(), 'ward-home-config-')))
  mkdirSync(join(configScratch, 'home'), { recursive: true })
  const tempRoot = spelledHome(tmpdir()) ? '/tmp' : tmpdir()
  const relocatedHome = mkdtempSync(join(tempRoot, 'ward-home-'))
  const shapes: Array<[string, string | undefined]> = [
    ['relocated', relocatedHome],
    ['unlisted', '/srv/homes/proof'],
    ['unlisted-slash', '/srv/homes/proof/'],
    ['root', '/'],
    ['unset', undefined],
  ]
  console.log('the recursive-delete wards know the home wherever it is')
  try {
    for (const [shape, home] of shapes) {
      const env: Record<string, string | undefined> = { ...process.env }
      delete env.USERPROFILE
      delete env.HOME
      if (home !== undefined) env.HOME = home
      env.MERCURY_CONFIG_DIR = join(configScratch, 'home')
      env.MERCURY_CREDENTIAL_STORE = 'file'
      env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
      env.MERCURY_SPAWNED_BY = 'proof:ward-home#1'
      console.log(`\n== the home is ${home === undefined ? 'UNSET (the account entry decides)' : home} (${shape})`)
      const child = spawnSync(process.execPath, [process.argv[1]!, '--home', shape, relocatedHome], { env, stdio: 'inherit', timeout: 120_000 })
      check(`the ${shape} shape ran to its end with every check green`, child.status === 0, child.status === null ? `signal ${child.signal ?? 'unknown'}` : `exit ${child.status}`)
    }
  } finally {
    rmSync(relocatedHome, { recursive: true, force: true })
    rmSync(configScratch, { recursive: true, force: true })
  }
  console.log(`\nward-home-anywhere: ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

const shape = process.argv[3] ?? ''
const relocatedHome = process.argv[4] ?? ''
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type PendingToolCall = import('../../src/utils/wards/wards.js').PendingToolCall
type WardVerdict = import('../../src/utils/wards/wards.js').WardVerdict
const { AUTONOMOUS_WARDS, REFUSAL_WARDS, evaluateWards } = await import('../../src/utils/wards/wards.js')
const guard = await import('../../src/guards/wardsGuard.js')
const { deleteWardActive, makeTargetResolver, WARDS_HOOK_ID, registerWardsGuard, resetWardsEngagedSessionsForTest } = guard
const homeSpellings: () => string[] = (guard as { homeSpellings?: () => string[] }).homeSpellings ?? (() => [])
const { judgeToolCall } = await import('../../src/guards/guards.js')
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

const bash = (command: string, resolvePath?: PendingToolCall['resolvePath']): PendingToolCall => ({
  toolName: 'Bash',
  input: { command },
  shellCommand: command,
  ...(resolvePath ? { resolvePath } : {}),
})
const holeOf = (verdict: WardVerdict): string => (verdict.allow ? 'ALLOWED (hole!)' : verdict.rule.name)
const ruleOf = (verdict: WardVerdict): string => (verdict.allow ? 'allowed' : `denied by ${verdict.rule.name}`)
const wardedBy = (verdict: WardVerdict, name: string): boolean => !verdict.allow && verdict.rule.name === name
const autonomous = (command: string, resolvePath?: PendingToolCall['resolvePath']): WardVerdict => evaluateWards(AUTONOMOUS_WARDS, bash(command, resolvePath))
const refusal = (command: string): WardVerdict => evaluateWards(REFUSAL_WARDS, bash(command))

check('the autonomous delete-ward is armed (MERCURY_SPAWNED_BY set)', deleteWardActive())

if (shape === 'relocated') {
  check('the relocated home is spelled under neither /Users nor /home', !spelledHome(relocatedHome) && homedir() === relocatedHome, `${relocatedHome} · homedir ${homedir()}`)
  const homeReal = realpathSync(relocatedHome)
  check("the guard's home spellings name the home as given and as resolved", homeSpellings().includes(relocatedHome) && homeSpellings().includes(homeReal), homeSpellings().join(' · '))
  const project = join(relocatedHome, 'hunt')
  const inside = join(project, 'scratch-dir', 'zzz-test')
  mkdirSync(inside, { recursive: true })
  const canary = join(project, 'CANARY')
  writeFileSync(canary, 'alive')
  const outside = join(relocatedHome, 'outside-decoy')
  mkdirSync(outside, { recursive: true })
  const projectReal = realpathSync(project)
  const outsideReal = realpathSync(outside)
  const resolveInProject = makeTargetResolver(projectReal)

  const absoluteInside = `rm -rf ${join(projectReal, 'scratch-dir', 'zzz-test')}`
  check('the string road alone wards an absolute delete under the resolved home spelling (nothing to resolve against)', wardedBy(autonomous(absoluteInside), 'no-home-recursive-delete'), holeOf(autonomous(absoluteInside)))
  check('the string road alone wards an absolute delete under the home as given', wardedBy(autonomous(`rm -rf ${join(relocatedHome, 'stuff')}`), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf ${join(relocatedHome, 'stuff')}`)))
  check('with the resolver the in-project absolute delete passes', autonomous(absoluteInside, resolveInProject).allow, ruleOf(autonomous(absoluteInside, resolveInProject)))
  check('the quoted in-project spelling passes too', autonomous(`rm -rf "${join(projectReal, 'scratch-dir', 'zzz-test')}"`, resolveInProject).allow)
  check('the relative in-project spelling passes', autonomous('rm -rf scratch-dir/zzz-test', resolveInProject).allow)
  check('the same delete OUTSIDE the project, under the home, stays warded', wardedBy(autonomous(`rm -rf ${outsideReal}`, resolveInProject), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf ${outsideReal}`, resolveInProject)))
  check('the quoted outside delete stays warded', wardedBy(autonomous(`rm -rf "${outsideReal}"`, resolveInProject), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf "${outsideReal}"`, resolveInProject)))
  check('a recursive delete of the home itself, as given, stays warded', !autonomous(`rm -rf ${relocatedHome}`, resolveInProject).allow, holeOf(autonomous(`rm -rf ${relocatedHome}`, resolveInProject)))
  check('a recursive delete of the home itself, as resolved, stays warded', !autonomous(`rm -rf ${homeReal}`, resolveInProject).allow, holeOf(autonomous(`rm -rf ${homeReal}`, resolveInProject)))
  const escape = `rm -rf ${join(projectReal, '..', 'escape-target')}`
  check('a ..-escape out of the project stays warded', !autonomous(escape, resolveInProject).allow, holeOf(autonomous(escape, resolveInProject)))
  check('find <in-project path> -delete passes', autonomous(`find ${join(projectReal, 'scratch-dir')} -name "*.log" -delete`, resolveInProject).allow)
  const findOutside = `find ${outsideReal} -name "*.log" -delete`
  check('find <outside path under the home> -delete stays warded', wardedBy(autonomous(findOutside, resolveInProject), 'no-home-recursive-delete'), holeOf(autonomous(findOutside, resolveInProject)))

  const wholeHome = [refusal(`rm -rf ${homeReal}`), refusal(`rm -rf ${relocatedHome}/`), refusal(`rm -rf "${homeReal}/*"`)]
  check('the refusal list refuses the home itself wherever it is (operator sessions included)', wholeHome.every(verdict => wardedBy(verdict, 'no-root-recursive-delete')), wholeHome.map(holeOf).join(' · '))
  check('the refusal list leaves a folder inside the home to the autonomous ward and the card (operator hands stay free)', refusal(`rm -rf ${join(projectReal, 'build')}`).allow && refusal(`rm -rf ${outsideReal}`).allow)

  const store = { state: { sessionHooks: new Map() }, set(fn: (p: never) => never) { this.state = fn(this.state) } }
  resetWardsEngagedSessionsForTest()
  const id = await runWithCwdOverride(projectReal, () => registerWardsGuard(store.set as never, 'ward-home-proof'))
  check('the wards guard registered in the relocated project cwd', id === WARDS_HOOK_ID)
  const judge = async (command: string): Promise<string | true> => {
    const verdict = await judgeToolCall('ward-home-proof', {
      tool: 'Bash',
      input: { command },
      callId: `ward-home-${command.length}-${command.charCodeAt(command.length - 1)}`,
      messages: [],
      toolRef: { name: 'Bash', shellCommandOf: (value: { command?: unknown }) => (typeof value.command === 'string' ? value.command : undefined) } as never,
    })
    return verdict.refused ? verdict.reason : true
  }
  const shown = (verdict: string | true): string => (verdict === true ? 'ALLOWED (hole!)' : verdict.slice(0, 90))
  const insideVerdict = await judge(absoluteInside)
  check('the hook road lets the in-project absolute delete through (the card decides)', insideVerdict === true, insideVerdict === true ? '' : insideVerdict.slice(0, 90))
  const outsideVerdict = await judge(`rm -rf ${outsideReal}`)
  check('the hook road wards the outside delete under the relocated home', typeof outsideVerdict === 'string' && outsideVerdict.includes("Ward 'no-home-recursive-delete'"), shown(outsideVerdict))
  const homeVerdict = await judge(`rm -rf ${relocatedHome}`)
  check('the hook road refuses a delete of the whole relocated home as given', typeof homeVerdict === 'string' && homeVerdict.includes("Ward 'no-root-recursive-delete'"), shown(homeVerdict))
  const homeRealVerdict = await judge(`rm -rf ${homeReal}/`)
  check('the hook road refuses a delete of the whole relocated home as resolved', typeof homeRealVerdict === 'string' && homeRealVerdict.includes("Ward 'no-root-recursive-delete'"), shown(homeRealVerdict))
  const escapeVerdict = await judge(escape)
  check('the hook road wards the ..-escape', typeof escapeVerdict === 'string' && escapeVerdict.includes("Ward 'no-home-recursive-delete'"), shown(escapeVerdict))
  const findVerdict = await judge(findOutside)
  check('the hook road wards find <outside> -delete', typeof findVerdict === 'string' && findVerdict.includes("Ward 'no-home-recursive-delete'"), shown(findVerdict))
  check('the canary survived and no decoy was touched — nothing was ever run', existsSync(canary) && existsSync(outside) && existsSync(inside))
}

if (shape === 'unlisted') {
  const fakeHome = '/srv/homes/proof'
  check('the fake home exists nowhere and is spelled under no listed prefix', !existsSync('/srv/homes') && homedir() === fakeHome && homeSpellings()[0] === fakeHome, homeSpellings().join(' · '))
  const stub = (path: string) => ({ path, root: `${fakeHome}/project` })
  check('an in-project absolute delete under the unlisted home resolves inside and passes', autonomous(`rm -rf ${fakeHome}/project/build`, stub).allow, ruleOf(autonomous(`rm -rf ${fakeHome}/project/build`, stub)))
  check('a delete beside the project under the unlisted home stays warded', wardedBy(autonomous(`rm -rf ${fakeHome}/other`, stub), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf ${fakeHome}/other`, stub)))
  check('the string road alone wards a delete under the unlisted home', wardedBy(autonomous(`rm -rf ${fakeHome}/anything`), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf ${fakeHome}/anything`)))
  check('find under the unlisted home with -delete stays warded', wardedBy(autonomous(`find ${fakeHome}/logs -name "*.log" -delete`), 'no-home-recursive-delete'), holeOf(autonomous(`find ${fakeHome}/logs -name "*.log" -delete`)))
  check('a sibling whose name merely begins with the home is not the home', autonomous(`rm -rf ${fakeHome}reader/x`).allow && refusal(`rm -rf ${fakeHome}reader`).allow)
  const wholeHome = [refusal(`rm -rf ${fakeHome}`), refusal(`rm -rf ${fakeHome}/`), refusal(`rm -rf ${fakeHome}/*`), refusal(`rm -rf '${fakeHome}'`)]
  check('the refusal list refuses the unlisted home itself in every closing spelling', wholeHome.every(verdict => wardedBy(verdict, 'no-root-recursive-delete')), wholeHome.map(holeOf).join(' · '))
  check('the refusal list leaves a folder inside the unlisted home alone', refusal(`rm -rf ${fakeHome}/project`).allow)
  for (const command of ['rm -rf /home/alice/Developer/x', 'rm -rf /Users/alice/Developer/x', 'rm -rf "/Users/alice/My Files"', "rm -rf '/home/alice/my files'", 'find /home/alice/proj -name "*.log" -delete', 'rm -rf ~/Developer/x', 'rm -rf $HOME/Developer', 'rm -rf ${HOME}/x']) {
    check(`${command} is warded with nothing to resolve against, whatever the home is`, wardedBy(autonomous(command), 'no-home-recursive-delete'), holeOf(autonomous(command)))
  }
  for (const command of ['rm -rf /tmp/ops-proof-x', 'rm -rf node_modules', 'rm /home/alice/notes.txt', 'find /home/alice/proj -name "*.ts"', 'rm -rf /opt/build/out']) {
    check(`${command} stays allowed`, autonomous(command).allow, ruleOf(autonomous(command)))
  }
}

if (shape === 'unlisted-slash') {
  const fakeHome = '/srv/homes/proof'
  check('a trailing slash on the home changes nothing', wardedBy(autonomous(`rm -rf ${fakeHome}/anything`), 'no-home-recursive-delete') && wardedBy(refusal(`rm -rf ${fakeHome}`), 'no-root-recursive-delete'), `${homeSpellings().join(' · ')} · ${holeOf(autonomous(`rm -rf ${fakeHome}/anything`))} · ${holeOf(refusal(`rm -rf ${fakeHome}`))}`)
}

if (shape === 'root') {
  check('with HOME=/ the door names the root and the engine adds no spelling: temp and double-slash deletes stay allowed', homeSpellings()[0] === '/' && autonomous('rm -rf /tmp/ops-proof-x').allow && autonomous('rm -rf //tmp/ops-proof-x').allow && autonomous('find //tmp/x -name "*.log" -delete').allow, `${homeSpellings().join(' · ')} · ${ruleOf(autonomous('rm -rf /tmp/ops-proof-x'))} · ${ruleOf(autonomous('rm -rf //tmp/ops-proof-x'))}`)
  check('rm -rf / is still refused', wardedBy(refusal('rm -rf /'), 'no-root-recursive-delete'))
}

if (shape === 'unset') {
  let accountHome: string | undefined
  try {
    accountHome = homedir()
  } catch {
    accountHome = undefined
  }
  check('HOME is unset and the product still names a home (the account entry)', process.env.HOME === undefined && accountHome !== undefined && accountHome !== '', accountHome ?? 'none')
  check("the guard's home spellings follow that door, not the environment", accountHome !== undefined && homeSpellings()[0] === accountHome, homeSpellings().join(' · '))
  if (accountHome !== undefined) {
    check('a recursive delete under that home is warded without a resolver', wardedBy(autonomous(`rm -rf ${join(accountHome, 'ward-proof-decoy')}`), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf ${join(accountHome, 'ward-proof-decoy')}`)))
    check('the refusal list refuses that home itself', wardedBy(refusal(`rm -rf ${accountHome}`), 'no-root-recursive-delete'), holeOf(refusal(`rm -rf ${accountHome}`)))
  }
}

console.log(`   ${shape}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
