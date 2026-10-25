import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('tool-selection-scope')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
await import('../../src/tools/AgentTool/AgentTool.js')
const { ToolSelector } = await import('../../src/components/agents/ToolSelector.js')
const { TrustDialog } = await import('../../src/components/TrustDialog/TrustDialog.js')
const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.js')
const { resolveAgentTools } = await import('../../src/tools/AgentTool/agentToolUtils.js')
const { useInput } = await import('../../src/ink.js')
function InputHost({ children }: { children: React.ReactNode }): React.ReactNode {
  useInput(() => {})
  return children
}
const tools = [{ name: 'Read' }, { name: 'Write' }] as never
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
try {
  for (const leg of [
    { initialTools: ['Read', 'Read'], explicitSelection: false, expected: ['Read'] },
    { initialTools: ['Read', 'Write'], explicitSelection: false, expected: undefined },
    { initialTools: ['Read', 'Write'], explicitSelection: true, expected: ['Read', 'Write'] },
    { initialTools: [], explicitSelection: true, expected: [] },
  ]) {
    let calls = 0
    let result: string[] | undefined
    const m = await mountOffscreen(React.createElement(InputHost, { children: React.createElement(ToolSelector, { tools, ...leg, onComplete: value => { result = value; calls++ } }) }), 100, 35)
    await settle(120)
    check('the tool selector paints Continue', m.screen().includes('Continue'), m.screen())
    m.push(KEY.enter)
    await settle(100)
    check(`selected ${JSON.stringify(leg.initialTools)}, explicit ${leg.explicitSelection}: scope preserved`, calls === 1 && JSON.stringify(result) === JSON.stringify(leg.expected), JSON.stringify(result))
    if (leg.explicitSelection && leg.initialTools.length > 0) {
      const resolved = resolveAgentTools({ source: 'projectSettings', disallowedTools: result }, tools)
      check('the complete deny selection resolves to no tools', resolved.resolvedTools.length === 0)
    }
    m.unmount()
  }
  const editor = readFileSync(join(import.meta.dir, '../../src/components/agents/studio/StudioEditor.tsx'), 'utf8')
  check('the disallowed-tools editor requests the explicit list', /initialTools=\{doc\.fields\.disallowedTools \?\? \[\]\}\s+explicitSelection/.test(editor))
  setSessionTrustAccepted(true)
  let completed = 0
  const onDone = () => { completed++ }
  const tree = React.createElement(TrustDialog, { onDone })
  const trusted = await mountOffscreen(tree, 100, 30)
  await settle(100)
  check('an accepted trust gate completes once', completed === 1, String(completed))
  trusted.resize(React.createElement(TrustDialog, { onDone }), 100, 30)
  await settle(100)
  check('rerendering the accepted gate does not complete twice', completed === 1, String(completed))
  trusted.unmount()
} finally {
  setSessionTrustAccepted(false)
  await releaseScratchHome(home)
}
process.exit(failures === 0 ? 0 : 1)
