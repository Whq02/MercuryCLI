// LIVE probe: what does GET {chatgpt-base}/models need? (solo-run, operator
// present). Prints status + body head per variant — bodies name missing params.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { resolveOpenaiRequestAuth } = await import(
  '../../../src/services/providers/openai/openaiAccounts.js'
)

const auth = await resolveOpenaiRequestAuth({ sourceKind: 'chatgpt-subscription' })
if (!auth) {
  console.error('no subscription auth — connect first')
  process.exit(1)
}

async function probe(label: string, url: string, extra: Record<string, string>): Promise<void> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { ...auth!.headers, ...extra },
  })
  const body = await response.text()
  console.log(`\n### ${label} → HTTP ${response.status}`)
  console.log(body.slice(0, 500))
}

const base = auth.baseUrl.replace(/\/$/, '')
await probe('bare', `${base}/models`, {})
await probe('client_version only', `${base}/models?client_version=0.99.0`, {})
await probe('originator+UA+version', `${base}/models?client_version=0.99.0`, {
  originator: 'codex_cli_rs',
  'user-agent': 'codex_cli_rs/0.99.0 (Mac OS 26.1.0; arm64) WindowsTerminal',
})
