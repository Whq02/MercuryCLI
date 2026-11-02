#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const { channelTargetCandidates, findChannelTargetQuery, generateCommandSuggestions, rankChannelTargets } = await import('../../src/utils/suggestions/commandSuggestions.js')

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    console.log(`\nprove-swarm-channel-completion: FAILED at check ${passed + 1}`)
    process.exit(1)
  }
  passed++
}
const j = (value: unknown): string => JSON.stringify(value)

console.log('§1 the target token: where completion is on, and where the body begins')
check('/whisper completes a seat from the first token', j(findChannelTargetQuery('/whisper al', 11)) === j({ kind: 'seat', start: 9, query: 'al' }))
check('/team completes a team label', j(findChannelTargetQuery('/team eng', 9)) === j({ kind: 'team', start: 6, query: 'eng' }))
check('/swarmchat team completes the same team labels', j(findChannelTargetQuery('/swarmchat team vi', 18)) === j({ kind: 'team', start: 16, query: 'vi' }))
check('a leading @ is part of the address, not the key', findChannelTargetQuery('/whisper @Al', 12)?.query === 'Al')
check('an empty token offers every candidate', j(findChannelTargetQuery('/whisper ', 9)) === j({ kind: 'seat', start: 9, query: '' }))
check('an open quote keeps completing a name with spaces', findChannelTargetQuery('/whisper "lists j', 17)?.query === 'lists j')
check('once the body begins, completion stops', findChannelTargetQuery('/whisper alpha hello', 20) === null && findChannelTargetQuery('/whisper "lists judge" hi', 25) === null)
check('/general has no target token', findChannelTargetQuery('/general hi', 11) === null)
check('a cursor away from the end completes nothing', findChannelTargetQuery('/whisper al', 5) === null)
check('other commands are untouched', findChannelTargetQuery('/sessions al', 12) === null && findChannelTargetQuery('/swarmchat all', 14) === null)
check('explicit on and off have no channel target to complete', ['/swarmchat on', '/swarmchat off', '/swarmchat on ', '/swarmchat off '].every(input => findChannelTargetQuery(input, input.length) === null))

console.log('§2 candidates come from the live roster, never from main or owner')
const seats = [
  { agent: 'main', name: 'main' },
  { agent: 'alpha', name: 'Alpha', team: 'engine' },
  { agent: 'beta', name: 'Beta', team: 'engine', captain: true as const },
  { agent: 'gamma', name: 'Gamma', team: 'view' },
  { agent: 'docs1', name: 'Docs', team: 'view' },
  { agent: 'docs2', name: 'Docs', team: 'view' },
  { agent: 'lj', name: 'lists judge', team: 'lists' },
  { agent: 'solo', name: 'Solo' },
]
const seatCandidates = channelTargetCandidates('seat', seats)
check('main is never a whisper choice', !seatCandidates.some(c => c.key === 'main'))
check('a unique name inserts itself; its team and captain duty ride the description', j(seatCandidates.find(c => c.key === 'Beta')) === j({ key: 'Beta', insert: 'Beta', description: 'captain · engine' }) && seatCandidates.find(c => c.key === 'Solo')?.description === '')
check('a duplicate name is told apart by its id and inserts the id', j(seatCandidates.filter(c => c.key.startsWith('Docs')).map(c => [c.key, c.insert])) === j([['Docs (docs1)', 'docs1'], ['Docs (docs2)', 'docs2']]))
check('a name with spaces inserts quoted', seatCandidates.find(c => c.key === 'lists judge')?.insert === '"lists judge"')
const teamCandidates = channelTargetCandidates('team', seats)
check('team labels are the distinct labels of enrolled seats, with the captain or the headcount beside', j(teamCandidates) === j([{ key: 'engine', insert: 'engine', description: 'captain Beta' }, { key: 'view', insert: 'view', description: '3 crewmates' }, { key: 'lists', insert: 'lists', description: '1 crewmate' }]))
check('all and general are never team labels', channelTargetCandidates('team', [{ agent: 'x', name: 'X', team: 'all' }, { agent: 'y', name: 'Y', team: 'General' }]).length === 0)
check('a roster that grows is read on the next keystroke, not cached', channelTargetCandidates('seat', [...seats, { agent: 'late', name: 'Late' }]).some(c => c.key === 'Late'))

console.log('§3 ranking is slash completion\u2019s: exact, then prefix, then a name part, then fuzzy')
const names = (query: string) => rankChannelTargets(query, seatCandidates).map(item => item.displayText)
check('an empty query lists everyone alphabetically', j(names('')) === j(['Alpha', 'Beta', 'Docs (docs1)', 'Docs (docs2)', 'Gamma', 'lists judge', 'Solo']))
check('an exact name outranks a longer prefix match', j(names('alpha')) === j(['Alpha']) && names('al')[0] === 'Alpha')
check('matching is case-insensitive', names('BETA')[0] === 'Beta' && names('docs').length === 2)
check('a name part matches after prefixes', names('judge')[0] === 'lists judge' && j(names('li')) === j(['lists judge']))
check('a fuzzy match is offered last', names('alpa')[0] === 'Alpha')
check('nothing matches nothing', names('zzz').length === 0)
check('an item carries what to insert, apart from what it shows', rankChannelTargets('docs', seatCandidates).every(item => typeof item.metadata === 'string' && item.id === `channel-${item.metadata}`))

console.log('§4 the composer fills only the target and never sends')
const hook = readFileSync(join(REPO, 'src/hooks/useTypeahead.tsx'), 'utf8')
const accept = hook.slice(hook.indexOf("case 'channel-target': {"), hook.indexOf("case 'agent': {"))
check('the accept case rebuilds the line as the command, the target and one trailing space', accept.includes('const rebuilt = `${currentInput.slice(0, target.start)}${String(suggestion.metadata ?? suggestion.displayText)} `') && accept.includes('setCursorOffset(rebuilt.length)'))
check('accepting never submits', !accept.includes('onSubmit'))
check('the candidates read the focused connector\u2019s live roster, or the local board without one', hook.includes("const seats = (hasFocusedSession() ? getFocusedSessionConnector().swarmBoard?.()?.seats : swarmView().seats) ?? []") && hook.includes("publish(items, 'channel-target', { selected: 0 })"))
check('a roster change re-ranks the open target without touching the typed line', hook.includes('subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))(() => {') && hook.includes('if (findChannelTargetQuery(inputRef.current, cursorOffsetRef.current)) setRosterStamp(stamp => stamp + 1)') && hook.includes('}, [input, mode, suppressSuggestions, commands, rosterStamp])'))
const prompt = readFileSync(join(REPO, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')
check('Enter on a selected candidate accepts it instead of sending', prompt.includes("typeahead.suggestionType === 'channel-target')"))
check('the footer knows the type', readFileSync(join(REPO, 'src/components/PromptInput/PromptInputFooterSuggestions.tsx'), 'utf8').includes("| 'channel-target'"))

console.log('§5 the three verbs in the catalogue')
const { builtinCommands } = await import('../../src/commands.js')
const byName = new Map(builtinCommands().map(command => [command.name, command]))
const swarmchat = byName.get('swarmchat')!
check('the swarmchat candidate carries on and off in its argument hint', swarmchat.argumentHint === '[on|off|all|team <name>|main]' && generateCommandSuggestions('/swarmch', [...byName.values()])[0]?.metadata === swarmchat)
check('general: Post to every crewmate on the board, <text>', byName.get('general')?.description === 'Post to every crewmate on the board' && byName.get('general')?.argumentHint === '<text>')
check('team: Post to one team on the board, <name> <text>', byName.get('team')?.description === 'Post to one team on the board' && byName.get('team')?.argumentHint === '<name> <text>')
check('whisper: Post to one crewmate on the board, <name> <text>', byName.get('whisper')?.description === 'Post to one crewmate on the board' && byName.get('whisper')?.argumentHint === '<name> <text>')
check('no aliases and no /main', ['general', 'team', 'whisper'].every(name => (byName.get(name)?.aliases ?? []).length === 0) && !byName.has('main'))

console.log(`\nprove-swarm-channel-completion: ALL PASS (${passed} checks)`)
process.exit(0)
