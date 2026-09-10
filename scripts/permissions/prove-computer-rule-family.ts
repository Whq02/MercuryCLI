#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'computer-rule-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'computer-rule-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
mkdirSync(join(PROJ, '.mercury'), { recursive: true })
process.chdir(PROJ)

const { permissionRuleValueFromString, permissionRuleValueToString } = await import(
  '../../src/utils/permissions/permissionRuleParser.ts'
)
const { suggestionForExactCommand } = await import('../../src/utils/permissions/shellRuleMatching.ts')
const { persistPermissionUpdate } = await import('../../src/utils/permissions/PermissionUpdate.ts')
const { loadAllPermissionRulesFromDisk } = await import('../../src/utils/permissions/permissionsLoader.ts')
const { applyPermissionRulesToPermissionContext } = await import('../../src/utils/permissions/permissions.ts')
const { getRuleByContentsForToolName } = await import('../../src/utils/permissions/decision/rules.ts')
const { COMPUTER_TOOL_NAME } = await import('../../src/services/desktop/toolName.ts')
type Ctx = import('../../src/utils/permissions/permissions.ts').ToolPermissionContext
type RuleUpdate = {
  type: string
  behavior?: string
  destination?: string
  rules?: Array<{ toolName: string; ruleContent?: string }>
}

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const emptyCtx = (): Ctx =>
  ({ mode: 'default', alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, additionalWorkingDirectories: new Map() }) as unknown as Ctx

const SAFARI = 'app:com.apple.Safari'
const VAULT = 'app:com.agilebits.onepassword7'

section('§1 THE RULE STRING ROUND-TRIPS FOR EVERY PLATFORM SHAPE')
for (const identity of ['com.apple.Safari', 'chrome.exe', 'firefox']) {
  const parsed = permissionRuleValueFromString(`${COMPUTER_TOOL_NAME}(app:${identity})`)
  check(
    `${COMPUTER_TOOL_NAME}(app:${identity}) parses to the tool and the app content`,
    parsed.toolName === COMPUTER_TOOL_NAME && parsed.ruleContent === `app:${identity}`,
    JSON.stringify(parsed),
  )
  check('and serialises back to the same spelling', permissionRuleValueToString(parsed) === `${COMPUTER_TOOL_NAME}(app:${identity})`)
}

section("§2 THE CARD'S SUGGESTION")
const suggestions = suggestionForExactCommand(COMPUTER_TOOL_NAME, SAFARI) as unknown as RuleUpdate[]
const update = suggestions[0]
check('exactly one addRules update', suggestions.length === 1 && update?.type === 'addRules', JSON.stringify(suggestions))
check("allow, to the project's local settings", update?.behavior === 'allow' && update?.destination === 'localSettings')
check(
  'the rule names the tool and the identity',
  update?.rules?.[0]?.toolName === COMPUTER_TOOL_NAME && update?.rules?.[0]?.ruleContent === SAFARI,
  JSON.stringify(update?.rules),
)

section('§3 THE PERSISTED RULE THROUGH THE DECISION CHAIN')
persistPermissionUpdate(update as never)
persistPermissionUpdate({
  type: 'addRules',
  rules: [{ toolName: COMPUTER_TOOL_NAME, ruleContent: VAULT }],
  behavior: 'deny',
  destination: 'localSettings',
} as never)
const written = JSON.parse(readFileSync(join(PROJ, '.mercury', 'settings.local.json'), 'utf8')) as {
  permissions?: { allow?: string[]; deny?: string[] }
}
check(
  `settings.local.json allow carries ${COMPUTER_TOOL_NAME}(${SAFARI})`,
  (written.permissions?.allow ?? []).includes(`${COMPUTER_TOOL_NAME}(${SAFARI})`),
  JSON.stringify(written.permissions),
)
check(
  `and deny carries ${COMPUTER_TOOL_NAME}(${VAULT})`,
  (written.permissions?.deny ?? []).includes(`${COMPUTER_TOOL_NAME}(${VAULT})`),
  JSON.stringify(written.permissions),
)
const ctx = applyPermissionRulesToPermissionContext(emptyCtx(), loadAllPermissionRulesFromDisk())
const allow = getRuleByContentsForToolName(ctx, COMPUTER_TOOL_NAME, 'allow')
const deny = getRuleByContentsForToolName(ctx, COMPUTER_TOOL_NAME, 'deny')
check('the loaded allow rules answer the Safari identity', allow.has(SAFARI), JSON.stringify([...allow.keys()]))
check('the loaded deny rules answer the vault identity', deny.has(VAULT), JSON.stringify([...deny.keys()]))
check('a deny rule never answers as allow', !allow.has(VAULT))
check('another identity is not matched', !allow.has('app:com.apple.Finder'))
check('the Browser family is untouched by a Computer rule', !getRuleByContentsForToolName(ctx, 'Browser', 'allow').has(SAFARI))

section('§4 IDENTITIES NEVER NORMALISE ACROSS PLATFORMS')
check('a bundle identifier rule does not match a bare name', !allow.has('app:Safari') && !allow.has('app:safari'))
check('nor an executable spelling', !allow.has('app:safari.exe'))
check('the padded spelling still names the identity', permissionRuleValueFromString(`  ${COMPUTER_TOOL_NAME}(${SAFARI})  `).ruleContent === SAFARI)

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-computer-rule-family: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-computer-rule-family: all green')
