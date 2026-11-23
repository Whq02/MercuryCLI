#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
const manager = await import('../../src/tools/engines/project-services/serviceManager.ts')
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
    check('a service started with a working directory inside the project starts', 'record' in started, j(started) + ' — startService in src/tools/engines/project-services/serviceManager.ts refused or failed the spec')
    names.push('preview')
    const byProject = manager.reconcileRecord(project, 'preview')
    const byCwd = manager.reconcileRecord(web, 'preview')
    const byOtherFolder = manager.reconcileRecord(elsewhere, 'preview')
    check('the project key finds it; the service\'s own working directory and another folder of the project do not file it elsewhere', byProject !== null && byProject.state !== 'failed' && byCwd === null && byOtherFolder === null, j({ byProject: byProject?.state, byCwd, byOtherFolder }) + ' — the record must be filed by spec.project (projectKeyOf, startService in src/tools/engines/project-services/serviceManager.ts), not by spec.cwd')
    check('the record keeps the working directory it was started in', byProject?.spec.cwd === web && byProject.spec.project === project, j(byProject?.spec) + ' — startService in src/tools/engines/project-services/serviceManager.ts must keep spec.cwd and spec.project as given')
    check('list under the project names it', manager.reconcileAll(project).map(r => r.spec.name).join(',') === 'preview', j(manager.reconcileAll(project).map(r => r.spec.name)) + ' — reconcileAll in src/tools/engines/project-services/serviceManager.ts must list records filed under the project key')
    const waited = await manager.waitForReady(project, 'preview', 500)
    check('wait under the project finds it (no readiness declared: ready at once)', waited.record !== null && waited.ready === true, j({ ready: waited.ready, state: waited.record?.state }) + ' — waitForReady in src/tools/engines/project-services/serviceManager.ts must find the record by the project key and treat no readiness checks as ready')
    const stopped = await manager.stopService(project, 'preview')
    check('stop under the project stops it', 'record' in stopped && stopped.record.state === 'stopped', j(stopped) + ' — stopService in src/tools/engines/project-services/serviceManager.ts must find the record by the project key')
  }

  section('§2 a wait that arrives before the start registered waits for the registration instead of answering absent')
  {
    const started = Date.now()
    const pending = manager.waitForReady(project, 'late', 5_000)
    setTimeout(() => { void manager.startService({ sessionId: 's1', spec: sleeper('late', web, { project }) as never }) }, 300)
    const outcome = await pending
    names.push('late')
    check('the wait found the service that registered 300 ms after it was asked', outcome.record !== null && outcome.ready === true && Date.now() - started < 3_000, j({ ready: outcome.ready, state: outcome.record?.state, ms: Date.now() - started }) + ' — waitForReady in src/tools/engines/project-services/serviceManager.ts must keep polling for the record during the registration grace')
    const absent = await manager.waitForReady(project, 'never-started', 5_000)
    check('a service that never registers is absent after the registration grace, not after the whole deadline', absent.record === null && Date.now() - started < 8_000, j(absent) + ' — waitForReady in src/tools/engines/project-services/serviceManager.ts must answer absent after WAIT_REGISTRATION_GRACE_MS, not after the full timeout')
    await manager.stopService(project, 'late')
  }

  section('§3 a record without a project key (an older record) still files under its working directory')
  {
    const started = await manager.startService({ sessionId: 's1', spec: sleeper('plain', web) as never })
    names.push('plain')
    check('started', 'record' in started, j(started) + ' — startService in src/tools/engines/project-services/serviceManager.ts refused or failed the spec')
    check('it is found under the working directory it was keyed by', manager.reconcileRecord(web, 'plain') !== null && manager.reconcileRecord(project, 'plain') === null, 'a spec without project must be keyed by spec.cwd (projectKeyOf in src/tools/engines/project-services/serviceManager.ts)')
    await manager.stopService(web, 'plain')
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
