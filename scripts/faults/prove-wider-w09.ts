#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dir
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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
  const { classCacheReport } = await import(join(SRC, 'services/vulcan/classCache.ts'))
  const { staticGodotCapsule } = await import(join(SRC, 'services/vulcan/godotCapsule.ts'))
  const { derivePresence } = await import(join(SRC, 'services/vulcan/editorPresence.ts'))
  const { GodotTool } = await import(join(SRC, 'tools/GodotTool/GodotTool.ts'))
  const { resetVulcanClientForTest } = await import(join(SRC, 'services/vulcan/vulcanClient.ts'))
  const { runWithCwdOverride } = await import(join(SRC, 'utils/cwd.ts'))

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
  const instancesMod = await import(join(SRC, 'services/vulcan/instances.ts'))
  const vulcanClientMod = await import(join(SRC, 'services/vulcan/vulcanClient.ts'))
  const { GodotTool } = await import(join(SRC, 'tools/GodotTool/GodotTool.ts'))
  const { buildGodotIdeSession, discoverGodotLaunchProfiles, _resetGodotSessionForTesting } = await import(join(SRC, 'services/ide/godotSession.ts'))
  const { makeOwnerKey } = await import(join(SRC, 'services/run/ownerKey.ts'))
  const { runWithCwdOverride } = await import(join(SRC, 'utils/cwd.ts'))

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
  const { godotEngineCli } = await import(join(SRC, 'cli/godotEngineCli.ts'))
  const { resolveGodotExecutable } = await import(join(SRC, 'services/vulcan/portabilityHealth.ts'))
  const { runningGodotProcesses } = await import(join(SRC, 'services/vulcan/godotProcessCensus.ts'))

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

console.log(failures === 0 ? 'PASS: prove-wider-w09' : `FAIL: prove-wider-w09 (${failures} failure(s))`)
process.exit(failures === 0 ? 0 : 1)
