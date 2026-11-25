;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const waitMs = Number(process.argv[2])
const { enableConfigs } = await import('../../../src/platform/settings/config.ts')
enableConfigs()
const accounts = await import('../../../src/models/roads/openrouter/openrouterAccounts.ts')
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const issues: string[] = []
const handles = accounts.beginOpenrouterConnect({ skipBrowserOpen: true, onListenerIssue: message => issues.push(message) })
while ((handles.boundLoopbackPort() === undefined && issues.length === 0) || handles.authorizeUrl === '') await sleep(5)
console.log(JSON.stringify({ about: 'begun', authorizeUrl: handles.authorizeUrl, port: handles.boundLoopbackPort() ?? null }))
const ended = await Promise.race([
  handles.result.then(ref => ({ ok: true, words: ref.label }), (error: Error) => ({ ok: false, words: error.message })),
  sleep(waitMs).then(() => ({ ok: false, words: 'no authorization code reached this sign-in' })),
])
handles.cancel('the proof is over')
console.log(JSON.stringify({ about: 'ended', ...ended, minted: accounts.readMintedOpenrouterKey()?.key ?? null, issues }))
process.exit(0)
