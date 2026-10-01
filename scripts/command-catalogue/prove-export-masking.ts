import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exportFixture } from './exportFixture.js'

const textOnly = process.argv.includes('--text-only')
let failures = 0
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const bearer = 'fixtureBearer0123456789'
const key = 'sk-fixture0123456789012345'
const stored = 'opaqueStoredFixtureValue'
const samples = [
  ['bearer', bearer, `Bearer ${bearer}`],
  ['authorization', 'BasicFixturePrivateValue', 'Authorization: Basic BasicFixturePrivateValue'],
  ['sk-key', key, `"${key}"`],
  ['anthropic', 'sk-ant-' + 'a'.repeat(30), 'sk-ant-' + 'a'.repeat(30)],
  ['github-pat', 'ghp_' + 'b'.repeat(36), 'ghp_' + 'b'.repeat(36)],
  ['github-oauth', 'gho_' + 'c'.repeat(36), 'gho_' + 'c'.repeat(36)],
  ['github-fine-grained', 'github_pat_' + 'd'.repeat(82), 'github_pat_' + 'd'.repeat(82)],
  ['xai', 'xai-' + 'e'.repeat(30), 'xai-' + 'e'.repeat(30)],
  ['gemini', 'AIza' + 'f'.repeat(35), 'AIza' + 'f'.repeat(35)],
  ['huggingface', 'hf_' + 'g'.repeat(34), 'hf_' + 'g'.repeat(34)],
  ['gitlab', 'glpat-' + 'h'.repeat(20), 'glpat-' + 'h'.repeat(20)],
  ['slack-bot', 'xoxb-' + 'i'.repeat(25), 'xoxb-' + 'i'.repeat(25)],
  ['slack-user', 'xoxp-' + 'j'.repeat(25), 'xoxp-' + 'j'.repeat(25)],
  ['aws', 'AKIA' + 'K'.repeat(16), 'AKIA' + 'K'.repeat(16)],
  ['query', 'fixtureQueryValue', 'https://example.test/?api_key=fixtureQueryValue&count=2'],
  ['token-env', 'fixtureTokenValue', 'SERVICE_TOKEN=fixtureTokenValue'],
  ['password-env', 'fixturePasswordValue', 'password="fixturePasswordValue"'],
  ['secret-env', 'fixtureSecretValue', "secret='fixtureSecretValue'"],
  ['pem', 'privateKeyFixtureBody', '-----BEGIN PRIVATE KEY-----\nprivateKeyFixtureBody\n-----END PRIVATE KEY-----'],
  ['stored', stored, stored],
]
const fixture = await exportFixture(samples.map(([, , text]) => text).join('\n'))
try {
  const { getSecureStorage } = await import('../../src/utils/secureStorage/index.js')
  check('the scratch credential store is planted', getSecureStorage().update({ trustedDeviceToken: stored, extensionSecrets: { proof: { value: 'otherOpaqueStoredValue' } } }).success)
  const { writeStoredCompatApiKey } = await import('../../src/utils/router/providerSecrets.js')
  writeStoredCompatApiKey('opaqueProviderFixture')
  const { saveApiKey } = await import('../../src/utils/auth.js')
  await saveApiKey('opaqueManagedFixture')
  writeFileSync(join(fixture.scratch, '.openai-auth.json'), JSON.stringify({ version: 1, tokens: { accessToken: 'opaqueAccessFixture', refreshToken: 'opaqueRefreshFixture' } }))
  const extraValues = ['otherOpaqueStoredValue', 'opaqueProviderFixture', 'opaqueManagedFixture', 'opaqueAccessFixture', 'opaqueRefreshFixture', 'opaqueEnvironmentFixture']
  process.env.OPENAI_API_KEY = extraValues[5]
  const first = fixture.messages[0] as any
  first.message.content += '\n' + extraValues.join('\n')
  const assistant = fixture.messages[1] as any
  assistant.message.content.find((block: any) => block.type === 'tool_use').input.nested = {
    password: 'unshaped password with spaces', Authorization: 'Basic nestedHeaderValue', ordinary: 'keep this value', count: 2,
  }
  const { getFocusedSessionConnector, setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.js')
  const connector = getFocusedSessionConnector()
  const workspace = join(fixture.scratch, stored)
  mkdirSync(workspace)
  setFocusedSessionConnector({ ...connector, sessionId: () => stored, workspace: () => ({ ...connector.workspace(), cwd: workspace }) })
  const before = JSON.stringify(fixture.messages)
  for (const extension of textOnly ? ['txt'] : ['txt', 'json']) {
    const name = `masked.${extension}`
    await fixture.write(name)
    const path = join(workspace, name)
    check(`${extension}: the requested file exists`, existsSync(path))
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    for (const [label, value] of samples) check(`${extension}: masks ${label} everywhere`, !text.includes(value!))
    check(`${extension}: all credential stores are masked by value`, extraValues.every(value => !text.includes(value)))
    check(`${extension}: structured secret fields are masked`, !text.includes('unshaped password with spaces') && !text.includes('nestedHeaderValue'))
    check(`${extension}: ordinary content and the query suffix survive`, text.includes('keep this value') && text.includes('&count=2') && text.includes('[redacted]') && text.includes('Both files checked.'))
    if (extension === 'json') {
      const document = JSON.parse(text)
      check('JSON remains valid and redacts header, text, input and result', document.session.id === '[redacted]' && !document.session.cwd.includes(stored) && document.messages[0].text.includes('Bearer [redacted]') && document.messages[1].tools[0].input.file_path.includes('[redacted]') && document.messages[1].tools[0].result.includes('[redacted]'))
    }
  }
  const dialog = await fixture.write('')
  check('the copy/save dialog receives masked text too', !(dialog.view as any).props.content.includes(stored) && !(dialog.view as any).props.content.includes(bearer))
  first.message.content = `Bearer ${bearer}`
  const named = await fixture.write('')
  check('the suggested filename cannot expose a prompt credential', !(named.view as any).props.defaultFilename.includes(bearer.toLowerCase()))
  first.message.content = JSON.parse(before)[0].message.content
  check('masking does not rewrite the transcript or credential store', JSON.stringify(fixture.messages) === before && getSecureStorage().read()?.trustedDeviceToken === stored)
  if (!textOnly) {
    const { createSecretRedactor, redactSecretValues } = await import('../../src/utils/redactSecrets.js')
    const redact = createSecretRedactor([stored, 'opaque\\"Credential\\\\Value'])
    check('surrounding prose, quotes and adjacent values survive naturally', redact('Use Authorization: Bearer simple-token then retry. api_key="one"&token=two; done') === 'Use Authorization: Bearer [redacted] then retry. api_key="[redacted]"&token=[redacted]; done')
    check('quoted Authorization preserves its surrounding command', redact('curl -H "Authorization: Bearer fixtureToken" https://example.test') === 'curl -H "Authorization: Bearer [redacted]" https://example.test')
    check('the full RFC bearer alphabet masks', redact('Bearer abc.~+/==') === 'Bearer [redacted]')
    check('a key ending in hyphens leaves no credential suffix', redact('"sk-' + 'a'.repeat(24) + '--"') === '"[redacted]"' && redact('AIza' + 'a'.repeat(34) + '-') === '[redacted]')
    check('redaction is idempotent', redact(redact(samples.map(([, , text]) => text).join('\n'))) === redact(samples.map(([, , text]) => text).join('\n')))
    check('an existing unrelated uppercase marker stays unchanged', redact('A literal [REDACTED] is unchanged.') === 'A literal [REDACTED] is unchanged.')
    check('a partial PEM block still masks its body', redact('before\n-----BEGIN RSA PRIVATE KEY-----\npartial-body') === 'before\n[redacted]')
    check('nested secret arrays retain shape and ordinary values', JSON.stringify(redactSecretValues({ password: ['short', 'two words'], ok: 3 }, redact)) === '{"password":["[redacted]","[redacted]"],"ok":3}')
    check('known credentials are masked in raw and JSON-escaped forms', !redact('opaque\\"Credential\\\\Value').includes('opaque') && !redact(JSON.stringify('opaque\\"Credential\\\\Value')).includes('opaque'))
    const resultRow = fixture.messages[2] as any
    resultRow.message.content[0].content = 'z'.repeat(1990) + stored + 'q'.repeat(8000)
    await fixture.write('boundary.json')
    const boundary = JSON.parse(readFileSync(join(workspace, 'boundary.json'), 'utf8'))
    check('masking precedes truncation so no credential prefix crosses the budget', !boundary.messages[1].tools[1].result.includes(stored.slice(0, 10)))
    writeFileSync(join(fixture.scratch, '.provider-secrets.json'), 'not valid json')
    const refused = await fixture.write('refused.json')
    check('an unreadable credential store refuses export without a file', !existsSync(join(workspace, 'refused.json')) && refused.receipt.includes('nothing was exported'))
  }
} finally {
  fixture.close()
}
console.log(failures === 0 ? 'prove-export-masking: ALL LAWS HOLD' : `prove-export-masking: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
