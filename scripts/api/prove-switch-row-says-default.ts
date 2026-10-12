#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of ['MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'MERCURY_THINKING_BINDING', 'MERCURY_WIRE_DUMP', 'MERCURY_SPAWNED_ENV']) {
  delete process.env[ambient]
}
const pureHome = mkdtempSync(join(tmpdir(), 'switch-row-pure-'))
process.env.MERCURY_CONFIG_DIR = pureHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.ANTHROPIC_BASE_URL

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { answerOf, isOutcome, type Frame } from '../lib/rows.ts'
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
const SONNET = 'claude-sonnet-5-5'
const SID = 'c0ffee00-0000-4000-8000-00000000a1e7'
const SAVED_ROW = `Model now: Sonnet 5.5 · saved as your default for new sessions — /model ${FABLE} switches back to Fable 5.1`
const CHAT_ONLY_ROW = `Model now: Opus 5 · for this chat only — /model ${SONNET} switches back to Sonnet 5.5`
const ROOT = join(import.meta.dir, '..', '..')
const SRC = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

section('§1 the row\'s words, the restore of a refused save, and the cockpit writing the default before the door')
{
  const factories = (await import('../../src/utils/messages/factories.ts')) as typeof import('../../src/utils/messages/factories.ts') & { modelSwitchStdoutText?: (display: string, facts?: { previousModel: string; previousDisplay: string; savedAsDefault: boolean }) => string }
  const words = factories.modelSwitchStdoutText
  check('the switch row has a words owner (RED on the base: absent)', typeof words === 'function')
  check('without the switch facts the row keeps its shipped shape (the recorded goldens stand)', words?.('Sonnet 5.5') === 'Model now: Sonnet 5.5', words?.('Sonnet 5.5'))
  check('saved as the default: the row says so, for new sessions, and names the way back by id and name', words?.('Sonnet 5.5', { previousModel: FABLE, previousDisplay: 'Fable 5.1', savedAsDefault: true }) === SAVED_ROW, words?.('Sonnet 5.5', { previousModel: FABLE, previousDisplay: 'Fable 5.1', savedAsDefault: true }))
  check('not saved: the row says this chat only and still names the way back', words?.('Opus 5', { previousModel: SONNET, previousDisplay: 'Sonnet 5.5', savedAsDefault: false }) === CHAT_ONLY_ROW, words?.('Opus 5', { previousModel: SONNET, previousDisplay: 'Sonnet 5.5', savedAsDefault: false }))
  const trail = (factories.createModelSwitchBreadcrumbs as (a: string, b: string, c?: unknown) => Array<{ isVirtual?: boolean; message: { content: unknown } }>)(SONNET, 'Sonnet 5.5', { previousModel: FABLE, previousDisplay: 'Fable 5.1', savedAsDefault: true })
  check('the breadcrumb trail\'s stdout row carries the words and stays a display-only row the model never reads', trail.length === 3 && trail[2]!.isVirtual === true && String(trail[2]!.message.content).includes(SAVED_ROW), j(trail[2]?.message.content))
  const plain = (factories.createModelSwitchBreadcrumbs as (a: string, b: string) => Array<{ message: { content: unknown } }>)(SONNET, 'Sonnet 5.5')
  check('the two-argument trail is byte-identical to the shipped one', String(plain[2]!.message.content) === '<local-command-stdout>Model now: Sonnet 5.5</local-command-stdout>', j(plain[2]?.message.content))

  writeFileSync(join(pureHome, 'settings.json'), JSON.stringify({ engine: { model: FABLE } }))
  const { persistModelChoice } = await import('../../src/commands/model/persistModelChoice.ts')
  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  resetSettingsCache()
  const choice = persistModelChoice(SONNET) as { outcome: string; sentence: string; restore?: () => void }
  const written = JSON.parse(readFileSync(join(pureHome, 'settings.json'), 'utf8')) as { engine?: { model?: string } }
  check('persisting a choice writes it as the default and says so', choice.outcome === 'saved' && written.engine?.model === SONNET, j({ choice, written }))
  check('the choice carries a restore for a refused switch (RED on the base: none)', typeof choice.restore === 'function')
  choice.restore?.()
  const restored = JSON.parse(readFileSync(join(pureHome, 'settings.json'), 'utf8')) as { engine?: { model?: string } }
  check('restore puts the previous default back', restored.engine?.model === FABLE, j(restored))
  resetSettingsCache()
  const same = persistModelChoice(FABLE) as { restore?: () => void }
  writeFileSync(join(pureHome, 'settings.json'), JSON.stringify({ engine: { model: OPUS } }))
  same.restore?.()
  check('a choice that changed nothing restores nothing', (JSON.parse(readFileSync(join(pureHome, 'settings.json'), 'utf8')) as { engine?: { model?: string } }).engine?.model === OPUS)

  const roads: Array<[string, string]> = [
    ['src/commands/model/mercuryModel.tsx', 'function applySelection'],
    ['src/commands/model/model.tsx', 'const applyNow'],
    ['src/components/PromptInput/useComposerModelDoors.tsx', 'const applyModelSelection'],
  ]
  for (const [path, road] of roads) {
    const src = SRC(path)
    const roadAt = src.indexOf(road)
    const doorAt = src.indexOf('.setModel(', roadAt)
    const persistAt = src.lastIndexOf('persistModelChoice(', doorAt)
    check(`${path}: the daemon road writes the default BEFORE the door, so the runner's row can read it (RED on the base: after the receipt)`, roadAt !== -1 && doorAt !== -1 && persistAt > roadAt, j({ roadAt, doorAt, persistAt }))
    check(`${path}: a refused switch restores the default`, src.indexOf('.restore()', doorAt) !== -1 && src.indexOf('.restore()', doorAt) < src.indexOf('no-op', doorAt), '')
  }
}

const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    section('§2 the session runner — the lasting row says whether the switch became the default and how to go back')
    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'SR-F1', model: FABLE },
      { kind: 'text', text: 'SR-S1', model: SONNET },
      { kind: 'text', text: 'SR-O1', model: OPUS },
    ]
    const fixture = await startFixtureApi(turns, { apiChecks: true })
    const home = mkdtempSync(join(tmpdir(), 'switch-row-home-'))
    const cwd = mkdtempSync(join(tmpdir(), 'switch-row-cwd-'))
    mkdirSync(join(home, '.mercury'), { recursive: true })
    const settingsPath = join(home, '.mercury', 'settings.json')
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
    const host = hostRunner({ node: nodeBin, dist: DIST, argv: ['--model', FABLE, '--allowed-tools', 'Read', '--session-id', SID], cwd, env, home: env.MERCURY_CONFIG_DIR })
    const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
    let turnsSent = 0
    const turn = async (prompt: string, marker: string): Promise<void> => {
      const ordinal = ++turnsSent
      await host.prompt(prompt)
      await host.waitFor(`turn ${ordinal} ("${prompt}") settled on the fixture's ${marker}`, row => isOutcome(row) && row.turn === ordinal && answerOf(row).includes(marker), 60_000)
    }
    let error = ''
    try {
      await host.initialize({})
      await turn('first on fable', 'SR-F1')
      writeFileSync(settingsPath, JSON.stringify({ engine: { model: SONNET } }))
      await host.request('session/set_model', { model: SONNET })
      await turn('now on sonnet', 'SR-S1')
      await host.request('session/set_model', { model: OPUS })
      await turn('now on opus', 'SR-O1')
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    }
    check('the three turns settled across two switches', error === '', error || host.stderr().slice(-600))
    const outputs = host.rows.filter((row: Frame) => row.type === 'command_output').map((row: Frame) => String(row.text ?? ''))
    check('the first switch, saved as the default by the cockpit before the door, paints a row that says so and names the way back (RED on the base: "Model now: Sonnet 5.5" alone)', outputs.some(text => text.includes(SAVED_ROW)), j(outputs))
    check('the second switch, not saved, paints a row that says this chat only and names the way back', outputs.some(text => text.includes(CHAT_ONLY_ROW)), j(outputs))
    check('no row still carries the bare shipped shape', !outputs.some(text => /Model now: [^·]+<\/local-command-stdout>/.test(text) || /Model now: [^·\n]+$/.test(text)), j(outputs))
    const walk = (dir: string): string[] => {
      const out: string[] = []
      if (!existsSync(dir)) return out
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (entry.name === `${SID}.jsonl`) out.push(full)
      }
      return out
    }
    const recorded = walk(join(home, '.mercury', 'projects')).flatMap(file => readFileSync(file, 'utf8').split('\n'))
    check('the session file keeps both rows, so a resumed chat still shows them', recorded.some(line => line.includes(SAVED_ROW)) && recorded.some(line => line.includes(CHAT_ONLY_ROW)), j(recorded.filter(line => line.includes('Model now')).map(line => line.slice(0, 200))))
    const requests = fixture.messageRequests().map(r => r.body as { messages?: Array<{ content?: unknown }> })
    const wire = JSON.stringify(requests.slice(1))
    check('the rows never reach the model (the switch stays invisible to it)', !wire.includes('Model now:'), wire.slice(0, 200))
    clearTimeout(killer)
    await host.stop(5_000).catch(() => null)
    await fixture.close()
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
