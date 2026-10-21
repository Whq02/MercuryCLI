#!/usr/bin/env bun
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-docs-skill-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_TMPDIR = join(HOME, 'tmp')
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(HOME, { recursive: true, force: true }))

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
const { getBundledSkills, getBundledSkillExtractDir } = await import('../../src/skills/bundledSkills.ts')
const { formatCommandsWithinBudgetDetailed } = await import('../../src/tools/SkillTool/prompt.ts')
const docsSkill = await import('../../src/skills/bundled/mercuryDocs.ts')
type Command = import('../../src/types/command.ts').Command

initBundledSkills()
const skills = getBundledSkills()
const byName = new Map(skills.map(s => [s.name, s]))
const promptText = async (command: Command, args: string): Promise<string> => {
  const out = await command.getPromptForCommand(args, {} as never)
  return out.map(b => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text: string }).text : '')).join('')
}

section('§1 the mercury-docs skill — registered, user- and model-invocable, inline, trigger-complete')
const docs = byName.get(docsSkill.MERCURY_DOCS_SKILL_NAME)
check('the skill registers under its name', docs !== undefined, [...byName.keys()].join(' '))
check('a prompt command the user may invoke and the model may invoke', docs?.type === 'prompt' && docs.userInvocable !== false && docs.isHidden !== true && docs.disableModelInvocation === false)
check('it runs inline — no fork, no agent type', docs?.context === undefined && (docs as { agent?: string } | undefined)?.agent === undefined)
check('the description sends every how-do-I-use-Mercury question here, names the shipped documentation as the source and keeps a doing skill for doing', /how to use Mercury itself/.test(String(docs?.description)) && /ships with this install/.test(String(docs?.description)) && /never from memory/.test(String(docs?.description)) && /even when a skill that does the thing exists/.test(String(docs?.description)))
check('the argument hint asks for the question', docs?.argumentHint === '<question about using Mercury>')
const LISTING_CAP = 250
const description = String(docs?.description)
const renderedListing = formatCommandsWithinBudgetDetailed(skills).content
const docsListingLine = renderedListing.split('\n').find(line => line.startsWith(`- ${docsSkill.MERCURY_DOCS_SKILL_NAME}: `)) ?? ''
const listingLineOf = (candidate: string): string => formatCommandsWithinBudgetDetailed([{ ...docs, description: candidate } as Command]).content
const hasTrigger = (line: string): boolean => line.startsWith(`- ${docsSkill.MERCURY_DOCS_SKILL_NAME}: Use when the user asks how to use Mercury itself`)
const hasTopics = (line: string): boolean => /\([a-z ,]+\)/i.test(line)
const hasGrounding = (line: string): boolean => line.includes('answered from the documentation that ships with this install, never from memory')
const hasBoundary = (line: string): boolean => line.endsWith('even when a skill that does the thing exists.')
const readsAsDocsTrigger = (line: string): boolean => hasTrigger(line) && hasTopics(line) && hasGrounding(line) && hasBoundary(line)
check(`the description fits the ${LISTING_CAP}-character skill-listing cap, so no tail of it is cut`, description.length <= LISTING_CAP, `${description.length} characters`)
check('the real rendered listing line is the whole description, with no ellipsis', docsListingLine === `- ${docsSkill.MERCURY_DOCS_SKILL_NAME}: ${description}` && !docsListingLine.endsWith('…'), docsListingLine)
check('the listing line the model reads carries the trigger, the topics, the grounding law and the doing boundary', readsAsDocsTrigger(docsListingLine), docsListingLine)
check('poison control: a description whose tail is pushed past the cap fails the listing predicate', !readsAsDocsTrigger(listingLineOf(description.replace('): answered', `): ${'at some considerable length, '.repeat(6)}answered`))))
check('poison control: a listing line without the doing boundary fails the listing predicate', !readsAsDocsTrigger(docsListingLine.replace(', even when a skill that does the thing exists', '')))
check('poison control: a listing line without the grounding law fails the listing predicate', !readsAsDocsTrigger(docsListingLine.replace('never from memory', 'from memory')))
check('poison control: a listing line without the topic list fails the listing predicate', !readsAsDocsTrigger(docsListingLine.replace(/ \([^)]+\)/, '')))

section('§2 the pages — README.md and every docs/*.md page of this tree, byte for byte, nothing else')
const pages = docsSkill.mercuryDocPages()
const expected = ['README.md', ...readdirSync(join(ROOT, 'docs')).filter(n => n.endsWith('.md')).sort().map(n => `docs/${n}`)]
check('the page set is README.md plus every top-level docs page', JSON.stringify(Object.keys(pages).sort()) === JSON.stringify([...expected].sort()), `${Object.keys(pages).length} carried vs ${expected.length} on disk`)
let identical = 0
for (const rel of expected) if (pages[rel] === readFileSync(join(ROOT, rel), 'utf8')) identical++
check('every carried page is the tree\'s page, byte for byte', identical === expected.length, `${identical} of ${expected.length}`)
check('no release page, template or media file rides along', !Object.keys(pages).some(k => k.includes('releases/') || k.includes('templates/') || k.includes('media/')))
check('the Saturn page the scheduling question needs is carried and names /saturn, CronCreate and the /loop skill', typeof pages['docs/SATURN.md'] === 'string' && /`\/saturn`/.test(pages['docs/SATURN.md']) && /CronCreate/.test(pages['docs/SATURN.md']) && /`\/loop`/.test(pages['docs/SATURN.md']))
const TOPIC_PAGES: Readonly<Record<string, ReadonlyArray<readonly [string, RegExp]>>> = {
  commands: [['README.md', /^## Slash commands/m]],
  scheduling: [['docs/SATURN.md', /`\/saturn`/]],
  providers: [['docs/ENGINES.md', /sign-in provider families/], ['README.md', /^## Providers and models: sign-ins/m]],
  hosting: [['docs/LLM-HOST.md', /`\/llmhost`/], ['docs/LLM-HOST.md', /mercury\s+host/]],
  'headless runs': [['docs/AUTOMATION.md', /`mercury run/], ['docs/AUTOMATION.md', /`mercury runner`/], ['README.md', /^## The headless CLI/m]],
  voice: [['docs/VOICE.md', /`\/voice on`/]],
  restart: [['README.md', /`\/restart`/], ['docs/TERMINAL-RUNTIME.md', /`\/restart`/]],
}
const topicsNamed = (/\(([^)]+)\)/.exec(description)?.[1] ?? '').split(',').map(topic => topic.trim()).filter(Boolean)
const topicsPinned = (carried: Readonly<Record<string, string>>, named: ReadonlyArray<string> = topicsNamed): boolean =>
  named.length > 0 &&
  JSON.stringify([...named].sort()) === JSON.stringify(Object.keys(TOPIC_PAGES).sort()) &&
  Object.values(TOPIC_PAGES).every(pins => pins.every(([page, anchor]) => anchor.test(carried[page] ?? '')))
check('each topic the description names is documented by shipped pages that carry its command or section', topicsPinned(pages), `named: ${topicsNamed.join(', ')}`)
check('poison control: a topic named without a pinned page fails the topic predicate', !topicsPinned(pages, [...topicsNamed, 'sdk']))
check('poison control: a page that lost the command the topic rests on fails the topic predicate', !topicsPinned({ ...pages, 'docs/VOICE.md': (pages['docs/VOICE.md'] ?? '').replaceAll('/voice on', '') }))
const index = pages['docs/README.md'] ?? ''
const pageLinks = [...index.matchAll(/\]\(([^)]+\.md)\)/g)].map(match => match[1]!)
const guideNames = expected.filter(path => path.startsWith('docs/') && path !== 'docs/README.md').map(path => path.slice(5))
check('the catalogue lists each shipped guide exactly once', guideNames.every(name => pageLinks.filter(link => link === name).length === 1), guideNames.filter(name => pageLinks.filter(link => link === name).length !== 1).join(', '))
check('every local catalogue link names a page on disk', pageLinks.every(link => existsSync(join(ROOT, 'docs', link))), pageLinks.filter(link => !existsSync(join(ROOT, 'docs', link))).join(', '))
const settingsText = pages['docs/SETTINGS.md'] ?? ''
const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
const settingsShape = SettingsSchema().shape
const coveredKeys = Object.entries(settingsShape).flatMap(([group, schema]) => {
  const object = 'unwrap' in schema ? schema.unwrap() : schema
  if ('shape' in object) return Object.keys(object.shape).map(key => `${group}.${key}`)
  return [group]
})
check('the settings guide covers each usable grouped key', coveredKeys.every(key => settingsText.includes(key)), coveredKeys.filter(key => !settingsText.includes(key)).join(', '))
const settingsExamples = [...settingsText.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!))
check('the settings guide carries a valid complete JSON example', settingsExamples.length > 0 && settingsExamples.every(example => SettingsSchema().safeParse(example).success))
check('the settings guide names all four custom patience fields', ['streamIdleSeconds', 'quietStreamIdleSeconds', 'fallbackCeilingSeconds', 'recoveryBudgetMinutes'].every(key => settingsText.includes(`patience.${key}`)))
check('the guide distinguishes the project guide from the personal layer', settingsText.includes('MERCURY.local.md') && settingsText.includes('personal layer') && settingsText.includes('AGENTS.md'))

section('§3 the prompt — the base directory, the guidance, the map, the question')
const text = await promptText(docs!, 'how do i schedule a prompt in mercury')
const extractDir = getBundledSkillExtractDir(docsSkill.MERCURY_DOCS_SKILL_NAME)
check('the prompt opens on the base-directory line naming the extract dir', text.startsWith(`Base directory for this skill: ${extractDir} `))
check('the guidance answers from the shipped documentation and names the Read and Grep road', /Answer the question from Mercury's own documentation/.test(text) && /read it with the Read tool/.test(text) && /Grep across the folder/.test(text))
check("the guidance names Mercury's own site and llms.txt as the map, and no other site", text.includes(docsSkill.MERCURY_DOCS_SITE) && text.includes(docsSkill.MERCURY_DOCS_MAP_URL) && /fetch no other site/.test(text))
check('an uncovered question is answered plainly, never guessed', /say so and name the nearest page instead of guessing/.test(text))
const guidance = text.slice(text.indexOf("Answer the question"), text.indexOf('## The pages'))
const README_CLAIMS: ReadonlyArray<readonly [string, RegExp]> = [
  ['install', /^## Install/m],
  ['updates', /^### Updates/m],
  ['provider sign-ins', /^## Providers and models: sign-ins/m],
  ['headless', /^## The headless CLI/m],
  ['slash-command table', /^## Slash commands/m],
]
const readmeClaimsPinned = (readme: string): boolean => README_CLAIMS.every(([phrase, heading]) => guidance.includes(phrase) && heading.test(readme))
check('every README section the guidance names is a heading of the README', readmeClaimsPinned(pages['README.md'] ?? ''))
check('poison control: a README without its slash-command table heading fails the README predicate', !readmeClaimsPinned((pages['README.md'] ?? '').replace('## Slash commands', '## Commands')))
check('the guidance states no count that could go stale', !/\d/.test(guidance), guidance.match(/\d+/g)?.join(',') ?? '')
check('poison control: a guidance with a provider count in it fails the no-count predicate', /\d/.test(guidance.replace('provider sign-ins', '20 provider sign-ins')))
check('the guidance sends a long page to a Grep and a window read, not a whole-file read', /Grep across the folder first/.test(guidance) && /only the lines the match points at/.test(guidance))
check('the guidance stays within its 900-character size budget', guidance.length <= 900, `${guidance.length} characters`)
const mapLines = text.split('\n').filter(line => line.startsWith('- README.md') || line.startsWith('- docs/'))
const mapPaths = mapLines.map(line => /^- ([^\s—]+)/.exec(line)?.[1] ?? '')
check('the map lists every carried page, README first', mapLines.length === expected.length && mapLines[0]!.startsWith('- README.md — Mercury CLI:'), `${mapLines.length} map rows`)
check('every docs/*.md in the tree is in the map and every path the map names exists', expected.every(p => mapPaths.includes(p)) && mapPaths.every(p => existsSync(join(ROOT, p))), mapPaths.filter(p => !existsSync(join(ROOT, p))).join(', '))
const surfaceIndexSection = index.split('## Reference')[0] ?? index
const surfaceLinks = [...surfaceIndexSection.matchAll(/\]\(([^)]+\.md)\)/g)]
  .map(m => m[1]!)
  .filter(link => link === '../README.md' || !link.startsWith('../'))
  .map(link => (link === '../README.md' ? 'README.md' : `docs/${link}`))
check("every surface docs/README.md's index names has a page in the map", surfaceLinks.length > 0 && surfaceLinks.every(p => mapPaths.includes(p)), surfaceLinks.filter(p => !mapPaths.includes(p)).join(', '))
check('each map row carries the page title and a one-line summary from the page itself', mapLines.every(line => / — .+: .+/.test(line)) && mapLines.some(line => line.startsWith('- docs/SATURN.md — Saturn: session schedules: Saturn is Mercury\'s scheduler.')))
const flat = (value: string): string => value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ')
const quotesPage = (page: string, summary: string): boolean => flat(page).includes(flat(summary.replace(/…$/, '')))
const complete = (summary: string): boolean => (summary.match(/`/g)?.length ?? 0) % 2 === 0 && (summary.match(/\(/g)?.length ?? 0) <= (summary.match(/\)/g)?.length ?? 0) && /[.?!…)`]$/.test(summary)
const aboutThePage = (summary: string): boolean => !/^Measured in\b|\bin the README\b/.test(summary)
const described = expected.map(rel => ({ rel, ...docsSkill.describeDocPage(pages[rel]!) }))
check("every map row's summary is the page's own words, nothing added and nothing paraphrased", described.every(row => quotesPage(pages[row.rel]!, row.summary)), described.filter(row => !quotesPage(pages[row.rel]!, row.summary)).map(row => row.rel).join(', '))
check('poison control: a summary with words the page never says fails the own-words predicate', !quotesPage(pages['docs/VOICE.md'] ?? '', `${described.find(row => row.rel === 'docs/VOICE.md')?.summary ?? ''} (\`/voice\`).`))
check('every map summary is complete: no open backtick or parenthesis, and it ends on a sentence end', described.every(row => complete(row.summary)), described.filter(row => !complete(row.summary)).map(row => row.rel).join(', '))
check('poison control: a summary cut inside a code span or a parenthesis, or never ended, fails the completeness predicate', !complete('Run it with `mercury run --format') && !complete('Run it with the flag (which is long') && !complete('Run it with the flag and then stop reading'))
check('every map row is at most 330 characters', mapLines.every(line => line.length <= 330), mapLines.filter(line => line.length > 330).map(line => line.slice(0, 40)).join(', '))
check('no map summary opens on a version stamp or points at another page instead of describing its own', described.every(row => aboutThePage(row.summary)), described.filter(row => !aboutThePage(row.summary)).map(row => row.rel).join(', '))
check('poison control: the base summaries of the Windows source guide and the memory study fail the about-the-page predicate', !aboutThePage('The release route on Windows is one line in PowerShell 7 (`irm … | iex` in the README\'s Install section) and needs Git and nothing else.') && !aboutThePage('Measured in Mercury 1.0.0-beta.32. Mercury 1.0.0-beta.33 shortened the note to one orienting note; the numbers below are for the .32 shape.'))
check('the Windows source-install map line describes building from source rather than the README release route', /building Mercury from source on a Windows machine/.test(docsSkill.describeDocPage(pages['docs/INSTALL-WINDOWS-FROM-SOURCE.md']!).summary))
const words = 'word '.repeat(28)
const SHAPES: ReadonlyArray<readonly [string, string, (summary: string) => boolean]> = [
  ['a plain page gives its first sentence', '# Foo\n\nFoo does one clear thing for the user on every machine it runs on. A second sentence follows.\n', summary => summary === 'Foo does one clear thing for the user on every machine it runs on.'],
  ['an abbreviation does not end the sentence', '# Foo\n\nUse it to pick the model for the session on this machine, e.g. `/model grok`, or leave the choice to Mercury. More follows.\n', summary => summary.endsWith('leave the choice to Mercury.')],
  ['a fenced sample before the prose is not the summary', '# Foo\n\n```sh\nmercury run --format rows --input rows --partial --a-very-long-flag-name-for-the-test\n```\n\nThe tool runs a prompt without a terminal interface and writes rows to standard output.\n', summary => summary.startsWith('The tool runs a prompt')],
  ['a cut inside a code span drops the whole span', `# Foo\n\nRun ${words}\`mercury run --format rows --input rows --partial\` and then it goes on for a while longer than that.\n`, summary => summary.endsWith('…') && !summary.includes('`')],
  ['a cut inside a parenthetical drops the whole aside', `# Foo\n\nRun ${words}(this aside is long enough to cross the cut and then some more words follow it here) and on.\n`, summary => summary.endsWith('…') && !summary.includes('(')],
  ['link markup is reduced to its text', '# Foo\n\nSee [the guide](GUIDE.md) for the full list of everything this tool can do for you on every machine.\n', summary => summary.startsWith('See the guide for the full list')],
  ['an answers line below the first heading is not an answer', '# Foo\n\nA first paragraph that is certainly over sixty characters long for the test.\n\n## Later\n\n<!-- answers: nope -->\n', summary => summary.startsWith('A first paragraph')],
  ['a page whose only long paragraph points elsewhere still gets a row', '# Foo\n\nThe whole story is told in the README, under Install, for every release route there is.\n', summary => summary.startsWith('The whole story')],
]
for (const [label, page, holds] of SHAPES) {
  const { summary } = docsSkill.describeDocPage(page)
  check(`describeDocPage on an ordinary page: ${label}`, holds(summary), summary)
}
check('describeDocPage honours an explicit <!-- answers: … --> line when a page carries one', docsSkill.describeDocPage('# Sample\n\n<!-- answers: custom routing line for the page -->\n\nA first paragraph that is over sixty characters long so the fallback would have chosen it.').summary === 'custom routing line for the page')
check('the question rides last under its own heading', text.endsWith('## The question\nhow do i schedule a prompt in mercury'))
const bare = await promptText(docs!, '')
check('no question ⇒ no question heading', !bare.includes('## The question'))

section('§4 extraction — the pages stand on disk under the per-process temp root, never a config home')
check('the extract dir is outside the config home', !extractDir.startsWith(HOME) || extractDir.startsWith(process.env.MERCURY_TMPDIR!))
let extracted = 0
for (const rel of expected) if (existsSync(join(extractDir, rel)) && readFileSync(join(extractDir, rel), 'utf8') === pages[rel]) extracted++
check('every page is extracted byte-identical after the first invocation', extracted === expected.length, `${extracted} of ${expected.length}`)

section('§5 no other product\'s documentation site anywhere in the skill')
const skillSource = readFileSync(join(ROOT, 'src', 'skills', 'bundled', 'mercuryDocs.ts'), 'utf8') + readFileSync(join(ROOT, 'src', 'skills', 'bundled', 'mercuryDocsPages.ts'), 'utf8')
const foreignDocs = /docs\.(anthropic|claude|openai|x\.ai|cursor|github)\.com|platform\.(openai|claude)\.com|developers\.openai\.com|modelcontextprotocol\.io|opencode\.ai|cline\.bot/i
check('the skill source names no other product\'s docs host', !foreignDocs.test(skillSource))
check('the rendered prompt names no other product\'s docs host', !foreignDocs.test(text))
const hosts = [...text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map(m => m[1]!.toLowerCase())
check('the only host the guidance names is mercury-cli.ai', hosts.length > 0 && hosts.every(h => h === 'mercury-cli.ai'), [...new Set(hosts)].join(' '))

console.log(`\n${failures === 0 ? '✅' : '❌'} MERCURY DOCS SKILL ${failures === 0 ? 'GREEN' : 'RED'} (${checks - failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
