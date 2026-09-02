import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'skill-deapply-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_SESSION_KIT
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — de-apply prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

console.log('============================================================')
console.log(' skill de-apply announced — the fourth removal arm')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const skillDir = join(PROJECT, '.mercury', 'skills')
const writeSkill = (name: string): void => {
  mkdirSync(join(skillDir, name), { recursive: true })
  writeFileSync(join(skillDir, name, 'SKILL.md'), `---\ndescription: the ${name} proof skill\n---\n\nBody of ${name}.\n`)
}
writeSkill('depa-alpha')
writeSkill('depa-beta')
writeSkill('depa-gamma')

const commands = await import('../../src/commands.ts')
const listing = await import('../../src/utils/attachments/skillListing.ts')
const { SKILL_TOOL_NAME } = await import('../../src/tools/SkillTool/constants.ts')
const pin = await import('../../src/services/mcp/sessionKitPin.ts')
const governance = await import('../../src/skills/kitGovernance.ts')

type ListingAttachment = { type: string; content: string; skillCount: number; isInitial: boolean; removedNames?: string[] }
const context = {
  agentId: undefined,
  options: { tools: [{ name: SKILL_TOOL_NAME }], mainLoopModel: 'claude-sonnet-4-6' },
  getAppState: () => ({ mcp: { commands: [] } }),
} as never
const list = async (): Promise<ListingAttachment[]> =>
  (await listing.getSkillListingAttachments(context)) as unknown as ListingAttachment[]
const spokenNames = (await commands.getSkillToolCommands(PROJECT)).map(c => c.name)
const nameOf = (base: string): string => spokenNames.find(n => n === base || n.endsWith(`:${base}`)) ?? base

section('§1 the first listing announces; an unchanged roster is silent')
{
  listing.resetSentSkillNames()
  const first = await list()
  t('one attachment on first sight', first.length === 1, String(first.length))
  const a = first[0]
  t(
    'the three fixture skills ride the content, nothing rides removedNames',
    a !== undefined && a.isInitial === true && ['depa-alpha', 'depa-beta', 'depa-gamma'].every(n => a.content.includes(nameOf(n))) && (a.removedNames?.length ?? -1) === 0,
    JSON.stringify({ content: a?.content.slice(0, 120), removed: a?.removedNames }),
  )
  const again = await list()
  t('an unchanged roster announces NOTHING', again.length === 0, String(again.length))
}

section("§2 the kit dial: 'off' AND 'invocable' both announce the removal")
{
  governance._resetKitGovernanceForTesting()
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify({
    schema: 1,
    mcp: [],
    skills: [],
    invocable: [],
    resolved: false,
    deltas: { mcpOff: [], skillStates: { [nameOf('depa-beta')]: 'invocable', [nameOf('depa-gamma')]: 'off' }, extensionsOff: [] },
  })
  const receipt = pin.consumeSessionKitPin()
  t('the kit latched through the consumed-once pin', receipt.outcome === 'pinned')
  commands.clearCommandMemoizationCaches()
  const dialled = await list()
  t('exactly one attachment for the dial', dialled.length === 1, String(dialled.length))
  const a = dialled[0]
  const removed = [...(a?.removedNames ?? [])].sort()
  t(
    "removedNames = the dialled pair (off + invocable), added set EMPTY",
    a !== undefined && a.skillCount === 0 && a.content === '' && removed.length === 2 && removed.includes(nameOf('depa-beta')) && removed.includes(nameOf('depa-gamma')),
    JSON.stringify({ removed, count: a?.skillCount, content: a?.content }),
  )
  const again = await list()
  t('the removal emits exactly once per transition', again.length === 0, String(again.length))
}

section('§3 the ledger pruned: re-enable announces as an ADDITION')
{
  governance._resetKitGovernanceForTesting()
  pin._resetSessionKitPinForTesting()
  process.env.MERCURY_SESSION_KIT = JSON.stringify({
    schema: 1,
    mcp: [],
    skills: [],
    invocable: [],
    resolved: false,
    deltas: { mcpOff: [], skillStates: { [nameOf('depa-gamma')]: 'off' }, extensionsOff: [] },
  })
  t('the re-dialled kit latched (beta back on, gamma still off)', pin.consumeSessionKitPin().outcome === 'pinned')
  commands.clearCommandMemoizationCaches()
  const reEnabled = await list()
  const a = reEnabled[0]
  t(
    'beta re-announces as an addition with no removal riding',
    reEnabled.length === 1 && a !== undefined && a.content.includes(nameOf('depa-beta')) && (a.removedNames?.length ?? -1) === 0 && a.isInitial === false,
    JSON.stringify({ content: a?.content.slice(0, 120), removed: a?.removedNames }),
  )
}

section('§4 a skill file deleted from disk announces too (one roster law)')
{
  rmSync(join(skillDir, 'depa-alpha'), { recursive: true, force: true })
  commands.clearCommandsCache()
  const gone = await list()
  const a = gone[0]
  t(
    "alpha's removal announces after its file left the disk",
    gone.length === 1 && a !== undefined && (a.removedNames ?? []).includes(nameOf('depa-alpha')) && a.skillCount === 0,
    JSON.stringify({ removed: a?.removedNames, count: a?.skillCount }),
  )
}

section('§5 the render arm and the legacy shape')
{
  const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
  const rendered = normalizeAttachmentForAPI(
    { type: 'skill_listing', content: '', skillCount: 0, isInitial: false, removedNames: ['depa-x'] } as never,
  ) as Array<{ message?: { content?: unknown } }>
  const text = JSON.stringify(rendered)
  t('a removal-only listing renders the refusal-warning sentence', text.includes('no longer available') && text.includes('depa-x'), text.slice(0, 200))
  let legacyThrew = false
  let legacyText = ''
  try {
    const legacy = normalizeAttachmentForAPI(
      { type: 'skill_listing', content: '- old: a skill', skillCount: 1, isInitial: true } as never,
    )
    legacyText = JSON.stringify(legacy)
  } catch {
    legacyThrew = true
  }
  t('a persisted legacy listing (no removedNames) renders and never throws', !legacyThrew && legacyText.includes('old: a skill'), legacyText.slice(0, 160))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ prove-skill-deapply-announced — ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ prove-skill-deapply-announced — all checks pass')
process.exit(0)
