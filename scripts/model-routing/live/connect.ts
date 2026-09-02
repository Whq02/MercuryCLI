// ============================================================================
//  scripts/model-routing/live/connect — LIVE OpenAI subscription connect through
//  Mercury's OWN account owner (operator-present, one
//  browser click). SOLO-RUN ONLY — never a gate member (outside the
//  prove-*.ts glob by directory). Exercises the exact code path behind
//  `/router connect`: beginOpenaiBrowserConnect → PKCE → loopback :1455 (or
//  the paste fallback typed into THIS terminal) → token exchange →
//  ~/.mercury/.openai-auth.json → forced live-catalogue refresh receipt.
//
//    bun run scripts/model-routing/live/connect.ts            # browser flow
//    bun run scripts/model-routing/live/connect.ts --device   # device-code flow
//
//  Secrets never print — plan/account facts + catalogue counts only.
// ============================================================================
// The build injects MACRO; direct bun-on-src runs shim it (suite convention).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const accounts = await import('../../../src/services/providers/openai/openaiAccounts.js')
const { refreshOpenaiCatalogue } = await import(
  '../../../src/services/providers/openai/openaiCatalogue.js'
)

const device = process.argv.includes('--device')

function printReceipt(ref: {
  label: string
  accountId?: string
  planType?: string
}): void {
  console.log('CONNECTED')
  console.log(`  source : chatgpt-subscription`)
  console.log(`  label  : ${ref.label}`)
  if (ref.accountId) console.log(`  account: ${ref.accountId}`)
  if (ref.planType) console.log(`  plan   : ${ref.planType}`)
  console.log(`  store  : ${accounts.openaiAuthPathForDisplay()}`)
}

async function catalogueReceipt(): Promise<void> {
  const snapshot = await refreshOpenaiCatalogue('chatgpt-subscription', { force: true })
  if (!snapshot) {
    console.log('catalogue: no snapshot (unexpected)')
    return
  }
  if (snapshot.lastError) {
    console.log(`catalogue: UNAVAILABLE — ${snapshot.lastError}`)
    return
  }
  console.log(`catalogue: ${snapshot.models.length} model(s) at ${new Date(snapshot.fetchedAtMs).toISOString()}`)
  for (const m of snapshot.models) {
    console.log(
      `  ${m.id}${m.displayName ? ` · ${m.displayName}` : ''}${Array.isArray(m.supportedReasoningEfforts) ? ` · efforts [${m.supportedReasoningEfforts.join(', ')}]${m.defaultReasoningEffort ? ` default ${m.defaultReasoningEffort}` : ''}` : ''}${m.visibility ? ` · ${m.visibility}` : ''}${typeof m.priority === 'number' ? ` · prio ${m.priority}` : ''}`,
    )
  }
}

if (accounts.subscriptionConnected()) {
  console.log('already connected — current resolution:')
  const ref = accounts.resolveOpenaiAccount()
  if (ref) printReceipt(ref)
  await catalogueReceipt()
  process.exit(0)
}

if (device) {
  const start = await accounts.beginOpenaiDeviceConnect()
  console.log(`DEVICE CODE: ${start.userCode}`)
  console.log(start.verifyHint)
  const ref = await start.result
  printReceipt(ref)
  await catalogueReceipt()
  process.exit(0)
}

const handles = accounts.beginOpenaiBrowserConnect({
  onListenerIssue: message => console.log(`[listener] ${message}`),
})
console.log('AUTHORIZE URL (browser should be opening):')
console.log(handles.authorizeUrl)
console.log('')
console.log('Waiting for the loopback callback… (or paste the redirected URL here + Enter)')

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  const line = chunk.trim()
  if (line) handles.completeWithRedirect(line)
})
process.stdin.resume()

const timeout = setTimeout(() => {
  handles.cancel('timed out after 10 minutes')
}, 10 * 60_000)

try {
  const ref = await handles.result
  clearTimeout(timeout)
  printReceipt(ref)
  await catalogueReceipt()
  process.exit(0)
} catch (error) {
  clearTimeout(timeout)
  console.error(`CONNECT FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
