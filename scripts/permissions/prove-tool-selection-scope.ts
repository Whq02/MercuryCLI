import React from 'react'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('tool-selection-scope')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
await import('../../src/tools/crewmate/CrewmateTool.js')
const { ToolSelector } = await import('../../src/screen/agents/ToolSelector.js')
const { TrustDialog } = await import('../../src/screen/trust-dialog/TrustDialog.js')
const { setSessionTrustAccepted } = await import('../../src/boot/process-state/processState.js')
const { resolveAgentTools } = await import('../../src/tools/crewmate/crewmateLifecycle.js')
const { useInput } = await import('../../src/screen/themedRenderer.js')
function InputHost({ children }: { children: React.ReactNode }): React.ReactNode {
  useInput(() => {})
  return children
}
const tools = [{ name: 'Read' }, { name: 'Write' }] as never
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}${detail ? ' — ' : ''}ToolSelector in src/screen/agents/ToolSelector.tsx, TrustDialog in src/screen/trust-dialog/TrustDialog.tsx and resolveAgentTools in src/tools/crewmate/crewmateLifecycle.ts are what this check exercises`}`)
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
    for (let waited = 0; waited < 5000 && !m.screen().includes('Continue'); waited += 120) await settle(120)
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
