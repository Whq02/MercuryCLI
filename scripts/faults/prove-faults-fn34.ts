import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const BUN = process.env.BUN ?? (process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun'))
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function runScenario(body: string): Record<string, unknown> {
  const scratch = mkdtempSync(join(tmpdir(), 'faults-fn34-'))
  const home = join(scratch, 'home')
  const project = join(scratch, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(home)}
    process.env.NODE_ENV = 'development'
    delete process.env.MERCURY_HOME
    delete process.env.MERCURY_SKIP_PROMPT_HISTORY
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.chdir(${JSON.stringify(project)})
    const fs = await import('node:fs')
    const path = await import('node:path')
    const HOME = ${JSON.stringify(home)}
    const PROJECT = ${JSON.stringify(project)}
    const SRC = ${JSON.stringify(SRC)}
    const out = {}
    ${body}
    process.stdout.write('\\n' + JSON.stringify(out))
    process.exit(0)
  `
  try {
    const res = spawnSync(BUN, ['-e', src], {
      encoding: 'utf8',
      env: { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_HOME: '' },
    })
    if (res.status !== 0) throw new Error(`scenario failed (rc=${res.status}): ${(res.stderr || res.stdout).slice(-1500)}`)
    const line = res.stdout.trim().split('\n').pop() ?? '{}'
    return JSON.parse(line) as Record<string, unknown>
  } finally {
    try {
      chmodSync(home, 0o700)
    } catch {}
    rmSync(scratch, { recursive: true, force: true })
  }
}

{
  if (POSIX_MODES) {
    const r = runScenario(`
      const { encodeTranscriptLine, resetTranscriptFormatCacheForTesting } = await import(path.join(SRC, 'sessions/transcripts/vnext.ts'))
      const { setStoreHealth, subscribeTranscriptStoreHealth, transcriptStoreHealth } = await import(path.join(SRC, 'sessions/transcripts/writer/storeHealth.ts'))
      const existing = path.join(HOME, 'existing.jsonl')
      fs.writeFileSync(existing, '{"schemaVersion":1,"creationOrdinal":"5"}\\n', { mode: 0o600 })
      fs.chmodSync(existing, 0o000)
      resetTranscriptFormatCacheForTesting()
      let notices = 0
      const off = subscribeTranscriptStoreHealth(() => {
        if (transcriptStoreHealth().failing) notices++
      })
      try {
        encodeTranscriptLine(existing, { type: 'user', uuid: '00000000-0000-4000-8000-000000000012' })
        out.firstHealth = transcriptStoreHealth()
        setStoreHealth({ failing: false, sentence: null })
        encodeTranscriptLine(existing, { type: 'user', uuid: '00000000-0000-4000-8000-000000000019' })
        out.notices = notices
        out.threw = null
      } catch (e) {
        out.threw = String(e)
      } finally {
        off()
        fs.chmodSync(existing, 0o600)
      }
      const after = encodeTranscriptLine(existing, { type: 'user', uuid: '00000000-0000-4000-8000-000000000013' })
      out.existing = existing
      out.afterOrdinal = Number(after.record.creationOrdinal)
      out.afterHasHeader = after.line.includes('mercury-transcript-header')
    `)
    const health = r.firstHealth as { failing: boolean; sentence: string | null } | undefined
    const existing = String(r.existing ?? '')
    const sentenceOk =
      health?.failing === true &&
      typeof health.sentence === 'string' &&
      health.sentence.startsWith(`Session transcript at ${existing} could not be read (`) &&
      health.sentence.endsWith('), so new messages may be saved out of order — restore read permission on the file.')
    check('vnext-unreadable-not-cached', r.threw === null && sentenceOk && r.notices === 1 && Number(r.afterOrdinal) > 5 && r.afterHasHeader === false, `${JSON.stringify(r)} — encodeTranscriptLine in src/sessions/transcripts/vnext.ts must not cache an unreadable transcript's format, must report store health once with the 'could not be read' sentence naming the file, and must continue the ordinal once the file is readable`)
  }
}
{
  if (POSIX_MODES) {
    const r = runScenario(`
      const writer = await import(path.join(SRC, 'sessions/transcripts/writer.ts'))
      const { setStoreHealth, subscribeTranscriptStoreHealth, transcriptStoreHealth } = await import(path.join(SRC, 'sessions/transcripts/writer/storeHealth.ts'))
      const { getSessionId } = await import(path.join(SRC, 'boot/process-state/processState.ts'))
      const sessionId = getSessionId()
      const sessionFile = path.join(HOME, 'main.jsonl')
      const agentFile = path.join(HOME, 'agent-a1.jsonl')
      const existingUuid = '00000000-0000-4000-8000-000000000014'
      fs.writeFileSync(sessionFile, '', { mode: 0o600 })
      writer.appendEntryToFile(agentFile, {
        type: 'user',
        uuid: existingUuid,
        parentUuid: null,
        isSidechain: true,
        agentId: 'a1',
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: PROJECT,
        version: 'proof',
        message: { role: 'user', content: 'already-on-disk' },
      })
      fs.chmodSync(agentFile, 0o000)
      writer.setSessionFileForTesting(sessionFile)
      writer.registerCrewmateTranscriptDestination('a1', agentFile)
      let notices = 0
      const off = subscribeTranscriptStoreHealth(() => {
        if (transcriptStoreHealth().failing) notices++
      })
      try {
        await writer.recordSidechainTranscript([{
          type: 'user',
          uuid: '00000000-0000-4000-8000-000000000015',
          sessionId,
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'while-unreadable' },
        }], 'a1')
        out.firstHealth = transcriptStoreHealth()
        setStoreHealth({ failing: false, sentence: null })
        await writer.recordSidechainTranscript([{
          type: 'user',
          uuid: '00000000-0000-4000-8000-000000000018',
          sessionId,
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'while-unreadable-2' },
        }], 'a1')
        out.notices = notices
        out.threw = null
      } catch (e) {
        out.threw = String(e)
      } finally {
        off()
        fs.chmodSync(agentFile, 0o600)
      }
      await writer.recordSidechainTranscript([{
        type: 'user',
        uuid: existingUuid,
        sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'already-on-disk' },
      }], 'a1')
      await writer.flushSessionStorage()
      const occurrences = fs.readFileSync(agentFile, 'utf8').split('\\n').filter(l => l.includes(existingUuid)).length
      out.agentFile = agentFile
      out.occurrences = occurrences
    `)
    const health = r.firstHealth as { failing: boolean; sentence: string | null } | undefined
    const agentFile = String(r.agentFile ?? '')
    const sentenceOk =
      health?.failing === true &&
      typeof health.sentence === 'string' &&
      health.sentence.startsWith(`Agent transcript at ${agentFile} could not be read (`) &&
      health.sentence.endsWith('), so entries may be duplicated — restore read permission on the file.')
    check('writer-agent-messages-unreadable-not-cached', r.threw === null && sentenceOk && r.notices === 1 && r.occurrences === 1, `${JSON.stringify(r)} — recordSidechainTranscript in src/sessions/transcripts/writer.ts must report the 'Agent transcript ... could not be read' store-health sentence once for an unreadable agent file and must not cache it, so an entry already on disk is not duplicated`)
  }
}
{
  if (POSIX_MODES) {
    const r = runScenario(`
      const { mock } = await import('bun:test')
      const managedRoot = path.join(HOME, 'managed')
      const dropInDir = path.join(managedRoot, 'managed-settings.d')
      fs.mkdirSync(dropInDir, { recursive: true })
      const managedPathMod = path.join(SRC, 'platform/settings/managedPath.ts')
      const realManaged = await import(managedPathMod)
      mock.module(managedPathMod, () => ({
        ...realManaged,
        getManagedFilePath: () => managedRoot,
        getManagedSettingsDropInDir: () => dropInDir,
      }))
      const rawRead = await import(path.join(SRC, 'platform/settings/mdm/rawRead.ts'))
      const mdm = await import(path.join(SRC, 'platform/settings/mdm/settings.ts'))
      const hkcuStdout = '    Settings    REG_SZ    {"display":{"theme":"dark"}}\\r\\n'

      fs.chmodSync(dropInDir, 0o000)
      try {
        mdm.clearMdmSettingsCache()
        rawRead._setMdmRawReadForProofs({ plistStdouts: null, hklmStdout: null, hkcuStdout })
        await mdm.ensureMdmSettingsLoaded()
        out.unreadableDropIn = mdm.getHkcuSettings().settings
      } finally {
        fs.chmodSync(dropInDir, 0o700)
      }

      const baseFile = path.join(managedRoot, 'managed-settings.json')
      fs.writeFileSync(baseFile, '{"display":{"theme":"true-black"}}', { mode: 0o600 })
      fs.chmodSync(baseFile, 0o000)
      try {
        mdm.clearMdmSettingsCache()
        rawRead._setMdmRawReadForProofs({ plistStdouts: null, hklmStdout: null, hkcuStdout })
        await mdm.ensureMdmSettingsLoaded()
        out.unreadableFile = mdm.getHkcuSettings().settings
      } finally {
        fs.chmodSync(baseFile, 0o600)
        fs.unlinkSync(baseFile)
      }

      mdm.clearMdmSettingsCache()
      rawRead._setMdmRawReadForProofs({ plistStdouts: null, hklmStdout: null, hkcuStdout })
      await mdm.ensureMdmSettingsLoaded()
      out.absentControl = mdm.getHkcuSettings().settings
    `)
    const dropIn = r.unreadableDropIn as { display?: { theme?: string } }
    const file = r.unreadableFile as { display?: { theme?: string } }
    const control = r.absentControl as { display?: { theme?: string } }
    check('mdm-unreadable-dropin-goes-on', dropIn?.display?.theme === 'dark' && control?.display?.theme === 'dark', `${JSON.stringify(r)} — ensureMdmSettingsLoaded in src/platform/settings/mdm/settings.ts must skip an unreadable managed-settings.d directory and still load the HKCU settings`)
    check('mdm-unreadable-file-goes-on', file?.display?.theme === 'dark' && control?.display?.theme === 'dark', `${JSON.stringify(r)} — ensureMdmSettingsLoaded in src/platform/settings/mdm/settings.ts must skip an unreadable managed-settings.json and still load the HKCU settings`)
  }
}
{
  if (POSIX_MODES) {
    const r = runScenario(`
      const { mock } = await import('bun:test')
      const managedRoot = path.join(HOME, 'managed2')
      const dropInDir = path.join(managedRoot, 'managed-settings.d')
      fs.mkdirSync(dropInDir, { recursive: true })
      const managedPathMod = path.join(SRC, 'platform/settings/managedPath.ts')
      const realManaged = await import(managedPathMod)
      mock.module(managedPathMod, () => ({
        ...realManaged,
        getManagedFilePath: () => managedRoot,
        getManagedSettingsDropInDir: () => dropInDir,
      }))
      const settingsMod = await import(path.join(SRC, 'platform/settings/settings.ts'))
      const cacheMod = await import(path.join(SRC, 'platform/settings/settingsCache.ts'))
      fs.chmodSync(dropInDir, 0o000)
      try {
        cacheMod.resetSettingsCache()
        out.loaded = settingsMod.loadManagedFileSettings()
      } finally {
        fs.chmodSync(dropInDir, 0o700)
        fs.rmSync(dropInDir, { recursive: true, force: true })
      }
      cacheMod.resetSettingsCache()
      out.absentLoaded = settingsMod.loadManagedFileSettings()
    `)
    const loaded = r.loaded as { errors: Array<{ message?: string }> }
    const absentLoaded = r.absentLoaded as { errors: unknown[] }
    check('settings-unreadable-dropin-reported', loaded.errors.some(e => e.message?.includes('settings file unreadable')) && absentLoaded.errors.length === 0, `${JSON.stringify(r)} — loadManagedFileSettings in src/platform/settings/settings.ts must report a 'settings file unreadable' error for an unreadable drop-in directory and no error when it is absent`)
  }
}
{
  if (POSIX_MODES) {
    const r = runScenario(`
      const tasks = await import(path.join(SRC, 'engine/task-framework/tasks.ts'))
      const tasksRoot = path.join(HOME, 'tasks')

      fs.writeFileSync(tasksRoot, 'not-a-directory', { mode: 0o600 })
      try {
        await tasks.ensureTasksDir('blocked-root')
        out.ensureDirThrew = null
      } catch (e) {
        out.ensureDirThrew = { code: e?.code ?? null, message: String(e?.message ?? e) }
      } finally {
        fs.unlinkSync(tasksRoot)
      }

      const epochList = 'epoch-list'
      const epochDir = tasks.getTasksDir(epochList)
      fs.mkdirSync(epochDir, { recursive: true })
      out.absentEpoch = await tasks.readTaskEpoch(epochList)
      const epochFile = path.join(epochDir, '.epoch')
      fs.writeFileSync(epochFile, '{"epoch":3}', { mode: 0o600 })
      fs.chmodSync(epochFile, 0o000)
      try {
        await tasks.readTaskEpoch(epochList)
        out.unreadableEpochThrew = null
      } catch (e) {
        out.unreadableEpochThrew = { code: e?.code ?? null, message: String(e?.message ?? e) }
      } finally {
        fs.chmodSync(epochFile, 0o600)
      }
      fs.writeFileSync(epochFile, '{corrupt', { mode: 0o600 })
      try {
        await tasks.readTaskEpoch(epochList)
        out.corruptEpochThrew = null
      } catch (e) {
        out.corruptEpochThrew = { name: e?.name ?? null, message: String(e?.message ?? e) }
      }

      const listId = 'unreadable-list'
      out.absentList = await tasks.listTasks('no-such-list')
      const listDir = tasks.getTasksDir(listId)
      fs.mkdirSync(listDir, { recursive: true })
      fs.chmodSync(listDir, 0o000)
      try {
        await tasks.listTasks(listId)
        out.unreadableListThrew = null
      } catch (e) {
        out.unreadableListThrew = { code: e?.code ?? null, message: String(e?.message ?? e) }
      } finally {
        fs.chmodSync(listDir, 0o700)
      }

      const hwmList = 'hwm-list'
      const hwmDir = tasks.getTasksDir(hwmList)
      fs.mkdirSync(hwmDir, { recursive: true })
      const hwmFile = path.join(hwmDir, '.highwatermark')
      fs.writeFileSync(hwmFile, '5', { mode: 0o600 })
      fs.chmodSync(hwmFile, 0o000)
      try {
        await tasks.createTask(hwmList, { subject: 's', description: 'd', status: 'pending', blocks: [], blockedBy: [] })
        out.unreadableHwmThrew = null
      } catch (e) {
        out.unreadableHwmThrew = { code: e?.code ?? null, message: String(e?.message ?? e) }
      } finally {
        fs.chmodSync(hwmFile, 0o600)
      }

      const delList = 'del-list'
      const createdId = await tasks.createTask(delList, { subject: 's', description: 'd', status: 'pending', blocks: [], blockedBy: [] })
      out.deleteAbsent = await tasks.deleteTask(delList, '999')
      const delDir = tasks.getTasksDir(delList)
      fs.chmodSync(delDir, 0o500)
      try {
        await tasks.deleteTask(delList, createdId)
        out.deleteDeniedThrew = null
      } catch (e) {
        out.deleteDeniedThrew = { code: e?.code ?? null, message: String(e?.message ?? e) }
      } finally {
        fs.chmodSync(delDir, 0o700)
      }
    `)
    const ensureDirThrew = r.ensureDirThrew as { code: string | null } | null
    const unreadableEpochThrew = r.unreadableEpochThrew as { code: string | null } | null
    const corruptEpochThrew = r.corruptEpochThrew as { name: string | null } | null
    const unreadableListThrew = r.unreadableListThrew as { code: string | null } | null
    const unreadableHwmThrew = r.unreadableHwmThrew as { code: string | null } | null
    const deleteDeniedThrew = r.deleteDeniedThrew as { code: string | null } | null
    check('tasks-ensure-dir-fails-on-enotdir', ensureDirThrew !== null && (ensureDirThrew.code === 'EEXIST' || ensureDirThrew.code === 'ENOTDIR'), `${JSON.stringify(r.ensureDirThrew)} — ensureTasksDir in src/engine/task-framework/tasks.ts must throw EEXIST/ENOTDIR when the tasks root is a file`)
    check('tasks-epoch-unreadable-and-corrupt-throw', r.absentEpoch === 0 && unreadableEpochThrew !== null && (unreadableEpochThrew.code === 'EACCES' || unreadableEpochThrew.code === 'EPERM') && corruptEpochThrew !== null, `${JSON.stringify({ absent: r.absentEpoch, unreadable: r.unreadableEpochThrew, corrupt: r.corruptEpochThrew })} — readTaskEpoch in src/engine/task-framework/tasks.ts must return 0 for an absent .epoch and throw for an unreadable or corrupt one`)
    check('tasks-list-unreadable-dir-throws', Array.isArray(r.absentList) && r.absentList.length === 0 && unreadableListThrew !== null && (unreadableListThrew.code === 'EACCES' || unreadableListThrew.code === 'EPERM'), `${JSON.stringify({ absent: r.absentList, unreadable: r.unreadableListThrew })} — listTasks in src/engine/task-framework/tasks.ts must return [] for a missing list and throw EACCES/EPERM for an unreadable list directory`)
    check('tasks-highwatermark-unreadable-refuses-create', unreadableHwmThrew !== null && (unreadableHwmThrew.code === 'EACCES' || unreadableHwmThrew.code === 'EPERM'), `${JSON.stringify(r.unreadableHwmThrew)} — createTask in src/engine/task-framework/tasks.ts must throw EACCES/EPERM when .highwatermark is unreadable instead of reusing an id`)
    check('tasks-delete-failure-throws', r.deleteAbsent === false && deleteDeniedThrew !== null && (deleteDeniedThrew.code === 'EACCES' || deleteDeniedThrew.code === 'EPERM'), `${JSON.stringify({ absent: r.deleteAbsent, denied: r.deleteDeniedThrew })} — deleteTask in src/engine/task-framework/tasks.ts must return false for an absent task and throw EACCES/EPERM when the delete is denied`)
  }
}
console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
