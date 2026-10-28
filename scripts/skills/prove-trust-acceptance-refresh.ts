import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'trust-skill-refresh-')))
const home = join(root, 'home')
const cwd = join(root, 'project')
const previousCwd = process.cwd()
mkdirSync(home)
mkdirSync(join(cwd, '.mercury', 'skills', 'after-trust'), { recursive: true })
writeFileSync(join(cwd, '.mercury', 'skills', 'after-trust', 'SKILL.md'), '---\ndescription: a skill made available after folder trust\n---\nTRUSTED_SKILL_BODY\n')
writeFileSync(join(home, '.mercury.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, projects: {} }))
writeFileSync(join(home, 'settings.json'), '{}')
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_DEMO
delete process.env.ANTHROPIC_API_KEY
process.chdir(cwd)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
state.setCwdState(cwd)
state.setOriginalCwd(cwd)
state.setProjectRoot(cwd)
state.setSessionTrustAccepted(false)
const { getCommands, getSkillToolCommands, getSlashCommandToolSkills } = await import('../../src/commands.ts')
const { showSetupScreens } = await import('../../src/interactiveHelpers.tsx')
const { TrustDialog } = await import('../../src/components/TrustDialog/TrustDialog.tsx')
const { makeTally } = await import('../daemon/dupline-world.ts')
const tally = makeTally('prove-trust-acceptance-refresh')
const hasSkill = (commands: Array<{ name: string }>): boolean => commands.some(command => command.name === 'after-trust')
let accepted = 0
function answer(node: React.ReactNode): boolean {
  if (Array.isArray(node)) return node.some(answer)
  if (!React.isValidElement(node)) return false
  const props = node.props as { children?: React.ReactNode; onDone?: (value?: unknown) => void }
  if (node.type === TrustDialog) {
    accepted++
    props.onDone?.()
    return true
  }
  if (typeof node.type === 'function' && node.type.name === 'TerminalProfileCard') {
    props.onDone?.('continue')
    return true
  }
  return answer(props.children)
}
try {
  const commands = await getCommands(cwd)
  const views = await Promise.all([getSkillToolCommands(cwd), getSlashCommandToolSkills(cwd)])
  tally.check('all catalogue views exclude the untrusted project skill', !hasSkill(commands) && views.every(view => !hasSkill(view)))
  await showSetupScreens({ render: (node: React.ReactNode) => { if (!answer(node)) throw new Error('unexpected setup card') } } as never, 'default', false, commands)
  tally.check('the trust card was accepted once', accepted === 1 && state.getSessionTrustAccepted())
  tally.check('the already-held boot catalogue now includes the skill', hasSkill(commands))
  tally.check('the outer command memo now includes the skill', hasSkill(await getCommands(cwd)))
  tally.check('both derived skill catalogues refresh without a restart', hasSkill(await getSkillToolCommands(cwd)) && hasSkill(await getSlashCommandToolSkills(cwd)))
} finally {
  process.chdir(previousCwd)
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
