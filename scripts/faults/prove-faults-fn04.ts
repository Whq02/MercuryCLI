#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function runScenario(body: string): Record<string, unknown> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'faults-fn04-')))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  for (const dir of [home, project]) mkdirSync(dir, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
    process.env.NODE_ENV = 'test'
    delete process.env.MERCURY_HOME
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const SCRATCH = ${JSON.stringify(scratch)}
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
  })
  if (res.status !== 0) throw new Error(`scenario failed: ${res.stderr.slice(-1500)}`)
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
}

console.log('\nSessionManagerView — ownSessionRecord catches malformed worker lookup without crashing render')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const workersMod = path.join(SRC, 'daemon/concourse-workers/concourseWorkers.ts')
    const real = await import(workersMod)
    mock.module(workersMod, () => ({
      ...real,
      readSessionWorkers: () => { throw new TypeError('worker-bug') },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'screen/widgets/faces/SessionManagerView.tsx'))})
    try {
      out.value = mod.ownSessionRecord('sess-1') ?? null
      out.threw = null
    } catch (error) {
      out.threw = error instanceof Error ? error.message : String(error)
    }
  `)
  check('SessionManagerView.ownSessionRecord returns undefined without throwing into render', r.threw === null && r.value === null, JSON.stringify(r))
}

console.log('\nFilePermissionDialog — resolveSymlinkTarget resolves dangling symlinks so outside-workspace warning shows')
{
  const r = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'permissions/cards/file-dialog/FilePermissionDialog.tsx'))})
    const outsideTarget = path.join(SCRATCH, 'outside-new-file.txt')
    const linkPath = path.join(PROJECT, 'dangling-link.txt')
    const plainPath = path.join(PROJECT, 'plain.txt')
    fs.writeFileSync(plainPath, 'ok')
    const liveTarget = path.join(SCRATCH, 'outside-live.txt')
    fs.writeFileSync(liveTarget, 'live')
    const liveLink = path.join(PROJECT, 'live-link.txt')
    try {
      fs.symlinkSync(outsideTarget, linkPath)
      fs.symlinkSync(liveTarget, liveLink)
    } catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') {
        out.noSymlink = true
      } else {
        throw error
      }
    }
    if (!out.noSymlink) {
      out.hasExport = typeof mod.resolveSymlinkTarget === 'function'
      out.dangling = mod.resolveSymlinkTarget?.(linkPath) ?? null
      out.live = mod.resolveSymlinkTarget?.(liveLink) ?? null
      out.plain = mod.resolveSymlinkTarget?.(plainPath) ?? null
      out.absent = mod.resolveSymlinkTarget?.(path.join(PROJECT, 'does-not-exist.txt')) ?? null
      out.expectedDangling = outsideTarget
      out.expectedLive = fs.realpathSync(liveTarget)
    }
  `)
  if (r.noSymlink === true) {
    skip('FilePermissionDialog.resolveSymlinkTarget resolves dangling symlink target', 'not read on Windows: no symlink privilege')
    skip('FilePermissionDialog.resolveSymlinkTarget keeps live symlink, plain file, and absent file behaviour', 'not read on Windows: no symlink privilege')
  } else {
    check('FilePermissionDialog.resolveSymlinkTarget resolves dangling symlink target', r.hasExport === true && r.dangling === r.expectedDangling, JSON.stringify(r))
    check('FilePermissionDialog.resolveSymlinkTarget keeps live symlink, plain file, and absent file behaviour', r.live === r.expectedLive && r.plain === null && r.absent === null, JSON.stringify(r))
  }
}

console.log('\nmcp — buildServePermissionContext refuses to drop deny rules when loading permission rules fails')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const loaderMod = path.join(SRC, 'permissions/rules/permissionsLoader.ts')
    const real = await import(loaderMod)
    mock.module(loaderMod, () => ({
      ...real,
      loadAllPermissionRulesFromDisk: () => { throw new Error('EACCES: permission rules unreadable') },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'integrations/mcp/mcpServer.ts'))})
    out.hasExport = typeof mod.buildServePermissionContext === 'function'
    try {
      if (out.hasExport) await mod.buildServePermissionContext()
      out.threw = null
    } catch (error) {
      out.threw = error instanceof Error ? error.message : String(error)
    }
  `)
  check('mcp.buildServePermissionContext rejects instead of returning empty permission context', r.hasExport === true && r.threw === 'EACCES: permission rules unreadable', JSON.stringify(r))
}

console.log('\ncontributions — unreadable folders and markdown files report unreadable instead of missing or parse failure')
if (!POSIX_MODES) skip('contributions unreadable folder and file', 'chmod 0o000/0o200 needs non-root POSIX')
else {
  const r = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'integrations/extensions/load/contributions.ts'))})
    const root = path.join(SCRATCH, 'ext-contrib')
    const skillsDir = path.join(root, 'skills')
    const lockedSkills = path.join(root, 'locked-skills')
    const cmdsDir = path.join(root, 'commands')
    const lockedSub = path.join(cmdsDir, 'nested')
    const skillOne = path.join(skillsDir, 'alpha')
    fs.mkdirSync(skillOne, { recursive: true })
    fs.mkdirSync(lockedSkills, { recursive: true })
    fs.mkdirSync(lockedSub, { recursive: true })
    const skillFile = path.join(skillOne, 'SKILL.md')
    fs.writeFileSync(skillFile, '---\\ndescription: ok\\n---\\nbody\\n')
    fs.writeFileSync(path.join(cmdsDir, 'ok.md'), '---\\ndescription: ok\\n---\\nbody\\n')
    fs.chmodSync(lockedSkills, 0o000)
    fs.chmodSync(lockedSub, 0o000)
    fs.chmodSync(skillFile, 0o200)
    try {
      const res = mod.resolveContributions(
        {
          name: 'demo',
          version: '1.0.0',
          description: 'demo',
          contributes: {
            skills: ['./skills', './locked-skills', './absent-skills'],
            commands: ['./commands'],
          },
        },
        root,
        'demo@test',
      )
      out.defects = res.defects
    } finally {
      fs.chmodSync(lockedSkills, 0o700)
      fs.chmodSync(lockedSub, 0o700)
      fs.chmodSync(skillFile, 0o600)
    }
  `)
  const defects = (r.defects as string[]) ?? []
  check('contributions reports unreadable top-level folder as folder unreadable, not folder missing', defects.some(d => d.includes('locked-skills') && d.includes('folder unreadable')) && !defects.some(d => d.includes('locked-skills') && d.includes('folder missing')), JSON.stringify(defects))
  check('contributions keeps absent folder as folder missing', defects.some(d => d.includes('absent-skills') && d.includes('folder missing')), JSON.stringify(defects))
  check('contributions reports unreadable command subfolder instead of treating it as empty', defects.some(d => d.includes('nested') && d.includes('folder unreadable')), JSON.stringify(defects))
  check('contributions reports unreadable SKILL.md as file unreadable, not frontmatter parse failure', defects.some(d => d.includes('alpha/SKILL.md') && d.includes('file unreadable')) && !defects.some(d => d.includes('alpha/SKILL.md') && d.includes('frontmatter did not parse')), JSON.stringify(defects))
}

console.log('\nroster — unreadable project extension entries and directory report in roster.problems')
{
  const r = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'integrations/extensions/roster.ts'))})
    const projExt = path.join(PROJECT, '.mercury', 'extensions')
    fs.mkdirSync(projExt, { recursive: true })
    try {
      fs.symlinkSync('self', path.join(projExt, 'self'))
    } catch (error) {
      if (process.platform === 'win32' && error?.code === 'EPERM') {
        out.loopNoSymlink = true
      } else {
        throw error
      }
    }
    if (!out.loopNoSymlink) {
      const res1 = mod.computeRoster({ cwd: PROJECT, sessionPaths: [] })
      out.loopProblems = res1.problems
      fs.unlinkSync(path.join(projExt, 'self'))
    }
    if (${JSON.stringify(POSIX_MODES)}) {
      fs.chmodSync(projExt, 0o000)
      try {
        const res2 = mod.computeRoster({ cwd: PROJECT, sessionPaths: [] })
        out.dirProblems = res2.problems
      } finally {
        fs.chmodSync(projExt, 0o700)
      }
    }
  `)
  if (r.loopNoSymlink === true) {
    skip('roster reports unstattable project extension entry in problems', 'not read on Windows: no symlink privilege')
  } else {
    const loopProblems = (r.loopProblems as string[]) ?? []
    check('roster reports unstattable project extension entry in problems', loopProblems.some(p => p.includes('self') && p.includes('unreadable')), JSON.stringify(loopProblems))
  }
  if (!POSIX_MODES) skip('roster unreadable project extensions dir', 'chmod 0o000 needs non-root POSIX')
  else {
    const dirProblems = (r.dirProblems as string[]) ?? []
    check('roster reports unreadable project extensions directory in problems', dirProblems.some(p => p.includes('extensions') && p.includes('unreadable')), JSON.stringify(dirProblems))
  }
}

console.log('\nsources — unreadable local archive reports archive unreadable instead of archive missing')
if (!POSIX_MODES) skip('sources unreadable local archive', 'chmod 0o200 needs non-root POSIX')
else {
  const r = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'integrations/extensions/sources.ts'))})
    const locked = path.join(SCRATCH, 'locked.zip')
    const missing = path.join(SCRATCH, 'absent.zip')
    fs.writeFileSync(locked, 'not-a-zip')
    fs.chmodSync(locked, 0o200)
    try {
      out.unreadable = await mod.addSource(locked)
      out.missing = await mod.addSource(missing)
    } finally {
      fs.chmodSync(locked, 0o600)
    }
  `)
  const unreadable = r.unreadable as { ok?: boolean; step?: string; reason?: string }
  const missing = r.missing as { ok?: boolean; step?: string; reason?: string }
  check('sources reports unreadable local archive as archive unreadable, not archive missing', unreadable?.ok === false && unreadable?.step === 'read' && String(unreadable?.reason).startsWith('archive unreadable · '), JSON.stringify(unreadable))
  check('sources keeps absent local archive as archive missing', missing?.ok === false && missing?.step === 'read' && String(missing?.reason).startsWith('archive missing · '), JSON.stringify(missing))
}

console.log('\nPaletteView — failed command load reports the error instead of No command matches')
{
  const r = runScenario(`
    const { mock } = await import('bun:test')
    const cmdsMod = path.join(SRC, 'commands/catalogue/commands.ts')
    const real = await import(cmdsMod)
    mock.module(cmdsMod, () => ({
      ...real,
      getCommands: async () => { throw new Error('EACCES: commands dir unreadable') },
    }))
    const mod = await import(${JSON.stringify(join(SRC, 'screen/widgets/PaletteView.tsx'))})
    out.hasExport = typeof mod.loadPaletteRows === 'function' && typeof mod.paletteLoadErrorLine === 'function'
    if (out.hasExport) {
      const loaded = await mod.loadPaletteRows(PROJECT)
      out.loaded = loaded
      out.line = loaded.ok ? null : mod.paletteLoadErrorLine(loaded.error)
    }
  `)
  check('PaletteView.loadPaletteRows returns failure and formats the error sentence', r.hasExport === true && (r.loaded as { ok?: boolean })?.ok === false && r.line === 'Could not read the command roster (EACCES: commands dir unreadable)', JSON.stringify(r))
}

console.log('\nFileEditPermissionRequest — unreadable file reports unreadable instead of previewing against empty content')
if (!POSIX_MODES) skip('FileEditPermissionRequest unreadable file', 'chmod 0o200 needs non-root POSIX')
else {
  const r = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'permissions/cards/file-edit/FileEditPermissionRequest.tsx'))})
    out.hasExport = typeof mod.previewEditOutcome === 'function'
    if (out.hasExport) {
      const locked = path.join(PROJECT, 'locked.txt')
      const absent = path.join(PROJECT, 'absent.txt')
      fs.writeFileSync(locked, 'existing line\\n')
      fs.chmodSync(locked, 0o200)
      try {
        out.unreadable = mod.previewEditOutcome({ file_path: locked, append: 'more\\n' }, null)
        out.absent = mod.previewEditOutcome({ file_path: absent, append: 'more\\n' }, null)
      } finally {
        fs.chmodSync(locked, 0o600)
      }
    }
  `)
  const unreadable = r.unreadable as { kind?: string; message?: string } | undefined
  const absent = r.absent as { kind?: string; edits?: Array<{ old_string: string }> } | undefined
  check('FileEditPermissionRequest.previewEditOutcome reports unreadable file instead of empty preview', r.hasExport === true && unreadable?.kind === 'unreadable' && String(unreadable?.message).startsWith('Could not read locked.txt to preview this edit ('), JSON.stringify(r))
  check('FileEditPermissionRequest.previewEditOutcome still previews append on absent file', absent?.kind === 'edits' && absent?.edits?.[0]?.old_string === '', JSON.stringify(absent))
}

console.log('\nSessionManagerView — failed session switch reports the error instead of silently staying put')
{
  const r = runScenario(`
    const mod = await import(${JSON.stringify(join(SRC, 'screen/widgets/faces/SessionManagerView.tsx'))})
    out.hasExport = typeof mod.runSessionSwitch === 'function'
    if (out.hasExport) {
      out.failed = await mod.runSessionSwitch(
        async () => { throw new Error('ENOENT: transcript vanished') },
        '00000000-0000-0000-0000-000000000001',
        {} as never,
      )
      out.succeeded = await mod.runSessionSwitch(
        async () => {},
        '00000000-0000-0000-0000-000000000001',
        {} as never,
      )
    }
  `)
  const failed = r.failed as { ok?: boolean; message?: string } | undefined
  const succeeded = r.succeeded as { ok?: boolean } | undefined
  check('SessionManagerView.runSessionSwitch returns the failure sentence when onResume rejects', r.hasExport === true && failed?.ok === false && failed?.message === 'Could not switch to that session (ENOENT: transcript vanished)', JSON.stringify(r))
  check('SessionManagerView.runSessionSwitch still answers ok when onResume succeeds', succeeded?.ok === true, JSON.stringify(succeeded))
}

void skip
void POSIX_MODES
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
