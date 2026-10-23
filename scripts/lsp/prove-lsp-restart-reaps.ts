#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'lsp-restart-reaps-'))
const project = join(scratch, 'project')
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.HOME = join(scratch, 'home')
process.env.USERPROFILE = process.env.HOME
mkdirSync(process.env.MERCURY_CONFIG_DIR)
mkdirSync(process.env.HOME)
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
delete process.env.MERCURY_LSP
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const name of ['MERCURY_LSP_CPP', 'MERCURY_LSP_PYTHON', 'MERCURY_LSP_RUFF', 'MERCURY_LSP_WEB', 'MERCURY_GODOT', 'MERCURY_UNITY']) process.env[name] = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

const src = resolve(process.env.PROVE_SRC ?? join(import.meta.dir, '../../src'))
const fixture = join(import.meta.dir, 'fixtures/fake-lsp-server.mjs')
const { enableConfigs } = await import(join(src, 'utils/config.ts'))
enableConfigs()
const singleton = await import(join(src, 'services/lsp/manager.ts'))
const command = await import(join(src, 'commands/lsp/lsp.ts'))
const { runWithCwdOverride } = await import(join(src, 'utils/cwd.ts'))
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}
const pids = (file: string): number[] => existsSync(file) ? readFileSync(file, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number) : []
const managers = new Set<{ shutdown(): Promise<unknown> }>()
const pidFiles: string[] = []
const guard = setTimeout(() => { console.error('prove-lsp-restart-reaps: timeout'); process.exit(1) }, 30_000)
guard.unref()

try {
  await runWithCwdOverride(project, async () => {
    for (const mode of ['ignore-shutdown', 'normal'] as const) {
      const pidFile = join(scratch, `${mode}.pids`)
      pidFiles.push(pidFile)
      process.env.MERCURY_LSP_SERVERS = JSON.stringify({ fixture: {
        command: process.execPath,
        args: [fixture],
        extensionToLanguage: { '.fake': 'fake' },
        env: { FAKE_LSP_MODE: mode, FAKE_LSP_PID_FILE: pidFile },
        workspaceFolder: project,
        startupTimeout: 5_000,
        shutdownTimeout: 300,
        restartOnCrash: false,
      } })
      singleton.initializeLspServerManager()
      await singleton.waitForInitialization()
      const old = singleton.getLspServerManager()!
      managers.add(old)
      const file = join(project, `${mode}.fake`)
      writeFileSync(file, 'fixture\n')
      await old.openFile(file, 'fixture\n')
      const oldPid = pids(pidFile)[0]!
      check(`${mode}: one fixture child is alive before restart`, pids(pidFile).length === 1 && alive(oldPid))
      const started = Date.now()
      const result = await command.call('restart', {} as never)
      const elapsed = Date.now() - started
      const text = result.type === 'text' ? result.value : JSON.stringify(result)
      console.log(`  result (${elapsed} ms): ${text}`)
      check(`${mode}: restart returns only after the old child is gone`, !alive(oldPid), `pid ${oldPid} survived the success result`)
      check(`${mode}: bounded restart settles`, elapsed < 6_000, `${elapsed} ms`)
      if (mode === 'ignore-shutdown') {
        check('the ignored shutdown reaches its configured deadline', elapsed >= 280, `${elapsed} ms`)
        check('the result reports the forced stop and elapsed seconds', /killed after \d+(?:\.\d+)? s/.test(text), text)
      } else {
        check('the result reports the observed exit', /exited cleanly|killed after \d+(?:\.\d+)? s/.test(text), text)
      }
      const fresh = singleton.getLspServerManager()!
      managers.add(fresh)
      check(`${mode}: a new manager replaced the old one`, fresh !== old)
      await fresh.openFile(file, 'fixture\n')
      const answer = await fresh.sendRequest(file, 'fake/cancelCount', {})
      const spawned = pids(pidFile)
      check(`${mode}: the next request answers from the replacement`, answer?.cancels === 0, JSON.stringify(answer))
      check(`${mode}: exactly one replacement child is alive`, spawned.length === 2 && spawned[0] !== spawned[1] && !alive(oldPid) && alive(spawned[1]!), JSON.stringify(spawned))
      if (mode === 'ignore-shutdown') {
        const named = await command.call('restart env:fixture', {} as never)
        const namedText = named.type === 'text' ? named.value : JSON.stringify(named)
        console.log(`  named result: ${namedText}`)
        const namedPids = pids(pidFile)
        check('named restart reports its kill after reaping the previous child', /killed after \d+(?:\.\d+)? s; running/.test(namedText) && !alive(spawned[1]!), namedText)
        check('named restart starts exactly one replacement', namedPids.length === 3 && alive(namedPids[2]!))
        check('a request after named restart answers', (await fresh.sendRequest(file, 'fake/cancelCount', {}))?.cancels === 0)
      }
      await singleton.shutdownLspServerManager()
      await old.shutdown()
      check(`${mode}: cleanup reaped every fixture generation`, pids(pidFile).every(pid => !alive(pid)))
    }

    const pidFile = join(scratch, 'overlap.pids')
    pidFiles.push(pidFile)
    const configured = JSON.parse(process.env.MERCURY_LSP_SERVERS!)
    configured.fixture.env = { FAKE_LSP_MODE: 'ignore-shutdown', FAKE_LSP_PID_FILE: pidFile }
    process.env.MERCURY_LSP_SERVERS = JSON.stringify(configured)
    singleton.initializeLspServerManager()
    await singleton.waitForInitialization()
    const old = singleton.getLspServerManager()!
    managers.add(old)
    const file = join(project, 'overlap.fake')
    writeFileSync(file, 'fixture\n')
    await old.openFile(file, 'fixture\n')
    const first = singleton.reinitializeLspServerManager()
    const second = singleton.reinitializeLspServerManager()
    check('concurrent reinitializations share one stop', first === second)
    await singleton.shutdownLspServerManager()
    await Promise.all([first, second])
    check('shutdown during restart waits for the old process', pids(pidFile).length === 1 && pids(pidFile).every(pid => !alive(pid)))
    check('shutdown cancels replacement initialization', singleton.getLspServerManager() === undefined && singleton.getInitializationStatus().status === 'not-started')
  })
} catch (error) {
  check('no unexpected exception', false, error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await singleton.shutdownLspServerManager()
  for (const manager of managers) await manager.shutdown().catch(() => {})
  const survivors = pidFiles.flatMap(pids).filter(alive)
  check('no fixture process remains', survivors.length === 0, survivors.join(', '))
  clearTimeout(guard)
  process.chdir(import.meta.dir)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`prove-lsp-restart-reaps: ${failures === 0 ? 'GREEN' : `RED (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
