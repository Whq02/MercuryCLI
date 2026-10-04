import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sourceArg = process.argv.indexOf('--source-root')
const root = sourceArg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[sourceArg + 1]!)
const scratch = mkdtempSync(join(tmpdir(), 'capsule-ledger-'))
const project = join(scratch, 'project')
mkdirSync(join(project, '.mercury/skills/capsule-proof'), { recursive: true })
mkdirSync(join(scratch, 'home'), { recursive: true })
writeFileSync(join(project, '.mercury/skills/capsule-proof/SKILL.md'), '---\ndescription: Prove capsule delivery.\n---\nKeep every fact.\n')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_SESSION_KIT
process.chdir(project)
let failures = 0
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
  if (!ok) failures++
}
try {
  const { enableConfigs } = await import(`${root}/src/utils/config/globalConfig.ts`)
  enableConfigs()
  const listing = await import(`${root}/src/utils/attachments/skillListing.ts`)
  const { getEngineModel } = await import(`${root}/src/utils/model/model.ts`)
  const { SKILL_TOOL_NAME } = await import(`${root}/src/tools/SkillTool/constants.ts`)
  const context = {
    options: { tools: [{ name: SKILL_TOOL_NAME }], engineModel: getEngineModel() },
    getAppState: () => ({ mcp: { commands: [] } }),
    messages: [] as any[],
  }
  listing.resetSentSkillNames()
  const first = await listing.getSkillListingAttachments(context)
  check('first listing carries the actual proof-home skill', first.some((row: any) => row.content.includes('capsule-proof')))
  check('unchanged roster is not repeated', (await listing.getSkillListingAttachments(context)).length === 0)
  context.messages = [{ type: 'system', subtype: 'compact_boundary', uuid: 'compact-proof-1' }]
  const afterCompact = await listing.getSkillListingAttachments(context)
  check('compaction restores skills no longer visible in the window', afterCompact.some((row: any) => row.content.includes('capsule-proof')))
  check('compaction resets exactly once', (await listing.getSkillListingAttachments(context)).length === 0)
  listing.resetSentSkillNames()
  listing.suppressNextSkillListing()
  const child = await listing.getSkillListingAttachments({ ...context, agentId: 'capsule-child', messages: [] })
  check('a child cannot consume the main resume suppression', child.some((row: any) => row.content.includes('capsule-proof')))
  check('the resumed main still suppresses its already-visible listing', (await listing.getSkillListingAttachments(context)).length === 0)
  const firstDirectory = join(scratch, 'first-skills')
  const laterDirectory = join(scratch, 'later-skills')
  for (const directory of [firstDirectory, laterDirectory]) {
    mkdirSync(join(directory, 'example'), { recursive: true })
    writeFileSync(join(directory, 'example/SKILL.md'), 'Keep the facts.\n')
  }
  const triggers = new Set([firstDirectory])
  const pending = listing.getDynamicSkillAttachments({ ...context, dynamicSkillDirTriggers: triggers })
  triggers.add(laterDirectory)
  await pending
  check('a new directory trigger arriving during collection is not lost', triggers.has(laterDirectory))
  const next = await listing.getDynamicSkillAttachments({ ...context, dynamicSkillDirTriggers: triggers })
  check('the next turn delivers the later directory', next.some((row: any) => row.skillDir === laterDirectory))
} finally {
  process.chdir(root)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures ? `FAIL capsule ledgers: ${failures} checks` : 'PASS capsule ledgers')
process.exit(failures ? 1 : 0)
