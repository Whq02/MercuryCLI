import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(suiteHome, 'limits-home-'))
process.env.MERCURY_CONFIG_DIR = home
const work = join(home, 'limits-proof')
mkdirSync(work, { recursive: true })
process.chdir(work)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(work); bootstrap.setCwdState(work); bootstrap.setProjectRoot(work)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const settings = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
const { DEFAULT_BOARD_LIMITS } = await import('../../src/services/crewBoard/contracts.ts')
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const { ResumeAgentTool } = await import('../../src/tools/ResumeAgentTool/ResumeAgentTool.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { drainPendingMessages } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
let checks = 0
function check(label: string, truth: unknown): void { assert(truth, label); checks++; console.log(`PASS ${label}`) }
const set = (swarm: NonNullable<import('../../src/utils/settings/types.ts').SettingsJson['swarm']>) => assert.equal(settings.updateSettingsForSource('userSettings', { swarm }).error, null)
check('absent settings keep the larger defaults and the loop guards', JSON.stringify(seam.swarmLimits()) === JSON.stringify(DEFAULT_BOARD_LIMITS))
const chosen = { seatAllowance: 300000, waveAllowance: 5000000, postsPerMinute: 10, postsPerSeat: 150, postChars: 4000 }
settings.updateSettingsForSource('projectSettings', { swarm: { enabled: true, ...chosen } })
settings.updateSettingsForSource('localSettings', { swarm: { enabled: true, ...chosen } })
check('project and local settings cannot set the master or limits', !seam.swarmMasterEnabled() && JSON.stringify(seam.swarmLimits()) === JSON.stringify(DEFAULT_BOARD_LIMITS))
set({ enabled: true, ...chosen })
check('the setting alone leaves the store unloaded', !seam.swarmModuleLoaded())
const on = runSwarmCommand('on')
check('millions are accepted and the command names the chosen values', on.includes('300,000 per agent, 5,000,000 per wave') && seam.swarmLimits().waveAllowance === 5000000)
const board = seam.swarmStore()!
const tool = seam.swarmTools()[0]!
const prompt = await tool.prompt({} as never)
check('the tool prompt names the configured limits and read cursor', prompt.includes('300,000') && prompt.includes('5,000,000') && prompt.includes('10 posts/minute, burst 20, 150 per seat/wave') && prompt.includes('starting at enrollment'))
check('schema and result handling impose no stale numeric ceiling', tool.inputSchema.safeParse({ op: 'read', limitTokens: 10000000 }).success && tool.inputSchema.safeParse({ op: 'post', text: 'x'.repeat(50000) }).success && tool.maxResultSizeChars === Infinity)
set({ seatAllowance: 5000000, waveAllowance: 20000000 })
check('a running wave keeps its opening values', board.limits.seatAllowance === chosen.seatAllowance && runSwarmCommand('on') === on)
check('uncap acts immediately and status names it', runSwarmCommand('uncap').includes('/swarm uncap is on') && runSwarmCommand('status').includes('no limit per agent, no limit per wave'))
check('an already-created tool prompt follows uncap', (await tool.prompt({} as never)).includes('no limit per seat'))
check('cap restores the saved wave values', runSwarmCommand('cap') === on && !board.uncapped)
runSwarmCommand('off')
check('reopening the wave preserves its captured values', runSwarmCommand('on') === on)

const invalid = join(work, 'invalid.json')
const parse = (swarm: unknown) => { writeFileSync(invalid, JSON.stringify({ swarm, view: { ping: false } })); resetSettingsCache(); return settings.parseSettingsFile(invalid) }
const low = parse({ seatAllowance: 1, waveAllowance: 1, postsPerMinute: 0, postsPerSeat: 1, postChars: 1 })
check('small nonzero values clamp while keeping siblings', low.settings?.swarm?.seatAllowance === 1000 && low.settings.swarm.waveAllowance === 1000 && low.settings.swarm.postsPerMinute === 1 && low.settings.swarm.postsPerSeat === 10 && low.settings.swarm.postChars === 400 && low.settings.view?.ping === false)
for (const [key, min] of [['seatAllowance', 1000], ['waveAllowance', 1000], ['postsPerMinute', 1], ['postsPerSeat', 10], ['postChars', 400]]) check(`the validator names swarm.${key} and its floor`, low.errors.some(e => e.path === `swarm.${key}` && e.message.includes(`at least ${min}`)))
const high = parse({ seatAllowance: 9000000, waveAllowance: 90000000, postsPerMinute: 99, postsPerSeat: 9999, postChars: 30000 })
check('upper bounds clamp at the new ceilings', high.settings?.swarm?.seatAllowance === 5000000 && high.settings.swarm.waveAllowance === 20000000 && high.settings.swarm.postsPerMinute === 30 && high.settings.swarm.postsPerSeat === 1000 && high.settings.swarm.postChars === 20000)
check('zero is accepted as written for every allowance', SettingsSchema().safeParse({ swarm: { seatAllowance: 0, waveAllowance: 0, postChars: 0 } }).success)
check('zero never disables the post loop guards', !SettingsSchema().safeParse({ swarm: { postsPerMinute: 0, postsPerSeat: 0 } }).success)
const relation = parse({ seatAllowance: 300000, waveAllowance: 1000 })
check('the finite wave floor follows the seat', relation.settings?.swarm?.waveAllowance === 300000 && relation.errors.some(e => e.path === 'swarm.waveAllowance' && e.message.includes('300000')))
check('zero wave remains uncapped even with a finite seat', parse({ seatAllowance: 5000000, waveAllowance: 0 }).settings?.swarm?.waveAllowance === 0)
check('unknown swarm keys still refuse', !SettingsSchema().safeParse({ swarm: { extra: 1 } }).success)
const { generateSettingsJSONSchema } = await import('../../src/utils/settings/schemaOutput.ts')
const { default: Ajv } = await import('ajv/dist/2020.js')
const validate = new Ajv({ strict: false }).compile(JSON.parse(generateSettingsJSONSchema()))
for (const key of ['seatAllowance', 'waveAllowance', 'postChars']) check(`JSON schema preserves zero or the floor for ${key}`, validate({ swarm: { [key]: 0 } }) && !validate({ swarm: { [key]: 1 } }) && !validate({ swarm: { [key]: -1 } }))
const negative = parse({ seatAllowance: -1, waveAllowance: 0, postChars: -1 })
check('negative allowances clamp to the floor, never to unlimited', negative.settings?.swarm?.seatAllowance === 1000 && negative.settings.swarm.postChars === 400)

runSwarmCommand('off')
bootstrap.regenerateSessionId()
set({ enabled: true, seatAllowance: 1000, waveAllowance: 1000, postChars: 400 })
runSwarmCommand('on')
await seam.latchSwarmAgent('recipient', 'Recipient')
const directBoard = seam.swarmStore()!
const main = seam.swarmPrincipal()!, recipient = seam.swarmPrincipal('recipient')!
for (let i = 0; i < 3; i++) assert(directBoard.post(main, { clientOpId: `fill-${i}`, kind: 'result', text: 'x'.repeat(400) }).ok)
for (let i = 0; i < 8; i++) directBoard.read(recipient, { since: 0 })
check('the direct-message fixture has a spent seat allowance', directBoard.read(recipient, { since: 0 }).events.length === 0)
let state = getDefaultAppState()
state.tasks.recipient = { id: 'recipient', type: 'local_agent', status: 'running', description: 'Recipient', agentId: 'recipient', agentType: 'mercury-crew', prompt: '', startTime: Date.now(), isBackgrounded: true, outputFile: '', outputOffset: 0, notified: false } as never
const change = (fn: (s: typeof state) => typeof state): void => { state = fn(state) }
const context = (toolUseId: string, agentId?: string): any => ({ toolUseId, agentId, getAppState: () => state, setAppState: change, setAppStateForTasks: change, options: { tools: [], commands: [] }, abortController: new AbortController() })
const message = 'D'.repeat(3000)
const before = directBoard.view().admitted
const beforeSeq = directBoard.view().snapshot
const sent = await SendMessageTool.call({ to: 'recipient', message }, context('direct'))
const queued = drainPendingMessages('recipient', () => state, change)
check('3000-character SendMessage reaches a spent seat whole', sent.data.success && queued.length === 1 && JSON.stringify(queued).includes(message))
check('the timeline has only the 400-character direct mirror', directBoard.view().events.at(-1)?.text === `${message.slice(0, 400)}… (sent directly)`)
check('direct delivery and mirror do not charge the recipient', directBoard.view().admitted === before && directBoard.read(recipient, { since: beforeSeq }).tokens === 0)
const resumed = await ResumeAgentTool.call({ to: 'recipient', message }, context('resume-direct'), (() => {}) as never, {} as never)
check('ResumeCrewmate to a running seat is also whole and direct', resumed.data.success && JSON.stringify(drainPendingMessages('recipient', () => state, change)).includes(message) && directBoard.view().admitted === before)
const toLead = await SendMessageTool.call({ to: 'main', message }, context('to-lead', 'recipient'))
check('a crewmate’s message to main uses the direct road', toLead.data.success && toLead.data.message.startsWith('Delivered to the main agent') && directBoard.view().admitted === before)
runSwarmCommand('off')
const off = await SendMessageTool.call({ to: 'recipient', message }, context('direct-off'))
check('direct messages are uncapped with swarm off too', off.data.success && JSON.stringify(drainPendingMessages('recipient', () => state, change)).includes(message) && directBoard.view().admitted === before)
runSwarmCommand('on')
const liveCost = directBoard.view().admitted
seam.settleSwarmAgent('recipient')
check('the real settlement seam removes completed-seat wave charges', liveCost > 0 && directBoard.view().admitted < liveCost)
runSwarmCommand('off')
console.log(`${checks} settings, live-command and direct-message checks passed`)
process.exit(0)
