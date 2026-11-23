#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
const AREA_FIX_HINTS: Record<string, string> = {
  godotCapsule: 'fix staticGodotCapsule in src/integrations/vulcan/godotCapsule.ts so a read error is thrown, not swallowed into a low census',
  portabilityHealth: 'fix godotPortabilityReport in src/integrations/vulcan/portabilityHealth.ts so a read error rejects, not a clean report',
  projection: 'fix gatherWorkbenchInputs in src/screen/workbench/projection.ts so a lane run snapshot error is not swallowed',
  loadSkillsDir: 'fix getSkillDirCommands and getSkillLoadRefusals in src/integrations/skills/loadSkillsDir.ts so a failed skill load is recorded as a refusal',
  bootBeacon: 'fix clearBootAttempts or readBootAttemptResidue in src/platform/substrate/bootBeacon.ts',
  invocationRecord: 'fix recordInvocation or readInvocationRecords in src/platform/substrate/invocationRecord.ts',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const hint = AREA_FIX_HINTS[label.split(':')[0] ?? '']
  const shown = !cond ? [detail, hint].filter(Boolean).join(' | ') : ''
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function skip(label: string, why: string): void {
  console.log(`  [SKIP] ${label} — ${why}`)
}

function caught(fn: () => unknown): { code: string | null; message: string } | null {
  try {
    fn()
    return null
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    return { code: typeof err?.code === 'string' ? err.code : null, message: String(err?.message ?? error) }
  }
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<{ code: string | null; message: string } | null> {
  try {
    await fn()
    return null
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    return { code: typeof err?.code === 'string' ? err.code : null, message: String(err?.message ?? error) }
  }
}

{
  console.log('\n1. src/integrations/vulcan/godotCapsule.ts')
  const { staticGodotCapsule } = await import(join(SRC, 'integrations/vulcan/godotCapsule.ts'))
  const { derivePresence } = await import(join(SRC, 'integrations/vulcan/editorPresence.ts'))
  const NO_EDITOR = derivePresence(6010, false, { ok: true, processes: [] }, '/fixture')
  const scratch = mkdtempSync(join(tmpdir(), 'faults-fn23-capsule-'))
  try {
    const proj = join(scratch, 'game')
    const scenesDir = join(proj, 'scenes')
    const lockedDir = join(proj, 'locked')
    mkdirSync(scenesDir, { recursive: true })
    mkdirSync(lockedDir, { recursive: true })
    writeFileSync(join(proj, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Fixture"\n')
    writeFileSync(join(scenesDir, 'main.tscn'), '[gd_scene format=3]\n')
    writeFileSync(join(lockedDir, 'secret.gd'), 'extends Node\n')

    const clean = staticGodotCapsule(proj, undefined, NO_EDITOR)
    check('godotCapsule: absent export_presets.cfg returns empty list', clean.export_presets.length === 0 && clean.scene_count === 1 && clean.script_count === 1)

    if (!POSIX_MODES) {
      skip('godotCapsule: unreadable subdir', 'requires non-root POSIX')
      skip('godotCapsule: unsearchable subdir statSync', 'requires non-root POSIX')
      skip('godotCapsule: unreadable export_presets.cfg', 'requires non-root POSIX')
    } else {
      chmodSync(lockedDir, 0o000)
      const dirErr = caught(() => staticGodotCapsule(proj, undefined, NO_EDITOR))
      chmodSync(lockedDir, 0o700)
      check('godotCapsule: unreadable subdir throws EACCES instead of low census', dirErr?.code === 'EACCES', JSON.stringify(dirErr))

      chmodSync(lockedDir, 0o400)
      const statErr = caught(() => staticGodotCapsule(proj, undefined, NO_EDITOR))
      chmodSync(lockedDir, 0o700)
      check('godotCapsule: unsearchable subdir statSync throws EACCES instead of skipping', statErr?.code === 'EACCES', JSON.stringify(statErr))

      const presets = join(proj, 'export_presets.cfg')
      writeFileSync(presets, '[preset.0]\nname="Web"\nplatform="Web"\n', { mode: 0o600 })
      chmodSync(presets, 0o200)
      const presetErr = caught(() => staticGodotCapsule(proj, undefined, NO_EDITOR))
      chmodSync(presets, 0o600)
      check('godotCapsule: unreadable export_presets.cfg throws EACCES instead of empty list', presetErr?.code === 'EACCES', JSON.stringify(presetErr))
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\n2. src/integrations/vulcan/portabilityHealth.ts')
  const { godotPortabilityReport } = await import(join(SRC, 'integrations/vulcan/portabilityHealth.ts'))
  const scratch = mkdtempSync(join(tmpdir(), 'faults-fn23-portability-'))
  try {
    const bareProj = join(scratch, 'bare')
    mkdirSync(bareProj, { recursive: true })
    const bareReport = await godotPortabilityReport(bareProj, { census: [] })
    check('portabilityHealth: absent project.godot and skills dirs still succeed', bareReport.absolutePaths.length === 0 && bareReport.controlDiscrepancies.length === 0)

    const proj = join(scratch, 'proj')
    const skillsRoot = join(proj, '.mercury', 'skills')
    const skillDir = join(skillsRoot, 'launch')
    const skillMd = join(skillDir, 'SKILL.md')
    const projectGodot = join(proj, 'project.godot')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(projectGodot, '[input]\nmove_left={deadzone:0.5}\n', { mode: 0o600 })
    writeFileSync(skillMd, '# Launch\n## Controls\n| action | key |\n| --- | --- |\n| move_left | A |\n', { mode: 0o600 })

    if (!POSIX_MODES) {
      skip('portabilityHealth: unreadable skills dir', 'requires non-root POSIX')
      skip('portabilityHealth: unreadable project.godot', 'requires non-root POSIX')
      skip('portabilityHealth: unreadable SKILL.md', 'requires non-root POSIX')
    } else {
      chmodSync(skillsRoot, 0o000)
      const dirErr = await caughtAsync(() => godotPortabilityReport(proj, { census: [] }))
      chmodSync(skillsRoot, 0o700)
      check('portabilityHealth: unreadable skills dir rejects with EACCES instead of clean report', dirErr?.code === 'EACCES', JSON.stringify(dirErr))

      chmodSync(projectGodot, 0o200)
      const godotErr = await caughtAsync(() => godotPortabilityReport(proj, { census: [] }))
      chmodSync(projectGodot, 0o600)
      check('portabilityHealth: unreadable project.godot rejects with EACCES instead of empty live actions', godotErr?.code === 'EACCES', JSON.stringify(godotErr))

      chmodSync(skillMd, 0o200)
      const skillErr = await caughtAsync(() => godotPortabilityReport(proj, { census: [] }))
      chmodSync(skillMd, 0o600)
      check('portabilityHealth: unreadable SKILL.md rejects with EACCES instead of skipping file', skillErr?.code === 'EACCES', JSON.stringify(skillErr))
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\n3. src/screen/workbench/projection.ts')
  const bunBin = process.env.BUN ?? process.execPath
  const script = `
    import { mock } from 'bun:test'
    import { join } from 'node:path'
    const src = ${JSON.stringify(SRC)}
    const coord = join(src, 'services/run/runCoordinator.ts')
    mock.module(coord, () => ({
      getRunSnapshot: (owner: string) => {
        if (String(owner).includes('lane-agent-1')) throw new TypeError('lane run snapshot bug')
        return null
      },
      subscribeRuns: () => () => {},
    }))
    const { gatherWorkbenchInputs } = await import(join(src, 'services/workbench/projection.ts'))
    try {
      await gatherWorkbenchInputs({
        getAppState: () => ({ tasks: { t1: { type: 'agent', agentId: 'lane-agent-1' } } }),
      })
      process.stdout.write(JSON.stringify({ threw: null }))
    } catch (error) {
      process.stdout.write(JSON.stringify({ threw: (error as Error).message }))
    }
    process.exit(0)
  `
  const res = spawnSync(bunBin, ['-e', script], { encoding: 'utf8' })
  const parsed = res.status === 0 ? (JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as { threw: string | null }) : { threw: `exit ${res.status}: ${res.stderr.slice(-200)}` }
  check('projection: in-memory lane run snapshot bug surfaces instead of being swallowed', parsed.threw === 'lane run snapshot bug', JSON.stringify(parsed))
}

{
  console.log('\n4. src/integrations/skills/loadSkillsDir.ts')
  const scratch = mkdtempSync(join(tmpdir(), 'faults-fn23-skills-'))
  try {
    const proj = join(scratch, 'proj')
    const skillDir = join(proj, '.mercury', 'skills', 'unreadable-skill')
    const skillMd = join(skillDir, 'SKILL.md')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillMd, '---\nname: unreadable-skill\ndescription: A skill.\n---\n\nBody.\n', { mode: 0o600 })

    const bunBin = process.env.BUN ?? process.execPath
    if (!POSIX_MODES) {
      skip('loadSkillsDir: unreadable SKILL.md is recorded in getSkillLoadRefusals', 'requires non-root POSIX')
    } else {
      chmodSync(skillMd, 0o200)
      const readScript = `
        import { join } from 'node:path'
        const src = ${JSON.stringify(SRC)}
        const { setSessionTrustAccepted } = await import(join(src, 'bootstrap/state.ts'))
        setSessionTrustAccepted(true)
        const { enableConfigs } = await import(join(src, 'utils/config/globalConfig.ts'))
        enableConfigs()
        const skills = await import(join(src, 'skills/loadSkillsDir.ts'))
        skills.clearSkillCaches()
        await skills.getSkillDirCommands(${JSON.stringify(proj)})
        process.stdout.write(JSON.stringify(skills.getSkillLoadRefusals()))
        process.exit(0)
      `
      const readRes = spawnSync(bunBin, ['-e', readScript], {
        encoding: 'utf8',
        env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'home-read'), MERCURY_BARE: '' },
      })
      chmodSync(skillMd, 0o600)
      const refusals = readRes.status === 0 ? (JSON.parse(readRes.stdout.trim().split('\n').pop() ?? '[]') as Array<{ path: string; error: string }>) : []
      check(
        'loadSkillsDir: unreadable SKILL.md is recorded in getSkillLoadRefusals',
        refusals.some(r => r.path === skillMd && /could not read/i.test(r.error)),
        JSON.stringify(refusals),
      )
    }

    const loadScript = `
      import { mock } from 'bun:test'
      import { join } from 'node:path'
      const src = ${JSON.stringify(SRC)}
      const fmPath = join(src, 'utils/frontmatterParser.ts')
      const actualFm = await import(fmPath)
      mock.module(fmPath, () => ({
        ...actualFm,
        parseFrontmatter: () => { throw new Error('frontmatter boom') },
      }))
      const { setSessionTrustAccepted } = await import(join(src, 'bootstrap/state.ts'))
      setSessionTrustAccepted(true)
      const { enableConfigs } = await import(join(src, 'utils/config/globalConfig.ts'))
      enableConfigs()
      const skills = await import(join(src, 'skills/loadSkillsDir.ts'))
      skills.clearSkillCaches()
      await skills.getSkillDirCommands(${JSON.stringify(proj)})
      process.stdout.write(JSON.stringify(skills.getSkillLoadRefusals()))
      process.exit(0)
    `
    const loadRes = spawnSync(bunBin, ['-e', loadScript], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: join(scratch, 'home-load'), MERCURY_BARE: '' },
    })
    const loadRefusals = loadRes.status === 0 ? (JSON.parse(loadRes.stdout.trim().split('\n').pop() ?? '[]') as Array<{ path: string; error: string }>) : []
    check(
      'loadSkillsDir: unexpected skill load throw is recorded in getSkillLoadRefusals',
      loadRefusals.some(r => r.path === skillMd && r.error.includes('frontmatter boom')),
      JSON.stringify(loadRefusals),
    )
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\n5. src/platform/substrate/bootBeacon.ts')
  const { bootAttemptsPath, clearBootAttempts, readBootAttemptResidue } = await import(join(SRC, 'platform/substrate/bootBeacon.ts'))
  const scratch = mkdtempSync(join(tmpdir(), 'faults-fn23-beacon-'))
  try {
    const home = join(scratch, 'home')
    mkdirSync(home, { recursive: true })
    const beacon = bootAttemptsPath(home)
    writeFileSync(beacon, JSON.stringify({ version: 1, attempts: [1700000001000, 1700000002000, 1700000003000] }) + '\n', { mode: 0o600 })

    if (!POSIX_MODES) {
      skip('bootBeacon: clearBootAttempts clears writable file inside read-only dir', 'requires non-root POSIX')
    } else {
      chmodSync(home, 0o500)
      clearBootAttempts(home)
      const residue = readBootAttemptResidue(home)
      chmodSync(home, 0o700)
      check(
        'bootBeacon: clearBootAttempts clears writable file inside read-only dir so residue reads null',
        residue === null,
        JSON.stringify(residue),
      )
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\n6. src/platform/substrate/invocationRecord.ts')
  const scratch = mkdtempSync(join(tmpdir(), 'faults-fn23-invrec-'))
  try {
    const bunBin = process.env.BUN ?? process.execPath
    const runInv = (home: string, body: string): Record<string, unknown> => {
      mkdirSync(home, { recursive: true })
      const script = `
        import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
        import { join } from 'node:path'
        const src = ${JSON.stringify(SRC)}
        const inv = await import(join(src, 'substrate/invocationRecord.ts'))
        const file = join(${JSON.stringify(home)}, 'invocation-record.json')
        const attempt = (fn: () => unknown) => {
          try { return { ok: true, value: fn() } }
          catch (e) { const err = e as NodeJS.ErrnoException; return { ok: false, code: err?.code ?? null, name: err?.name ?? null, message: String(err?.message ?? e) } }
        }
        const out: Record<string, unknown> = {}
        ${body}
        process.stdout.write(JSON.stringify(out))
        process.exit(0)
      `
      const res = spawnSync(bunBin, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, MERCURY_CONFIG_DIR: home },
      })
      if (res.status !== 0) throw new Error(`invrec child failed: ${res.stderr.slice(-300)}`)
      return JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}') as Record<string, unknown>
    }

    const absent = runInv(join(scratch, 'absent'), `out.read = attempt(() => inv.readInvocationRecords())`)
    const absentRead = absent.read as { ok: boolean; value?: unknown[] }
    check('invocationRecord: absent file returns empty array', absentRead.ok && Array.isArray(absentRead.value) && absentRead.value.length === 0)

    const corrupt = runInv(
      join(scratch, 'corrupt'),
      `
      const broken = '{broken json'
      writeFileSync(file, broken, { mode: 0o600 })
      out.read = attempt(() => inv.readInvocationRecords())
      inv.recordInvocation()
      out.healed = attempt(() => inv.readInvocationRecords())
      `,
    )
    const corruptRead = corrupt.read as { ok: boolean; name?: string | null }
    const corruptHealed = corrupt.healed as { ok: boolean; value?: unknown[] }
    check('invocationRecord: corrupt JSON throws from readInvocationRecords', !corruptRead.ok && corruptRead.name === 'SyntaxError', JSON.stringify(corruptRead))
    check('invocationRecord: corrupt JSON heals on next recordInvocation', corruptHealed.ok && Array.isArray(corruptHealed.value) && corruptHealed.value.length === 1, JSON.stringify(corruptHealed))

    if (!POSIX_MODES) {
      skip('invocationRecord: unreadable file is not overwritten and throws on read', 'requires non-root POSIX')
    } else {
      const unreadable = runInv(
        join(scratch, 'unreadable'),
        `
        const prior = JSON.stringify({ version: 1, rows: [{ schema: 1, pid: 1, recordedAtMs: 1, platform: 'darwin', argv0: 'node', execBasename: 'node', stdinTTY: false, stdoutTTY: false, stderrTTY: false, shellHint: 'posix-sh' }] }) + '\\n'
        writeFileSync(file, prior, { mode: 0o600 })
        chmodSync(file, 0o200)
        inv.recordInvocation()
        out.read = attempt(() => inv.readInvocationRecords())
        chmodSync(file, 0o600)
        out.keptAfterWrite = readFileSync(file, 'utf8') === prior
        `,
      )
      const unreadableRead = unreadable.read as { ok: boolean; code?: string | null }
      check('invocationRecord: unreadable file is not overwritten by recordInvocation', unreadable.keptAfterWrite === true, JSON.stringify(unreadable))
      check('invocationRecord: unreadable file throws EACCES from readInvocationRecords', !unreadableRead.ok && unreadableRead.code === 'EACCES', JSON.stringify(unreadableRead))
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
