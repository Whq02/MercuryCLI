#!/usr/bin/env bun
import { plugin } from 'bun'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bundled-listing-fit-')))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
for (const dir of [home, join(home, 'tmp'), project]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_TMPDIR = join(home, 'tmp')
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER
delete process.env.MERCURY_SESSION_KIT
delete process.env.MERCURY_SKILL_CHAR_BUDGET
delete process.env.MERCURY_SATURN_DISABLE
delete process.env.MERCURY_KEYBINDINGS
process.chdir(project)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

plugin({
  name: 'bundled-skill-text',
  setup(build) {
    build.onLoad({ filter: /\.md$/ }, ({ path }) => ({
      contents: `export default ${JSON.stringify(readFileSync(path, 'utf8'))}`,
      loader: 'js',
    }))
  },
})

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { setSessionTrustAccepted } = await import('../../src/boot/process-state/processState.ts')
setSessionTrustAccepted(true)
const { initBundledSkills } = await import('../../src/integrations/skills/bundled/index.ts')
const { getBundledSkills } = await import('../../src/integrations/skills/bundledSkills.ts')
const { computeActiveSet, publishActiveSet } = await import('../../src/integrations/extensions/active.ts')
const { clearCommandsCache, getSkillToolCommands } = await import('../../src/commands/catalogue/commands.ts')
const { MAX_LISTING_DESC_CHARS } = await import('../../src/tools/kit/names/skill.ts')
const { formatCommandsWithinBudgetDetailed } = await import('../../src/engine/attachments/skillListingFormat.ts')
const { SkillTool } = await import('../../src/tools/skill/SkillTool.ts')
const { getSkillListingAttachments, resetSentSkillNames } = await import('../../src/engine/attachment-shapes/skillListing.ts')
type Command = import('../../src/commands/catalogue/command.ts').Command

initBundledSkills()
publishActiveSet(computeActiveSet({ cwd: project }))
clearCommandsCache()

const commands = await getSkillToolCommands(project)
const byName = new Map(commands.map(cmd => [cmd.name, cmd]))

const generatedEight = ['code-review', 'deep-research', 'extension-maker', 'image-generation', 'mcp-smithy', 'provider-apis', 'research', 'skill-forge']
const codeModelFive = ['keybindings-help', 'loop', 'mercury-docs', 'schedule', 'update-config']
const craftThree = ['filmcraft:filmcraft', 'lightcraft:lightcraft', 'photocraft:photocraft']
const expectedNames = [...generatedEight, ...codeModelFive, ...craftThree].sort()

check(
  'the bundled Skill-tool roster carries all 16 model-invocable skills across the three families',
  JSON.stringify([...byName.keys()].sort()) === JSON.stringify(expectedNames),
  `${[...byName.keys()].sort().join(', ')} — a bundled skill was added, removed or hidden from the Skill tool; fix its registration in src/integrations/skills/bundled/index.ts (initBundledSkills) or its disableModelInvocation flag, or update the expected lists at the top of this file`,
)

const { content, truncation } = formatCommandsWithinBudgetDetailed(commands)
check('the bundled listing fits within the default character budget without name-only truncation', truncation === null, `${JSON.stringify(truncation)} — shorten the description or whenToUse of the bundled skills in src/integrations/skills/bundled until formatCommandsWithinBudgetDetailed in src/engine/attachments/skillListingFormat.ts cuts nothing`)

resetSentSkillNames()
const attachments = await getSkillListingAttachments({
  options: { tools: [SkillTool], engineModel: 'fixture-model' },
  getAppState: () => ({ mcp: { commands: [] } }),
} as never)
const attachedContent = attachments.map(item => String((item as { content?: unknown }).content ?? '')).join('\n')
check('the real attachment builder produces the identical listing', attachedContent === content, `${attachedContent.slice(0, 200)} — getSkillListingAttachments in src/engine/attachment-shapes/skillListing.ts must build the listing with the same formatCommandsWithinBudgetDetailed call as this test`)

const lines = content.split('\n')
check('one listing line per model-invocable bundled skill', lines.length === expectedNames.length, `${lines.length} lines — each model-invocable bundled skill must render exactly one line; check for a newline in a description or whenToUse under src/integrations/skills/bundled`)

for (const name of expectedNames) {
  const cmd = byName.get(name)
  const line = lines.find(row => row.startsWith(`- ${name}: `)) ?? ''
  const prefix = `- ${name}: `
  const listed = line.startsWith(prefix) ? line.slice(prefix.length) : ''
  const rawDesc = String(cmd?.description ?? '')
  const rawWhen = (cmd as { whenToUse?: string } | undefined)?.whenToUse
  const expectedListed = rawWhen ? `${rawDesc} - ${rawWhen}` : rawDesc

  check(`${name}: listing line has no ellipsis cut`, line !== '' && !line.includes('…') && !line.endsWith('...'), `${line} — shorten this skill description or whenToUse under src/integrations/skills/bundled so formatCommandsWithinBudgetDetailed (src/engine/attachments/skillListingFormat.ts) does not cut it`)
  check(
    `${name}: whole description fits the ${MAX_LISTING_DESC_CHARS}-char cap and renders verbatim`,
    expectedListed.length > 0 && expectedListed.length <= MAX_LISTING_DESC_CHARS && listed === expectedListed,
    `len=${expectedListed.length} listed=${JSON.stringify(listed)} expected=${JSON.stringify(expectedListed)} — keep description plus whenToUse of this skill under src/integrations/skills/bundled within MAX_LISTING_DESC_CHARS (src/tools/kit/names/skill.ts)`,
  )
  check(
    `${name}: states its trigger first`,
    /^(?:Use when|Use this skill for)\b/.test(listed),
    `${listed} — start the description of this skill under src/integrations/skills/bundled with Use when or Use this skill for`,
  )
  check(
    `${name}: tells it from its nearest sibling`,
    /\b(?:Not for|even when a skill that does the thing exists)\b/.test(listed),
    `${listed} — add a Not for clause (or the mercury-docs closing phrase) to the description of this skill under src/integrations/skills/bundled`,
  )
}

for (const command of getBundledSkills().filter(item => item.disableModelInvocation === true)) {
  const single = formatCommandsWithinBudgetDetailed([command]).content
  check(
    `${command.name} (user-only): fits the ${MAX_LISTING_DESC_CHARS}-char cap without ellipsis`,
    single === `- ${command.name}: ${String(command.description)}` && !single.includes('…'),
    `${single} — shorten this user-only skill description under src/integrations/skills/bundled so formatCommandsWithinBudgetDetailed (src/engine/attachments/skillListingFormat.ts) renders it whole`,
  )
}

const overlong = formatCommandsWithinBudgetDetailed([
  {
    type: 'prompt',
    name: 'poison-cut',
    description: `Use when testing an overlong unbroken clause that runs past the listing limit: ${'alpha '.repeat(50).trim()}`,
    loadedFrom: 'bundled',
  } as unknown as Command,
]).content
check('poison control: an overlong unbroken description is cut with "…" by the product function', overlong.endsWith('…'), `${overlong} — formatCommandsWithinBudgetDetailed in src/engine/attachments/skillListingFormat.ts must cut an overlong unbroken description at MAX_LISTING_DESC_CHARS and end it with an ellipsis`)

publishActiveSet(null)
clearCommandsCache()
console.log(failures === 0 ? `BUNDLED LISTING FIT GREEN (${checks} checks)` : `BUNDLED LISTING FIT RED (${failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
