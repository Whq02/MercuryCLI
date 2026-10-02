#!/usr/bin/env bun
// gate-watch: src/types/permissions.ts src/utils/permissions/PermissionMode.ts src/utils/permissions/PermissionUpdateSchema.ts
// gate-watch: src/utils/settings/types.ts src/daemon/headlessRun.ts src/services/agents/codec.ts
// gate-watch: src/main.tsx src/utils/conversationRecovery.ts src/services/acp/acpServer.ts src/tools/AgentTool/AgentTool.tsx
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.NODE_ENV = 'test'
const scratch = mkdtempSync(join(tmpdir(), 'mode-words-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'door-home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SKIP_PERMISSIONS
delete process.env.MERCURY_DAEMON_PERMISSION_MODE
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_BUNDLE ?? join(ROOT, 'dist', 'mercury.mjs')
const WORDS = ['acceptEdits', 'bypassPermissions', 'plan', 'auto'] as const
const CONTROL = 'frobnicate'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}
const swap = (text: string, word: string): string => text.split(word).join(CONTROL)
const issues = (result: { success: boolean; error?: { issues: unknown[] } }): string =>
  result.success ? 'accepted' : JSON.stringify(result.error?.issues.map(issue => ({ ...(issue as Record<string, unknown>), message: String((issue as { message?: unknown }).message) })))

const vocab = await import('../../src/types/permissions.js')
const modes = await import('../../src/utils/permissions/PermissionMode.js')
const updates = await import('../../src/utils/permissions/PermissionUpdateSchema.js')
const settings = await import('../../src/utils/settings/types.js')
const daemon = await import('../../src/daemon/headlessRun.js')
const codec = await import('../../src/services/agents/codec.js')

console.log('— the vocabulary: one mode list, no second spelling of any mode —')
t('the vocabulary module exports no spelling table and no decoder', !('RETIRED_PERMISSION_MODE_SPELLINGS' in vocab) && !('decodePermissionModeSpelling' in vocab) && !('RETIRED_PERMISSION_MODE_SPELLINGS' in modes) && !('decodePermissionModeSpelling' in modes))
for (const word of WORDS) {
  t(`'${word}' is in no mode list`, !([...vocab.PERMISSION_MODES, ...vocab.INTERNAL_PERMISSION_MODES, ...vocab.EXTERNAL_PERMISSION_MODES] as readonly string[]).includes(word))
}

console.log(`— the readers answer '${CONTROL}' and each old word alike —`)
for (const word of WORDS) {
  t(`fromString('${word}') is fromString('${CONTROL}')`, modes.permissionModeFromString(word) === modes.permissionModeFromString(CONTROL) && modes.permissionModeFromString(CONTROL) === 'default', modes.permissionModeFromString(word))
  t(`the mode schema refuses '${word}' with the words it has for '${CONTROL}'`, swap(issues(modes.permissionModeSchema().safeParse(word)), word) === issues(modes.permissionModeSchema().safeParse(CONTROL)) && !modes.permissionModeSchema().safeParse(word).success, issues(modes.permissionModeSchema().safeParse(word)))
  t(`the external mode schema refuses '${word}' the same way`, swap(issues(modes.externalPermissionModeSchema().safeParse(word)), word) === issues(modes.externalPermissionModeSchema().safeParse(CONTROL)) && !modes.externalPermissionModeSchema().safeParse(word).success)
  const update = (mode: string) => updates.permissionUpdateSchema().safeParse({ type: 'setMode', mode, destination: 'session' })
  t(`a setMode update carrying '${word}' is refused as one carrying '${CONTROL}'`, swap(issues(update(word)), word) === issues(update(CONTROL)) && !update(word).success, issues(update(word)))
  const file = (mode: string) => settings.SettingsSchema().safeParse({ guardrails: { mode } })
  t(`a settings file with guardrails.mode '${word}' is refused as one with '${CONTROL}'`, swap(issues(file(word)), word) === issues(file(CONTROL)) && !file(word).success, issues(file(word)))
  process.env.MERCURY_DAEMON_PERMISSION_MODE = word
  const fromEnv = daemon.getHeadlessPermissionMode()
  process.env.MERCURY_DAEMON_PERMISSION_MODE = CONTROL
  t(`the daemon's mode variable set to '${word}' reads as set to '${CONTROL}' (the fallback)`, fromEnv === daemon.getHeadlessPermissionMode() && fromEnv === daemon.HEADLESS_PERMISSION_MODE_DEFAULT, fromEnv)
  delete process.env.MERCURY_DAEMON_PERMISSION_MODE
  const agent = (mode: string) => codec.decodeAgentDocument(`---\nname: proof-agent\ndescription: a proof agent\npermissionMode: ${mode}\n---\nbody\n`)
  t(`an agent file with permissionMode '${word}' decodes as one with '${CONTROL}'`, agent(word).fields.permissionMode === undefined && swap(JSON.stringify(agent(word).diagnostics), word) === JSON.stringify(agent(CONTROL).diagnostics) && agent(CONTROL).diagnostics.length === 1, JSON.stringify(agent(word).diagnostics))
}

console.log(`— the built product: --mode <old word> is --mode ${CONTROL}; a saved chat under an old word opens in default —`)
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
    const cwd = mkdtempSync(join(tmpdir(), 'mode-words-cwd-'))
    const home = join(scratch, 'door-home')
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
    const control = await run(['hello', '--mode', CONTROL, '--format', 'text'])
    t(`"--mode ${CONTROL}" is the parser's own refusal (exit 2)`, control.status === 2 && control.stderr.includes(`option '--mode <mode>' argument '${CONTROL}' is invalid`), `${control.status} ${control.stderr.slice(0, 200)}`)
    t('the parser names the live modes and no other', /Allowed choices are default, dontAsk, implement, sovereign, flow, apollo\./.test(control.stderr), control.stderr.slice(0, 300))
    for (const word of WORDS) {
      const typed = await run(['hello', '--mode', word, '--format', 'text'])
      t(`"--mode ${word}" exits as "--mode ${CONTROL}" does`, typed.status === control.status, `${typed.status} vs ${control.status}`)
      t(`"--mode ${word}" writes the parser's line, word for word with "--mode ${CONTROL}"`, swap(typed.stderr, word) === control.stderr && typed.stdout === control.stdout, `${typed.stderr.slice(0, 200)} | ${control.stderr.slice(0, 200)}`)
    }
    const projectDir = getProjectDir(cwd)
    mkdirSync(projectDir, { recursive: true })
    const init = (stdout: string): Record<string, unknown> | undefined => stdout.split('\n').map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } }).find(row => row?.type === 'system' && row.subtype === 'init') ?? undefined
    for (const [index, word] of WORDS.entries()) {
      const sid = `b1b1b1b1-0000-4000-8000-00000000b1b${index}`
      const user = { ...createUserMessage({ content: `the first question under ${word}`, permissionMode: word as never }), sessionId: sid, cwd, parentUuid: null }
      const assistant = { ...createAssistantMessage({ content: 'the first answer' }), sessionId: sid, cwd, parentUuid: user.uuid }
      writeFileSync(join(projectDir, `${sid}.jsonl`), encodeSeedTranscript([user, assistant], sid))
      const resumed = await run(['the second question', '--resume', sid, '--format', 'rows', '--model', 'claude-opus-4-8'])
      t(`a saved chat recorded under '${word}' opens and answers`, resumed.status === 0 && resumed.stdout.includes('seven'), `exit=${resumed.status} stderr=${resumed.stderr.slice(0, 300)}`)
      t(`…in the default mode`, init(resumed.stdout)?.permission_mode === 'default', String(init(resumed.stdout)?.permission_mode))
      const history = fixture.messageRequests().map(r => JSON.stringify(r.body)).filter(body => body.includes('the second question'))
      t(`…with its history intact`, history.some(body => body.includes(`the first question under ${word}`)), `${history.length} requests carry the second question`)
    }
    await fixture.close()
  }
}

console.log(failures ? '\n❌ RETIRED-MODE-WORDS-UNKNOWN RED' : '\n✅ RETIRED-MODE-WORDS-UNKNOWN GREEN')
process.exit(failures)
