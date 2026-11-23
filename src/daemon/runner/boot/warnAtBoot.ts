import { currentSettingsFaults, untoldSettingsFaults } from '../../../platform/settings-faults/faultNotices.js'
import { GLYPH } from '../../../screen/theme/glyphs.js'
import { settingsFaultLine } from '../../../platform/settings/validation.js'
import { currentHiddenCharacterLines, untoldHiddenCharacterLines } from '../../../platform/text/hiddenCharacterFindings.js'
import { hooksSkippedForTrustLine } from '../../../integrations/event-hooks/hooksConfigSnapshot.js'
import { mcpServersSkippedForTrustLine } from '../../../integrations/mcp/serverConfigs.js'
import { toolsWithheldByDeny, getAllBaseTools } from '../../../tools/kit/toolList.js'
import { withheldByRuleWords } from '../../../permissions/rules/ruleReason.js'
import type { BootMade, BootStep, RunnerPorts } from '../runnerPorts.js'

function run(ports: RunnerPorts): BootMade<never> {
  const { getAppState, options, windowsShellRoadNotice } = ports
  const shellRoadNotice = windowsShellRoadNotice()
  if (shellRoadNotice !== null) process.stderr.write(`${shellRoadNotice}\n`)
  for (const fault of options.door === 'wire' ? currentSettingsFaults() : untoldSettingsFaults()) {
    process.stderr.write(`${GLYPH.warn} ${settingsFaultLine(fault)}\n`)
  }
  for (const line of options.door === 'wire' ? currentHiddenCharacterLines() : untoldHiddenCharacterLines()) {
    process.stderr.write(`${GLYPH.warn} ${line}\n`)
  }
  const skippedHooks = hooksSkippedForTrustLine()
  if (skippedHooks !== null && options.door !== 'wire') process.stderr.write(`${GLYPH.warn} ${skippedHooks}\n`)
  const skippedServers = mcpServersSkippedForTrustLine()
  if (skippedServers !== null && options.door !== 'wire') process.stderr.write(`${GLYPH.warn} ${skippedServers}\n`)
  if (options.door !== 'wire') {
    for (const withheld of toolsWithheldByDeny(getAllBaseTools(), getAppState().toolPermissionContext)) {
      process.stderr.write(`${GLYPH.warn} ${withheldByRuleWords(withheld.tool, withheld.rule)}\n`)
    }
  }
  return {}
}

export const warnAtBoot: BootStep<never> = { name: 'warnAtBoot', makes: [], run }
