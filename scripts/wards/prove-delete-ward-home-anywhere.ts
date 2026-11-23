#!/usr/bin/env bun
// gate-watch: src/permissions/wards/wards.ts src/permissions/wards/wardsRefusals.ts src/permissions/wards/wardsShellRead.ts src/permissions/guards/wardsGuard.ts src/permissions/guards/guards.ts src/engine/cwdMemo.ts src/platform/files/cwd.ts src/platform/files/path.ts src/screen/fullscreen-layout/pathLabel.ts src/tools/read/pathPrefix.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'

const spelledHome = (path: string): boolean => path.startsWith('/Users/') || path.startsWith('/home/') || /^[a-zA-Z]:[\\/]+Users(?:[\\/]|$)/i.test(path)
const isWindowsSystem = (path: string): boolean => /^[a-zA-Z]:[\\/]+(?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:[\\/]|$)/i.test(path)

function mkdtempOutsideProfiles(prefix: string): string {
  if (process.platform !== 'win32') return mkdtempSync(join(spelledHome(tmpdir()) ? '/tmp' : tmpdir(), prefix))
  const driveRoot = parse(tmpdir()).root
  const repoParent = dirname(join(import.meta.dir, '..', '..'))
  const candidates = [tmpdir(), process.env.MERCURY_TMPDIR ?? '', join(driveRoot, 'Temp'), repoParent, driveRoot].filter(dir => dir !== '' && !spelledHome(dir) && !isWindowsSystem(dir))
  for (const dir of candidates) {
    try {
      if (!existsSync(dir)) continue
      return mkdtempSync(join(dir, prefix))
    } catch {
      continue
    }
  }
  return mkdtempSync(join(tmpdir(), prefix))
}

let passed = 0
let failed = 0
const homeAnywhereFailHint = 'change the no-home-recursive-delete and no-root-recursive-delete rules and wardHomes or setHomeSpellings in src/permissions/wards/wards.ts, or homeSpellings, makeTargetResolver and registerWardsGuard in src/permissions/guards/wardsGuard.ts; a failing shape line from the parent means read the child output above it'
function check(label: string, ok: boolean, detail = ''): void {
  ok ? passed++ : failed++
  const shown = ok ? detail : [detail, homeAnywhereFailHint].filter(Boolean).join(' | ')
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

if (process.argv[2] !== '--home') {
  const configScratch = realpathSync(mkdtempSync(join(tmpdir(), 'ward-home-config-')))
  mkdirSync(join(configScratch, 'home'), { recursive: true })
  const relocatedHome = mkdtempOutsideProfiles('ward-home-')
  const rootHome = process.platform === 'win32' ? parse(tmpdir()).root : '/'
  const shapes: Array<[string, string | undefined]> = [
    ['relocated', relocatedHome],
    ['unlisted', '/srv/homes/proof'],
    ['unlisted-slash', '/srv/homes/proof/'],
    ['root', rootHome],
    ['unset', undefined],
    ['win32-standin', undefined],
  ]
  console.log('the recursive-delete wards know the home wherever it is')
  try {
    for (const [shape, home] of shapes) {
      const env: Record<string, string | undefined> = { ...process.env }
      delete env.USERPROFILE
      delete env.HOME
      if (home !== undefined) {
        env.HOME = home
        if (process.platform === 'win32') env.USERPROFILE = home
      }
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

type PendingToolCall = import('../../src/permissions/wards/wards.js').PendingToolCall
type WardVerdict = import('../../src/permissions/wards/wards.js').WardVerdict
const { AUTONOMOUS_WARDS, BUILTIN_WARDS, REFUSAL_WARDS, evaluateWards, setHomeSpellings, wardHomes } = await import('../../src/permissions/wards/wards.js')
const guard = await import('../../src/permissions/guards/wardsGuard.js')
const { deleteWardActive, makeTargetResolver, WARDS_HOOK_ID, registerWardsGuard, resetWardsEngagedSessionsForTest } = guard
const homeSpellings: () => string[] = (guard as { homeSpellings?: () => string[] }).homeSpellings ?? (() => [])
const { judgeToolCall } = await import('../../src/permissions/guards/guards.js')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')

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

const bashPath = (path: string): string => (process.platform === 'win32' ? path.replaceAll('\\', '/') : path)

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

  const absoluteInside = `rm -rf ${bashPath(join(projectReal, 'scratch-dir', 'zzz-test'))}`
  check('the string road alone wards an absolute delete under the resolved home spelling (nothing to resolve against)', wardedBy(autonomous(absoluteInside), 'no-home-recursive-delete'), holeOf(autonomous(absoluteInside)))
  check('the string road alone wards an absolute delete under the home as given', wardedBy(autonomous(`rm -rf ${bashPath(join(relocatedHome, 'stuff'))}`), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf ${bashPath(join(relocatedHome, 'stuff'))}`)))
  check('with the resolver the in-project absolute delete passes', autonomous(absoluteInside, resolveInProject).allow, ruleOf(autonomous(absoluteInside, resolveInProject)))
  check('the quoted in-project spelling passes too', autonomous(`rm -rf "${bashPath(join(projectReal, 'scratch-dir', 'zzz-test'))}"`, resolveInProject).allow)
  check('the relative in-project spelling passes', autonomous('rm -rf scratch-dir/zzz-test', resolveInProject).allow)
  check('the same delete OUTSIDE the project, under the home, stays warded', wardedBy(autonomous(`rm -rf ${bashPath(outsideReal)}`, resolveInProject), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf ${bashPath(outsideReal)}`, resolveInProject)))
  check('the quoted outside delete stays warded', wardedBy(autonomous(`rm -rf "${bashPath(outsideReal)}"`, resolveInProject), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf "${bashPath(outsideReal)}"`, resolveInProject)))
  check('a recursive delete of the home itself, as given, stays warded', !autonomous(`rm -rf ${bashPath(relocatedHome)}`, resolveInProject).allow, holeOf(autonomous(`rm -rf ${bashPath(relocatedHome)}`, resolveInProject)))
  check('a recursive delete of the home itself, as resolved, stays warded', !autonomous(`rm -rf ${bashPath(homeReal)}`, resolveInProject).allow, holeOf(autonomous(`rm -rf ${bashPath(homeReal)}`, resolveInProject)))
  const escape = `rm -rf ${bashPath(join(projectReal, '..', 'escape-target'))}`
  check('a ..-escape out of the project stays warded', !autonomous(escape, resolveInProject).allow, holeOf(autonomous(escape, resolveInProject)))
  check('find <in-project path> -delete passes', autonomous(`find ${bashPath(join(projectReal, 'scratch-dir'))} -name "*.log" -delete`, resolveInProject).allow)
  const findOutside = `find ${bashPath(outsideReal)} -name "*.log" -delete`
  check('find <outside path under the home> -delete stays warded', wardedBy(autonomous(findOutside, resolveInProject), 'no-home-recursive-delete'), holeOf(autonomous(findOutside, resolveInProject)))

  const wholeHome = [refusal(`rm -rf ${bashPath(homeReal)}`), refusal(`rm -rf ${bashPath(relocatedHome)}/`), refusal(`rm -rf "${bashPath(homeReal)}/*"`)]
  check('the refusal list refuses the home itself wherever it is (operator sessions included)', wholeHome.every(verdict => wardedBy(verdict, 'no-root-recursive-delete')), wholeHome.map(holeOf).join(' · '))
  check('the refusal list leaves a folder inside the home to the autonomous ward and the card (operator hands stay free)', refusal(`rm -rf ${bashPath(join(projectReal, 'build'))}`).allow && refusal(`rm -rf ${bashPath(outsideReal)}`).allow)

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
  const outsideVerdict = await judge(`rm -rf ${bashPath(outsideReal)}`)
  check('the hook road wards the outside delete under the relocated home', typeof outsideVerdict === 'string' && outsideVerdict.includes("Ward 'no-home-recursive-delete'"), shown(outsideVerdict))
  const homeVerdict = await judge(`rm -rf ${bashPath(relocatedHome)}`)
  check('the hook road refuses a delete of the whole relocated home as given', typeof homeVerdict === 'string' && homeVerdict.includes("Ward 'no-root-recursive-delete'"), shown(homeVerdict))
  const homeRealVerdict = await judge(`rm -rf ${bashPath(homeReal)}/`)
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
  if (process.platform === 'win32') {
    const driveRoot = parse(tmpdir()).root
    const driveSlashed = driveRoot.replace(/\\/g, '/')
    check(`with HOME=${driveRoot} the door names the root and the engine adds no spelling: temp and double-slash deletes stay allowed`, homeSpellings()[0] === driveRoot && wardHomes().length === 0 && autonomous(`rm -rf ${driveSlashed}tmp/ops-proof-x`).allow && autonomous('rm -rf /tmp/ops-proof-x').allow && autonomous('rm -rf //tmp/ops-proof-x').allow && autonomous('find //tmp/x -name "*.log" -delete').allow, `${homeSpellings().join(' · ')} · ${wardHomes().join(' · ')} · ${ruleOf(autonomous(`rm -rf ${driveSlashed}tmp/ops-proof-x`))} · ${ruleOf(autonomous('rm -rf /tmp/ops-proof-x'))}`)
    check(`rm -rf ${driveSlashed} and rm -rf / are still refused`, wardedBy(refusal(`rm -rf ${driveSlashed}`), 'no-root-recursive-delete') && wardedBy(refusal('rm -rf /'), 'no-root-recursive-delete'), `${holeOf(refusal(`rm -rf ${driveSlashed}`))} · ${holeOf(refusal('rm -rf /'))}`)
  } else {
    check('with HOME=/ the door names the root and the engine adds no spelling: temp and double-slash deletes stay allowed', homeSpellings()[0] === '/' && autonomous('rm -rf /tmp/ops-proof-x').allow && autonomous('rm -rf //tmp/ops-proof-x').allow && autonomous('find //tmp/x -name "*.log" -delete').allow, `${homeSpellings().join(' · ')} · ${ruleOf(autonomous('rm -rf /tmp/ops-proof-x'))} · ${ruleOf(autonomous('rm -rf //tmp/ops-proof-x'))}`)
    check('rm -rf / is still refused', wardedBy(refusal('rm -rf /'), 'no-root-recursive-delete'))
  }
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
    check('a recursive delete under that home is warded without a resolver', wardedBy(autonomous(`rm -rf ${bashPath(join(accountHome, 'ward-proof-decoy'))}`), 'no-home-recursive-delete'), holeOf(autonomous(`rm -rf ${bashPath(join(accountHome, 'ward-proof-decoy'))}`)))
    check('the refusal list refuses that home itself', wardedBy(refusal(`rm -rf ${bashPath(accountHome)}`), 'no-root-recursive-delete'), holeOf(refusal(`rm -rf ${bashPath(accountHome)}`)))
  }
}

if (shape === 'win32-standin') {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const savedHome = process.env.HOME
  const savedProfile = process.env.USERPROFILE
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    const driveHome = 'D:\\work\\home'
    process.env.HOME = driveHome
    process.env.USERPROFILE = driveHome
    setHomeSpellings(() => [driveHome])
    check('win32 standin: wardHomes keeps a drive spelling outside Users', wardHomes().includes('D:/work/home'), wardHomes().join(' · '))
    const stub = (path: string) => ({ path: path.replace(/\//g, '\\'), root: 'D:\\work\\home\\hunt' })
    const ps = (command: string, resolvePath?: PendingToolCall['resolvePath']): PendingToolCall => ({
      toolName: 'PowerShell',
      input: { command },
      shellCommand: command,
      ...(resolvePath ? { resolvePath } : {}),
    })
    for (const [label, command] of [
      ['forward-slash drive path', 'rm -rf D:/work/home/outside'],
      ['backslash drive path', 'rm -rf D:\\work\\home\\outside'],
      ['quoted drive path with space', 'rm -rf "D:/work/home/My Files"'],
      ['lowercase drive path', 'rm -rf d:/work/home/outside'],
      ['msys drive path', 'rm -rf /d/work/home/outside'],
      ['find -delete under drive home', 'find D:/work/home/outside -name "*.log" -delete'],
    ] as const) {
      check(`win32 standin: ${label} is warded`, wardedBy(autonomous(command), 'no-home-recursive-delete'), holeOf(autonomous(command)))
    }
    for (const [label, command] of [
      ['Remove-Item under drive home', 'Remove-Item -Recurse -Force D:\\work\\home\\outside'],
      ['rd /s under drive home', 'rd /s /q D:\\work\\home\\outside'],
    ] as const) {
      const verdict = evaluateWards(AUTONOMOUS_WARDS, ps(command))
      check(`win32 standin: ${label} is warded`, wardedBy(verdict, 'no-home-recursive-delete'), holeOf(verdict))
    }
    check('win32 standin: in-project delete under drive home passes with resolver', autonomous('rm -rf D:/work/home/hunt/build', stub).allow, ruleOf(autonomous('rm -rf D:/work/home/hunt/build', stub)))
    check('win32 standin: quoted ~ in-project delete under drive home passes with resolver', autonomous('rm -rf "~/hunt/build"', stub).allow, ruleOf(autonomous('rm -rf "~/hunt/build"', stub)))
    check('win32 standin: sibling whose name starts with drive home stays allowed', autonomous('rm -rf D:/work/homereader/x').allow && refusal('rm -rf D:/work/homereader').allow)
    check('win32 standin: refusal list refuses whole drive home and leaves subfolders alone', wardedBy(refusal('rm -rf D:/work/home'), 'no-root-recursive-delete') && refusal('rm -rf D:/work/home/outside').allow)

    setHomeSpellings(() => ['D:\\'])
    check('win32 standin: bare drive root D:\\ adds no spelling and leaves temp and double-slash deletes allowed', wardHomes().length === 0 && autonomous('rm -rf D:/tmp/x').allow && autonomous('rm -rf /tmp/ops-proof-x').allow && autonomous('rm -rf //tmp/ops-proof-x').allow && autonomous('find //tmp/x -name "*.log" -delete').allow, wardHomes().join(' · '))
    check('win32 standin: rm -rf D:/ and rm -rf / are still refused', wardedBy(refusal('rm -rf D:/'), 'no-root-recursive-delete') && wardedBy(refusal('rm -rf /'), 'no-root-recursive-delete'), `${holeOf(refusal('rm -rf D:/'))} · ${holeOf(refusal('rm -rf /'))}`)
    const hexBackslash = evaluateWards(BUILTIN_WARDS, {
      toolName: 'Write',
      input: { file_path: 'C:\\proj\\src\\components\\New.tsx', content: 'export const c = "#ff0000"\n' },
      isMercurySource: () => true,
    })
    check('win32 standin: backslash path fires no-new-hex-outside-theme', wardedBy(hexBackslash, 'no-new-hex-outside-theme'), holeOf(hexBackslash))
    const emojiBackslash = evaluateWards(BUILTIN_WARDS, {
      toolName: 'Write',
      input: { file_path: 'C:\\proj\\src\\components\\New.tsx', content: 'export const s = "\u{1F600}"\n' },
      isMercurySource: () => true,
    })
    check('win32 standin: backslash path fires no-emoji-in-tui-source', wardedBy(emojiBackslash, 'no-emoji-in-tui-source'), holeOf(emojiBackslash))
    const paletteBackslash = evaluateWards(BUILTIN_WARDS, {
      toolName: 'Write',
      input: { file_path: 'C:\\proj\\src\\components\\mercuryPalette.ts', content: 'export const c = "#ff0000"\n' },
      isMercurySource: () => true,
    })
    check('win32 standin: allowPathPattern permits backslash mercuryPalette.ts', paletteBackslash.allow, ruleOf(paletteBackslash))
    const generatedBackslash = evaluateWards(BUILTIN_WARDS, {
      toolName: 'Edit',
      input: { file_path: 'C:\\proj\\scripts\\settings\\settings-schema.json', new_string: '{}' },
      resolvePath: () => ({ path: 'C:\\proj\\scripts\\settings\\settings-schema.json', root: 'C:\\proj' }),
    })
    check('win32 standin: backslash generated asset path fires no-hand-edit-generated-file', wardedBy(generatedBackslash, 'no-hand-edit-generated-file'), holeOf(generatedBackslash))
    const lockBackslash = evaluateWards(BUILTIN_WARDS, {
      toolName: 'Edit',
      input: { file_path: 'C:\\other\\bun.lock', new_string: '{}' },
      resolvePath: () => ({ path: 'C:\\other\\bun.lock', root: undefined }),
    })
    check('win32 standin: backslash lockfile fires no-hand-edit-generated-file', wardedBy(lockBackslash, 'no-hand-edit-generated-file'), holeOf(lockBackslash))
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    setHomeSpellings(homeSpellings)
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedProfile
  }
}

console.log(`   ${shape}: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
