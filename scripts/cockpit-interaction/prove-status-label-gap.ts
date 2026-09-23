import { fixture, fixtureReads, buildFacts, model } from './status-popup-fixture.js'
const React = await import('react')
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { SettingsStatusView } = await import('../../src/components/mercury-ui/screens/SettingsStatusView.js')
let failures = 0
function check(name: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`)
}
const frame = await renderToString(React.createElement(SettingsStatusView, { facts: fixture.facts, onClose() {}, width: 106, rowBudget: 44 }), 110)
const row = (name: string): string => frame.split('\n').find(line => line.includes(name)) ?? ''
check('the two account labels align their values at the page column', row('Anthropic').indexOf('Claude subscription') === 16 && row('OpenAI').indexOf('ChatGPT pro') === 16)
check('the long family name keeps its label-value separator', row('Hugging Face').includes('Hugging Face  op-hf'))
check('the combined endpoint labels stay whole and separated', row('Custom endpoint').includes('Custom endpoint · Local        not configured'))
check('the grouped API keys retain the page gap', row('Z.AI').includes('DeepSeek     API keys'))
const absent = buildFacts([], model, { ...fixtureReads, families: () => fixtureReads.families!().map(f => ({ ...f, credentialed: false })) })
const empty = await renderToString(React.createElement(SettingsStatusView, { facts: absent.facts, onClose() {}, width: 106, rowBudget: 44 }), 110)
check('absent account notes never run into their labels', empty.includes('Hugging Face  not configured') && !/Facenot|Localnot|endpointnot/.test(empty))
console.log(`status label gaps: ${failures} failures`)
process.exit(failures ? 1 : 0)
