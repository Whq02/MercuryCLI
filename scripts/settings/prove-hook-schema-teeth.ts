#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'hook-teeth-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { parseSettingsFile } = await import('../../src/utils/settings/settings.ts')
const { readHooksMap } = await import('../../src/schemas/hooks.ts')
const { HOOK_EVENTS, hookEventTable } = await import('../../src/utils/hooks/contract.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

let n = 0
type Entry = Record<string, unknown>
const parseHooks = (hooks: unknown, event = 'tool.before'): { entries: Entry[]; errors: Array<{ path?: string; message: string }>; all: Record<string, unknown> } => {
  const path = join(HOME, `case-${n++}.json`)
  writeFileSync(path, JSON.stringify({ events: { hooks } }))
  const { settings, errors } = parseSettingsFile(path)
  const all = (settings?.events?.hooks ?? {}) as Record<string, unknown>
  return { entries: (all[event] ?? []) as Entry[], errors: errors as Array<{ path?: string; message: string }>, all }
}
const texts = (entries: Entry[]): string => JSON.stringify(entries.map(e => e.run ?? e.question ?? e.crewmate))
const errorWords = (errors: Array<{ message: string }>): string => errors.map(e => e.message).join(' | ')

section('§1 a clean entry parses byte-faithfully')
{
  const clean = parseHooks({ 'tool.before': [{ match: 'Bash|Read', run: 'echo ok', timeout: 30 }] })
  check('a clean hooks block parses with zero errors', clean.errors.length === 0, errorWords(clean.errors))
  const entry = clean.entries[0]
  check('the match, run and timeout survive as given, nothing filled in', entry?.match === 'Bash|Read' && entry?.run === 'echo ok' && entry?.timeout === 30 && Object.keys(entry ?? {}).sort().join(',') === 'match,run,timeout', JSON.stringify(entry))
  const none = parseHooks({ 'tool.before': [{ run: 'echo everywhere' }] })
  check('an entry without match is legal (it matches everything)', none.errors.length === 0 && none.entries.length === 1)
  const question = parseHooks({ 'turn.answer': [{ question: 'Did it run the tests? $EVENT', model: 'fixture-model' }] }, 'turn.answer')
  check('a question entry with a model parses', question.errors.length === 0 && String(question.entries[0]?.question).startsWith('Did it') && question.entries[0]?.model === 'fixture-model')
  const crewmate = parseHooks({ 'turn.answer': [{ crewmate: 'Check the tests ran', timeout: 120, once: true, name: 'tests ran' }] }, 'turn.answer')
  check('a crewmate entry with once and a name parses', crewmate.errors.length === 0 && crewmate.entries[0]?.name === 'tests ran' && crewmate.entries[0]?.once === true)
  const daemon = parseHooks({ 'session.state': [{ match: 'needs-you|stalled', run: 'notify', background: true }] }, 'session.state')
  check('a background run entry on session.state parses', daemon.errors.length === 0 && daemon.entries[0]?.background === true)
  const watch = parseHooks({ 'file.changed': [{ watch: ['.env', 'config.json'], run: 'reload' }] }, 'file.changed')
  check('a watch list on file.changed parses', watch.errors.length === 0 && Array.isArray(watch.entries[0]?.watch))
}

section('§2 a faulty entry is named and dropped WHOLE; the rest of the file applies; nothing widens')
{
  const cases: Array<[string, unknown, RegExp]> = [
    ['an uncompilable match', { match: 'startu[p', run: 'echo broken' }, /match is not a valid regular expression: "startu\[p"/],
    ['a typo in a field name', { mather: 'resume', run: 'echo scoped' }, /Unrecognized key: "mather"/],
    ['a wrong-typed match (would widen to everything)', { match: 42, run: 'echo widen' }, /match: .*expected string/],
    ['a beyond-bound timeout', { run: 'echo slow', timeout: 999_999_999 }, /timeout: .*2147483/],
    ['two kinds in one entry', { run: 'a', question: 'b' }, /exactly one of run, question or crewmate/],
    ['no kind at all', { match: 'Bash', timeout: 3 }, /exactly one of run, question or crewmate/],
    ['shell on a question', { question: 'why?', shell: 'bash' }, /shell belongs to a run hook/],
    ['model on a run', { run: 'echo', model: 'x' }, /model belongs to a question or crewmate hook/],
    ['a condition field the entry does not have', { match: 'Bash', if: 'Bash(git *)', run: 'echo' }, /Unrecognized key: "if"/],
    ['watch outside file.changed', { watch: ['x'], run: 'echo' }, /watch belongs to file.changed, not tool.before/],
    ["a rule reading a tool's arguments the matcher cannot read", { match: 'Sleep(10)', run: 'echo' }, /not the arguments of Sleep/],
    ['MCP arguments have no permission content matcher', { match: 'mcp__files__read(path:src)', run: 'echo' }, /not the arguments of mcp__files__read/],
    ['failClosed on a background hook', { run: 'echo', background: true, failClosed: true }, /failClosed belongs to a foreground hook/],
    ['a wrong-typed failClosed', { run: 'echo', failClosed: 'yes' }, /failClosed: .*expected boolean/],
  ]
  for (const [label, bad, words] of cases) {
    const result = parseHooks({ 'tool.before': [bad, { match: 'Bash', run: 'echo fine' }] })
    check(`${label}: one named fault`, result.errors.length === 1 && words.test(result.errors[0]?.message ?? ''), errorWords(result.errors))
    check(`${label}: the faulty entry is gone and the clean one stays`, result.entries.length === 1 && result.entries[0]?.run === 'echo fine' && result.entries[0]?.match === 'Bash', texts(result.entries))
  }
  const noMatch = parseHooks({ 'turn.start': [{ match: 'x', run: 'echo' }, { run: 'echo fine' }] }, 'turn.start')
  check('match on an event with no match field is a named fault; the entry drops', noMatch.errors.length === 1 && /turn.start has no match field/.test(noMatch.errors[0]?.message ?? '') && noMatch.entries.length === 1 && noMatch.entries[0]?.run === 'echo fine', errorWords(noMatch.errors))
  const kindOnDaemon = parseHooks({ 'session.state': [{ question: 'is it bad?' }, { run: 'echo fine' }] }, 'session.state')
  check('a question on session.state is a named fault (run hooks only); the run entry stays', kindOnDaemon.errors.length === 1 && /session.state runs run hooks only/.test(kindOnDaemon.errors[0]?.message ?? '') && kindOnDaemon.entries.length === 1, errorWords(kindOnDaemon.errors))
  const foreground = parseHooks({ 'session.end': [{ run: 'bye', background: true }, { run: 'echo fine' }] }, 'session.end')
  check('background on session.end is a named fault (the runner is leaving); the other entry stays', foreground.errors.length === 1 && /session.end runs in the foreground/.test(foreground.errors[0]?.message ?? '') && foreground.entries.length === 1, errorWords(foreground.errors))
  const path = parseHooks({ 'tool.after': [{ run: 'echo fine' }, { match: '(', run: 'x' }] }, 'tool.after')
  check('the fault names its path: events.hooks.tool.after.1', path.errors[0]?.path === 'events.hooks.tool.after.1', JSON.stringify(path.errors))
  const closedEnd = parseHooks({ 'turn.end': [{ match: 'failed', run: 'echo', failClosed: true }, { match: 'failed', run: 'echo fine' }] }, 'turn.end')
  check('failClosed on an event no answer may block is a named fault; the plain entry stays', closedEnd.errors.length === 1 && /turn.end cannot be blocked; remove failClosed/.test(closedEnd.errors[0]?.message ?? '') && closedEnd.entries.length === 1, errorWords(closedEnd.errors))
  const ruleOnStatus = parseHooks({ 'turn.end': [{ match: 'Bash(git *)', run: 'echo' }, { match: 'failed', run: 'echo fine' }] }, 'turn.end')
  check("a rule with arguments on an event that matches a status, not a tool call, is a named fault", ruleOnStatus.errors.length === 1 && /turn.end matches status, not a tool call's arguments: "Bash\(git \*\)"/.test(ruleOnStatus.errors[0]?.message ?? '') && ruleOnStatus.entries.length === 1, errorWords(ruleOnStatus.errors))
  const ruled = parseHooks({ 'tool.before': [{ match: 'Bash(git *)', run: 'echo', failClosed: true }, { match: 'Edit(src/**)|Write(src/**)', question: 'fine? $EVENT' }, { match: 'Bash(*)', run: 'echo all' }], 'permission.ask': [{ match: 'Read(~/secrets/**)', run: 'echo', failClosed: true }] })
  check('a rule with arguments, alone or joined with |, and failClosed on a blockable event parse byte-faithfully', ruled.errors.length === 0 && ruled.entries.length === 3 && ruled.entries[0]?.match === 'Bash(git *)' && ruled.entries[0]?.failClosed === true && ruled.entries[1]?.match === 'Edit(src/**)|Write(src/**)' && (ruled.all['permission.ask'] as Entry[]).length === 1, errorWords(ruled.errors))
  const families = ['Crewmate(mercury-scout)', 'WebFetch(domain:example.com)', 'WebFetch(domain:*.example.com)', 'mcp__files', 'mcp__files__*', 'Crewmate(mercury-scout)|WebFetch(domain:example.com)|mcp__files__*']
  const supported = parseHooks({ 'tool.before': families.map(match => ({ match, run: 'echo' })) })
  check('crewmate type, fetch domain and MCP server matchers load byte-faithfully', supported.errors.length === 0 && JSON.stringify(supported.entries.map(entry => entry.match)) === JSON.stringify(families), errorWords(supported.errors))
}

section('§3 an unknown event name is a named fault; the other events load')
{
  const unknown = parseHooks({ NotAnEvent: [{ run: 'echo never' }], 'tool.before': [{ run: 'echo fine' }] })
  check('an unknown event name is one named fault', unknown.errors.length === 1 && /NotAnEvent is not a hook event Mercury fires/.test(unknown.errors[0]?.message ?? ''), errorWords(unknown.errors))
  check('…its entries never load, and the other event keeps its entry', unknown.all.NotAnEvent === undefined && unknown.entries.length === 1 && unknown.entries[0]?.run === 'echo fine', JSON.stringify(unknown.all))
  const nested = parseHooks({ 'tool.before': [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo nested' }] }, { run: 'echo fine' }] })
  check('a nested group under an event is an entry with unknown fields: named and dropped; the flat entry stays', nested.errors.length === 1 && nested.entries.length === 1 && nested.entries[0]?.run === 'echo fine', errorWords(nested.errors))
  for (const event of HOOK_EVENTS) {
    const sample = hookEventTable[event].match === undefined ? { run: 'echo' } : { match: 'x', run: 'echo' }
    const parsed = parseHooks({ [event]: [sample] }, event)
    check(`${event} is a known event: a run entry loads with zero errors`, parsed.errors.length === 0 && parsed.entries.length === 1, errorWords(parsed.errors))
  }
}

section('§4 readHooksMap (the frontmatter road) names each fault and keeps the rest')
{
  const reading = readHooksMap({
    'tool.before': [{ match: 'startu[p', run: 'echo broken' }, { match: 'Bash', run: 'echo fine' }],
    Nope: [{ run: 'x' }],
    'turn.answer': [{ question: 'ok?' }],
  })
  check('two faults named, in the frontmatter words', reading.faults.length === 2 && reading.faults.some(f => /tool.before\[0\]: match is not a valid regular expression/.test(f)) && reading.faults.some(f => /^Nope: Nope is not a hook event Mercury fires/.test(f)), JSON.stringify(reading.faults))
  check('the clean entries of both events load', reading.hooks['tool.before']?.length === 1 && reading.hooks['tool.before']?.[0]?.run === 'echo fine' && reading.hooks['turn.answer']?.length === 1, JSON.stringify(reading.hooks))
  check('a non-object hooks block is one fault and no hooks', readHooksMap('nope').hooks['tool.before'] === undefined && readHooksMap('nope').faults.length === 1)
  check('an absent block is no hooks and no fault', readHooksMap(undefined).faults.length === 0)
}

section('§5 THE DOCUMENTED GRAMMAR — the schema accepts every match the runtime matcher accepts')
{
  const { matchesPattern } = await import('../../src/utils/hooks/matching.ts')
  const { matcherCompiles, matcherShape } = await import('../../src/utils/hooks/matcherGrammar.ts')
  const star = parseHooks({ 'tool.before': [{ match: '*', run: 'echo every tool' }] })
  check('"*" (docs/HOOKS.md: matches everything) parses with zero errors and survives as written', star.errors.length === 0 && star.entries[0]?.match === '*', errorWords(star.errors))
  const empty = parseHooks({ 'tool.before': [{ match: '', run: 'echo every tool' }] })
  check('"" (the empty match) parses with zero errors and survives', empty.errors.length === 0 && empty.entries[0]?.match === '', errorWords(empty.errors))
  for (const matcher of ['*', '', 'Bash', 'Bash|Read', '^(Read|Edit)$', 'mcp__.*']) {
    check(`the schema and the runtime agree on ${JSON.stringify(matcher)}`, matcherCompiles(matcher) && (matcher === '' || matcher === '*' ? await matchesPattern('Bash', matcher) : matcherShape(matcher) !== 'regex' || await matchesPattern('Read', matcher) === new RegExp(matcher).test('Read')))
  }
  check('"*" is the runtime\'s match-everything, never a regex', matcherShape('*') === 'everything' && await matchesPattern('Bash', '*') && await matchesPattern('Write', '*'))
  check('an uncompilable regex is refused by both', !matcherCompiles('startu[p') && !await matchesPattern('startup', 'startu[p') && parseHooks({ 'tool.before': [{ match: 'startu[p', run: 'echo x' }] }).errors.length > 0)
  check('a permission rule is its own shape, and the runtime reads it as one', matcherShape('Bash(git *)') === 'rules' && matcherShape('Edit(*.rs)|Write(*.rs)') === 'rules' && matcherCompiles('Bash(git *)') && await matchesPattern('Bash', 'Bash(git *)', { command: 'git push' }))
  check('Bash(*) is the whole tool, as a permission rule reads it, not an uncompilable regex', matcherShape('Bash(*)') === 'rules' && matcherCompiles('Bash(*)') && await matchesPattern('Bash', 'Bash(*)', { command: 'ls' }) && parseHooks({ 'tool.before': [{ match: 'Bash(*)', run: 'echo x' }] }).errors.length === 0)
  check('a regex with a group is a regex still: no tool name opens it', matcherShape('^(Read|Edit)$') === 'regex' && matcherShape('(Read|Edit)') === 'regex' && matcherShape('mcp__.*') === 'regex')
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-hook-schema-teeth: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-hook-schema-teeth: all green')
