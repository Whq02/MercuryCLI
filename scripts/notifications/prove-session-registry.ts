#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const t = checker()
const root = scratchRoot('session-registry')
delete process.env.MERCURY_HOME
process.env.MERCURY_ENTRYPOINT = 'cli'

const { getMercuryHome } = await import('../../src/utils/envUtils.ts')
const { countConcurrentSessions, registerSession, updateSessionBridgeId, updateSessionName } = await import('../../src/utils/concurrentSessions.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
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
  await updateSessionBridgeId('bridge-1')
  t.check('the bridge id lands', record().bridgeSessionId === 'bridge-1')
  await updateSessionBridgeId(null)
  t.check('a null bridge id clears it and keeps the name', record().bridgeSessionId === null && record().name === 'a named session')
}

t.section('§3 the count: live records count, dead ones are swept, odd names are left alone')
{
  const dead = join(dir, '999999.json')
  const odd = join(dir, '999999-notes.json')
  const alien = join(dir, 'readme.txt')
  writeFileSync(dead, JSON.stringify({ pid: 999999 }))
  writeFileSync(odd, '{}')
  writeFileSync(alien, 'x')
  const count = await countConcurrentSessions()
  t.check('the own session counts and the dead pid does not', count === 1, String(count))
  t.check('the dead record was swept', !existsSync(dead))
  t.check('a file that merely starts with digits is never read as a pid nor deleted', existsSync(odd) && existsSync(alien))
  t.check('the own record survives the sweep', existsSync(own))
  mkdirSync(join(root, 'elsewhere'), { recursive: true })
  process.env.MERCURY_CONFIG_DIR = join(root, 'elsewhere', 'missing')
  t.check('a missing sessions folder counts zero', (await countConcurrentSessions()) === 0)
}

t.finish('prove-session-registry')
