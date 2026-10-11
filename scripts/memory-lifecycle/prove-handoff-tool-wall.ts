import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'handoff-tool-wall-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { askForHandoff } = await import('../../src/mneme/handoffAsk.ts')
  const { createSubagentContext } = await import('../../src/utils/forkedAgent.ts')
  const { resolveHookPermissionDecision } = await import('../../src/services/tools/toolHooks.ts')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
  const { openEntry } = await import('../../src/mneme/ledger.ts')
  const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
  const { getSessionId } = await import('../../src/bootstrap/state.ts')
  openEntry(mnemeProjectKey(), { sessionId: String(getSessionId()), model: 'fixture' })
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const state = getDefaultAppState()
  const parent = {
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => state, setAppState: () => {}, options: {}, messages: [],
  } as never
  let decision = ''
  await askForHandoff({
    cacheSafeParams: { systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: parent, forkContextMessages: [createUserMessage({ content: 'work' })] },
    run: async params => {
      try {
      const context = createSubagentContext(params.cacheSafeParams.toolUseContext, params.overrides)
      const result = await resolveHookPermissionDecision(
        { behavior: 'allow', decisionReason: { type: 'hook', hookName: 'allow Bash' } },
        { name: 'Bash' } as never, { command: 'echo forbidden' }, context,
        params.canUseTool, createAssistantMessage({ content: 'closing' }), 'closing-bash',
      )
      decision = result.decision.behavior
      return { messages: [] }
      } catch (error) { console.error(error); throw error }
    },
  })
  assert.equal(decision, 'deny', 'a tool.before allow must not bypass the closing ask allowlist')
  console.log('HANDOFF TOOL WALL GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
