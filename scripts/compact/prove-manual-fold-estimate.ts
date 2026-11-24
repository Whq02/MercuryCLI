#!/usr/bin/env bun
import { mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', '..', 'src')
const scratch = mkdtempSync(join(tmpdir(), 'manual-fold-estimate-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'NODE_ENV', 'MERCURY_PROJECT_INTEL']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const previousCwd = process.cwd()
process.chdir(cwd)

const HINT = 'check the stand-in summary of src/engine/compaction/fold/projection.ts counting the brief headings via summarySkeleton in src/engine/compaction/summariserPrompt.ts'
let failures = 0
let checks = 0
const check = (label: string, good: boolean, detail = ''): void => {
  checks++
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${good ? (detail ? ` — ${detail}` : '') : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!good) failures++
}

try {
  const promptPath = join(SRC, 'engine/compaction/summariserPrompt.ts')
  const realPrompt = await import(promptPath)
  const realSummarySkeleton = realPrompt.summarySkeleton
  let bareMode = false
  mock.module(promptPath, () => ({
    ...realPrompt,
    summarySkeleton: () => (bareMode ? '' : realSummarySkeleton()),
  }))

  const state = await import(join(SRC, 'boot/process-state/processState.ts'))
  state.setOriginalCwd(cwd)
  state.setProjectRoot(cwd)
  state.setCwdState(cwd)
  state.setSessionTrustAccepted(true)
  state.setIsInteractive(false)
  const { enableConfigs } = await import(join(SRC, 'platform/config/globalConfig.ts'))
  enableConfigs()
  const { getDefaultAppState } = await import(join(SRC, 'screen/app-state/AppStateStore.ts'))
  const { createFileStateCacheWithSizeLimit } = await import(join(SRC, 'platform/files/fileStateCache.ts'))
  const messagesDoor = await import(join(SRC, 'engine/messages/messages.ts'))
  const { projectManualFold } = await import(join(SRC, 'engine/compaction/fold/projection.ts'))
  const { roughTokenCountEstimation } = await import(join(SRC, 'models/facts/tokenEstimation.ts'))

  const MODEL = 'claude-fable-5-1'
  let appState = getDefaultAppState()
  const context = {
    abortController: new AbortController(),
    options: { tools: [], commands: [], engineModel: MODEL, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (f: (s: typeof appState) => typeof appState) => { appState = f(appState) },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    loadedNestedMemoryPaths: new Set<string>(),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    setInProgressToolUseIDs() {},
    setResponseLength() {},
    updateFileHistoryState() {},
  }
  const words = (chars: number): string => 'word '.repeat(Math.ceil(chars / 5)).slice(0, chars)
  let serial = 0
  const assistant = (text: string) => {
    const row = messagesDoor.createAssistantMessage({ content: text })
    row.message.id = `msg_probe_${++serial}`
    return row
  }
  const twoRounds = (firstAnswerChars: number) => [
    messagesDoor.createUserMessage({ content: 'note this down' }),
    assistant(words(firstAnswerChars)),
    messagesDoor.createUserMessage({ content: 'and once more' }),
    assistant('done'),
  ]
  const project = async (firstAnswerChars: number) => {
    const projection = await projectManualFold(twoRounds(firstAnswerChars), context as never, { postFoldCarry: [], userContext: {} } as never, undefined)
    if (projection === null) throw new Error('no projection')
    return projection
  }

  const headings = [...new Set([...String(realPrompt.getFoldPrompt()).matchAll(/^(\d{1,2}\. [^:\n]+:)/gm)].map(match => match[1]))]
  const fixedParts = `Summary:\n${headings.join('\n')}`
  const fixedTokens = roughTokenCountEstimation(fixedParts)
  console.log(`the brief asks for ${headings.length} numbered sections; with the head \`Summary:\` they are ${fixedParts.length} characters, about ${fixedTokens} tokens, in every summary written to it`)

  bareMode = false
  let threshold = -1
  for (let chars = 0; chars <= 6000; chars += 20) {
    const projection = await project(chars)
    if (projection.after < projection.before) { threshold = chars; break }
  }
  bareMode = true
  let floor = -1
  for (let chars = 0; chars <= 6000; chars += 20) {
    const projection = await project(chars)
    if (projection.after < projection.before) { floor = chars; break }
  }
  bareMode = false
  console.log(`the smallest first answer of a two-round session the estimate lets through to the summariser: ${threshold} characters (about ${Math.round(threshold / 4)} tokens); without headings: ${floor} characters`)

  const tight = floor + Math.round(fixedParts.length / 2)
  const tightView = await project(tight)
  check(`a two-round session whose first answer is ${tight} characters is refused before anything is sent: what would fold is smaller than the summary's own fixed parts`, tightView.after >= tightView.before, `the estimate reads ${tightView.before} before and ${tightView.after} after`)
  check('the estimate counts the fixed parts of the summary: the threshold stands above the bare one by about their size', threshold - floor >= fixedParts.length * 0.6 && threshold - floor <= fixedParts.length * 1.6, `threshold ${threshold}, bare ${floor}, fixed parts ${fixedParts.length} characters`)
  const roomy = floor + fixedParts.length * 3
  const roomyView = await project(roomy)
  check(`a two-round session whose first answer is ${roomy} characters still goes to the summariser`, roomyView.after < roomyView.before, `${roomyView.before} before, ${roomyView.after} after`)
  const long = await project(8000)
  check('a two-round session with a 2,000-token answer still goes to the summariser', long.after < long.before && long.totalRounds === 2, `${long.before} before, ${long.after} after, ${long.totalRounds} rounds`)
  const tiny = await project(0)
  check('a two-round session of a few words is refused before anything is sent, as before', tiny.after >= tiny.before, `${tiny.before} before, ${tiny.after} after`)
} finally {
  process.chdir(previousCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? `all ${checks} hold` : `${failures} of ${checks} fail`)
process.exit(failures === 0 ? 0 : 1)
