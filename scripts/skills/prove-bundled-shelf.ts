import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bundled-shelf-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_SESSION_KIT
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.chdir(scratch)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const { initBundledSkills } = await import('../../src/skills/bundled/index.ts')
const { getBundledSkills } = await import('../../src/skills/bundledSkills.ts')
const { SkillTool } = await import('../../src/tools/SkillTool/SkillTool.ts')
const { getSkillListingAttachments } = await import('../../src/utils/attachments/skillListing.ts')
initBundledSkills()
const expected = ['mercury-docs', 'update-config', 'keybindings-help', 'loop', 'schedule', 'skillify', 'skill-forge', 'extension-maker', 'mcp-smithy', 'provider-apis', 'debug', 'research'].sort()
const absent = [['pdf', 'documents'], ['slide', 'decks'], ['spread', 'sheets'], ['word', 'documents'], ['sim', 'plify'], ['ver', 'ifier'], ['app', 'proof']].map((parts, index) => parts.join([2, 4, 5].includes(index) ? '' : '-'))
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const names = getBundledSkills().map(skill => skill.name).sort()
check('the bundled shelf is exactly the twelve named skills', JSON.stringify(names) === JSON.stringify(expected), names.join(' '))
const context = {
  options: { tools: [SkillTool], engineModel: 'fixture-model' },
  getAppState: () => ({ mcp: { commands: [] } }),
} as never
const listing = JSON.stringify(await getSkillListingAttachments(context))
for (const [index, name] of absent.entries()) {
  const paths = [join(root, 'mercury-skills', name), ...[name, `${name}.ts`, `${name}Content.ts`].map(file => join(root, 'src/skills/bundled', file))]
  check(`unbundled slot ${index + 1} has no source, wrapper, content or mirror`, paths.every(path => !existsSync(path)))
  check(`unbundled slot ${index + 1} has no registration or listing`, !names.includes(name) && !listing.includes(`- ${name}:`))
  const validation = await SkillTool.validateInput({ skill: name }, context)
  check(`unbundled slot ${index + 1} is an ordinary unknown skill`, !validation.result && validation.errorCode === 2 && validation.message.startsWith(`Unknown skill: ${name}.`), JSON.stringify(validation))
}
console.log(failures === 0 ? 'BUNDLED SHELF GREEN' : `BUNDLED SHELF RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
