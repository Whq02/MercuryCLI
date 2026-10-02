#!/usr/bin/env bun
// gate-watch: src/utils/permissions/getNextPermissionMode.ts src/utils/permissions/PermissionMode.ts src/types/permissions.ts
// gate-watch: src/utils/permissions/permissionSetup.ts src/tools.ts src/utils/capability/declarations.ts src/substrate/flagRegistry.ts
// gate-watch: src/components/mercury-ui/compactModeChip.ts src/components/MercuryFrame.tsx src/utils/attachments/modeLifecycles.ts
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.NODE_ENV = 'test'
const scratch = mkdtempSync(join(tmpdir(), 'mode-cycle-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'door-home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_AUTOPILOT = '1'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SKIP_PERMISSIONS
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_BUNDLE ?? join(ROOT, 'dist', 'mercury.mjs')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const permissions = await import('../../src/types/permissions.js')
const modes = await import('../../src/utils/permissions/PermissionMode.js')
const cycle = await import('../../src/utils/permissions/getNextPermissionMode.js')
const chip = await import('../../src/components/mercury-ui/compactModeChip.js')
const declarations = await import('../../src/utils/capability/declarations.js')
const registry = await import('../../src/substrate/flagRegistry.js')
const tools = await import('../../src/tools.js')

console.log('— the mode lists —')
const every = [...permissions.PERMISSION_MODES, ...permissions.INTERNAL_PERMISSION_MODES, ...permissions.EXTERNAL_PERMISSION_MODES] as readonly string[]
t('no mode list carries a word beyond default, dontAsk, implement, sovereign, flow, bubble, apollo', every.every(m => ['default', 'dontAsk', 'implement', 'sovereign', 'flow', 'bubble', 'apollo'].includes(m)), every.join(','))
t('the user-addressable list ends at apollo after sovereign and flow', permissions.PERMISSION_MODES.join(',') === 'default,dontAsk,implement,sovereign,flow,apollo', permissions.PERMISSION_MODES.join(','))
t('sovereign alone bypasses permissions', (permissions.PERMISSION_MODES as readonly string[]).filter(m => modes.modeBypassesPermissions(m as never)).join(',') === 'sovereign')
t("'autopilot' is a string the mode reader turns into default, like any unknown word", modes.permissionModeFromString('autopilot') === 'default' && modes.permissionModeFromString('frobnicate') === 'default')

console.log('— the Shift+Tab cycle ends at sovereign —')
const context = (mode: string, bypass: boolean): never => ({ mode, alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: bypass }) as never
t('from sovereign the cycle returns to default (bypass available, the old opt-in set in the environment)', cycle.getNextPermissionMode(context('sovereign', true)) === 'default', String(cycle.getNextPermissionMode(context('sovereign', true))))
t('from sovereign the cycle returns to default (bypass unavailable)', cycle.getNextPermissionMode(context('sovereign', false)) === 'default')
const walked: string[] = ['default']
for (let i = 0; i < 8 && (walked.length === 1 || walked[walked.length - 1] !== 'default'); i++) {
  walked.push(cycle.getNextPermissionMode(context(walked[walked.length - 1]!, true)))
}
t('the whole cycle with bypass available visits only live modes and closes on default', walked[walked.length - 1] === 'default' && walked.slice(1, -1).every(m => (permissions.PERMISSION_MODES as readonly string[]).includes(m)), walked.join(' → '))
t('the stop before default is sovereign', walked[walked.length - 2] === 'sovereign', walked.join(' → '))
t('default → implement → apollo opens the cycle', walked[1] === 'implement' && walked[2] === 'apollo', walked.join(' → '))

console.log('— the tier tool and its rules —')
const pool = tools.getTools({ mode: 'sovereign', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: true } as never) as Array<{ name: string }>
t('no tool named SetTier is in the pool (sovereign, bypass available, the old opt-in set)', !pool.some(tool => tool.name === 'SetTier'), pool.map(tool => tool.name).filter(n => /tier/i.test(n)).join(','))
t('no capability declaration names SetTier', !('SetTier' in declarations.TOOL_CAPABILITY_DECLARATIONS))
t('no registry row names an autopilot flag', !registry.FLAG_REGISTRY.some(row => /AUTOPILOT/.test(row.env)))

console.log('— the mode band and the compact chip —')
t('the compact chip for sovereign reads sovereign · auto-approved', chip.compactModeChip('sovereign')?.text.includes('sovereign · auto-approved') === true)
t('the compact chip knows no autopilot word', chip.compactModeChip('autopilot' as never)?.text === `${modes.permissionModeSymbol('autopilot' as never)} default`, String(chip.compactModeChip('autopilot' as never)?.text))
const frameSrc = await Bun.file(join(ROOT, 'src/components/MercuryFrame.tsx')).text()
t('the mode band carries no tier readout', !/self-tier|⇅/.test(frameSrc))

console.log('— the built product: --mode autopilot is an unknown value like --mode frobnicate; an old chat opens —')
if (!existsSync(DIST)) {
  t('the bundle is built (bun run build.ts; MERCURY_PROOF_BUNDLE points elsewhere)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    t('a node binary on PATH', false)
  } else {
    const { startFixtureApi } = await import('../lib/fixtureApi.ts')
    const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
    const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.js')
    const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.js')
    const fixture = await startFixtureApi(Array.from({ length: 20 }, () => ({ kind: 'text' as const, text: 'seven' })))
    const cwd = mkdtempSync(join(tmpdir(), 'mode-cycle-cwd-'))
    const home = join(scratch, 'door-home')
    mkdirSync(home, { recursive: true })
    const env: Record<string, string> = {
      HOME: scratch,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      MERCURY_CREWS_DIR: join(scratch, 'crews'),
      MERCURY_DAP: '0',
      MERCURY_AUTOPILOT: '1',
    }
    const run = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise(resolvePromise => {
        const child = spawn(nodeBin, [DIST, 'run', ...args], { cwd, env })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.on('close', status => {
          clearTimeout(killer)
          resolvePromise({ status, stdout, stderr })
        })
      })
    const a = await run(['hello', '--mode', 'autopilot', '--format', 'text'])
    const b = await run(['hello', '--mode', 'frobnicate', '--format', 'text'])
    t('"--mode autopilot" exits as "--mode frobnicate" does (the parser\'s own exit)', a.status === b.status && a.status === 2, `${a.status} vs ${b.status}`)
    t('"--mode autopilot" writes the parser\'s own line, word for word with "--mode frobnicate"', a.stderr.replace('autopilot', 'frobnicate') === b.stderr && b.stderr.includes("option '--mode <mode>' argument 'frobnicate' is invalid"), `${a.stderr.slice(0, 200)} | ${b.stderr.slice(0, 200)}`)
    t('the parser names the live modes and no other', /Allowed choices are default, dontAsk, implement, sovereign, flow, apollo\./.test(b.stderr), b.stderr.slice(0, 300))

    const rows = await run(['hello', '--format', 'rows', '--model', 'claude-opus-4-8'])
    const init = rows.stdout.split('\n').map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } }).find(row => row?.type === 'system' && row.subtype === 'init')
    t('a run under the old opt-in lists no SetTier tool in its init row', rows.status === 0 && Array.isArray(init?.tools) && !(init!.tools as string[]).includes('SetTier'), `exit=${rows.status} tools=${JSON.stringify(init?.tools).slice(0, 200)}`)

    const sid = 'a0a0a0a0-0000-4000-8000-00000000a0a0'
    const user = { ...createUserMessage({ content: 'the first question', permissionMode: 'autopilot' as never }), sessionId: sid, cwd, parentUuid: null }
    const assistant = { ...createAssistantMessage({ content: 'the first answer' }), sessionId: sid, cwd, parentUuid: user.uuid }
    const projectDir = getProjectDir(cwd)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${sid}.jsonl`), encodeSeedTranscript([user, assistant], sid))
    const resumed = await run(['the second question', '--resume', sid, '--format', 'rows', '--model', 'claude-opus-4-8'])
    const resumedInit = resumed.stdout.split('\n').map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } }).find(row => row?.type === 'system' && row.subtype === 'init')
    t('a saved chat whose turns were recorded under autopilot opens and answers', resumed.status === 0 && resumed.stdout.includes('seven'), `exit=${resumed.status} stderr=${resumed.stderr.slice(0, 300)}`)
    t('…in the default mode', resumedInit?.permission_mode === 'default', String(resumedInit?.permission_mode))
    const history = fixture.messageRequests().map(r => JSON.stringify(r.body)).filter(body => body.includes('the second question'))
    t('…with its history intact (the first question rides the request)', history.some(body => body.includes('the first question')), `${history.length} requests carry the second question`)
    const sid2 = 'a0a0a0a0-0000-4000-8000-00000000a0a1'
    const user2 = { ...createUserMessage({ content: 'the stored question', permissionMode: 'sovereign' }), sessionId: sid2, cwd, parentUuid: null }
    const assistant2 = { ...createAssistantMessage({ content: 'the stored answer' }), sessionId: sid2, cwd, parentUuid: user2.uuid }
    writeFileSync(join(projectDir, `${sid2}.jsonl`), encodeSeedTranscript([user2, assistant2], sid2))
    const stored = await run(['the next question', '--resume', sid2, '--format', 'rows', '--model', 'claude-opus-4-8'])
    t('a saved chat whose turns were stored as sovereign (the word an earlier build wrote for its self-serve mode) opens and answers', stored.status === 0 && stored.stdout.includes('seven'), `exit=${stored.status} stderr=${stored.stderr.slice(0, 300)}`)
    t('…with its history intact', fixture.messageRequests().map(r => JSON.stringify(r.body)).some(body => body.includes('the next question') && body.includes('the stored question')))
    await fixture.close()
  }
}

console.log(failures ? '\n❌ MODE-CYCLE-ENDS-AT-SOVEREIGN RED' : '\n✅ MODE-CYCLE-ENDS-AT-SOVEREIGN GREEN')
process.exit(failures)
