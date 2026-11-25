import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const [road = '', port = ''] = process.argv.slice(2)
const { enableConfigs } = await import('../../../src/platform/settings/config.ts')
enableConfigs()
const openai = await import('../../../src/models/roads/openai/openaiAccounts.ts')
const gemini = await import('../../../src/models/roads/gemini/geminiAccounts.ts')

const issues: string[] = []
const options = { loopbackPort: Number(port), onListenerIssue: (message: string) => { issues.push(message) } }
const handles = road === 'openai' ? openai.beginOpenaiBrowserConnect(options) : road === 'gemini-oauth' ? gemini.beginGeminiBrowserConnect(options) : gemini.beginGeminiPlanBrowserConnect(options)
while (handles.boundLoopbackPort() === undefined && issues.length === 0) await new Promise(resolve => setTimeout(resolve, 10))
console.log(JSON.stringify({ about: 'begun', authorizeUrl: handles.authorizeUrl, bound: handles.boundLoopbackPort() ?? null, issue: issues[0] ?? null }))
createInterface({ input: process.stdin }).once('line', pasted => handles.completeWithRedirect(pasted))
const ended = await handles.result.then(account => ({ ok: true, account: account.label }), (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))

type Pair = { refreshToken?: string }
function stored(): string | undefined {
  if (road === 'openai') return (JSON.parse(readFileSync(openai.openaiAuthPathForDisplay(), 'utf8')) as { tokens?: Pair }).tokens?.refreshToken
  const file = JSON.parse(readFileSync(gemini.geminiAuthPathForDisplay(), 'utf8')) as { tokens?: Pair; plan?: { tokens?: Pair } }
  return road === 'gemini-oauth' ? file.tokens?.refreshToken : file.plan?.tokens?.refreshToken
}
console.log(JSON.stringify({ about: 'ended', ...ended, stored: ended.ok ? stored() : undefined }))
process.exit(0)
