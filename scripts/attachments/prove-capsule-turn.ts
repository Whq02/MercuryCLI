import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'capsule-turn-'))
const cwd = join(scratch, 'work')
mkdirSync(join(cwd, '.mercury/skills/capsule-turn-proof'), { recursive: true })
mkdirSync(join(scratch, 'home'), { recursive: true })
writeFileSync(join(cwd, '.mercury/skills/capsule-turn-proof/SKILL.md'), '---\ndescription: Exercise one collected turn.\n---\nKeep the capsule facts.\n')
writeFileSync(join(cwd, 'example.txt'), 'a file fact for the collection proof\n')
writeFileSync(join(cwd, 'MERCURY.md'), 'Keep every collection fact.\n')
const priorCwd = process.cwd()
process.chdir(cwd)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_PROJECT_INTEL = '0'
delete process.env.MERCURY_BARE
delete process.env.NODE_ENV
try {
  const bootstrap = await import('../../src/boot/process-state/processState.js')
  bootstrap.setOriginalCwd(cwd)
  bootstrap.setProjectRoot(cwd)
  bootstrap.setCwdState(cwd)
  bootstrap.setSessionTrustAccepted(true)
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
  enableConfigs()
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.js')
  const { getEngineModel } = await import('../../src/models/catalogue/engineModel.js')
  const { SKILL_TOOL_NAME } = await import('../../src/tools/kit/names/skill.js')
  const { getAttachments } = await import('../../src/engine/attachments/turnAttachments.js')
  const { normalizeAttachmentForAPI } = await import('../../src/engine/messages/attachmentText.js')
  let state = getDefaultAppState()
  const context = {
    abortController: new AbortController(),
    options: { commands: [], tools: [{ name: SKILL_TOOL_NAME }], engineModel: getEngineModel(), mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [{ agentType: 'capsule-reviewer' }], allAgents: [] } },
    getAppState: () => state,
    setAppState: (f: any) => { state = f(state) },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    nestedMemoryAttachmentTriggers: new Set<string>(),
    loadedNestedMemoryPaths: new Set<string>(),
    setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
  }
  const rows = await getAttachments(`Read @${join(cwd, 'example.txt')} with @"capsule-reviewer (agent)"`, context as never, [], [])
  const capsule = rows.filter(row => row.type === 'context_capsule')
  assert.equal(capsule.length, 1, 'the real collector emits one capsule even with optional project intelligence disabled')
  for (const type of ['file', 'agent_mention', 'skill_listing']) {
    const receipt = rows.find(row => row.type === type)
    assert(receipt?.capsuleReceipt, `${type} participates through the real producer`)
    assert.equal(normalizeAttachmentForAPI(receipt).length, 0)
  }
  const content = normalizeAttachmentForAPI(capsule[0]!).map(message => JSON.stringify(message.message.content)).join('\n')
  assert(content.includes('a file fact for the collection proof'), `context_capsule omitted attached file text in src/engine/attachments/turnAttachments.ts: ${content.slice(0, 200)}`)
  assert(content.includes('capsule-reviewer'), `context_capsule omitted agent mention capsule-reviewer in src/engine/attachments/turnAttachments.ts: ${content.slice(0, 200)}`)
  assert(content.includes('capsule-turn-proof'), `context_capsule omitted skill listing capsule-turn-proof in src/engine/attachments/turnAttachments.ts: ${content.slice(0, 200)}`)
  console.log('PASS live collector: current input, file read, agent mention and real skill listing enter one capsule with silent receipts')
} finally {
  process.chdir(priorCwd)
  rmSync(scratch, { recursive: true, force: true })
}
