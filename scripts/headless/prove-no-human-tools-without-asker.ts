#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { hostRunner } from '../lib/runnerHost.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const NODE = existsSync(vendoredNode) ? vendoredNode : Bun.which('node') ?? 'node'
const MODEL = 'claude-opus-4-8'
const API_KEY = 'fixture-key-000'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'no-human-tools-')))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

const { setAskChannel, setSessionKind, setIsInteractive } = await import('../../src/bootstrap/state.ts')
const { getAllBaseTools, getTools, assembleToolPool } = await import('../../src/tools.ts')
import type { Tool, Tools } from '../../src/Tool.ts'
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getRuntimePostureSection, markSessionNonInteractive, markSessionBootRules, resetRuntimePostureForTest } = await import('../../src/utils/cockpit/runtimePosture.ts')
const { LOCAL_POSTURE_WORDS } = await import('../../src/constants/localPromptProfile.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}

function deferredReminderText(body: unknown): string {
  const messages = (body as { messages?: Array<{ content?: unknown }> }).messages ?? []
  const chunks: string[] = []
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      if (msg.content.includes('Deferred tools:')) chunks.push(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const text = (block as { text?: string }).text
        if (typeof text === 'string' && text.includes('Deferred tools:')) chunks.push(text)
      }
    }
  }
  return chunks.join('\n')
}

function wireToolNames(body: unknown): string[] {
  const tools = (body as { tools?: Array<{ name?: string }> }).tools ?? []
  return tools.map(t => String(t.name ?? '')).filter(Boolean)
}

function systemPromptText(body: unknown): string {
  const system = (body as { system?: unknown }).system
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map(part => String((part as { text?: string }).text ?? '')).join('\n')
  return ''
}

function lastToolResultText(body: unknown): string {
  const messages = (body as { messages?: Array<{ content?: unknown }> }).messages ?? []
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if ((block as { type?: string }).type === 'tool_result') {
        const inner = (block as { content?: unknown }).content
        return typeof inner === 'string' ? inner : JSON.stringify(inner)
      }
    }
  }
  return ''
}

function searchContext(tools: Tools) {
  const ctx = getEmptyToolPermissionContext()
  return {
    options: { tools, engineModel: MODEL },
    messages: [],
    getAppState: () => ({ toolPermissionContext: ctx, mcp: { clients: [] } }),
  } as never
}

try {
  section('§1 in-process tool pool, ToolSearch, and posture text')
  const ctx = getEmptyToolPermissionContext()
  const allBase = getAllBaseTools()
  const humanTools = allBase.filter(tool => tool.requiresUserInteraction?.() === true)
  const humanNames = humanTools.map(tool => tool.name)
  check(
    'product marks AskUserQuestion and ApolloReview as requiring user interaction',
    humanNames.includes('AskUserQuestion') && humanNames.includes('ApolloReview'),
    `found ${JSON.stringify(humanNames)}; requiresUserInteraction() on tools in src/tools/ must identify human-requiring tools`,
  )

  setIsInteractive(false)
  setAskChannel('none')
  setSessionKind('headless')
  const noneTools = getTools(ctx)
  const noneNames = new Set(noneTools.map(t => t.name))
  const leaked = humanNames.filter(name => noneNames.has(name))
  check(
    'with askChannel=none, getTools omits every tool whose requiresUserInteraction() is true',
    leaked.length === 0,
    `leaked ${JSON.stringify(leaked)}; filter tools with requiresUserInteraction() when !canAnswerAsks() in src/tools.ts`,
  )

  const customHumanTool = { ...humanTools[0]!, name: 'CustomHumanProbe', requiresUserInteraction: () => true } as Tool
  const pooledNone = assembleToolPool(ctx, [customHumanTool])
  check(
    'with askChannel=none, assembleToolPool also omits any non-base tool requiring user interaction',
    !pooledNone.some(t => t.name === 'CustomHumanProbe'),
    'filter requiresUserInteraction() in mcpToolPartition in src/tools.ts when !canAnswerAsks()',
  )

  const selectAskNone = await ToolSearchTool.call({ query: 'select:AskUserQuestion', max_results: 5 }, searchContext(noneTools))
  const selectReviewNone = await ToolSearchTool.call({ query: 'select:ApolloReview', max_results: 5 }, searchContext(noneTools))
  const keywordNone = await ToolSearchTool.call({ query: 'question operator', max_results: 10 }, searchContext(noneTools))
  check(
    'with askChannel=none, ToolSearch finds none of the human-requiring tools by select or keyword',
    selectAskNone.data.matches.length === 0 &&
      selectReviewNone.data.matches.length === 0 &&
      !keywordNone.data.matches.some(name => humanNames.includes(name)),
    `got selectAsk=${JSON.stringify(selectAskNone.data.matches)} selectReview=${JSON.stringify(selectReviewNone.data.matches)} kw=${JSON.stringify(keywordNone.data.matches)}; exclude human-requiring tools from the pool in src/tools.ts`,
  )

  resetRuntimePostureForTest()
  markSessionNonInteractive('default')
  markSessionBootRules(ctx)
  const nonePosture = getRuntimePostureSection() ?? ''
  check(
    'with askChannel=none, runtime posture text does not send the model to AskUserQuestion',
    !nonePosture.includes('AskUserQuestion'),
    `got ${JSON.stringify(nonePosture)}; update the unattended posture sentence in src/utils/cockpit/runtimePosture.ts`,
  )
  check(
    'local unattended posture text does not send the model to AskUserQuestion',
    !LOCAL_POSTURE_WORDS.unattended.includes('AskUserQuestion'),
    `got ${JSON.stringify(LOCAL_POSTURE_WORDS.unattended)}; update LOCAL_POSTURE_WORDS.unattended in src/constants/localPromptProfile.ts`,
  )

  setAskChannel('sdk')
  const sdkTools = getTools(ctx)
  const sdkNames = new Set(sdkTools.map(t => t.name))
  const missingSdk = humanNames.filter(name => !sdkNames.has(name))
  check(
    'with askChannel=sdk, every human-requiring tool is still offered by getTools',
    missingSdk.length === 0,
    `missing ${JSON.stringify(missingSdk)}; keep all human-requiring tools when canAnswerAsks() is true in src/tools.ts`,
  )

  const selectAskSdk = await ToolSearchTool.call({ query: 'select:AskUserQuestion', max_results: 5 }, searchContext(sdkTools))
  const selectReviewSdk = await ToolSearchTool.call({ query: 'select:ApolloReview', max_results: 5 }, searchContext(sdkTools))
  check(
    'with askChannel=sdk, ToolSearch finds AskUserQuestion and ApolloReview',
    selectAskSdk.data.matches.includes('AskUserQuestion') && selectReviewSdk.data.matches.includes('ApolloReview'),
    `got ask=${JSON.stringify(selectAskSdk.data.matches)} review=${JSON.stringify(selectReviewSdk.data.matches)}; keep human-requiring tools in the pool when canAnswerAsks() is true`,
  )

  setAskChannel('operator')
  const operatorNames = getTools(ctx).map(t => t.name)
  check(
    'with askChannel=operator, the offered tool list is identical to askChannel=sdk',
    JSON.stringify(operatorNames) === JSON.stringify(sdkTools.map(t => t.name)),
    'getTools in src/tools.ts must treat operator and sdk channels identically',
  )

  section('§2 built product end-to-end: mercury run (none) vs mercury runner (sdk)')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs is built', false, 'run bun run build.ts before running this proof')
  } else {
    const projectDir = join(scratch, 'project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'README.md'), '# probe\n')
    seedFirstRun(home, [projectDir])

    const searchScript: ScriptedTurn[] = [
      { kind: 'tool_use', name: 'ToolSearch', input: { query: 'select:AskUserQuestion' } },
      { kind: 'text', text: 'DONE' },
    ]

    const runApi = await startFixtureApi(searchScript)
    try {
      const env = {
        HOME: scratch,
        PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
        TERM: 'dumb',
        TMPDIR: tmpdir(),
        MERCURY_CONFIG_DIR: home,
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_DAEMON_DIR: join(scratch, 'daemon-run'),
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_BROWSER_NO_DISCOVERY: '1',
        BROWSER: '/usr/bin/true',
        ANTHROPIC_BASE_URL: runApi.url,
        ANTHROPIC_API_KEY: API_KEY,
      }
      const exit = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveExit => {
        const child = spawn(NODE, [DIST, 'run', '--model', MODEL, '--format', 'rows', '--', 'probe'], { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
        child.stdout.on('data', d => { stdout += String(d) })
        child.stderr.on('data', d => { stderr += String(d) })
        child.once('close', code => { clearTimeout(timer); resolveExit({ code, stdout, stderr }) })
      })
      const reqs = runApi.messageRequests()
      const firstBody = reqs[0]?.body
      const secondBody = reqs[1]?.body
      const roster = wireToolNames(firstBody)
      const deferred = deferredReminderText(firstBody)
      const sys = systemPromptText(firstBody)
      const toolResult = lastToolResultText(secondBody)
      check(
        'mercury run completes and omits AskUserQuestion and ApolloReview from the wire tool roster and deferred list',
        exit.code === 0 &&
          reqs.length >= 2 &&
          !roster.includes('AskUserQuestion') &&
          !roster.includes('ApolloReview') &&
          !deferred.includes('AskUserQuestion') &&
          !deferred.includes('ApolloReview'),
        `code=${exit.code} rosterHas=${roster.filter(n => n === 'AskUserQuestion' || n === 'ApolloReview')} deferredHas=${['AskUserQuestion', 'ApolloReview'].filter(n => deferred.includes(n))}; filter requiresUserInteraction() in src/tools.ts and rebuild dist/mercury.mjs`,
      )
      check(
        'mercury run ToolSearch select:AskUserQuestion cannot load AskUserQuestion',
        !wireToolNames(secondBody).includes('AskUserQuestion') && !toolResult.includes('Tools admitted to this session') && !toolResult.includes('Tool references removed'),
        `toolResult=${JSON.stringify(toolResult.slice(0, 200))}; ensure AskUserQuestion is excluded from the turn tool pool in src/tools.ts / src/cli/headless/printTurn.ts`,
      )
      check(
        'mercury run system prompt does not direct the model to AskUserQuestion',
        !sys.includes('still ask through AskUserQuestion') && !sys.includes('ask with AskUserQuestion'),
        'update unattended posture text in src/utils/cockpit/runtimePosture.ts and src/constants/localPromptProfile.ts',
      )
    } finally {
      await runApi.close()
    }

    const runnerApi = await startFixtureApi(searchScript)
    try {
      const host = hostRunner({
        dist: DIST,
        node: NODE,
        cwd: projectDir,
        home: scratch,
        env: {
          HOME: scratch,
          PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(NODE)}`,
          TERM: 'dumb',
          TMPDIR: tmpdir(),
          MERCURY_CONFIG_DIR: home,
          MERCURY_CREDENTIAL_STORE: 'file',
          MERCURY_DAEMON_DIR: join(scratch, 'daemon-runner'),
          MERCURY_LOCAL_PROBE_TARGETS: 'none',
          MERCURY_BROWSER_NO_DISCOVERY: '1',
          BROWSER: '/usr/bin/true',
          ANTHROPIC_BASE_URL: runnerApi.url,
          ANTHROPIC_API_KEY: API_KEY,
        },
        argv: ['--model', MODEL],
      })
      const killer = setTimeout(() => host.child.kill('SIGKILL'), 90_000)
      try {
        await host.initialize()
        await host.prompt('probe')
        await host.waitFor('outcome', row => row.type === 'outcome', 60_000)
      } finally {
        host.end()
        await host.exited
        clearTimeout(killer)
        host.peer.close('probe done')
      }
      const reqs = runnerApi.messageRequests()
      const firstBody = reqs[0]?.body
      const secondBody = reqs[1]?.body
      const runnerRoster = wireToolNames(firstBody)
      const deferred = deferredReminderText(firstBody)
      const toolResult = lastToolResultText(secondBody)
      const offeredInRunner = (name: string): boolean => runnerRoster.includes(name) || deferred.includes(name)
      check(
        'mercury runner (sdk channel) still offers AskUserQuestion and ApolloReview and ToolSearch loads AskUserQuestion',
        reqs.length >= 2 &&
          offeredInRunner('AskUserQuestion') &&
          offeredInRunner('ApolloReview') &&
          !toolResult.includes('No deferred tool') &&
          !toolResult.includes('unknown') &&
          wireToolNames(secondBody).includes('AskUserQuestion'),
        `reqs=${reqs.length} runnerRosterHas=${['AskUserQuestion', 'ApolloReview'].filter(offeredInRunner)} toolResult=${JSON.stringify(toolResult.slice(0, 160))} secondRosterHasAsk=${wireToolNames(secondBody).includes('AskUserQuestion')}; keep human-requiring tools when canAnswerAsks() is true`,
      )
    } finally {
      await runnerApi.close()
    }
  }
} finally {
  resetRuntimePostureForTest()
  setAskChannel('operator')
  rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`FAIL (${failures} of ${checks} checks failed)`)
  process.exit(1)
}
console.log(`PASS (${checks} checks)`)
