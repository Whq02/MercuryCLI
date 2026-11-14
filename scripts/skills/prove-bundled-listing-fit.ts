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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)
const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
const { getBundledSkills } = await import('../../src/skills/bundledSkills.ts')
const { computeActiveSet, publishActiveSet } = await import('../../src/extensions/active.ts')
const { clearCommandsCache, getSkillToolCommands } = await import('../../src/commands.ts')
const { MAX_LISTING_DESC_CHARS } = await import('../../src/tools/SkillTool/constants.ts')
const { formatCommandsWithinBudgetDetailed } = await import('../../src/tools/SkillTool/prompt.ts')
const { SkillTool } = await import('../../src/tools/SkillTool/SkillTool.ts')
const { getSkillListingAttachments, resetSentSkillNames } = await import('../../src/utils/attachments/skillListing.ts')
type Command = import('../../src/types/command.ts').Command

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
  [...byName.keys()].sort().join(', '),
)

const { content, truncation } = formatCommandsWithinBudgetDetailed(commands)
check('the bundled listing fits within the default character budget without name-only truncation', truncation === null, JSON.stringify(truncation))

resetSentSkillNames()
const attachments = await getSkillListingAttachments({
  options: { tools: [SkillTool], engineModel: 'fixture-model' },
  getAppState: () => ({ mcp: { commands: [] } }),
} as never)
const attachedContent = attachments.map(item => String((item as { content?: unknown }).content ?? '')).join('\n')
check('the real attachment builder produces the identical listing', attachedContent === content, attachedContent.slice(0, 200))

const lines = content.split('\n')
check('one listing line per model-invocable bundled skill', lines.length === expectedNames.length, `${lines.length} lines`)

for (const name of expectedNames) {
  const cmd = byName.get(name)
  const line = lines.find(row => row.startsWith(`- ${name}: `)) ?? ''
  const prefix = `- ${name}: `
  const listed = line.startsWith(prefix) ? line.slice(prefix.length) : ''
  const rawDesc = String(cmd?.description ?? '')
  const rawWhen = (cmd as { whenToUse?: string } | undefined)?.whenToUse
  const expectedListed = rawWhen ? `${rawDesc} - ${rawWhen}` : rawDesc

  check(`${name}: listing line has no ellipsis cut`, line !== '' && !line.includes('…') && !line.endsWith('...'), line)
  check(
    `${name}: whole description fits the ${MAX_LISTING_DESC_CHARS}-char cap and renders verbatim`,
    expectedListed.length > 0 && expectedListed.length <= MAX_LISTING_DESC_CHARS && listed === expectedListed,
    `len=${expectedListed.length} listed=${JSON.stringify(listed)} expected=${JSON.stringify(expectedListed)}`,
  )
  check(
    `${name}: states its trigger first`,
    /^(?:Use when|Use this skill for)\b/.test(listed),
    listed,
  )
  check(
    `${name}: tells it from its nearest sibling`,
    /\b(?:Not for|even when a skill that does the thing exists)\b/.test(listed),
    listed,
  )
}

for (const command of getBundledSkills().filter(item => item.disableModelInvocation === true)) {
  const single = formatCommandsWithinBudgetDetailed([command]).content
  check(
    `${command.name} (user-only): fits the ${MAX_LISTING_DESC_CHARS}-char cap without ellipsis`,
    single === `- ${command.name}: ${String(command.description)}` && !single.includes('…'),
    single,
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
check('poison control: an overlong unbroken description is cut with "…" by the product function', overlong.endsWith('…'), overlong)

publishActiveSet(null)
clearCommandsCache()
console.log(failures === 0 ? `BUNDLED LISTING FIT GREEN (${checks} checks)` : `BUNDLED LISTING FIT RED (${failures} of ${checks})`)
process.exit(failures === 0 ? 0 : 1)
