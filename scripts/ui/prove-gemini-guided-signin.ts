#!/usr/bin/env bun
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gemini-guided-signin-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.GOOGLE_API_KEY
delete process.env.GEMINI_API_KEY
delete process.env.MERCURY_GEMINI_OAUTH_CLIENT_ID
delete process.env.MERCURY_GEMINI_OAUTH_CLIENT_SECRET

const ROOT = join(import.meta.dir, '..', '..')
const guide = await import('../../src/components/geminiConnectGuide.ts')
const accounts = await import('../../src/services/providers/gemini/geminiAccounts.ts')

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel)
  }
  return out
}
type Page = { address: string; observedAt: string; source: string }
const dated = (page: Page | undefined): boolean =>
  page !== undefined && /^https:\/\//.test(page.address) && /^\d{4}-\d{2}-\d{2}$/.test(page.observedAt) && page.source.length > 10

section('§1 the six steps and their dated pages')
const steps = guide.GEMINI_GOOGLE_ACCOUNT_STEPS
check('six steps numbered 1 to 6 in order', steps.length === 6 && steps.every((s, i) => s.number === i + 1), steps.map(s => s.number).join(','))
check('every step has a title and a detail of its own', steps.every(s => s.title.length > 8 && s.detail.length > 20) && new Set(steps.map(s => s.title)).size === 6)
check('steps 1 to 4 open a page: an https address beside its observed date and its source', [1, 2, 3, 4].every(n => dated(steps[n - 1]!.page)), JSON.stringify(steps.slice(0, 4).map(s => s.page)))
check('step 3 names the overview page beside its own', dated(steps[2]!.overviewPage) && steps[2]!.overviewPage!.address.endsWith('/auth/overview'))
check('steps 5 and 6 open no Console page', steps[4]!.page === undefined && steps[5]!.page === undefined && steps[4]!.overviewPage === undefined)
const hosts = steps.flatMap(s => [s.page, s.overviewPage]).filter((p): p is Page => p !== undefined).map(p => new URL(p.address).host)
check("every step page is Google's Console or its Auth Platform", hosts.every(h => h === 'console.cloud.google.com' || h === 'console.developers.google.com'), hosts.join(','))
check('step 1 is the project page, step 2 the enable-API flow for the Generative Language API', steps[0]!.page!.address === 'https://console.cloud.google.com/projectcreate' && steps[1]!.page!.address === 'https://console.cloud.google.com/flows/enableapi?apiid=generativelanguage.googleapis.com')
check('step 3 is the Audience page, step 4 the clients page', steps[2]!.page!.address.endsWith('/auth/audience') && steps[3]!.page!.address.endsWith('/auth/clients'))
check('step 2 says the enable-API page can create the project too', steps[1]!.detail.includes('it can create one too'))
check("the API key page is AI Studio's key page, dated", dated(guide.GEMINI_API_KEY_PAGE) && guide.GEMINI_API_KEY_PAGE.address === 'https://aistudio.google.com/apikey')
const pages = guide.geminiGuidePages()
check('the release-day list carries every page once: the key page, four step pages, the overview page', pages.length === 6 && new Set(pages.map(p => p.address)).size === 6 && pages[0] === guide.GEMINI_API_KEY_PAGE)
check('step 3 says why the test user is needed and names the Get started road', steps[2]!.detail.includes('Google lets an unpublished app sign in only its listed test users') && steps[2]!.detail.includes('External') && steps[2]!.detail.includes('Test users') && steps[2]!.detail.includes('Get started'))
check('step 4 asks for a Desktop app client', steps[3]!.detail.includes('Desktop app'))
check('step 5 says the id is kept for good and the secret is optional', steps[4]!.detail.includes('kept for good') && steps[4]!.detail.includes('optional'))
check('step 6 names the unverified-app dialog, Continue and Allow', steps[5]!.detail.includes("Google hasn't verified this app") && steps[5]!.detail.includes('Continue') && steps[5]!.detail.includes('Allow'))

section('§2 the rows: the key first, the account second, the change row only over a stored client')
const none = guide.geminiConnectRows({ oauthConnected: false })
check('the API key row is first, with the ruled words', none[0]!.value === 'key' && none[0]!.label === 'API key — the easiest: create one in AI Studio, paste it here', none[0]!.label)
check('the Google account row follows; no third row without a stored client', none.length === 2 && none[1]!.value === 'google' && none[1]!.label === 'Google account — six steps, each opens its Console page', JSON.stringify(none))
const storedKey = guide.geminiConnectRows({ keySource: 'stored', oauthConnected: false })
check('a stored key shows the key row as connected', storedKey[0]!.label === 'API key — connected (stored locally) · ↵ pastes a replacement', storedKey[0]!.label)
const envKey = guide.geminiConnectRows({ keySource: 'env-google', oauthConnected: false })
const envKey2 = guide.geminiConnectRows({ keySource: 'env-gemini', oauthConnected: false })
check('an environment key names its variable on the connected row', envKey[0]!.label.includes('connected (GOOGLE_API_KEY in the environment)') && envKey2[0]!.label.includes('connected (GEMINI_API_KEY in the environment)'), envKey[0]!.label)
const storedClient = guide.geminiConnectRows({ clientSource: 'stored', oauthConnected: false })
check('a stored client id shortens the account row to the sign-in and adds the change row third', storedClient.length === 3 && storedClient[1]!.label === 'Google account — the client id is stored · ↵ signs in (step 6)' && storedClient[2]!.value === 'client' && storedClient[2]!.label === 'Change the stored client id (step 5 again)', JSON.stringify(storedClient))
const envClient = guide.geminiConnectRows({ clientSource: 'env', oauthConnected: false })
check('an environment client id names its variable and offers no change row', envClient.length === 2 && envClient[1]!.label.includes('MERCURY_GEMINI_OAUTH_CLIENT_ID') && envClient[1]!.label.includes('(step 6)'), JSON.stringify(envClient))
const connected = guide.geminiConnectRows({ clientSource: 'stored', oauthConnected: true })
check('a connected Google account reads connected and signs in again from step 6', connected[1]!.label === 'Google account — connected · ↵ signs in again (step 6)' && connected.length === 3, connected[1]!.label)
check('the card title and intro are one spelling', guide.GEMINI_CONNECT_TITLE === 'Connect Google Gemini' && guide.GEMINI_CONNECT_INTRO.includes('one paste') && guide.GEMINI_CONNECT_INTRO.includes('six numbered steps'))

section('§3 the opening step and the return after a refusal')
check('no client: the walk starts at step 1', guide.geminiGuideOpeningStep({ oauthConnected: false }) === 1)
check('a stored client id opens at step 6; an environment one too', guide.geminiGuideOpeningStep({ clientSource: 'stored', oauthConnected: false }) === 6 && guide.geminiGuideOpeningStep({ clientSource: 'env', oauthConnected: true }) === 6)
const denied = accounts.geminiOauthErrorRemedy('access_denied', 'fixture')
check("Google's access_denied refusal, in today's words, returns the card to step 3", guide.geminiGuideReturnStep(denied) === 3 && denied.includes('your OAuth app is in testing mode and this Google account is not one of its test users'), denied)
const internal = accounts.geminiOauthErrorRemedy('org_internal')
check('org_internal keeps its words and settles the card as before', guide.geminiGuideReturnStep(internal) === undefined && internal.includes('restricted to its own Google Workspace organization'), internal)
check('a cancel, a state mismatch and a token refusal settle the card as before', ['gemini connect cancelled', 'cancelled from the connect surface', 'pasted state does not match this sign-in attempt', 'google token endpoint returned HTTP 401 (invalid_client)'].every(m => guide.geminiGuideReturnStep(m) === undefined))

section('§4 the pane: the numbered list, the current step marked, the page and its open state')
const full = guide.geminiGuidePaneLines({ step: 3, opened: 'opened', compact: false })
check('the title names the step of six', full[0]!.tone === 'title' && full[0]!.text === 'Connect a Google account — step 3 of 6', full[0]!.text)
const list = full.filter(l => l.tone === 'done' || l.tone === 'current' || l.tone === 'todo')
check('the full layout lists all six steps, done ticked, the current marked, the rest plain', list.length === 6 && list.map(l => l.tone).join(',') === 'done,done,current,todo,todo,todo' && list[0]!.text === '✓ 1. Create a Google Cloud project' && list[2]!.text === '› 3. Set up the consent screen for testing' && list[5]!.text === '  6. Sign in with Google in the browser', JSON.stringify(list))
const detailAt = full.findIndex(l => l.tone === 'detail')
check('the detail follows the list, then the address, then the overview address, then the open state', detailAt === 7 && full[detailAt]!.text === steps[2]!.detail && full[8]!.tone === 'address' && full[8]!.text === steps[2]!.page!.address && full[9]!.text === `the overview page: ${steps[2]!.overviewPage!.address}` && full[10]!.tone === 'status' && full[10]!.text === 'opened in your browser' && full.length === 11, JSON.stringify(full.slice(7)))
const compact = guide.geminiGuidePaneLines({ step: 3, opened: 'opened', compact: true })
check('the compact layout lists only the current step', compact.filter(l => l.tone === 'current').length === 1 && compact.filter(l => l.tone === 'done' || l.tone === 'todo').length === 0 && compact[1]!.text === '› 3. Set up the consent screen for testing')
const failed = guide.geminiGuidePaneLines({ step: 1, opened: 'failed', compact: true })
check('a browser that did not open is said as a warning beside the address', failed[failed.length - 1]!.tone === 'note' && failed[failed.length - 1]!.text === 'no browser opened here — open the address above yourself' && failed[failed.length - 2]!.tone === 'address')
check('an opening browser is said while it opens', guide.geminiGuideOpenWords('opening') === 'opening your browser…')
const noted = guide.geminiGuidePaneLines({ step: 3, opened: 'opened', note: denied, compact: false })
check("the refusal's words ride the pane as its last line when the card returns to step 3", noted[noted.length - 1]!.tone === 'note' && noted[noted.length - 1]!.text === denied)
const five = guide.geminiGuidePaneLines({ step: 5, compact: false })
const six = guide.geminiGuidePaneLines({ step: 6, compact: false })
check('steps 5 and 6 paint no address and no open state', five.every(l => l.tone !== 'address' && l.tone !== 'status') && six.every(l => l.tone !== 'address' && l.tone !== 'status') && five[five.length - 1]!.text === steps[4]!.detail && six[six.length - 1]!.text === steps[5]!.detail)
check('the hints: next and reopen on the page steps, the fields at step 5, the copy chord at step 6', [1, 2, 3, 4].every(n => guide.geminiGuideHint(n as 1) === '↵ done, next step · o opens the page again · esc back') && guide.geminiGuideHint(5, 'id') === '↵ continues to the secret · esc back' && guide.geminiGuideHint(5, 'secret') === '↵ stores (secret optional) · esc back to the id' && guide.geminiGuideHint(6) === 'c copies the URL · ESC cancels.')

section('§5 the key leg: AI Studio opened, the address printed, the paste awaited')
const opened = guide.geminiKeyLegLines('opened')
check('the key leg names AI Studio, its opened state and the paste', opened[0]!.text === 'Connect Google Gemini — API key' && opened[1]!.text === 'AI Studio opened in your browser: press Create API key there, then paste the key here.' && opened[2]!.tone === 'address' && opened[2]!.text === 'https://aistudio.google.com/apikey', JSON.stringify(opened))
check('a box without a browser is told to open the address itself', guide.geminiKeyLegLines('failed')[1]!.text === 'Open AI Studio at the address below, press Create API key there, then paste the key here.' && guide.geminiKeyLegLines(undefined)[1]!.text.startsWith('Open AI Studio'))
check("the storage sentence is the previous card's, byte for byte", opened[3]!.text === 'Stored auth-scoped (mode 600), never logged; GOOGLE_API_KEY / GEMINI_API_KEY env vars always win over the store (GOOGLE_API_KEY outranks — the documented precedence).')

section('§6 one owner of the addresses and the words; the card consumes the model')
const spellers = walk('src').filter(rel => /aistudio\.google\.com|console\.cloud\.google\.com|console\.developers\.google\.com/.test(read(rel)))
check('no source file but the model spells a Console or AI Studio address', spellers.length === 1 && spellers[0] === 'src/components/geminiConnectGuide.ts', spellers.join(','))
const card = read('src/components/GeminiConnect.tsx')
check('the card reads its rows, its pane, its return step and the key page from the model', ['geminiConnectRows(', 'geminiGuidePaneLines(', 'geminiGuideReturnStep(', 'geminiGuideOpeningStep(', 'GEMINI_API_KEY_PAGE.address', 'geminiKeyLegLines('].every(n => card.includes(n)))
check('the card opens the pages through the one browser opener and keeps the login doors', ['openBrowser(', 'finishGeminiOauthConnect(', 'storeGeminiApiKeyLogin(', 'keyPasteGuardNote(', 'GEMINI_CLIENT_STORED_UNVERIFIED_NOTE', 'writeGeminiOauthClientConfig('].every(n => card.includes(n)))
check('the card no longer spells the one-sentence Console road nor the client gate', !card.includes('APIs & Services') && !card.includes('geminiOauthClientMissingCopy') && !card.includes('needs an OAuth client first'))

section('§7 the docs follow the steps in the same words')
const docs = read('docs/ENGINES.md')
const titleAt = steps.map(s => docs.indexOf(s.title))
check('every step title is in docs/ENGINES.md', steps.every(s => docs.includes(s.title)), steps.filter(s => !docs.includes(s.title)).map(s => s.title).join(' | '))
check('the titles read in step order', titleAt.every(at => at >= 0) && titleAt.every((at, i) => i === 0 || at > titleAt[i - 1]!), titleAt.join(','))
check('the docs name the key row, the AI Studio page, the test-user reason and the return to step 3', docs.includes(guide.GEMINI_KEY_ROW) && docs.includes('https://aistudio.google.com/apikey') && docs.includes('Google lets an unpublished app sign in only its listed test users') && docs.includes('access_denied') && docs.includes('step 3'))

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
