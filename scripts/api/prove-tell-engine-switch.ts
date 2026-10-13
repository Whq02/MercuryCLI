#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of ['MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'MERCURY_THINKING_BINDING', 'MERCURY_WIRE_DUMP']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tell-engine-switch-pure-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { answerOf, isOutcome } from '../lib/rows.ts'
import { hostRunner } from '../lib/runnerHost.ts'

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const FABLE = 'claude-fable-5-1'
const OPUS = 'claude-opus-5'
const NOTICE_MARK = 'The engine running this seat changed at '
const CAVEAT_MARK = '<local-command-caveat>'
const MODEL_COMMAND_MARK = '<command-name>/model</command-name>'
const STDOUT_MARK = 'Model now:'

const textsOf = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap(block => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []))
}

section('§1 the setting and the line')
{
  const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
  const schemaDef = SettingsSchema() as { def?: { shape?: Record<string, { def?: { innerType?: { def?: { shape?: Record<string, unknown> } } } }> } }
  const memoryInner = schemaDef.def?.shape?.memory?.def?.innerType
  const memoryShape = (memoryInner as { def?: { shape?: Record<string, unknown> } } | undefined)?.def?.shape ?? (memoryInner as { shape?: Record<string, unknown> } | undefined)?.shape
  check('memory.tellEngineSwitch is a declared boolean setting (RED on the base: absent)', memoryShape !== undefined && typeof memoryShape.tellEngineSwitch !== 'undefined', j(Object.keys(memoryShape ?? {})))
  const parsed = SettingsSchema().parse({ memory: { enabled: true } }) as { memory?: { tellEngineSwitch?: boolean } }
  check('absent, the setting parses to absence (the default is off)', parsed.memory?.tellEngineSwitch === undefined)
  check('it accepts true and false and refuses a word', SettingsSchema().safeParse({ memory: { tellEngineSwitch: true } }).success && SettingsSchema().safeParse({ memory: { tellEngineSwitch: false } }).success && !SettingsSchema().safeParse({ memory: { tellEngineSwitch: 'yes' } }).success)
  const schema = JSON.parse(readFileSync(join(import.meta.dir, '..', 'settings', 'settings-schema.json'), 'utf8')) as { properties?: { memory?: { properties?: Record<string, { description?: string; type?: string }> } } }
  const row = schema.properties?.memory?.properties?.tellEngineSwitch
  check('the committed settings schema carries the key with its help text', row?.type === 'boolean' && (row.description ?? '').includes('invisible to the model') && (row.description ?? '').includes('mercury://seat'), j(row))
  const factories = (await import('../../src/utils/messages/factories.ts')) as { createEngineSwitchNotice?: (modelId: string, display: string, at: string) => { isMeta?: true; isVirtual?: true; message: { content: unknown } }; engineSwitchNoticeText?: (modelId: string, display: string, at: string) => string }
  const at = '2026-10-11T02:40:00.000Z'
  const notice = factories.createEngineSwitchNotice?.(OPUS, 'Opus 5', at)
  check('the line is one model-visible meta row naming the new engine, its name and the time it was given (RED on the base: no such row)', notice !== undefined && notice.isMeta === true && notice.isVirtual === undefined && notice.message.content === `${NOTICE_MARK}${at}: it is now \`${OPUS}\` (Opus 5). The replies above this line were written by the engine before it. When repeating a switch time to the user, say the time with its zone as the seat page gives it.`, j(notice?.message.content))
  const unnamed = factories.engineSwitchNoticeText?.('some-server/qwen3-32b', 'some-server/qwen3-32b', at) ?? ''
  check('an engine with no known name is named by its id alone', unnamed.includes('`some-server/qwen3-32b`') && !unnamed.includes('('), unnamed)
}

const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    type Body = { model?: string; messages?: Array<{ role?: string; content?: unknown }> }
    const drive = async (label: string, settings: Record<string, unknown> | null, sid: string): Promise<{ second: string[]; recorded: string[]; error: string }> => {
      const turns: ScriptedTurn[] = [
        { kind: 'text', text: 'TE-F1', model: FABLE },
        { kind: 'text', text: 'TE-O1', model: OPUS },
      ]
      const fixture: FixtureApi = await startFixtureApi(turns, { apiChecks: true })
      const home = mkdtempSync(join(tmpdir(), `tell-engine-switch-${label}-home-`))
      const cwd = mkdtempSync(join(tmpdir(), `tell-engine-switch-${label}-cwd-`))
      mkdirSync(join(home, '.mercury'), { recursive: true })
      if (settings !== null) writeFileSync(join(home, '.mercury', 'settings.json'), JSON.stringify(settings))
      const env = {
        HOME: home,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TERM: 'dumb',
        MERCURY_CONFIG_DIR: join(home, '.mercury'),
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        ANTHROPIC_BASE_URL: fixture.url,
        ANTHROPIC_API_KEY: 'fixture-key-000',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
      }
      const host = hostRunner({ node: nodeBin, dist: DIST, argv: ['--model', FABLE, '--allowed-tools', 'Read', '--session-id', sid], cwd, env, home: env.MERCURY_CONFIG_DIR })
      const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
      let turnsSent = 0
      const turn = async (prompt: string, marker: string): Promise<void> => {
        const ordinal = ++turnsSent
        await host.prompt(prompt)
        await host.waitFor(`${label}: turn ${ordinal} ("${prompt}") settled on the fixture's ${marker}`, row => isOutcome(row) && row.turn === ordinal && answerOf(row).includes(marker), 60_000)
      }
      let error = ''
      try {
        await host.initialize({})
        await turn('first on fable', 'TE-F1')
        await host.request('session/set_model', { model: OPUS })
        await turn('and now?', 'TE-O1')
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown)
      }
      const second = ((fixture.messageRequests()[1]?.body as Body | undefined)?.messages ?? []).flatMap(m => textsOf(m.content))
      const walk = (dir: string): string[] => {
        const out: string[] = []
        if (!existsSync(dir)) return out
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) out.push(...walk(full))
          else if (entry.name === `${sid}.jsonl`) out.push(full)
        }
        return out
      }
      const recorded = walk(join(home, '.mercury', 'projects')).flatMap(file => readFileSync(file, 'utf8').split('\n'))
      clearTimeout(killer)
      await host.stop(5_000).catch(() => null)
      await fixture.close()
      return { second, recorded, error }
    }

    section('§2 the setting off (the default) — a switch is invisible: no line, no /model rows')
    {
      const off = await drive('off', null, 'c0ffee00-0000-4000-8000-00000000a1f6')
      check('the two turns settled', off.error === '', off.error)
      check('the request after the switch carries no engine notice and none of the three /model rows', !off.second.some(text => text.includes(NOTICE_MARK) || text.includes(CAVEAT_MARK) || text.includes(MODEL_COMMAND_MARK) || text.includes(STDOUT_MARK)), j(off.second))
      check('the session file carries no engine notice either', !off.recorded.some(line => line.includes(NOTICE_MARK)))
    }

    section('§3 the setting on — one line reaches the model at the switch; the /model rows still do not')
    {
      const on = await drive('on', { memory: { tellEngineSwitch: true } }, 'c0ffee00-0000-4000-8000-00000000a1f7')
      check('the two turns settled', on.error === '', on.error)
      const notices = on.second.filter(text => text.includes(NOTICE_MARK))
      check('exactly one engine notice rides the request after the switch (RED on the base: the setting did not exist)', notices.length === 1, j(on.second))
      check('…naming the new engine and a clock time in ISO form', notices[0] !== undefined && notices[0].includes(`it is now \`${OPUS}\``) && /changed at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z:/.test(notices[0]), notices[0])
      check('…and still none of the three /model rows', !on.second.some(text => text.includes(CAVEAT_MARK) || text.includes(MODEL_COMMAND_MARK) || text.includes(STDOUT_MARK)), j(on.second))
      check('the operator\'s prompt rides after the notice', on.second.findIndex(text => text.includes(NOTICE_MARK)) < on.second.findIndex(text => text.includes('and now?')), j(on.second))
      const recordedNotices = on.recorded.filter(line => line.includes(NOTICE_MARK))
      check('the session file records the notice as a meta row (a resume keeps telling the model)', recordedNotices.length === 1 && /"isMeta":\s*true/.test(recordedNotices[0]!), recordedNotices[0]?.slice(0, 300))
    }
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
