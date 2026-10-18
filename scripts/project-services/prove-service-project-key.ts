#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-svc-project-key-home-'))
delete process.env.MERCURY_SERVICES

let failures = 0
let count = 0
function check(label: string, cond: boolean, detail = ''): void {
  count++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const manager = await import('../../src/services/projectServices/serviceManager.ts')
const j = (v: unknown): string => JSON.stringify(v)

const project = realpathSync(mkdtempSync(join(tmpdir(), 'prove-svc-project-')))
const web = join(project, 'web')
const elsewhere = join(project, 'docs')
mkdirSync(web, { recursive: true })
mkdirSync(elsewhere, { recursive: true })
const sleeper = (name: string, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, command: 'sleep', args: ['300'], cwd, readiness: [], readinessMode: 'all', restart: 'never', lifecycle: 'session', ...extra,
})
const names: string[] = []
try {
  section('§1 the record lives under the project, not under the working directory the service runs in (the field row M39-06)')
  {
    const spec = sleeper('preview', web, { project })
    const started = await manager.startService({ sessionId: 's1', spec: spec as never })
    check('a service started with a working directory inside the project starts', 'record' in started, j(started))
    names.push('preview')
    const byProject = manager.reconcileRecord(project, 'preview')
    const byCwd = manager.reconcileRecord(web, 'preview')
    const byOtherFolder = manager.reconcileRecord(elsewhere, 'preview')
    check('the project key finds it; the service\'s own working directory and another folder of the project do not file it elsewhere', byProject !== null && byProject.state !== 'failed' && byCwd === null && byOtherFolder === null, j({ byProject: byProject?.state, byCwd, byOtherFolder }))
    check('the record keeps the working directory it was started in', byProject?.spec.cwd === web && byProject.spec.project === project, j(byProject?.spec))
    check('list under the project names it', manager.reconcileAll(project).map(r => r.spec.name).join(',') === 'preview', j(manager.reconcileAll(project).map(r => r.spec.name)))
    const waited = await manager.waitForReady(project, 'preview', 500)
    check('wait under the project finds it (no readiness declared: ready at once)', waited.record !== null && waited.ready === true, j({ ready: waited.ready, state: waited.record?.state }))
    const stopped = await manager.stopService(project, 'preview')
    check('stop under the project stops it', 'record' in stopped && stopped.record.state === 'stopped', j(stopped))
  }

  section('§2 a wait that arrives before the start registered waits for the registration instead of answering absent')
  {
    const started = Date.now()
    const pending = manager.waitForReady(project, 'late', 5_000)
    setTimeout(() => { void manager.startService({ sessionId: 's1', spec: sleeper('late', web, { project }) as never }) }, 300)
    const outcome = await pending
    names.push('late')
    check('the wait found the service that registered 300 ms after it was asked', outcome.record !== null && outcome.ready === true && Date.now() - started < 3_000, j({ ready: outcome.ready, state: outcome.record?.state, ms: Date.now() - started }))
    const absent = await manager.waitForReady(project, 'never-started', 5_000)
    check('a service that never registers is absent after the registration grace, not after the whole deadline', absent.record === null && Date.now() - started < 8_000, j(absent))
    await manager.stopService(project, 'late')
  }

  section('§3 a record without a project key (an older record) still files under its working directory')
  {
    const started = await manager.startService({ sessionId: 's1', spec: sleeper('plain', web) as never })
    names.push('plain')
    check('started', 'record' in started, j(started))
    check('it is found under the working directory it was keyed by', manager.reconcileRecord(web, 'plain') !== null && manager.reconcileRecord(project, 'plain') === null)
    await manager.stopService(web, 'plain')
  }

  section('§4 the tool reads the project root for every op, never the drifting shell cwd')
  {
    const tool = readFileSync(join(ROOT, 'src/tools/ServiceTool/ServiceTool.ts'), 'utf8')
    check('the start spec carries the project', tool.includes('const project = getOriginalCwd()') && tool.includes('cwd: input.cwd ?? cwd,\n          project,'))
    check('list, describe, wait, logs, input, stop and restart read the project key', !tool.includes('input.cwd ?? cwd, input.name') && tool.includes('reconcileAll(project)') && tool.includes('waitForReady(project, input.name!, wait.value)') && tool.includes('stopService(project, input.name!)') && tool.includes('restartService(project, input.name!, sessionId, owner)'))
    const adapter = readFileSync(join(ROOT, 'src/services/resources/adapters/service.ts'), 'utf8')
    check('mercury://service/<name> reads the project root too', adapter.includes('reconcileRecord(getOriginalCwd(), ref.id)') && !adapter.includes('reconcileAll(ctx.cwd)'))
  }
} finally {
  for (const name of names) {
    try { await manager.stopService(project, name) } catch {}
    try { await manager.stopService(web, name) } catch {}
  }
  rmSync(project, { recursive: true, force: true })
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('SERVICE PROJECT KEY RED')
  process.exit(1)
}
console.log('SERVICE PROJECT KEY GREEN')
