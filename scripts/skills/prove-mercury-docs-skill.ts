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
const docsSkill = await import('../../src/skills/bundled/mercuryDocs.ts')
const verifierSkill = await import('../../src/skills/bundled/verifier.ts')
const { SKILL_TOOL_NAME } = await import('../../src/tools/SkillTool/constants.ts')
type Command = import('../../src/types/command.ts').Command

initBundledSkills()
const skills = getBundledSkills()
const byName = new Map(skills.map(s => [s.name, s]))
const promptText = async (command: Command, args: string): Promise<string> => {
  const out = await command.getPromptForCommand(args, {} as never)
  return out.map(b => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text: string }).text : '')).join('')
}

section('§1 the mercury-docs skill — registered, user- and model-invocable, inline')
const docs = byName.get(docsSkill.MERCURY_DOCS_SKILL_NAME)
check('the skill registers under its name', docs !== undefined, [...byName.keys()].join(' '))
check('a prompt command the user may invoke and the model may invoke', docs?.type === 'prompt' && docs.userInvocable !== false && docs.isHidden !== true && docs.disableModelInvocation === false)
check('it runs inline — no fork, no agent type', docs?.context === undefined && (docs as { agent?: string } | undefined)?.agent === undefined)
check('the description sends every how-do-I-use-Mercury question here, names the shipped documentation as the source and keeps a doing skill for doing', /how to use Mercury itself/.test(String(docs?.description)) && /ships with this install/.test(String(docs?.description)) && /never from memory/.test(String(docs?.description)) && /even when a skill that does the thing exists/.test(String(docs?.description)))
check('the argument hint asks for the question', docs?.argumentHint === '<question about using Mercury>')

section('§2 the pages — README.md and every docs/*.md page of this tree, byte for byte, nothing else')
const pages = docsSkill.mercuryDocPages()
const expected = ['README.md', ...readdirSync(join(ROOT, 'docs')).filter(n => n.endsWith('.md')).sort().map(n => `docs/${n}`)]
check('the page set is README.md plus every top-level docs page', JSON.stringify(Object.keys(pages).sort()) === JSON.stringify([...expected].sort()), `${Object.keys(pages).length} carried vs ${expected.length} on disk`)
let identical = 0
for (const rel of expected) if (pages[rel] === readFileSync(join(ROOT, rel), 'utf8')) identical++
check('every carried page is the tree\'s page, byte for byte', identical === expected.length, `${identical} of ${expected.length}`)
check('no release page, template or media file rides along', !Object.keys(pages).some(k => k.includes('releases/') || k.includes('templates/') || k.includes('media/')))
check('the Saturn page the scheduling question needs is carried and names /saturn, CronCreate and the /loop skill', typeof pages['docs/SATURN.md'] === 'string' && /`\/saturn`/.test(pages['docs/SATURN.md']) && /CronCreate/.test(pages['docs/SATURN.md']) && /`\/loop`/.test(pages['docs/SATURN.md']))
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
const mapLines = text.split('\n').filter(line => line.startsWith('- README.md') || line.startsWith('- docs/'))
check('the map lists every carried page, README first', mapLines.length === expected.length && mapLines[0]!.startsWith('- README.md — Mercury:'), `${mapLines.length} map rows`)
check('each map row carries the page title and a one-line summary from the page itself', mapLines.every(line => / — .+: .+/.test(line)) && mapLines.some(line => line.startsWith('- docs/SATURN.md — Saturn — session schedules: Saturn is Mercury\'s scheduler.')))
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

section('§6 the verifier skill — the adversarial brief, forked into a crew agent, the model\'s door')
const verifier = byName.get(verifierSkill.VERIFIER_SKILL_NAME)
check('the skill registers under its name', verifier !== undefined)
check('model-invocable, not a menu entry (the operator\'s door is /verify)', verifier?.type === 'prompt' && verifier.disableModelInvocation === false && verifier.userInvocable === false && verifier.isHidden === true)
check('it forks into the mercury-crew agent', verifier?.context === 'fork' && (verifier as { agent?: string } | undefined)?.agent === 'mercury-crew')
const brief = await promptText(verifier!, 'the task: add a parser; files: src/parse.ts; approach: recursive descent')
check('the brief opens on the break-it charge and forbids project writes', brief.startsWith('You are verifying someone else\'s work for Mercury.') && /## Do not modify the project/.test(brief))
check('the brief ends on the verdict contract', /End your response with exactly one line: `VERDICT: ` then one of `PASS`, `FAIL`, `PARTIAL`/.test(brief))
check('the handed work rides under its own heading', brief.endsWith('## The work to verify\nthe task: add a parser; files: src/parse.ts; approach: recursive descent'))
check('an empty argument tells the agent to reconstruct the change itself', /reconstruct the change from the working tree/.test(await promptText(verifier!, '')))
check('the description names the verdict line and when to reach for it', /VERDICT: PASS, FAIL or PARTIAL/.test(String(verifier?.description)) && /run those instead/.test(String(verifier?.description)))
check('the Skill tool is the door the model takes', SKILL_TOOL_NAME === 'Skill')

console.log(`\n${failures === 0 ? '✅' : '❌'} MERCURY DOCS SKILL ${failures === 0 ? 'GREEN' : 'RED'} (${checks - failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
