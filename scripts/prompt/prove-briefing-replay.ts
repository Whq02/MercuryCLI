#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answeredWith } from '../lib/rows.ts'
import { captureBriefing, dist, reminderTextsOf, systemTextOf, type ChatFunction } from './_briefingCapture.ts'

const fixtures = join(import.meta.dir, 'fixtures', 'briefing-replay')
const recorded = JSON.parse(readFileSync(join(fixtures, 'recorded-calls.json'), 'utf8')) as { calls: Array<{ run: string; name: string; keys: string[] }> }
const baseTools = JSON.parse(readFileSync(join(fixtures, 'base-tools-1.0.0.json'), 'utf8')) as ChatFunction[]
const baseSystem = readFileSync(join(fixtures, 'base-system-1.0.0.txt'), 'utf8')
const baseReminders = readFileSync(join(fixtures, 'base-reminders-1.0.0.txt'), 'utf8').split('\n=====\n')

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'it', 'its', 'as', 'at', 'by', 'be', 'that', 'this', 'when', 'your', 'you', 'not', 'never', 'only', 'one', 'from', 'into', 'what', 'their', 'them', 'they', 'then', 'than', 'every', 'each', 'any', 'all', 'which', 'who', 'has', 'have', 'had', 'does', 'do', 'did', 'was', 'were', 'will', 'can', 'may', 'so', 'if', 'but', 'no', 'nor', 'own', 'use', 'before', 'after', 'through', 'over', 'under', 'out', 'up', 'how', 'where', 'there', 'here', 'such', 'both', 'more', 'most', 'other', 'some', 'same', 'very', 'just', 'also', 'again', 'once', 'ever', 'still', 'even'])
const words = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[`"'“”‘’]/g, ' ').split(/[^a-z0-9_./:-]+/).filter(word => word.length >= 3 && !STOP.has(word)))
const normalizeText = (text: string): string => text
  .replace(/\/(?:private\/tmp|tmp|Users|home)\/[^\s`)]+/g, '<path>')
  .replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')
  .replace(/capsule-digest:[0-9a-f]+/g, 'capsule-digest:<digest>')
  .replace(/Today's date is [0-9-]+/g, "Today's date is <date>")
  .replace(/Node v[0-9.]+/g, 'Node <v>')
  .replace(/Python [0-9.]+/g, 'Python <v>')
  .replace(/Darwin [0-9.]+/g, 'Darwin <v>')

const CONSTRAINTS: Record<string, string[]> = {
  Bash: ['stdout and stderr merged', 'operator does not reliably see it', 'Exited with code', 'exit 1', 'no matches found', 'run_in_background', 'Never poll', 'max_output_chars', 'working directory persists', 'variables, functions and options do not', '&&', 'bare newline does not separate'],
  Read: ['numbered from 1', '2000 lines', 'offset', 'limit', 'ranges', 'lossless', 'Never edit unseen clipped text', 'OCR', 'pages', 'Notebooks', 'mercury://', 'WebFetch', 'outline', 'line_anchors'],
  Edit: ['old_string', 'new_string', 'replace_all', 'hunks', 'append', 'section', 'indentation', 'line-number prefix', 'stale or unread', 'expected_anchor', 'fa:', 'ra:', 'do not reread'],
  Write: ['overwritten', 'Read has to have read the file first', 'entire file', 'syntax error', 'Documentation files', 'never proactively'],
  Grep: ['ripgrep', 'braces need escaping', 'PCRE2', 'literal: true', 'documents', '20 documents'],
  Glob: ['glob patterns', 'newest modification first', 'Ignore files apply'],
  Eval: ['retained', 'One call is one cell', 'reaped', 'never retry a denial', 'nonzero is a value', 'timeoutSeconds', 'Full helper signatures'],
  ChangeSet: ['apply', 'preview', 'status', 'discard', 'expected_anchor', 'hunks', 'edits', 'delete', 'move', 'new_path', 'disjoint', 'writes nothing', 'noChangePaths', '16 files/set', '32 hunks/file', '128 hunks/set', '4MB', '16 retained plans', '30-minute', 'Write', 'NotebookEdit', 'Bash'],
  ToolSearch: ['Deferred tools:', 'select:', 'keyword', 'loads nothing', 'already in your tool list'],
}

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ': ' + detail : ''}`)
}
check('the built product is present', existsSync(dist))
if (!existsSync(dist)) process.exit(1)

console.log('\n── §1 the recorded tool calls of the 1.0.0 benchmark against the tip\'s first call ──')
const first = await captureBriefing('Read README.md and state its first heading.', [{ kind: 'text', text: 'FIRST-CALL-DONE' }], 2)
check('the fixture session completes and its first call is captured', first.code === 0 && answeredWith(first.stdout, 'FIRST-CALL-DONE') && first.requests.length === 1, `${first.code} ${first.requests.length} ${first.stderr.slice(-200)}`)
const tipTools = new Map((first.requests[0]?.tools ?? []).map(tool => [tool.function.name, tool.function]))
const shapes = new Map<string, string[]>()
for (const call of recorded.calls) shapes.set(`${call.name}:${call.keys.join(',')}`, call.keys)
const missingTool: string[] = []
const missingKey: string[] = []
for (const [shape, keys] of shapes) {
  const name = shape.split(':')[0]!
  const tool = tipTools.get(name)
  if (tool === undefined) { missingTool.push(shape); continue }
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const required = (tool.parameters as { required?: string[] }).required ?? []
  const absent = keys.filter(key => !(key in properties))
  const unmet = required.filter(key => !keys.includes(key))
  if (absent.length > 0 || unmet.length > 0) missingKey.push(`${shape} (absent ${absent.join('|') || '-'}; unmet ${unmet.join('|') || '-'})`)
}
console.log(`  [INFO] ${recorded.calls.length} recorded calls across ${new Set(recorded.calls.map(call => call.run)).size} runs, ${shapes.size} distinct name+field shapes, tools on the tip's first call: ${[...tipTools.keys()].join(', ')}`)
check('every recorded call names a tool the tip sends in full on the first call', missingTool.length === 0, missingTool.join('; '))
check('every recorded call\'s fields exist on the tip\'s schema for that tool and its required fields are met', missingKey.length === 0, missingKey.join('; '))

console.log('\n── §2 the schema fields of the 1.0.0 definitions survive, type for type ──')
const typeShape = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(typeShape)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'description').map(([key, item]) => [key, typeShape(item)]))
  return value
}
for (const base of baseTools) {
  const tip = tipTools.get(base.name)
  if (tip === undefined) continue
  const same = JSON.stringify(typeShape(base.parameters)) === JSON.stringify(typeShape(tip.parameters))
  check(`${base.name}: every field, type, enum, bound, default and required mark is the 1.0.0 one`, same, same ? '' : `base ${JSON.stringify(typeShape(base.parameters)).slice(0, 300)} … tip ${JSON.stringify(typeShape(tip.parameters)).slice(0, 300)}`)
}
const eagerBase = baseTools.filter(base => tipTools.has(base.name))
check('the nine eager definitions of the tip are all among the fourteen of 1.0.0', eagerBase.length === tipTools.size, `${eagerBase.map(tool => tool.name).join(', ')} vs ${[...tipTools.keys()].join(', ')}`)

console.log('\n── §3 the constraints each description carries ──')
for (const [name, needles] of Object.entries(CONSTRAINTS)) {
  const tip = tipTools.get(name)
  if (tip === undefined) { check(`${name}: on the first call`, false); continue }
  const lost = needles.filter(needle => !tip.description.includes(needle))
  const base = baseTools.find(tool => tool.name === name)
  const baseWords = words(base?.description ?? '')
  const tipWords = words(tip.description)
  const kept = [...baseWords].filter(word => tipWords.has(word)).length
  console.log(`  [INFO] ${name}: ${Buffer.byteLength(base?.description ?? '', 'utf8')} → ${Buffer.byteLength(tip.description, 'utf8')} B; ${kept}/${baseWords.size} of the 1.0.0 content words remain`)
  check(`${name}: every constraint the model must know is still in the description`, lost.length === 0, lost.join(' | '))
}

console.log('\n── §4 the system instructions census: every 1.0.0 sentence keeps its content words on the tip ──')
const tipSystem = normalizeText(first.normalize(systemTextOf(first.requests[0]!)))
const tipSystemWords = words(tipSystem)
const sentences = normalizeText(baseSystem).split(/(?<=[.!?])\s+(?=[A-Z`"'(])|\n+/).map(sentence => sentence.trim()).filter(sentence => words(sentence).size >= 4)
const thin: string[] = []
let covered = 0
for (const sentence of sentences) {
  const need = words(sentence)
  const have = [...need].filter(word => tipSystemWords.has(word)).length
  const ratio = have / need.size
  if (ratio >= 0.75) covered++
  else thin.push(`${(ratio * 100).toFixed(0)}% "${sentence.slice(0, 90)}" missing ${[...need].filter(word => !tipSystemWords.has(word)).slice(0, 8).join(' ')}`)
}
console.log(`  [INFO] ${sentences.length} instruction sentences in the 1.0.0 headless system prompt; ${covered} keep at least three quarters of their content words; tip system ${Buffer.byteLength(tipSystem, 'utf8')} B vs 1.0.0 ${Buffer.byteLength(normalizeText(baseSystem), 'utf8')} B`)
check('every 1.0.0 instruction sentence keeps at least three quarters of its content words somewhere in the tip system prompt', thin.length === 0, `\n    ${thin.join('\n    ')}`)
for (const heading of ['## Authorisation and completion', '## Stop and resume', '## Engineering and evidence', '## Communication', '# The project estate', '# Memory', '# Lineage', '# Environment', 'Model currency:', '# Runtime posture', 'gitStatus:', 'gitRules:']) {
  check(`the tip keeps the ${heading} part`, tipSystem.includes(heading))
}

console.log('\n── §5 the skill listing census: every 1.0.0 skill name and its routing words survive ──')
const tipReminders = reminderTextsOf(first.requests[0]!).map(text => normalizeText(first.normalize(text)))
const tipSkills = tipReminders.find(text => text.includes('## Skills')) ?? ''
const baseSkills = baseReminders.find(text => text.includes('## Skills')) ?? ''
const skillLines = baseSkills.split('\n').filter(line => line.startsWith('- '))
const tipSkillWords = words(tipSkills)
const lostSkills: string[] = []
for (const line of skillLines) {
  const name = line.slice(2).split(':')[0]!
  const need = words(line.slice(name.length + 3))
  const have = [...need].filter(word => tipSkillWords.has(word)).length
  if (!tipSkills.includes(`- ${name}:`)) lostSkills.push(`${name} (name missing)`)
  else if (have / need.size < 0.5) lostSkills.push(`${name} (${have}/${need.size} routing words)`)
}
console.log(`  [INFO] ${skillLines.length} bundled skills in the 1.0.0 listing; tip listing ${Buffer.byteLength(tipSkills, 'utf8')} B vs 1.0.0 ${Buffer.byteLength(baseSkills, 'utf8')} B`)
check('every 1.0.0 skill is listed by name on the tip with at least half of its routing words', lostSkills.length === 0, lostSkills.join('; '))
check('the listing still says how a skill is run', /through the Skill tool/.test(tipSkills))

console.log('\n── §6 a headless fixture session that asks for Crewmate by name gets its definition ──')
const admitted = await captureBriefing('Delegate the README reading to a crewmate.', [
  { kind: 'tool_calls', calls: [{ name: 'ToolSearch', args: { query: 'select:Crewmate' } }] },
  { kind: 'text', text: 'ADMITTED-DONE' },
], 3)
check('the two-turn fixture session completes with its answer', admitted.code === 0 && answeredWith(admitted.stdout, 'ADMITTED-DONE') && admitted.requests.length === 2, `${admitted.code} ${admitted.requests.length} ${admitted.stderr.slice(-200)}`)
const second = admitted.requests[1]
if (second) {
  const firstNames = (admitted.requests[0]?.tools ?? []).map(tool => tool.function.name)
  const secondNames = second.tools.map(tool => tool.function.name)
  const crew = second.tools.find(tool => tool.function.name === 'Crewmate')?.function
  check('the first call carried no Crewmate definition', !firstNames.includes('Crewmate'), firstNames.join(', '))
  check('the second call carries Crewmate\'s complete definition, appended after the opening roster', crew !== undefined && secondNames.indexOf('Crewmate') === secondNames.length - 1 && JSON.stringify(secondNames.slice(0, firstNames.length)) === JSON.stringify(firstNames), secondNames.join(', '))
  const baseCrew = baseTools.find(tool => tool.name === 'Crewmate')!
  check('that definition keeps every field of the 1.0.0 Crewmate schema, type for type', crew !== undefined && JSON.stringify(typeShape(baseCrew.parameters)) === JSON.stringify(typeShape(crew.parameters)))
  check('the admission record tells the model the tool is callable from this request on', second.messages.some(message => message.role === 'tool' && String(message.content).includes('Tools admitted to this session') && String(message.content).includes('Crewmate')))
  check('the Crewmate manual rides with the admission', reminderTextsOf(second).some(text => text.includes('# Tool manual: Crewmate')) || second.messages.some(message => typeof message.content === 'string' && (message.content as string).includes('# Tool manual: Crewmate')))
}
process.exit(failures === 0 ? 0 : 1)
