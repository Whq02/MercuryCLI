import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BoardEvent, BoardPrincipal } from '../../src/services/crewBoard/contracts.ts'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(suiteHome, 'owner-verbs-home-'))
process.env.MERCURY_CONFIG_DIR = home
const { open } = await import('../../src/services/crewBoard/store.ts')
const { DEFAULT_BOARD_LIMITS } = await import('../../src/services/crewBoard/contracts.ts')
const { CHANNEL_USAGE, parseChannelArgs } = await import('../../src/utils/crew/channelCommand.ts')
let checks = 0
const check = (label: string, value: unknown) => { assert(value, label); console.log(`PASS ${label}`); checks++ }

console.log('§1 the command grammar')
check('general carries its whole body and refuses blank text', parseChannelArgs('general', 'ship it  now\nplease')?.text === 'ship it  now\nplease' && parseChannelArgs('general', '   ') === null)
check('team and whisper take the first token as the target, with an optional @ and quotes for a name with spaces', JSON.stringify(parseChannelArgs('team', '@engine the row is wrong')) === JSON.stringify({ target: 'engine', text: 'the row is wrong' }) && JSON.stringify(parseChannelArgs('whisper', '"lists judge" check row 4')) === JSON.stringify({ target: 'lists judge', text: 'check row 4' }))
check('the body keeps its internal whitespace and newlines', parseChannelArgs('whisper', 'alpha  two  spaces\nand a line')?.text === 'two  spaces\nand a line')
check('the body keeps its tail too: only the separator after the target is taken', parseChannelArgs('whisper', 'Alpha first\nsecond  \n')?.text === 'first\nsecond  \n' && parseChannelArgs('team', '  engine  two words ')?.text === 'two words ')
check('a target without words, or words without a target, answers the usage line', parseChannelArgs('whisper', 'alpha') === null && parseChannelArgs('team', '') === null && CHANNEL_USAGE.whisper === '/whisper <name> <text>' && CHANNEL_USAGE.team === '/team <name> <text>' && CHANNEL_USAGE.general === '/general <text>')

console.log('§2 the target matrix in the store')
{
  let now = 0
  const board = open(join(home, 'verbs.sqlite'), 'verbs', { ...DEFAULT_BOARD_LIMITS, postsPerMinute: 1, postsPerSeat: 2 }, () => now)
  const seat = (agentId: string, name = agentId, team?: string): BoardPrincipal => {
    const principal = { author: { sessionId: 'verbs', agentId, executionId: 'run' }, name, team }
    board.enroll(principal)
    return principal
  }
  const main = seat('main')
  seat('alpha', 'Alpha', 'engine')
  seat('beta', 'Beta', 'engine')
  seat('gamma', 'Gamma', 'view')
  seat('delta', 'Delta')
  seat('docs1', 'Docs', 'view')
  seat('docs2', 'Docs', 'view')
  let serial = 0
  const owner = (channel: 'general' | 'team' | 'whisper', text: string, target?: string, clientOpId = `op${++serial}`) => { now += 1000; return board.postOwner(main, { clientOpId, channel, text, ...(target === undefined ? {} : { target }) }) }
  const event = (id: string): BoardEvent => board.view().events.find(e => e.eventId === id)!
  try {
    assert.throws(() => board.enroll({ author: { sessionId: 'verbs', agentId: 'owner', executionId: 'run' }, name: 'Someone' }), /reserved for the operator/)
    assert.throws(() => board.enroll({ author: { sessionId: 'verbs', agentId: 'imp', executionId: 'run' }, name: 'Owner' }), /reserved for the operator/)
    check('owner is reserved at enrollment by id and by name', !board.seats().some(s => s.agent === 'owner' || s.name.toLowerCase() === 'owner'))

    const general = owner('general', 'Everyone: stop and read.')
    assert(general.ok, JSON.stringify(general))
    const g = event(general.eventId)
    check('general reaches every enrolled crewmate plus main, once each', JSON.stringify(general.recipients) === JSON.stringify(['main', 'alpha', 'beta', 'gamma', 'delta', 'docs1', 'docs2']) && JSON.stringify(g.addresses) === JSON.stringify(['all', 'main']) && g.channel?.kind === 'general')
    check('the owner event carries the owner role, name and id, kind ask, and the body verbatim', g.authorRole === 'owner' && g.authorName === 'owner' && g.author.agentId === 'owner' && g.author.sessionId === 'verbs' && g.kind === 'ask' && g.text === 'Everyone: stop and read.')
    check('main is woken and every other recipient gets the whole body', board.leadMention()?.eventId === general.eventId && board.boundary({ author: { sessionId: 'verbs', agentId: 'gamma', executionId: 'run' }, name: 'Gamma' }, new Set())?.text.includes('Everyone: stop and read.'))

    const team = owner('team', 'Engine: the parser row.', 'ENGINE')
    assert(team.ok, JSON.stringify(team))
    check('a team without a captain reaches all its seats, matched case-insensitively, with the canonical label kept', JSON.stringify(team.recipients) === JSON.stringify(['main', 'alpha', 'beta']) && team.channel.kind === 'team' && team.channel.target === 'engine' && JSON.stringify(event(team.eventId).addresses) === JSON.stringify(['engine', 'main']))
    const appointed = board.assignCaptain(main, 'engine', 'alpha')
    assert(appointed.ok, JSON.stringify(appointed))
    const captained = owner('team', 'Engine: fold and report.', '@engine')
    assert(captained.ok, JSON.stringify(captained))
    check('a team with a captain reaches the captain alone, plus main', JSON.stringify(captained.recipients) === JSON.stringify(['main', 'alpha']))
    const unknownTeam = owner('team', 'Anyone there?', 'parser')
    check('an unknown team refuses without posting and names the usable labels', !unknownTeam.ok && unknownTeam.reason === 'Name one team on the board.' && JSON.stringify(unknownTeam.candidates) === JSON.stringify(['engine', 'view']) && board.view().events.length === 3)

    const byName = owner('whisper', 'Gamma, the view row.', 'gAMMA')
    const byId = owner('whisper', 'Docs one, your row.', 'docs1')
    assert(byName.ok && byId.ok, JSON.stringify([byName, byId]))
    check('a whisper resolves an enrolled name case-insensitively or a stable id, and reaches that seat plus main', JSON.stringify(byName.recipients) === JSON.stringify(['main', 'gamma']) && byName.channel.kind === 'whisper' && byName.channel.target === 'Gamma' && JSON.stringify(byId.recipients) === JSON.stringify(['main', 'docs1']) && byId.channel.kind === 'whisper' && byId.channel.target === 'Docs')
    const ambiguous = owner('whisper', 'Docs, which of you?', 'docs')
    check('a duplicate name refuses and names each id instead of guessing', !ambiguous.ok && ambiguous.reason === 'Name one enrolled crewmate.' && JSON.stringify(ambiguous.candidates) === JSON.stringify(['Docs (docs1)', 'Docs (docs2)']))
    const unknownSeat = owner('whisper', 'Hello?', 'zeta')
    check('an unknown seat refuses and names the crewmates', !unknownSeat.ok && unknownSeat.candidates?.length === 6 && unknownSeat.candidates[0] === 'Alpha (alpha)')
    const toMain = owner('whisper', 'Main, a word.', 'main')
    const toOwner = owner('whisper', 'Owner, a word.', '@owner')
    check('whispering main or owner answers the prompt-line sentence', !toMain.ok && toMain.reason === 'Use the prompt line for main.' && !toOwner.ok && toOwner.reason === 'Use the prompt line for main.')

    const inert = owner('whisper', 'Tell @all and @Beta nothing: this is for you.', 'Gamma')
    assert(inert.ok, JSON.stringify(inert))
    check('a mention inside the body widens nothing', JSON.stringify(inert.recipients) === JSON.stringify(['main', 'gamma']) && JSON.stringify(event(inert.eventId).mentions) === JSON.stringify(['main', 'gamma']))
    const blank = owner('general', '   \n ')
    check('blank text refuses', !blank.ok && blank.reason === 'A post needs text.')

    const again = owner('general', 'Everyone: stop and read.', undefined, 'op1')
    check('the same retry key replays the same event instead of posting twice', again.ok && again.replay && again.eventId === general.eventId && board.view().events.filter(e => e.authorRole === 'owner').length === 6)
    const forged = owner('general', 'Different words.', undefined, 'op1')
    check('a retry key reused for other words refuses', !forged.ok && forged.reason === 'That retry key already names a different post.')
    check('owner posts ride no peer loop guard (one a minute, two a wave, and still every post lands)', board.view().events.filter(e => e.authorRole === 'owner').length === 6)
    const peer = board.postOwner({ author: { sessionId: 'verbs', agentId: 'gamma', executionId: 'run' }, name: 'Gamma' }, { clientOpId: 'peer-try', channel: 'general', text: 'I am the owner now.' })
    check('a peer cannot post as owner', !peer.ok && peer.reason === 'Only the operator command path posts as owner.')
  } finally { board.close() }
}

console.log('§3 the seam and the command body without a focused session')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(home); bootstrap.setCwdState(home); bootstrap.setProjectRoot(home)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { runChannelCommand } = await import('../../src/utils/crew/channelCommand.ts')
check('without a live wave the verb answers the /swarm on door', (await runChannelCommand('general', 'hello')).type === 'text' && JSON.stringify(await runChannelCommand('general', 'hello')).includes('/swarm on'))
runSwarmCommand('on')
await seam.latchSwarmAgent('alpha', 'Alpha', false, false, 'engine')
await seam.latchSwarmAgent('beta', 'Beta', false, false, 'engine')
{
  const sent = await runChannelCommand('whisper', 'alpha  Read the row,\nthen answer.')
  const board = seam.swarmStore()!
  const posted = board.view().events.find(e => e.authorRole === 'owner')!
  check('the plain-world verb posts through the seam, answers skip (no echo), and keeps the body', sent.type === 'skip' && posted.channel?.kind === 'whisper' && posted.channel.target === 'Alpha' && posted.text === 'Read the row,\nthen answer.')
  check('the lead is woken by its own whisper copy', board.leadMention()?.eventId === posted.eventId)
  const refused = await runChannelCommand('team', 'parser nobody home')
  check('a refusal is a local line that names the candidates', refused.type === 'text' && refused.value === 'Name one team on the board. engine')
  const usage = await runChannelCommand('whisper', 'alpha')
  check('bad grammar answers the usage line locally', usage.type === 'text' && usage.value === '/whisper <name> <text>')
}
{
  const { builtinCommands, sessionSeatCommandTable, commandSeat } = await import('../../src/commands.ts')
  const verbs = builtinCommands().filter(c => ['general', 'team', 'whisper'].includes(c.name))
  check('the three verbs are screen-seat local commands with model invocation disabled, never served by the runner table', verbs.length === 3 && verbs.every(c => c.type === 'local' && commandSeat(c) === 'screen' && c.disableModelInvocation === true && c.supportsNonInteractive === false) && !sessionSeatCommandTable(builtinCommands()).some(c => ['general', 'team', 'whisper'].includes(c.name)))
  const store = readFileSync(fileURLToPath(new URL('../../src/services/crewBoard/store.ts', import.meta.url)), 'utf8')
  check('only the trusted store arm mints the owner role', (store.match(/authorRole: 'owner'/g) ?? []).length === 1 && !/post\(p, input, delivery[\s\S]*?authorRole: 'owner'[\s\S]*?postOwner\(/.test(store))
}
{
  const { createUserMessage, createAssistantAPIErrorMessage } = await import('../../src/utils/messages/factories.ts')
  const { promptBehindAuthWall } = await import('../../src/utils/messages/authWallHold.ts')
  const notice = createUserMessage({ content: '<crew-board>{"name":"owner","kind":"ask","text":"hello there"}</crew-board>', isVirtual: true, origin: { kind: 'task-notification' } })
  const nudge = createUserMessage({ content: 'A board post is waiting.', isMeta: true })
  const wall = createAssistantAPIErrorMessage({ content: 'Sign in to continue.', error: 'authentication_failed' })
  const spoken = createUserMessage({ content: 'fix the parser row' })
  check('a board notice behind the auth wall is never restored into the composer: a virtual row is not the operator\'s words', promptBehindAuthWall([notice, nudge, wall]) === null && promptBehindAuthWall([spoken, notice, nudge, wall])?.text === 'fix the parser row')
  const echo = createUserMessage({ content: '<command-message>swarm on</command-message><command-name>/swarm on</command-name><command-args>on</command-args>' })
  const stdout = createUserMessage({ content: '<local-command-stdout>Swarm on for new crewmates</local-command-stdout>' })
  check('a finished local command is not a prompt behind the wall: neither its output nor its echo is restored', promptBehindAuthWall([spoken, echo, stdout, notice, nudge, wall]) === null && promptBehindAuthWall([echo, createUserMessage({ content: 'expanded skill prompt', isMeta: true }), wall])?.text === '/swarm on on')
}

console.log('§4 the typed verb reaches the board from the real screen')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') console.log(`[SKIP] §4 needs the POSIX PTY capture driver; this host has ${driver.kind}`)
else {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
  const captures = arg('--captures') ?? join(suiteHome, 'owner-verbs-captures')
  mkdirSync(captures, { recursive: true })
  const { CONFIG_HOME, RUNTIME_CWD, SID, scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')
  const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
  const { readSessionWorkers } = await import('../../src/daemon/concourseWorkers.ts')
  const boardPath = join(getProjectDir(RUNTIME_CWD), SID, 'boards', 'wave', 'board.sqlite')
  writeFileSync(join(CONFIG_HOME, 'settings.json'), JSON.stringify({ swarm: { enabled: true } }))
  try {
    const cols = Number(arg('--cols') ?? 120)
    const config = scenario('resume-2turn', cols, 44)
    const gridPath = join(captures, `owner-verbs-${cols}.grid.json`)
    const configPath = join(captures, `owner-verbs-${cols}.json`)
    writeFileSync(configPath, JSON.stringify({ ...config, total: 220, out: gridPath, readyText: ['Name one enrolled crewmate'], readySettleTicks: 3, sends: [
      { atTick: 999, awaitText: 'Type a prompt', requireAwait: true, minTick: 5, awaitSettleTicks: 2, data: '/swarm on' },
      { atTick: 999, awaitText: '/swarm on', requireAwait: true, minTick: 5, awaitSettleTicks: 2, data: '\r' },
      { atTick: 999, awaitText: 'Swarm on for new crewmates', requireAwait: true, minTick: 5, awaitSettleTicks: 6, data: '/whisper Poster hello there' },
      { atTick: 999, awaitText: '/whisper Poster hello there', requireAwait: true, minTick: 5, awaitSettleTicks: 2, data: '\r' },
      { atTick: 999, awaitText: 'Swarm on for new crewmates', requireAwait: true, minTick: 5, awaitSettleTicks: 8, data: '/whisper Nobody hi' },
      { atTick: 999, awaitText: '/whisper Nobody hi', requireAwait: true, minTick: 5, awaitSettleTicks: 2, data: '\r' },
    ] }))
    const tee = join(captures, `owner-verbs-${cols}.tee.bin`)
    writeFileSync(tee, '')
    let enrolled = false
    const observer = watch(tee, () => {
      if (enrolled || !readFileSync(tee).includes(Buffer.from('Swarm on for new crewmates'))) return
      enrolled = true
      const board = open(boardPath, SID)
      try { board.enroll({ author: { sessionId: SID, agentId: `poster-${cols}`, executionId: 'run' }, name: 'Poster', team: 'lists' }) } finally { board.close() }
    })
    let stderr = ''
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(driver.python, [fileURLToPath(new URL('../ui/vshot.py', import.meta.url)), configPath], { env: { ...process.env, VSHOT_TEE: tee }, timeout: vshotBudgetMs(150000), stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('exit', resolve)
    }).finally(() => observer.close())
    assert(enrolled, 'the fixture never observed the board switch')
    assert.equal(code, 0, stderr)
    const board = open(boardPath, SID, undefined, Date.now, true)
    try {
      const owners = board.view().events.filter(e => e.authorRole === 'owner')
      check('the typed whisper is one owner event on the board, addressed to the seat and main', owners.length === 1 && owners[0]!.channel?.kind === 'whisper' && owners[0]!.channel.target === 'Poster' && owners[0]!.text === 'hello there' && JSON.stringify(owners[0]!.mentions) === JSON.stringify(['main', `poster-${cols}`]))
      check('the refused whisper posted nothing', board.view().events.every(e => e.text !== 'hi'))
    } finally { board.close() }
    const transcript = join(getProjectDir(RUNTIME_CWD), `${SID}.jsonl`)
    const rows = existsSync(transcript) ? readFileSync(transcript, 'utf8') : ''
    const carrying = rows.split('\n').filter(line => line.includes('hello there'))
    check('no slash echo, stdout receipt or prompt row of the verb reaches the runner transcript', !rows.includes('<command-name>/whisper') && !rows.includes('Name one enrolled crewmate') && carrying.every(line => !line.includes('command-name') && !line.includes('local-command-stdout') && !line.includes('"type":"user"')))
    check('the board notice never rides a later prompt: no user row carries <crew-board>', !rows.split('\n').some(line => line.includes('"type":"user"') && line.includes('<crew-board>')))
    const grid = JSON.parse(readFileSync(gridPath, 'utf8'))
    const lines: string[] = grid.grid.map((cells: { c: string }[]) => cells.map(cell => cell.c || ' ').join(''))
    writeFileSync(join(captures, `owner-verbs-${cols}.txt`), lines.join('\n'))
    check('the refusal is painted on the screen with its candidate', lines.some(line => line.includes('Name one enrolled crewmate. Poster (poster-' + cols + ')')))
    check('the composer is empty again after the receipt, not filled with the board notice', !lines.some(line => line.includes('<crew-board>')))
    const receipts = lines.filter(line => /\d\d:\d\d:\d\d \[owner\] @Poster hello there/.test(line))
    check('the sender receipt is painted once, as [owner] @Poster hello there, with swarm chat off and no [Crewboard] copy', receipts.length === 1 && !lines.some(line => line.includes('[Crewboard] owner')) && carrying.filter(line => line.includes('"crew_chat"')).length === 1)
  } finally {
    const dir = process.env.MERCURY_DAEMON_DIR
    if (dir?.endsWith(`mercury-render-daemon-${process.pid}`)) {
      for (const worker of Object.values(readSessionWorkers(dir))) if (worker.pid && worker.endedAt === undefined) { try { process.kill(worker.pid, 'SIGTERM') } catch {} }
      try { const pid = Number(readFileSync(join(dir, 'daemon.pid'), 'utf8').trim()); if (pid > 1) process.kill(pid, 'SIGTERM') } catch {}
    }
    cleanupScenario('resume-2turn')
  }
}
console.log(`prove-swarm-owner-verbs: ${checks} checks green`)
