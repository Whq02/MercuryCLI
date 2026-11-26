#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { check, finish, openKit } from './flowLawKit.ts'

async function prove(): Promise<void> {
  const host = { ...path }, win = host.win32
  const nativeHost = process.platform
  const home = 'C:/sample/home', temp = 'C:/sample/temp', project = 'C:/sample/project', other = 'C:/sample/other'
  const slashed = (s: string) => s.replaceAll('\\', '/')
  const bash = (s: string) => slashed(s).replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`)
  const virtual = (s: string) => /^(?:[CDZ]:(?:[/\\]|$)|[/\\](?:[cdz](?:[/\\]|$)|sample(?:[/\\]|$))|[/\\]$)/i.test(s)
  let windows = false
  const grammar = (...words: string[]) => windows && words.some(virtual) ? win : host
  const system = { ...os }
  mock.module('node:os', () => ({ ...system, homedir: () => windows ? home : system.homedir(), tmpdir: () => windows ? temp : system.tmpdir() }))
  if (nativeHost !== 'win32') mock.module('node:path', () => ({
    ...host,
    resolve: (...words: string[]) => grammar(...words) === win ? win.resolve(project, ...words) : host.resolve(...words),
    join: (...words: string[]) => grammar(...words).join(...words),
    dirname: (s: string) => grammar(s).dirname(s), basename: (s: string) => grammar(s).basename(s),
    isAbsolute: (s: string) => grammar(s).isAbsolute(s), normalize: (s: string) => grammar(s).normalize(s),
  }))
  const kit = await openKit('bash-drive-deny')
  const { getFsImplementation, setFsImplementation } = await import('../../src/platform/files/fsOperations.ts')
  const { getPlatform } = await import('../../src/platform/environment/platform.ts')
  const { setOriginalCwd, setCwdState } = await import('../../src/boot/process-state/processState.ts')
  const { getScratchpadDir } = await import('../../src/permissions/rules/filesystem.ts')
  const fs = getFsImplementation(), platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const drives = host.join(kit.world, 'volumes')
  const onDisk = (s: string) => {
    const n = slashed(win.resolve(project, s))
    return host.join(drives, n[0]!.toUpperCase(), ...n.slice(3).split('/'))
  }
  const onDrive = (s: string) => {
    const [drive, ...tail] = host.relative(drives, s).split(host.sep)
    return win.join(`${drive}:/`, ...tail)
  }
  const put = (s: string) => mkdirSync(onDisk(s), { recursive: true })
  const edit = (s: string) => `Edit(//${s[0]!.toUpperCase()}/${s.slice(3)})`
  type Rules = { deny?: string[]; ask?: string[] }
  type Verdict = 'allow' | 'ask' | 'deny'
  type Spell = (p: string) => string
  const redirect = (p: string, op = '>') => `echo sample ${op} "${p}"`
  const under = (p: string, file: string) => `cd "${p}" && ${redirect(file)}`
  const denied = (s: string): Rules => ({ deny: [edit(s)] })
  const native: Spell = p => p
  const reason = 'check only Windows shell write paths with the existing file deny matcher; keep the original verdict otherwise'
  try {
    windows = true
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    getPlatform.cache.set(undefined, 'windows')
    process.env.USERPROFILE = home
    process.env.TEMP = process.env.TMP = process.env.MERCURY_TMPDIR = temp
    setOriginalCwd(project); setCwdState(project)
    for (const dir of [home, temp, `${project}/sub/deep`, `${project}/space dir`, `${project}/MiXeD`, `${project}/é`, `${other}/deep`, 'D:/sample/project']) put(dir)
    symlinkSync(onDisk(`${other}/deep`), onDisk(`${project}/portal`), nativeHost === 'win32' ? 'junction' : 'dir')
    symlinkSync(onDisk(`${project}/sub`), onDisk(`${project}/local`), nativeHost === 'win32' ? 'junction' : 'dir')
    setFsImplementation({ ...fs,
      existsSync: s => fs.existsSync(virtual(s) ? onDisk(s) : s),
      lstatSync: s => fs.lstatSync(virtual(s) ? onDisk(s) : s),
      realpathSync: s => virtual(s) ? onDrive(fs.realpathSync(onDisk(s))) : fs.realpathSync(s),
      readlinkSync: s => virtual(s) ? onDrive(fs.readlinkSync(onDisk(s))) : fs.readlinkSync(s),
    })
    const scratch = slashed(getScratchpadDir())
    if (!scratch.startsWith(temp + '/')) throw new Error(`The Windows scratch fixture must be under ${temp}, not ${scratch}`)
    put(scratch)
    const rows: Array<{ label: string; git: string; win: string; gitVerdict: Verdict; winVerdict: Verdict; rules: Rules }> = []
    const pair = (label: string, form: (s: Spell) => string, gitVerdict: Verdict, winVerdict: Verdict, rules: Rules = {}) => rows.push({ label, git: form(bash), win: form(native), gitVerdict, winVerdict, rules })
    pair('variable under scratch', s => `SP="${s(scratch)}"; mkdir -p "$SP" && echo a > "$SP/a.txt"`, 'allow', 'allow')
    pair('scratch after a directory change', s => `SP="${s(scratch)}"; cd ${s(project)} && echo b > "$SP/b.txt"`, 'ask', 'allow')
    pair('scratch literal', s => redirect(s(scratch) + '/c.txt'), 'allow', 'allow')
    pair('project child directory', s => under(s(project) + '/sub', 'note.txt'), 'ask', 'allow')
    pair('temporary write', s => redirect(s(temp) + '/note'), 'ask', 'allow')
    pair('temporary deletion', s => `rm -f ${s(temp)}/old`, 'ask', 'allow')
    for (const name of ['leaf', 'sub/deep/new', 'space dir/new', 'MiXeD/new', 'é/new', 'sub/./new', 'sub/../new', 'local/new']) pair(name, s => redirect(s(`${project}/${name}`)), 'ask', 'allow')
    pair('drive case', s => redirect(s(project.toLowerCase() + '/leaf')), 'ask', 'allow')
    for (const name of [project + '-other/new', other + '/new', home + '/new', 'D:/sample/project/new', `${project}/sub/../../other/new`, `${project}/portal/new`]) pair(name, s => redirect(s(name)), 'ask', 'ask')
    pair('append', s => redirect(s(project + '/new'), '>>'), 'ask', 'allow')
    pair('quoted cwd', s => under(s(project + '/space dir'), 'new'), 'ask', 'allow')
    pair('input and output', s => `cat < "${s(project)}/in" > "${s(project)}/out"`, 'ask', 'allow')
    pair('relative output under denied cwd', s => under(s(project + '/sub'), 'note'), 'deny', 'deny', denied(project + '/sub/note'))
    pair('direct deny', s => redirect(s(project + '/note')), 'deny', 'deny', denied(project + '/note'))
    pair('file ask', s => redirect(s(project + '/note')), 'ask', 'allow', { ask: [edit(project + '/note')] })
    pair('command ask', s => redirect(s(project + '/note')), 'ask', 'ask', { ask: ['Bash(echo *)'] })
    pair('command deny', s => redirect(s(project + '/note')), 'deny', 'deny', { deny: ['Bash(echo *)'] })
    pair('output past denied junction', s => redirect(s(project + '/portal/new')), 'deny', 'deny', denied(other + '/deep/new'))
    pair('link then parent', s => redirect(s === bash ? s(project + '/portal/../new') : other + '/new'), 'ask', 'ask')
    for (const protectedParent of [false, true]) pair(`physical cwd then parent, deny ${protectedParent}`, s => s === bash ? `cd -P "${s(project)}/portal" && ${redirect('../new')}` : under(other + '/deep', '../new'), protectedParent ? 'deny' : 'ask', protectedParent ? 'deny' : 'ask', protectedParent ? denied(other + '/new') : {})
    pair('native script retains its literal', s => `node -e "if (false) fs.writeFileSync('${s === bash ? bash(project) : 'C:' + bash(project)}/new', '')"`, 'ask', 'ask')
    pair('relative control', () => redirect('new'), 'allow', 'allow')
    pair('unrelated rule', s => redirect(s(other + '/new')), 'ask', 'ask', denied(project + '/else'))
    check('all 36 original decisions are paired', rows.length === 36, String(rows.length))
    for (const row of rows) {
      for (const [command, expected, spelling] of [[row.git, row.gitVerdict, 'shell'], [row.win, row.winVerdict, 'native']] as const) {
        const result = await kit.decide(command, { cwd: project, rules: row.rules })
        check(`${row.label} (${spelling}) stays ${expected}`, result.decision.behavior === expected, `${reason}: ${JSON.stringify(result)}`)
      }
    }
    for (const mode of ['default', 'sovereign']) {
      for (const row of rows.filter(r => r.label === 'relative output under denied cwd' || r.label === 'output past denied junction')) {
        for (const cmd of [row.git, row.win]) {
          const { decision } = await kit.decide(cmd, { cwd: project, rules: row.rules, mode })
          check(`${mode}: ${row.label} is denied (${cmd === row.git ? 'shell' : 'native'})`, decision.behavior === 'deny', `${decision.behavior}: ${decision.message}; ${reason}`)
        }
      }
    }
    const dir = bash(project + '/portal'), target = `${dir}/leaf`, rule = denied(other + '/deep/leaf')
    const claims: Array<[string, string, Rules, boolean]> = [
      ['enter a junction', under(dir, 'leaf'), rule, true], ['link before parent', redirect(`${dir}/../leaf`), denied(other + '/leaf'), true],
      ['escaped folder', `cd ${bash(project)}/space\\ dir && ${redirect('leaf')}`, denied(project + '/space dir/leaf'), true],
      ['directory stack', `pushd "${dir}" && ${redirect('leaf')}`, rule, true], ['subshell redirect', `(${under(dir, 'leaf')})`, rule, true],
      ['after &&', `true && ${redirect(target)}`, rule, true], ['tee operand', `tee "${target}"`, rule, true],
      ['copy destination', `cp dummy "${target}"`, rule, true], ['move destination', `mv dummy "${target}"`, rule, true],
      ['outside denied sibling', redirect(`${dir}/sibling`), rule, false], ['unmounted drive', under('/z/sample', 'leaf'), denied('Z:/sample/leaf'), false],
      ['script data is not a redirect', `node -e "if (false) fs.writeFileSync('${target}', '')"`, rule, false],
    ]
    for (const [name, command, rules, shouldDeny] of claims) {
      const { decision } = await kit.decide(command, { cwd: project, rules })
      check(name, (decision.behavior === 'deny') === shouldDeny, `${decision.behavior}; ${reason}`)
    }
    if (nativeHost !== 'win32') {
      windows = false
      Object.defineProperty(process, 'platform', platform)
      getPlatform.cache.delete(undefined)
      setOriginalCwd(kit.project); setCwdState(kit.project)
      const posixMount = host.join(kit.world, 'posix-c')
      mkdirSync(posixMount)
      setFsImplementation({ ...fs, existsSync: s => s === '/c' || fs.existsSync(s), lstatSync: s => fs.lstatSync(s === '/c' ? posixMount : s), realpathSync: s => s === '/c' ? '/c' : fs.realpathSync(s) })
      const decision = await kit.decide(redirect(bash(project) + '/leaf'), { rules: { deny: [`Edit(${project}/leaf)`] } })
      check('a POSIX directory named /c is not a drive mount', decision.decision.behavior !== 'deny', reason)
    }
  } finally {
    windows = false
    Object.defineProperty(process, 'platform', platform)
    setFsImplementation(fs)
    kit.close()
  }
}
await prove()
finish('prove-bash-drive-write-deny')
