#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'picker-replaced-default-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'sk-ant-picker-default-proof'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_MODEL

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail: string, fixWhere: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail} — ${fixWhere}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'
const CLOCK = String.raw`\d{2}:\d{2} \S+`

const factories = await import('../../src/engine/message-shapes/factories.js')
const { persistModelChoice } = await import('../../src/commands/model/persistModelChoice.js')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.js')
const { applyOnSeat } = await import('../../src/commands/model/picker/apply.js')
const { bindSeatVerbs } = await import('../../src/daemon/runner/boot/bindSeatVerbs.js')
const { enableConfigs } = await import('../../src/platform/settings/config.js')
const { setSessionPersistenceDisabled } = await import('../../src/boot/process-state/processState.js')
enableConfigs()
setSessionPersistenceDisabled(true)

const settingsPath = join(home, 'settings.json')
function writeSettings(model?: string): void {
  writeFileSync(settingsPath, JSON.stringify(model === undefined ? {} : { engine: { model } }))
  resetSettingsCache()
}

try {
  section('§1 modelSwitchStdoutText names the replaced default when it differs from the session model')
  {
    const fix = 'update ModelSwitchFacts and modelSwitchStdoutText in src/engine/message-shapes/factories.ts'
    const factsDiff = {
      previousModel: SONNET,
      previousDisplay: 'Sonnet 5.5',
      savedAsDefault: true,
      replacedDefaultModel: OPUS,
      replacedDefaultDisplay: 'Opus 5.5',
      model: HAIKU,
    } as Parameters<typeof factories.modelSwitchStdoutText>[1]
    const gotDiff = factories.modelSwitchStdoutText('Haiku 5.5', factsDiff)
    const wantDiff = `Model now: Haiku 5.5 · saved as your default for new sessions (it was Opus 5.5) — /model ${SONNET} switches this session back to Sonnet 5.5`
    check('replaced default differs from previous session model (no clock)', gotDiff === wantDiff, `got=${JSON.stringify(gotDiff)}`, fix)

    const gotDiffClock = factories.modelSwitchStdoutText('Haiku 5.5', { ...factsDiff!, at: '00:57 GMT' } as Parameters<typeof factories.modelSwitchStdoutText>[1])
    const wantDiffClock = `Model now: Haiku 5.5 · 00:57 GMT · saved as your default for new sessions (it was Opus 5.5) — /model ${SONNET} switches this session back to Sonnet 5.5`
    check('replaced default differs from previous session model (with clock)', gotDiffClock === wantDiffClock, `got=${JSON.stringify(gotDiffClock)}`, fix)

    const trail = factories.createModelSwitchBreadcrumbs(HAIKU, 'Haiku 5.5', factsDiff)
    check('createModelSwitchBreadcrumbs carries the ruled line on the virtual stdout row', trail.length === 3 && trail[2]!.isVirtual === true && String(trail[2]!.message.content) === `<local-command-stdout>${wantDiff}</local-command-stdout>`, `got=${JSON.stringify(trail[2]?.message.content)}`, fix)

    const sameLine = `Model now: Haiku 5.5 · saved as your default for new sessions — /model ${SONNET} switches back to Sonnet 5.5`
    const gotSame = factories.modelSwitchStdoutText('Haiku 5.5', {
      previousModel: SONNET,
      previousDisplay: 'Sonnet 5.5',
      savedAsDefault: true,
      replacedDefaultModel: SONNET,
      replacedDefaultDisplay: 'Sonnet 5.5',
      model: HAIKU,
    } as Parameters<typeof factories.modelSwitchStdoutText>[1])
    check('replaced default equals previous session model ⇒ unchanged byte for byte', gotSame === sameLine, `got=${JSON.stringify(gotSame)}`, fix)

    const gotNone = factories.modelSwitchStdoutText('Haiku 5.5', {
      previousModel: SONNET,
      previousDisplay: 'Sonnet 5.5',
      savedAsDefault: true,
      model: HAIKU,
    })
    check('no prior saved default ⇒ unchanged byte for byte', gotNone === sameLine, `got=${JSON.stringify(gotNone)}`, fix)

    const gotAlreadyDefault = factories.modelSwitchStdoutText('Haiku 5.5', {
      previousModel: SONNET,
      previousDisplay: 'Sonnet 5.5',
      savedAsDefault: true,
      replacedDefaultModel: HAIKU,
      replacedDefaultDisplay: 'Haiku 5.5',
      model: HAIKU,
    } as Parameters<typeof factories.modelSwitchStdoutText>[1])
    check('pick already was the saved default ⇒ unchanged byte for byte', gotAlreadyDefault === sameLine, `got=${JSON.stringify(gotAlreadyDefault)}`, fix)

    const chatOnlyLine = `Model now: Haiku 5.5 · for this chat only — /model ${SONNET} switches back to Sonnet 5.5`
    const gotChatOnly = factories.modelSwitchStdoutText('Haiku 5.5', {
      previousModel: SONNET,
      previousDisplay: 'Sonnet 5.5',
      savedAsDefault: false,
      replacedDefaultModel: OPUS,
      replacedDefaultDisplay: 'Opus 5.5',
      model: HAIKU,
    } as Parameters<typeof factories.modelSwitchStdoutText>[1])
    check('chat-only switch never claims a replaced default ⇒ unchanged byte for byte', gotChatOnly === chatOnlyLine, `got=${JSON.stringify(gotChatOnly)}`, fix)
  }

  section('§2 persistModelChoice reports the replaced saved default')
  {
    const fix = 'return replacedDefault from persistModelChoice in src/commands/model/persistModelChoice.ts'
    writeSettings(OPUS)
    const c1 = persistModelChoice(HAIKU) as { outcome: string; replacedDefault?: string | null }
    check('overwriting Opus 5.5 with Haiku 5.5 reports replacedDefault claude-opus-5-5', c1.outcome === 'saved' && c1.replacedDefault === OPUS, JSON.stringify(c1), fix)

    writeSettings('opus55')
    const c2 = persistModelChoice(HAIKU) as { outcome: string; replacedDefault?: string | null }
    check('overwriting alias opus55 normalizes replacedDefault to claude-opus-5-5', c2.outcome === 'saved' && c2.replacedDefault === OPUS, JSON.stringify(c2), fix)

    writeSettings(HAIKU)
    const c3 = persistModelChoice(HAIKU) as { outcome: string; replacedDefault?: string | null }
    check('picking the model already saved as default reports replacedDefault null', c3.outcome === 'saved' && c3.replacedDefault === null, JSON.stringify(c3), fix)

    writeSettings(undefined)
    const c4 = persistModelChoice(HAIKU) as { outcome: string; replacedDefault?: string | null }
    check('writing a first default when none was saved reports replacedDefault null', c4.outcome === 'saved' && c4.replacedDefault === null, JSON.stringify(c4), fix)
  }

  section('§3 picker applyOnSeat → setModel → bindSeatVerbs end-to-end')
  {
    const fix = 'forward choice.replacedDefault from src/commands/model/picker/apply.ts through setModel and bindSeatVerbs (src/daemon/runner/boot/bindSeatVerbs.ts)'
    async function runPickerPick(savedBefore: string, sessionModel: string, picked: string): Promise<{ forwarded: string | undefined; row: string }> {
      writeSettings(savedBefore)
      let forwarded: string | undefined
      const rows: string[] = []
      const ports = {
        enqueueRow: (row: { text?: string }) => { if (typeof row.text === 'string') rows.push(row.text) },
        live: { activeModel: sessionModel },
        liveScope: () => ({ sessionId: '00000000-0000-4000-8000-000000000010' }),
        messages: [],
        modelInfos: [
          { value: OPUS, display_name: 'Opus 5.5' },
          { value: SONNET, display_name: 'Sonnet 5.5' },
          { value: HAIKU, display_name: 'Haiku 5.5' },
        ],
        setAppState: () => {},
      }
      const seatVerbs = (await bindSeatVerbs.run(ports as never)) as { applySeatModel: (model: string, words?: string, replacedDefault?: string) => Promise<void> }
      const done = new Promise<void>(resolve => {
        const focused = {
          modelFacts: () => ({ effective: sessionModel, main: sessionModel, setting: sessionModel, sessionPin: sessionModel, pendingSwitch: null }),
          records: () => [],
          setModel: async (setting: string | null, words?: string, replacedDefault?: string) => {
            forwarded = replacedDefault
            resetSettingsCache()
            await seatVerbs.applySeatModel(String(setting), words, replacedDefault)
            return { state: 'applied' as const }
          },
        }
        applyOnSeat(
          {
            onDone: () => resolve(),
            labelOf: () => 'Haiku 5.5',
            flipDoorNote: () => '',
          } as never,
          focused as never,
          picked,
          picked,
          { kind: 'model' } as never,
        )
      })
      await done
      return { forwarded, row: rows[0] ?? '' }
    }

    const thirdDefault = await runPickerPick(OPUS, SONNET, HAIKU)
    check('picker forwards replacedDefault claude-opus-5-5 to focused.setModel', thirdDefault.forwarded === OPUS, `forwarded=${JSON.stringify(thirdDefault.forwarded)}`, fix)
    const wantThirdRe = new RegExp(`^<local-command-stdout>Model now: Haiku 5\\.5 · ${CLOCK} · saved as your default for new sessions \\(it was Opus 5\\.5\\) — /model ${SONNET} switches this session back to Sonnet 5\\.5</local-command-stdout>$`)
    check('runner breadcrumb names replaced default (it was Opus 5.5) and says switches this session back to Sonnet 5.5', wantThirdRe.test(thirdDefault.row), `row=${JSON.stringify(thirdDefault.row)}`, fix)

    const sameDefault = await runPickerPick(SONNET, SONNET, HAIKU)
    const wantSameRe = new RegExp(`^<local-command-stdout>Model now: Haiku 5\\.5 · ${CLOCK} · saved as your default for new sessions — /model ${SONNET} switches back to Sonnet 5\\.5</local-command-stdout>$`)
    check('when replaced default IS the session model, runner breadcrumb is unchanged byte for byte', wantSameRe.test(sameDefault.row), `row=${JSON.stringify(sameDefault.row)}`, fix)
  }
} finally {
  removeScratch(scratch)
}

console.log(`\nprove-picker-names-replaced-default: ${checks - failures}/${checks} PASS`)
process.exit(failures === 0 ? 0 : 1)
