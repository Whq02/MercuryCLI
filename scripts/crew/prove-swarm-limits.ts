import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
const work = join(home, 'limits-proof')
mkdirSync(work, { recursive: true })
process.chdir(work)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(work)
bootstrap.setCwdState(work)
bootstrap.setProjectRoot(work)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const settings = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
const { validateSettingsFileContent } = await import('../../src/utils/settings/validation.ts')
const { DEFAULT_BOARD_LIMITS } = await import('../../src/services/crewBoard/contracts.ts')
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { open } = await import('../../src/services/crewBoard/store.ts')
let checks = 0
function check(label: string, truth: unknown): void { assert(truth, label); checks++; console.log(`PASS ${label}`) }
const set = (swarm: NonNullable<import('../../src/utils/settings/types.ts').SettingsJson['swarm']>) => assert.equal(settings.updateSettingsForSource('userSettings', { swarm }).error, null)
const chosen = { seatAllowance: 12000, waveAllowance: 50000, postsPerMinute: 10, postsPerSeat: 150 }

check('absent settings keep all four defaults', JSON.stringify(seam.swarmLimits()) === JSON.stringify(DEFAULT_BOARD_LIMITS))
settings.updateSettingsForSource('projectSettings', { swarm: { enabled: true, ...chosen } })
settings.updateSettingsForSource('localSettings', { swarm: { enabled: true, ...chosen } })
check('project and local settings cannot set the master or limits', !seam.swarmMasterEnabled() && JSON.stringify(seam.swarmLimits()) === JSON.stringify(DEFAULT_BOARD_LIMITS))
set({ enabled: true, ...chosen })
check('settings alone keep the store unloaded', !seam.swarmModuleLoaded())
const on = runSwarmCommand('on')
check('the on line carries the chosen allowances', on === 'Swarm on for new crewmates — board context 12,000 tokens per agent, 50,000 per wave; no extra turns.')
const wave = seam.swarmStore()!
const tool = seam.swarmTools()[0]!
const prompt = await tool.prompt({} as never)
check('the tool prompt carries every chosen limit', prompt.includes('up to 12000') && prompt.includes('10 posts/minute, burst 20, 150 per seat/wave') && prompt.includes('12000/seat and 50000/wave'))
check('the tool schema permits the new maximum and refuses N+1', tool.inputSchema.safeParse({ op: 'read', limitTokens: 12000 }).success && !tool.inputSchema.safeParse({ op: 'read', limitTokens: 12001 }).success)
check('larger reads retain enough result space', tool.maxResultSizeChars >= 24000)
set({ seatAllowance: 20000, waveAllowance: 90000, postsPerMinute: 20, postsPerSeat: 300 })
check('a running wave keeps its opening object', seam.swarmStore() === wave && JSON.stringify(wave.limits) === JSON.stringify(chosen))
check('the settings reader changes without changing the running wave', seam.swarmLimits().seatAllowance === 20000 && seam.swarmLimits().waveAllowance === 90000)
check('command and prompt keep naming the running limits', runSwarmCommand('on') === on && await seam.swarmTools()[0]!.prompt({} as never) === prompt)
await seam.latchSwarmAgent('later', 'Later')
check('a seat joining mid-wave receives the opening limits', seam.swarmTools('later')[0]!.inputSchema.safeParse({ op: 'read', limitTokens: 12000 }).success && !seam.swarmTools('later')[0]!.inputSchema.safeParse({ op: 'read', limitTokens: 12001 }).success)
seam.settleSwarmAgent('later')
runSwarmCommand('off')
check('closing and reopening the same wave preserves its limits', runSwarmCommand('on') === on && JSON.stringify(seam.swarmStore()!.limits) === JSON.stringify(chosen))

const invalid = join(work, 'invalid.json')
const readInvalid = (swarm: unknown) => {
  writeFileSync(invalid, JSON.stringify({ swarm, view: { ping: false } }))
  resetSettingsCache()
  return settings.parseSettingsFile(invalid)
}
const low = readInvalid({ enabled: true, seatAllowance: 1, waveAllowance: 1, postsPerMinute: 0, postsPerSeat: 1 })
check('below-floor limits clamp while keeping unrelated settings', low.settings?.swarm?.seatAllowance === 1000 && low.settings.swarm.waveAllowance === 1000 && low.settings.swarm.postsPerMinute === 1 && low.settings.swarm.postsPerSeat === 10 && low.settings.view?.ping === false)
for (const [key, minimum] of [['seatAllowance', 1000], ['waveAllowance', 1000], ['postsPerMinute', 1], ['postsPerSeat', 10]]) check(`the validator names swarm.${key} and its floor`, low.errors.some(error => error.path === `swarm.${key}` && error.message.includes(`at least ${minimum}`)))
const high = readInvalid({ seatAllowance: 999999, waveAllowance: 999999, postsPerMinute: 999, postsPerSeat: 9999 })
check('above-ceiling limits clamp', high.settings?.swarm?.seatAllowance === 60000 && high.settings.swarm.waveAllowance === 400000 && high.settings.swarm.postsPerMinute === 30 && high.settings.swarm.postsPerSeat === 1000)
for (const [key, maximum] of [['seatAllowance', 60000], ['waveAllowance', 400000], ['postsPerMinute', 30], ['postsPerSeat', 1000]]) check(`the validator names swarm.${key} and its ceiling`, high.errors.some(error => error.path === `swarm.${key}` && error.message.includes(`at most ${maximum}`)))
const relation = readInvalid({ seatAllowance: 12000, waveAllowance: 2000 })
check('the wave floor follows the seat allowance', relation.settings?.swarm?.waveAllowance === 12000 && relation.errors.some(error => error.path === 'swarm.waveAllowance' && error.message.includes('at least 12000')))
check('strict settings reject unknown swarm keys', !SettingsSchema().safeParse({ swarm: { invented: 1 } }).success)
const edit = validateSettingsFileContent(JSON.stringify({ swarm: { seatAllowance: 12 } }))
check('edit validation names the same floor', !edit.isValid && edit.error.includes('swarm.seatAllowance: Value must be at least 1000'))
set({ seatAllowance: 60000, waveAllowance: undefined })
check('an omitted wave allowance still covers the chosen seat allowance', seam.swarmLimits().waveAllowance === 60000)
set({ seatAllowance: 20000, waveAllowance: 90000 })
const nextWave = open(join(work, 'next.sqlite'), 'next', seam.swarmLimits())
check('a new wave takes the new settings', nextWave.limits.seatAllowance === 20000 && nextWave.limits.waveAllowance === 90000)
nextWave.close()

let now = 0
const path = join(work, 'budget.sqlite')
const board = open(path, 'budget', chosen, () => now)
const principal = (id: string) => ({ author: { sessionId: 'budget', agentId: id, executionId: 'run' }, name: id })
const author = principal('author')
board.enroll(author)
for (let i = 0; i < 20; i++) assert(board.post(author, { clientOpId: `burst-${i}`, kind: 'result', text: 'x'.repeat(1100) }).ok)
const refused = board.post(author, { clientOpId: 'burst-21', kind: 'result', text: 'Too soon' })
check('the new rate permits twenty posts and refuses the twenty-first', !refused.ok && refused.retryAfter === 6000 && refused.reason.includes('10 a minute, with a burst of 20'))
now = 5999
check('a credit is not restored early', !board.post(author, { clientOpId: 'early', kind: 'result', text: 'Too soon' }).ok)
now = 6000
check('one credit refills at the new rate', board.post(author, { clientOpId: 'refilled', kind: 'result', text: 'Ready' }).ok)
for (let i = 21; i < 150; i++) { now += 6000; assert(board.post(author, { clientOpId: `post-${i}`, kind: 'result', text: 'Ready' }).ok) }
now += 6000
const cap = board.post(author, { clientOpId: 'post-151', kind: 'result', text: 'Past the cap' })
check('the per-seat post cap uses 150 rather than 120', !cap.ok && cap.reason.includes('150 posts'))
const reader = principal('reader')
board.enroll(reader)
assert.throws(() => board.read(reader, { limitTokens: 12001 }), /Board reads allow 1 to 12,000 tokens\./)
check('the store read error names the new ceiling', true)
let own = 0
for (let i = 0; i < 30; i++) { const page = board.read(reader, { limitTokens: 12000 }); own += page.tokens; if (page.reason) break }
check('seat context passes 6000 and refuses at 12000', own > 11900 && own <= 12000 && board.read(reader, {}).events.length === 0)
for (let i = 0; i < 6; i++) {
  const peer = principal(`reader-${i}`)
  board.enroll(peer)
  for (let page = 0; page < 30; page++) if (board.read(peer, { limitTokens: 12000 }).reason) break
}
check('wave context passes 40000 and refuses at 50000', board.view().admitted > 49900 && board.view().admitted <= 50000 && board.read(principal('reader-5'), {}).events.length === 0)
const reopened = open(path, 'budget', DEFAULT_BOARD_LIMITS, () => now)
check('a second store sees the same persisted limits', JSON.stringify(reopened.limits) === JSON.stringify(chosen))
reopened.close()
board.close()

const forecast = open(join(work, 'forecast.sqlite'), 'forecast', chosen)
const peers = ['writer', 'reader'].map(id => ({ author: { sessionId: 'forecast', agentId: id, executionId: 'run' }, name: id }))
peers.forEach(peer => forecast.enroll(peer))
assert(forecast.post(peers[0]!, { clientOpId: 'finding', kind: 'result', text: 'x'.repeat(1100) }).ok)
const packet = forecast.read(peers[0]!, {})
assert(packet.packetId)
let replay = 0
while ((forecast.view().appearances ?? 0) < 4100000) forecast.presented(peers[0]!, [], `request-${replay++}`, [packet.packetId])
check('the forecast ceiling scales past the old four million', forecast.read(peers[1]!, {}).events.length > 0)
while ((forecast.view().appearances ?? 0) < 5000000) forecast.presented(peers[0]!, [], `request-${replay++}`, [packet.packetId])
check('the scaled five-million forecast ceiling refuses more context', forecast.read(peers[1]!, {}).reason?.includes('allowance'))
forecast.close()
runSwarmCommand('off')
console.log(`${checks} swarm limit checks passed`)
process.exit(0)
