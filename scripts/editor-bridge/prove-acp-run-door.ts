#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL ACP bundle exists: ${dist} — run bun run build.ts, or pass --dist <path to mercury.mjs>`); process.exit(1) }
const home = realpathSync(mkdtempSync(join(tmpdir(), 'acp-run-door-')))
seedFirstRun(home, [home])
process.env.MERCURY_CONFIG_DIR = home
const { MercuryChildSession } = await import('../../src/integrations/acp/childSession.ts')
const api = await startFixtureApi([{ kind: 'text', text: 'The editor turn answered.' }])
let answer = '', session = '', failures = 0
let finish!: (outcome: string) => void
const ended = new Promise<string>(resolve => { finish = resolve })
const child = new MercuryChildSession({ cwd: home, permissionMode: 'flow', entry: { node: 'node', script: dist }, env: {
  HOME: home,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'fixture-key',
  ANTHROPIC_BASE_URL: api.url,
} }, {
  onInit: id => { session = id },
  onAssistantText: text => { answer += text },
  onToolUse: () => {},
  onToolResult: () => {},
  onPermissionAsk: async () => { finish('unexpected permission ask'); return { outcome: 'deny' as const, message: 'unexpected' } },
  onTurnEnd: outcome => { finish(outcome) },
  onExit: code => { finish(`exit ${code}`) },
})
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail} — look at the MercuryChildSession constructor (runner argv) and writeUserPrompt in src/integrations/acp/childSession.ts`}`); if (!ok) failures++ }
const timer = setTimeout(() => { console.log('FAIL no turn outcome from the ACP run child within 60s: check the child spawned by MercuryChildSession in src/integrations/acp/childSession.ts and the fixture api'); finish('deadline') }, 60_000)
try {
  const argv = child.child.spawnargs.slice(1)
  check('the ACP child starts through the runner door with its mode and no output words', argv[0] === dist && argv[1] === 'runner' && !argv.some(a => a.startsWith('--input') || a.startsWith('--format') || a.startsWith('--permission')) && argv[argv.indexOf('--mode') + 1] === 'flow', JSON.stringify(argv))
  await child.writeUserPrompt([{ type: 'text', text: 'answer the editor' }])
  const outcome = await ended
  check('the ACP run child completes a loopback turn', outcome === 'success' && answer === 'The editor turn answered.' && session.length > 0, JSON.stringify({ outcome, answer, session }))
} finally {
  clearTimeout(timer)
  await child.close()
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
