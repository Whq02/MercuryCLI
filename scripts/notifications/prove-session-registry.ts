#!/usr/bin/env bun
// gate-watch: src/sessions/transcripts/concurrentSessions.ts
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const t = checker()
const root = scratchRoot('session-registry')
delete process.env.MERCURY_HOME
process.env.MERCURY_ENTRYPOINT = 'cli'

const { getMercuryHome } = await import('../../src/platform/environment/envUtils.ts')
const { registerSession, updateSessionName } = await import('../../src/sessions/transcripts/concurrentSessions.ts')
const { getSessionId } = await import('../../src/boot/process-state/processState.ts')
const dir = join(getMercuryHome(), 'sessions')
const own = join(dir, `${process.pid}.json`)
const record = (): Record<string, unknown> => JSON.parse(readFileSync(own, 'utf8')) as Record<string, unknown>

t.section('§1 registration writes the own record under a private folder')
{
  t.check('the scratch home is the registry home', dir.startsWith(root), dir)
  t.check('registration answers true', (await registerSession()) === true)
  t.check('the sessions folder is private to the owner', (statSync(dir).mode & 0o777) === 0o700, (statSync(dir).mode & 0o777).toString(8))
  t.check('the own record is private to the owner', (statSync(own).mode & 0o777) === 0o600, (statSync(own).mode & 0o777).toString(8))
  const r = record()
  t.check('the record names the pid, the session, the cwd, the kind and the entrypoint', r.pid === process.pid && r.sessionId === getSessionId() && typeof r.cwd === 'string' && r.kind === 'interactive' && r.entrypoint === 'cli' && typeof r.startedAt === 'number', JSON.stringify(r))
}

t.section('§2 the patches merge into the record')
{
  await updateSessionName(undefined)
  t.check('an absent name writes nothing', record().name === undefined)
  await updateSessionName('a named session')
  t.check('the name lands beside the other fields', record().name === 'a named session' && record().pid === process.pid)
}

t.finish('prove-session-registry')
