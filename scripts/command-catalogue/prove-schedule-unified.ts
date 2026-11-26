#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
const EXPECTED_DESC = 'Schedules (Saturn): the board; with words, schedules it'
const EXPECTED_HINT = '[what and when]'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'schedule-unified-')))
const home = join(scratch, 'home')
const cwd = join(scratch, 'proj')
mkdirSync(home, { recursive: true })
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = FIXTURE_API_KEY
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SATURN_DISABLE

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { initBundledSkills } = await import('../../src/integrations/skills/bundled/index.ts')
const { builtinCommands, clearCommandsCache, findCommand, getCommands, getSkillToolCommands, getSlashCommandToolSkills } = await import('../../src/commands/catalogue/commands.ts')
const { getInMemoryErrors } = await import('../../src/platform/logs/errorLog.ts')
const { applyProcessSessionKitEdit, _resetSessionKitPinForTesting } = await import('../../src/integrations/mcp/sessionKitPin.ts')
const { effectiveCatalogue } = await import('../../src/commands/catalogue/effectiveCatalogue.ts')
const { SkillTool } = await import('../../src/tools/skill/SkillTool.ts')
const { getSkillListingAttachments, resetSentSkillNames } = await import('../../src/engine/attachment-shapes/skillListing.ts')
const { SATURN_BOARD_COMMAND, buildCronCreatePrompt } = await import('../../src/tools/cron/prompt.ts')
const { loopPromptForInput } = await import('../../src/integrations/skills/bundled/loop.ts')
const { saturnSection } = await import('../../src/screen/cockpit-gauges/helm-lanes-model/sections.ts')

initBundledSkills()
clearCommandsCache()

try {
  console.log('§1 catalogue, command list and Skill tool roster')
  const builtins = [...builtinCommands()]
  const builtinSchedule = builtins.filter(c => c.name === 'schedule')
  const builtinSaturn = builtins.filter(c => c.name === 'saturn' || (c.aliases ?? []).includes('saturn'))
  check(
    'builtinCommands holds one /schedule local-jsx command with exact description and argumentHint',
    builtinSchedule.length === 1 &&
      builtinSchedule[0]!.type === 'local-jsx' &&
      builtinSchedule[0]!.description === EXPECTED_DESC &&
      builtinSchedule[0]!.argumentHint === EXPECTED_HINT &&
      (builtinSchedule[0]!.aliases ?? []).length === 0,
    `${JSON.stringify(builtinSchedule.map(c => ({ name: c.name, type: c.type, description: c.description, argumentHint: c.argumentHint, aliases: c.aliases })))} — set name, description and argumentHint in src/commands/saturn/index.ts`,
  )
  check(
    'builtinCommands holds no saturn command or alias',
    builtinSaturn.length === 0,
    `${JSON.stringify(builtinSaturn.map(c => c.name))} — remove saturn from src/commands/saturn/index.ts`,
  )

  const roster = await getCommands(cwd)
  const rosterSchedule = roster.filter(c => c.name === 'schedule')
  const rosterSaturn = roster.filter(c => c.name === 'saturn' || (c.aliases ?? []).includes('saturn'))
  check(
    'getCommands shows ONE /schedule row (the built-in board/words command) and no /saturn row',
    rosterSchedule.length === 1 &&
      rosterSchedule[0]!.type === 'local-jsx' &&
      rosterSchedule[0]!.description === EXPECTED_DESC &&
      rosterSchedule[0]!.argumentHint === EXPECTED_HINT &&
      rosterSaturn.length === 0,
    `schedule=${JSON.stringify(rosterSchedule.map(c => ({ type: c.type, source: c.source, desc: c.description, hint: c.argumentHint })))} saturn=${rosterSaturn.length} — let built-in /schedule own the command list in loadAllCommands (src/commands/catalogue/commands.ts)`,
  )

  const surfaces = effectiveCatalogue()
  const surfaceSchedule = surfaces.find(s => s.name === 'schedule')
  check(
    'effectiveCatalogue lists /schedule in crew & delegation with exact description and no saturn surface',
    surfaceSchedule !== undefined &&
      surfaceSchedule.category === 'crew' &&
      surfaceSchedule.description === EXPECTED_DESC &&
      surfaces.every(s => s.name !== 'saturn' && !s.aliases.includes('saturn')),
    `${JSON.stringify(surfaceSchedule)} — update COMMAND_DOMAINS in src/screen/help/commandDomains.ts and src/commands/saturn/index.ts`,
  )

  const errsBefore = getInMemoryErrors().length
  const skillCommands = await getSkillToolCommands(cwd)
  const slashSkills = await getSlashCommandToolSkills(cwd)
  applyProcessSessionKitEdit({ skills: [{ name: 'loop', state: 'on' }] }, [])
  try {
    await getCommands(cwd)
  } finally {
    _resetSessionKitPinForTesting()
  }
  const newErrs = getInMemoryErrors().slice(errsBefore)
  const skillSchedule = findCommand('schedule', skillCommands)
  const slashSchedule = findCommand('schedule', slashSkills)
  check(
    'getSkillToolCommands and getSlashCommandToolSkills expose bundled schedule with zero collision errors (including getCommands under a kit)',
    newErrs.length === 0 &&
      skillSchedule !== undefined &&
      skillSchedule.type === 'prompt' &&
      skillSchedule.loadedFrom === 'bundled' &&
      skillSchedule.description.startsWith('Use when ') &&
      slashSchedule !== undefined &&
      slashSchedule.type === 'prompt' &&
      slashSchedule.loadedFrom === 'bundled',
    `errors=${newErrs.length} first=${JSON.stringify(newErrs[0]?.error.split('\n')[0])} schedule=${JSON.stringify(skillSchedule && { name: skillSchedule.name, type: skillSchedule.type, loadedFrom: skillSchedule.loadedFrom })} — add only built-in-displaced bundled skills in src/commands/catalogue/commands.ts`,
  )
  resetSentSkillNames()
  const listingCtx = {
    options: { tools: [SkillTool], engineModel: 'fixture-model' },
    getAppState: () => ({ mcp: { commands: [] } }),
  } as never
  const listingText = JSON.stringify(await getSkillListingAttachments(listingCtx))
  check(
    'getSkillListingAttachments still lists schedule for plain-chat model invocation',
    listingText.includes('- schedule: Use when '),
    `${listingText.slice(0, 300)} — keep schedule in getSkillToolCommands (src/commands/catalogue/commands.ts)`,
  )

  const skillValidation = await SkillTool.validateInput({ skill: 'schedule', args: 'remind me at 3pm' }, listingCtx)
  check(
    'SkillTool validates { skill: "schedule", args: "remind me at 3pm" }',
    skillValidation.result === true,
    `${JSON.stringify(skillValidation)} — keep schedule in SkillTool command universe (src/commands/catalogue/commands.ts)`,
  )

  console.log('\n§2 skill workflow and board-command wording')
  const promptBlocks =
    skillSchedule !== undefined && skillSchedule.type === 'prompt'
      ? await skillSchedule.getPromptForCommand('remind me at 3pm to check the build', {} as never)
      : []
  const promptText = promptBlocks.map(b => (b.type === 'text' ? b.text : '')).join('\n')
  const bareBlocks =
    skillSchedule !== undefined && skillSchedule.type === 'prompt'
      ? await skillSchedule.getPromptForCommand('', {} as never)
      : []
  const bareText = bareBlocks.map(b => (b.type === 'text' ? b.text : '')).join('\n')
  check(
    'schedule skill drops the bare opening question and names /schedule (never /saturn)',
    !bareText.includes('What would you like to do with scheduled agents?') &&
      !promptText.includes('/saturn') &&
      promptText.includes('/schedule') &&
      promptText.includes('remind me at 3pm to check the build'),
    `${promptText.slice(0, 260)} — update src/integrations/skills/bundled/schedule.ts`,
  )
  check(
    'SATURN_BOARD_COMMAND, CronCreate prompt and /loop prompt name /schedule (never /saturn)',
    SATURN_BOARD_COMMAND === '/schedule' &&
      buildCronCreatePrompt().includes('/schedule') &&
      !buildCronCreatePrompt().includes('/saturn') &&
      loopPromptForInput('5m').includes('/schedule') &&
      !loopPromptForInput('5m').includes('/saturn'),
    `SATURN_BOARD_COMMAND=${SATURN_BOARD_COMMAND} — update src/tools/cron/prompt.ts`,
  )
  const railSpec = saturnSection({
    input: {
      wakeGlance: { count: 1, soonestAt: Date.now() + 60_000, heldCount: 0 },
    },
    tok: { success: '', textSecondary: '', textMuted: '' },
    nowMs: Date.now(),
  } as never)
  const railRow = railSpec?.rows[0]
  check(
    'helm-lanes saturnSection is titled schedule and opens /schedule on click',
    railSpec?.label === 'schedule' &&
      railSpec?.open === '/schedule' &&
      railRow?.kind === 'rail' &&
      railRow.row?.kind === 'command' &&
      railRow.row.command === '/schedule',
    `${JSON.stringify(railSpec)} — update label, open and command in saturnSection (src/screen/cockpit-gauges/helm-lanes-model/sections.ts)`,
  )

  console.log('\n§3 built bundle: /saturn unknown, bare /schedule interactive, /schedule <words> and Skill road reach the recording model')
  check('dist/mercury.mjs exists (run bun run build.ts first)', existsSync(DIST), DIST)
  if (existsSync(DIST)) {
    const NODE = nodeBinPath()
    const runHome = join(scratch, 'run-home')
    const runCwd = join(scratch, 'run-cwd')
    mkdirSync(runCwd, { recursive: true })
    seedFirstRun(runHome, [runCwd])

    const fixture = await startFixtureApi([
      { kind: 'text', text: 'scheduled ack' },
      { kind: 'text', text: 'scheduled ack 2' },
    ])
    const baseEnv = {
      HOME: runHome,
      PATH: process.env.PATH,
      MERCURY_CONFIG_DIR: runHome,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(runHome, 'daemon'),
      ANTHROPIC_API_KEY: FIXTURE_API_KEY,
      ANTHROPIC_BASE_URL: fixture.url,
      OPENAI_API_KEY: '',
      MERCURY_THINKING_BINDING: 'drop_block',
      TMPDIR: tmpdir(),
    }
    const runOne = (prompt: string, env = baseEnv): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise(resolveRun => {
        const child = spawn(NODE, [DIST, 'run', '--mode', 'sovereign', '--model', 'claude-opus-5', prompt], {
          cwd: runCwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => (stdout += String(d)))
        child.stderr.on('data', d => (stderr += String(d)))
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', status => {
          clearTimeout(timer)
          resolveRun({ status, stdout, stderr })
        })
      })

    try {
      const saturnRes = await runOne('/saturn')
      check(
        '/saturn fails as unknown command with zero model requests',
        saturnRes.status === 1 &&
          saturnRes.stdout === '' &&
          saturnRes.stderr.trim().startsWith('Unknown command: /saturn') &&
          fixture.messageRequests().length === 0,
        `status=${saturnRes.status} out=${JSON.stringify(saturnRes.stdout)} err=${JSON.stringify(saturnRes.stderr)} reqs=${fixture.messageRequests().length}`,
      )

      const bareRes = await runOne('/schedule')
      const expectedBare = `The /schedule command is an interactive surface — it needs the foreground session; with words it runs here too: /schedule ${EXPECTED_HINT}.`
      check(
        'bare /schedule refuses as interactive surface headlessly naming its with-words form and with zero model requests',
        bareRes.status === 1 &&
          bareRes.stdout === '' &&
          bareRes.stderr.includes('The /schedule command is an interactive surface') &&
          bareRes.stderr.includes(expectedBare) &&
          !bareRes.stderr.includes('has no headless form') &&
          fixture.messageRequests().length === 0,
        `status=${bareRes.status} out=${JSON.stringify(bareRes.stdout)} err=${JSON.stringify(bareRes.stderr)} reqs=${fixture.messageRequests().length}`,
      )

      const helpRes = await runOne('/help')
      check(
        'local-jsx command without promptWithArgs (/help) keeps its unchanged headless refusal sentence',
        helpRes.status === 1 &&
          helpRes.stdout === '' &&
          helpRes.stderr.includes('The /help command is an interactive surface — it needs the foreground session and has no headless form.') &&
          fixture.messageRequests().length === 0,
        `status=${helpRes.status} out=${JSON.stringify(helpRes.stdout)} err=${JSON.stringify(helpRes.stderr)} reqs=${fixture.messageRequests().length}`,
      )

      const wordsRes = await runOne('/schedule remind me at 3pm to check the build')
      const reqs = fixture.messageRequests()
      const lastBody = JSON.stringify(reqs[reqs.length - 1]?.body ?? {})
      check(
        '/schedule <words> reaches the recording model with the workflow, /schedule, and the user words',
        wordsRes.status === 0 &&
          reqs.length >= 1 &&
          lastBody.includes('Manage scheduled local agents.') &&
          lastBody.includes('remind me at 3pm to check the build') &&
          lastBody.includes('/schedule') &&
          !lastBody.includes('/saturn') &&
          !lastBody.includes('What would you like to do with scheduled agents?'),
        `status=${wordsRes.status} reqs=${reqs.length} err=${JSON.stringify(wordsRes.stderr.slice(0, 300))} bodyHasWorkflow=${lastBody.includes('Manage scheduled local agents.')} bodyHasWords=${lastBody.includes('remind me at 3pm to check the build')} bodyHasOld=${lastBody.includes('/saturn')}`,
      )
    } finally {
      await fixture.close()
    }

    const skillCaptured: Array<Record<string, unknown>> = []
    let seq = 0
    const skillServer = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        const url = (req.url ?? '').split('?')[0] ?? ''
        if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(url.endsWith('count_tokens') ? JSON.stringify({ input_tokens: 100 }) : '{}')
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        skillCaptured.push(body)
        seq++
        const sse =
          seq === 1
            ? [
                `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
                `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_sched_1', name: 'Skill', input: {} } })}\n\n`,
                `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ skill: 'schedule', args: 'remind me at 3pm to check the build' }) } })}\n\n`,
                `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
                `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } })}\n\n`,
                `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
              ].join('')
            : [
                `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } })}\n\n`,
                `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
                `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'skill road done' } })}\n\n`,
                `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
                `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
                `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
              ].join('')
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.end(sse)
      })
    })
    await new Promise<void>(r => skillServer.listen(0, '127.0.0.1', r))
    const addr = skillServer.address()
    const skillUrl = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`
    try {
      const plainRes = await runOne('remind me at 3pm to check the build', { ...baseEnv, ANTHROPIC_BASE_URL: skillUrl })
      const secondBody = JSON.stringify(skillCaptured[1] ?? {})
      check(
        'plain chat reaching Skill({ skill: "schedule" }) expands the workflow with /schedule and the user words',
        plainRes.status === 0 &&
          skillCaptured.length === 2 &&
          secondBody.includes('Manage scheduled local agents.') &&
          secondBody.includes('remind me at 3pm to check the build') &&
          secondBody.includes('/schedule') &&
          !secondBody.includes('/saturn'),
        `status=${plainRes.status} reqs=${skillCaptured.length} err=${JSON.stringify(plainRes.stderr.slice(0, 300))}`,
      )
    } finally {
      await new Promise<void>(r => skillServer.close(() => r()))
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ SCHEDULE UNIFIED GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ SCHEDULE UNIFIED RED (${failures} of ${checks} checks failed)`)
process.exit(1)
