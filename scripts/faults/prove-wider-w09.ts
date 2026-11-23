#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
const W09_WHERE: Record<string, string> = {
  'w09-1': 'classCacheReport in src/integrations/vulcan/classCache.ts, staticGodotCapsule in src/integrations/vulcan/godotCapsule.ts and src/tools/godot/GodotTool.ts',
  'w09-2': 'scanVulcanInstances in src/integrations/vulcan/instances.ts, src/tools/godot/GodotTool.ts and src/integrations/ide/godotSession.ts',
  'w09-3': 'src/commands/verbs/godotEngineCli.ts, runningGodotProcesses in src/integrations/vulcan/godotProcessCensus.ts and resolveGodotExecutable in src/integrations/vulcan/portabilityHealth.ts',
  'w09-4': 'vulcanInstallStatus in src/integrations/vulcan/addonInstaller.ts, vulcanCheck in src/platform/health/sections/runtime/services.ts and src/integrations/ide/godotSession.ts',
  'w09-5': 'src/integrations/unity/bridgeToken.ts, src/integrations/blender/bridgeToken.ts, src/integrations/ide/unityBridgeSession.ts and src/integrations/ide/blenderBridgeSession.ts',
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const where = W09_WHERE[label.split(' ')[0] ?? '']
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && where ? ` — to fix, change the code this check exercises: ${where}` : ''}`)
}

function startFakeVulcanServer(
  instance: { version: 1; id: string; role: 'agent-editor'; port: number; pid: number; projectRoot: string; ownerPid: number },
  token: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buf = ''
    let authed = false
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        const frame = JSON.parse(line) as Record<string, unknown>
        if (!authed) {
          if (frame.op === 'hello' && frame.token === token) {
            authed = true
            socket.write(JSON.stringify({ ok: true, result: { version: 1, godot: '4.6-fake', project: 'fixture' }, instance }) + '\n')
          } else {
            socket.write(JSON.stringify({ ok: false, error: { code: 'AUTH_FAILED', message: 'bad token' } }) + '\n')
            socket.end()
          }
          continue
        }
        socket.write(JSON.stringify({ id: frame.id, ok: true, result: { valid: true }, instance }) + '\n')
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      instance.port = addr.port
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>(done => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

{
  console.log('\n1. w09-1: classCache unreadable dir/stat/script/cache surfaced in report, capsule, and script_validate')
  const { classCacheReport } = await import(join(SRC, 'integrations/vulcan/classCache.ts'))
  const { staticGodotCapsule } = await import(join(SRC, 'integrations/vulcan/godotCapsule.ts'))
  const { derivePresence } = await import(join(SRC, 'integrations/vulcan/editorPresence.ts'))
  const { GodotTool } = await import(join(SRC, 'tools/godot/GodotTool.ts'))
  const { resetVulcanClientForTest } = await import(join(SRC, 'integrations/vulcan/vulcanClient.ts'))
  const { runWithCwdOverride } = await import(join(SRC, 'platform/files/cwd.ts'))

  const NO_EDITOR = derivePresence(6010, false, { ok: true, processes: [] }, '/fixture')
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w09-1-')))
  const restoreModes: Array<() => void> = []
  try {
    const proj = join(scratch, 'proj')
    mkdirSync(join(proj, 'scripts'), { recursive: true })
    mkdirSync(join(proj, 'locked'), { recursive: true })
    mkdirSync(join(proj, '.godot'), { recursive: true })
    writeFileSync(join(proj, 'project.godot'), 'config_version=5\n[application]\nconfig/name="W09"\n')
    writeFileSync(join(proj, 'scripts', 'ok.gd'), 'class_name OkClass\nextends Node\n')
    const secretScript = join(proj, 'scripts', 'secret.gd')
    writeFileSync(secretScript, 'class_name SecretClass\nextends Node\n', { mode: 0o600 })
    const cacheFile = join(proj, '.godot', 'global_script_class_cache.cfg')
    writeFileSync(cacheFile, 'list=Array[Dictionary]([])\n', { mode: 0o600 })
    symlinkSync(join(proj, 'missing-target.gd'), join(proj, 'scripts', 'broken.gd'))

    if (POSIX_MODES) {
      chmodSync(join(proj, 'locked'), 0o000)
      restoreModes.push(() => chmodSync(join(proj, 'locked'), 0o700))
      chmodSync(secretScript, 0o000)
      restoreModes.push(() => chmodSync(secretScript, 0o600))
      chmodSync(cacheFile, 0o000)
      restoreModes.push(() => chmodSync(cacheFile, 0o600))

      const report = classCacheReport(proj, 20) as {
        state: string
        hint: string
        unreadable?: Array<{ path: string; error: string }>
      }
      check('w09-1 classCacheReport marks unreadable cache as unreadable with error', report.state === 'unreadable' && report.hint.includes('could not be read ('), `${report.state}: ${report.hint}`)
      const unreadablePaths = (report.unreadable ?? []).map(u => u.path)
      check(
        'w09-1 classCacheReport records unreadable dir, broken stat, and unreadable script',
        unreadablePaths.includes('res://locked') && unreadablePaths.includes('res://scripts/broken.gd') && unreadablePaths.includes('res://scripts/secret.gd'),
        JSON.stringify(unreadablePaths),
      )

      chmodSync(join(proj, 'locked'), 0o700)
      const cap = staticGodotCapsule(proj, undefined, NO_EDITOR) as {
        class_cache: { state: string; hint: string; unreadable?: string }
      }
      check(
        'w09-1 staticGodotCapsule reports unreadable cache and unreadable scripts line',
        cap.class_cache.state === 'unreadable' &&
          cap.class_cache.hint.includes('could not be read (') &&
          typeof cap.class_cache.unreadable === 'string' &&
          cap.class_cache.unreadable.includes('files or folders could not be read and are not in this report (first: res://'),
        JSON.stringify(cap.class_cache),
      )

      const id = 'a'.repeat(32)
      const token = 'b'.repeat(64)
      const instDir = join(proj, '.godot', 'mercury-vulcan', id)
      mkdirSync(instDir, { recursive: true, mode: 0o700 })
      chmodSync(instDir, 0o700)
      const inst = { version: 1 as const, id, role: 'agent-editor' as const, port: 0, pid: process.pid, projectRoot: proj, ownerPid: process.pid }
      const srv = await startFakeVulcanServer(inst, token)
      try {
        writeFileSync(join(instDir, 'instance.json'), JSON.stringify(inst), { mode: 0o600 })
        writeFileSync(join(instDir, 'token'), token, { mode: 0o600 })
        resetVulcanClientForTest()
        const prevFlag = process.env.MERCURY_GODOT_TOOLS
        process.env.MERCURY_GODOT_TOOLS = '1'
        try {
          const out = await runWithCwdOverride(proj, () =>
            GodotTool.call({ op: 'script_validate', args: { path: 'res://scripts/ok.gd' } }, {} as never, {} as never, { uuid: '00000000-0000-4000-8000-000000000001' } as never),
          )
          const text = (out.data as { result: string }).result
          check(
            'w09-1 GodotTool script_validate includes unreadable cache and unreadable files lines',
            text.includes('"valid": true') &&
              text.includes('could not be read (') &&
              text.includes('files or folders could not be read and are not in this report (first: res://'),
            text,
          )
        } finally {
          if (prevFlag === undefined) delete process.env.MERCURY_GODOT_TOOLS
          else process.env.MERCURY_GODOT_TOOLS = prevFlag
          resetVulcanClientForTest()
        }
      } finally {
        await srv.close()
      }
    }

    const absentProj = join(scratch, 'absent')
    mkdirSync(absentProj, { recursive: true })
    writeFileSync(join(absentProj, 'project.godot'), 'config_version=5\n')
    const absentReport = classCacheReport(absentProj, 20) as { state: string; unreadable?: unknown[] }
    check('w09-1 absent cache still reports absent with empty unreadable', absentReport.state === 'absent' && Array.isArray(absentReport.unreadable) && absentReport.unreadable.length === 0, JSON.stringify(absentReport))
  } finally {
    for (const fn of restoreModes.reverse()) {
      try { fn() } catch { void 0 }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\n2. w09-2: unreadable Vulcan instances dir, instance.json/token, and engine trees dir')
  const instancesMod = await import(join(SRC, 'integrations/vulcan/instances.ts'))
  const vulcanClientMod = await import(join(SRC, 'integrations/vulcan/vulcanClient.ts'))
  const { GodotTool } = await import(join(SRC, 'tools/godot/GodotTool.ts'))
  const { buildGodotIdeSession, discoverGodotLaunchProfiles, _resetGodotSessionForTesting } = await import(join(SRC, 'integrations/ide/godotSession.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'engine/run-owner/ownerKey.ts'))
  const { runWithCwdOverride } = await import(join(SRC, 'platform/files/cwd.ts'))

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w09-2-')))
  const restoreModes: Array<() => void> = []
  const prevFlag = process.env.MERCURY_GODOT_TOOLS
  process.env.MERCURY_GODOT_TOOLS = '1'
  try {
    const proj = join(scratch, 'proj')
    const instRoot = join(proj, '.godot', 'mercury-vulcan')
    mkdirSync(instRoot, { recursive: true })
    writeFileSync(join(proj, 'project.godot'), 'config_version=5\n[application]\nconfig/name="W09Two"\n')

    const scanFn = (instancesMod as { scanVulcanInstances?: (root: string) => { instances: unknown[]; unreadable: Array<{ path: string; error: string }> } }).scanVulcanInstances
    check('w09-2 scanVulcanInstances is exported', typeof scanFn === 'function')

    if (POSIX_MODES) {
      chmodSync(instRoot, 0o000)
      restoreModes.push(() => chmodSync(instRoot, 0o700))

      const scan = scanFn ? scanFn(proj) : { instances: [], unreadable: [] }
      check('w09-2 unreadable instances dir recorded in scan while list stays empty', instancesMod.listVulcanInstances(proj).length === 0 && scan.unreadable.some(u => u.path === instRoot), JSON.stringify(scan))

      const toolOut = await runWithCwdOverride(proj, () =>
        GodotTool.call({ op: 'editor_state' }, {} as never, {} as never, { uuid: '00000000-0000-4000-8000-000000000002' } as never),
      )
      const toolText = (toolOut.data as { result: string }).result
      check('w09-2 GodotTool editor_state reports unreadable instances dir instead of no instance', toolText.includes(`the Godot instance at ${instRoot} could not be read (`), toolText)

      const capOut = await runWithCwdOverride(proj, () =>
        GodotTool.call({ op: 'project_capsule' }, {} as never, {} as never, { uuid: '00000000-0000-4000-8000-000000000003' } as never),
      )
      const capText = (capOut.data as { result: string }).result
      check('w09-2 GodotTool project_capsule reports unreadable instances dir instead of static fallback', capText.includes(`the Godot instance at ${instRoot} could not be read (`), capText)

      _resetGodotSessionForTesting()
      const owner = makeOwnerKey({ workspace: proj, sessionId: 'w09-2', lane: 'main' })
      const sess = await buildGodotIdeSession(owner, proj)
      check('w09-2 buildGodotIdeSession reports unreadable instances dir instead of no editor', sess.vulcan.detail.includes(`the Godot instance at ${instRoot} could not be read (`), sess.vulcan.detail)

      const disc = await discoverGodotLaunchProfiles(proj) as { instanceError?: string }
      check('w09-2 discoverGodotLaunchProfiles reports unreadable instances dir', typeof disc.instanceError === 'string' && disc.instanceError.includes(`the Godot instance at ${instRoot} could not be read (`), JSON.stringify(disc))

      chmodSync(instRoot, 0o700)

      const badId = 'c'.repeat(32)
      const badDir = join(instRoot, badId)
      mkdirSync(badDir, { recursive: true, mode: 0o700 })
      chmodSync(badDir, 0o700)
      writeFileSync(join(badDir, 'instance.json'), '{not-json', { mode: 0o600 })
      const badOut = await runWithCwdOverride(proj, () =>
        GodotTool.call({ op: 'editor_state' }, {} as never, {} as never, { uuid: '00000000-0000-4000-8000-000000000004' } as never),
      )
      const badText = (badOut.data as { result: string }).result
      check('w09-2 corrupt instance.json reported by GodotTool', badText.includes(`the Godot instance at ${badDir} could not be read (`), badText)

      writeFileSync(
        join(badDir, 'instance.json'),
        JSON.stringify({ version: 1, id: badId, role: 'agent-editor', port: 6019, pid: process.pid, projectRoot: proj, ownerPid: process.pid }),
        { mode: 0o600 },
      )
      writeFileSync(join(badDir, 'token'), 'not-a-valid-token', { mode: 0o600 })
      const tokOut = await runWithCwdOverride(proj, () =>
        GodotTool.call({ op: 'editor_state' }, {} as never, {} as never, { uuid: '00000000-0000-4000-8000-000000000005' } as never),
      )
      const tokText = (tokOut.data as { result: string }).result
      check('w09-2 unreadable/invalid token reported by GodotTool while getVulcanClient returns null', vulcanClientMod.getVulcanClient(proj) === null && tokText.includes(`the Godot instance at ${badDir} could not be read (`), tokText)
      rmSync(badDir, { recursive: true, force: true })

      const treesDir = join(proj, '.mercury', 'engine', 'trees')
      mkdirSync(treesDir, { recursive: true })
      chmodSync(treesDir, 0o000)
      restoreModes.push(() => chmodSync(treesDir, 0o700))
      const treesOut = await runWithCwdOverride(proj, () =>
        GodotTool.call({ op: 'editor_state' }, {} as never, {} as never, { uuid: '00000000-0000-4000-8000-000000000006' } as never),
      )
      const treesText = (treesOut.data as { result: string }).result
      check('w09-2 unreadable engine trees dir reported by GodotTool', treesText.includes(`the Godot instance at ${treesDir} could not be read (`), treesText)
      chmodSync(treesDir, 0o700)
    }
  } finally {
    if (prevFlag === undefined) delete process.env.MERCURY_GODOT_TOOLS
    else process.env.MERCURY_GODOT_TOOLS = prevFlag
    vulcanClientMod.resetVulcanClientForTest()
    for (const fn of restoreModes.reverse()) {
      try { fn() } catch { void 0 }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\n3. w09-3: failed process census surfaced in godotEngineCli jobs/cancel and portabilityHealth')
  const { godotEngineCli } = await import(join(SRC, 'commands/verbs/godotEngineCli.ts'))
  const { resolveGodotExecutable } = await import(join(SRC, 'integrations/vulcan/portabilityHealth.ts'))
  const { runningGodotProcesses } = await import(join(SRC, 'integrations/vulcan/godotProcessCensus.ts'))

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w09-3-')))
  const prevPath = process.env.PATH
  const prevPin = process.env.MERCURY_GODOT_EXECUTABLE
  try {
    const proj = join(scratch, 'proj')
    const fakeBin = join(scratch, 'fake-bin')
    mkdirSync(proj, { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(join(proj, 'project.godot'), 'config_version=5\n[application]\nconfig/name="W09Three"\n')

    if (POSIX_MODES) {
      const fakePs = join(fakeBin, 'ps')
      writeFileSync(fakePs, '#!/bin/sh\nexit 7\n', { mode: 0o755 })
      chmodSync(fakePs, 0o755)
      delete process.env.MERCURY_GODOT_EXECUTABLE
      process.env.PATH = `${fakeBin}:${prevPath ?? ''}`

      const silentList = await runningGodotProcesses()
      check('w09-3 runningGodotProcesses keeps returning empty list on failure', Array.isArray(silentList) && silentList.length === 0, JSON.stringify(silentList))

      const jobsOut: string[] = []
      const jobsErr: string[] = []
      const jobsRc = await godotEngineCli(['jobs', '--project', proj], {
        out: s => jobsOut.push(s),
        err: s => jobsErr.push(s),
        cliName: 'mercury',
      })
      const jobsText = jobsOut.join('\n')
      check(
        'w09-3 godotEngineCli jobs reports process census failure instead of empty alive list',
        jobsRc === 0 && jobsText.includes('the running Godot processes could not be listed ('),
        `rc=${jobsRc} out=${jobsText} err=${jobsErr.join('\n')}`,
      )

      const cancelOut: string[] = []
      const cancelErr: string[] = []
      const cancelRc = await godotEngineCli(['cancel', 'job-nonexistent', '--project', proj], {
        out: s => cancelOut.push(s),
        err: s => cancelErr.push(s),
        cliName: 'mercury',
      })
      const cancelText = cancelOut.join('\n')
      check(
        'w09-3 godotEngineCli cancel reports process census failure instead of no engine alive',
        cancelRc === 1 && cancelText.includes('the running Godot processes could not be listed (') && !cancelText.includes('no engine of that job is alive'),
        `rc=${cancelRc} out=${cancelText} err=${cancelErr.join('\n')}`,
      )

      const emptyFs = {
        exists: () => false,
        executable: () => false,
        isDir: () => false,
        list: () => [] as string[],
      }
      const receipt = await resolveGodotExecutable({ projectRoot: proj, env: { PATH: '' }, fs: emptyFs }) as {
        source: string
        note: string
        censusError?: string
      }
      check(
        'w09-3 portabilityHealth resolveGodotExecutable reports process census failure',
        receipt.source === 'not-found' &&
          receipt.note.includes('the running Godot processes could not be listed (') &&
          typeof receipt.censusError === 'string' &&
          receipt.censusError.includes('the running Godot processes could not be listed ('),
        JSON.stringify(receipt),
      )
    }
  } finally {
    if (prevPath === undefined) delete process.env.PATH
    else process.env.PATH = prevPath
    if (prevPin === undefined) delete process.env.MERCURY_GODOT_EXECUTABLE
    else process.env.MERCURY_GODOT_EXECUTABLE = prevPin
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\n4. w09-4: unreadable project.godot surfaced in vulcanInstallStatus, runtime/services health, and godotSession')
  const { vulcanInstallStatus, readEnabledPlugins } = await import(join(SRC, 'integrations/vulcan/addonInstaller.ts'))
  const { vulcanCheck } = await import(join(SRC, 'platform/health/sections/runtime/services.ts'))
  const { buildGodotIdeSession, _resetGodotSessionForTesting } = await import(join(SRC, 'integrations/ide/godotSession.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'engine/run-owner/ownerKey.ts'))
  const { runWithCwdOverride } = await import(join(SRC, 'platform/files/cwd.ts'))

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w09-4-')))
  const restoreModes: Array<() => void> = []
  const prevFlag = process.env.MERCURY_GODOT_TOOLS
  process.env.MERCURY_GODOT_TOOLS = '1'
  try {
    const proj = join(scratch, 'proj')
    mkdirSync(join(proj, 'addons', 'mercury_vulcan'), { recursive: true })
    const godotCfg = 'plug' + 'in'
    writeFileSync(join(proj, 'addons', 'mercury_vulcan', `${godotCfg}.cfg`), `[${godotCfg}]\nname="Mercury VULCAN"\n`)
    const projectFile = join(proj, 'project.godot')
    writeFileSync(projectFile, `[editor_${godotCfg}s]\nenabled=PackedStringArray("res://addons/mercury_vulcan/${godotCfg}.cfg")\n`, { mode: 0o600 })

    const absentProj = join(scratch, 'absent')
    mkdirSync(absentProj, { recursive: true })
    const absentStatus = vulcanInstallStatus(absentProj) as { enabled: boolean; projectReadError?: string }
    check('w09-4 absent project.godot keeps projectReadError undefined', !absentStatus.enabled && absentStatus.projectReadError === undefined, JSON.stringify(absentStatus))

    if (POSIX_MODES) {
      chmodSync(projectFile, 0o000)
      restoreModes.push(() => chmodSync(projectFile, 0o600))

      const enabledList = readEnabledPlugins(proj)
      const status = vulcanInstallStatus(proj) as { installed: boolean; enabled: boolean; projectReadError?: string }
      check(
        'w09-4 vulcanInstallStatus carries projectReadError while readEnabledPlugins stays empty',
        status.installed && !status.enabled && enabledList.length === 0 && typeof status.projectReadError === 'string' && status.projectReadError.length > 0,
        JSON.stringify(status),
      )

      const healthRes = await runWithCwdOverride(proj, () => vulcanCheck().run())
      check(
        'w09-4 runtime/services vulcanCheck reports project.godot could not be read instead of addon not enabled',
        healthRes.evidence.includes('project.godot could not be read (') && !healthRes.evidence.includes('addon not enabled') && (healthRes.fix ?? '').includes('project.godot could not be read ('),
        JSON.stringify(healthRes),
      )

      _resetGodotSessionForTesting()
      const owner = makeOwnerKey({ workspace: proj, sessionId: 'w09-4', lane: 'main' })
      let sessionErr: string | null = null
      let sessionOut: Awaited<ReturnType<typeof buildGodotIdeSession>> | null = null
      try {
        sessionOut = await buildGodotIdeSession(owner, proj)
      } catch (error) {
        sessionErr = error instanceof Error ? error.message : String(error)
      }
      check(
        'w09-4 buildGodotIdeSession reports project.godot could not be read instead of not enabled',
        sessionErr === null &&
          sessionOut !== null &&
          sessionOut.vulcan.detail.includes('project.godot could not be read (') &&
          !sessionOut.vulcan.detail.includes('not enabled'),
        sessionErr ? `threw: ${sessionErr}` : JSON.stringify(sessionOut?.vulcan),
      )
    }
  } finally {
    if (prevFlag === undefined) delete process.env.MERCURY_GODOT_TOOLS
    else process.env.MERCURY_GODOT_TOOLS = prevFlag
    for (const fn of restoreModes.reverse()) {
      try { fn() } catch { void 0 }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  console.log('\n5. w09-5: unreadable Unity and Blender bridge tokens distinguished from absent in sessions and readiness')
  const unityTokenMod = await import(join(SRC, 'integrations/unity/bridgeToken.ts'))
  const blenderTokenMod = await import(join(SRC, 'integrations/blender/bridgeToken.ts'))
  const { buildUnityBridgeIdeSession, unityBridgeReadinessRecords } = await import(join(SRC, 'integrations/ide/unityBridgeSession.ts'))
  const { buildBlenderBridgeIdeSession, blenderBridgeReadinessRecords } = await import(join(SRC, 'integrations/ide/blenderBridgeSession.ts'))
  const { getBlenderBridgeClient, resetBlenderBridgeClientForTest } = await import(join(SRC, 'integrations/blender/bridgeClient.ts'))
  const { BLENDER_ADDON_MODULE } = await import(join(SRC, 'integrations/blender/addonHome.ts'))
  const { runWithCwdOverride } = await import(join(SRC, 'platform/files/cwd.ts'))

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'wider-w09-5-')))
  const restoreModes: Array<() => void> = []
  const savedEnv = {
    MERCURY_UNITY: process.env.MERCURY_UNITY,
    MERCURY_UNITY_BRIDGE_TOKEN: process.env.MERCURY_UNITY_BRIDGE_TOKEN,
    MERCURY_UNITY_BRIDGE_PORT: process.env.MERCURY_UNITY_BRIDGE_PORT,
    MERCURY_BLENDER: process.env.MERCURY_BLENDER,
    MERCURY_BLENDER_BRIDGE_TOKEN: process.env.MERCURY_BLENDER_BRIDGE_TOKEN,
    MERCURY_BLENDER_BRIDGE_ADDON_DIR: process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR,
    MERCURY_BLENDER_BRIDGE_PORT: process.env.MERCURY_BLENDER_BRIDGE_PORT,
  }
  try {
    delete process.env.MERCURY_UNITY_BRIDGE_TOKEN
    delete process.env.MERCURY_BLENDER_BRIDGE_TOKEN
    process.env.MERCURY_UNITY = '1'
    process.env.MERCURY_UNITY_BRIDGE_PORT = '1'
    process.env.MERCURY_BLENDER = '1'
    process.env.MERCURY_BLENDER_BRIDGE_PORT = '1'

    const unityProj = join(scratch, 'unity-proj')
    mkdirSync(join(unityProj, 'Assets'), { recursive: true })
    mkdirSync(join(unityProj, 'ProjectSettings'), { recursive: true })
    mkdirSync(join(unityProj, 'Packages', 'com.mercury.unity-bridge'), { recursive: true })
    writeFileSync(join(unityProj, 'Packages', 'com.mercury.unity-bridge', 'package.json'), '{"name":"com.mercury.unity-bridge"}\n')
    writeFileSync(join(unityProj, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.0f1\n')

    const blenderHome = join(scratch, 'blender-addons')
    mkdirSync(join(blenderHome, BLENDER_ADDON_MODULE), { recursive: true })
    writeFileSync(join(blenderHome, BLENDER_ADDON_MODULE, '__init__.py'), '# fixture\n')
    process.env.MERCURY_BLENDER_BRIDGE_ADDON_DIR = blenderHome

    const readUnityOutcome = (unityTokenMod as { readUnityBridgeTokenOutcome?: (root: string) => { state: string; path?: string; error?: string } }).readUnityBridgeTokenOutcome
    const readBlenderOutcome = (blenderTokenMod as { readBlenderBridgeTokenOutcome?: (home: string) => { state: string; path?: string; error?: string } }).readBlenderBridgeTokenOutcome

    const uAbsent = readUnityOutcome ? readUnityOutcome(unityProj) : { state: 'missing-export' }
    const bAbsent = readBlenderOutcome ? readBlenderOutcome(blenderHome) : { state: 'missing-export' }
    check('w09-5 absent unity and blender bridge tokens return state absent', uAbsent.state === 'absent' && bAbsent.state === 'absent', JSON.stringify({ uAbsent, bAbsent }))

    if (POSIX_MODES) {
      const uTokenFile = unityTokenMod.unityBridgeTokenPath(unityProj)
      mkdirSync(join(unityProj, 'Library'), { recursive: true })
      writeFileSync(uTokenFile, 'a'.repeat(64) + '\n', { mode: 0o600 })
      chmodSync(uTokenFile, 0o000)
      restoreModes.push(() => chmodSync(uTokenFile, 0o600))

      const bTokenFile = blenderTokenMod.blenderBridgeTokenPath(blenderHome)
      writeFileSync(bTokenFile, 'b'.repeat(64) + '\n', { mode: 0o600 })
      chmodSync(bTokenFile, 0o000)
      restoreModes.push(() => chmodSync(bTokenFile, 0o600))

      const uUnread = readUnityOutcome ? readUnityOutcome(unityProj) : { state: 'missing-export' }
      check(
        'w09-5 unreadable unity token returns unreadable while readUnityBridgeToken returns undefined',
        uUnread.state === 'unreadable' && uUnread.path === uTokenFile && unityTokenMod.readUnityBridgeToken(unityProj) === undefined,
        JSON.stringify(uUnread),
      )

      const uSession = await buildUnityBridgeIdeSession(unityProj)
      check(
        'w09-5 unityBridgeSession reports unreadable bridge token without throwing',
        uSession.bridge.detail.includes(`the bridge token at ${uTokenFile} could not be read (`),
        uSession.bridge.detail,
      )

      const uReady = runWithCwdOverride(unityProj, () => unityBridgeReadinessRecords())
      check(
        'w09-5 unityBridgeReadinessRecords reports unreadable bridge token instead of ABSENT',
        uReady.length === 1 &&
          uReady[0]!.detail.includes(`the bridge token at ${uTokenFile} could not be read (`) &&
          !uReady[0]!.detail.includes('token ABSENT'),
        JSON.stringify(uReady),
      )

      const bUnread = readBlenderOutcome ? readBlenderOutcome(blenderHome) : { state: 'missing-export' }
      check(
        'w09-5 unreadable blender token returns unreadable while readBlenderBridgeToken and client return null/undefined',
        bUnread.state === 'unreadable' &&
          bUnread.path === bTokenFile &&
          blenderTokenMod.readBlenderBridgeToken(blenderHome) === undefined &&
          getBlenderBridgeClient() === null,
        JSON.stringify(bUnread),
      )

      const bSession = await buildBlenderBridgeIdeSession(scratch)
      check(
        'w09-5 blenderBridgeSession reports unreadable bridge token without throwing',
        bSession.bridge.detail.includes(`the bridge token at ${bTokenFile} could not be read (`),
        bSession.bridge.detail,
      )

      const bReady = blenderBridgeReadinessRecords()
      check(
        'w09-5 blenderBridgeReadinessRecords reports unreadable bridge token instead of ABSENT',
        bReady.length === 1 &&
          bReady[0]!.detail.includes(`the bridge token at ${bTokenFile} could not be read (`) &&
          !bReady[0]!.detail.includes('token ABSENT'),
        JSON.stringify(bReady),
      )
    }
  } finally {
    resetBlenderBridgeClientForTest()
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    for (const fn of restoreModes.reverse()) {
      try { fn() } catch { void 0 }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? 'PASS: prove-wider-w09' : `FAIL: prove-wider-w09 (${failures} failure(s))`)
process.exit(failures === 0 ? 0 : 1)
