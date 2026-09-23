#!/usr/bin/env bun
import { languageServerEnv, subprocessEnv } from '../../src/utils/subprocessEnv.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  [PASS] ${label}`)
  } else {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const windows = process.platform === 'win32'

function spellings(env: NodeJS.ProcessEnv, name: string): string[] {
  return Object.keys(env).filter(key => key.toUpperCase() === name.toUpperCase())
}

function withEnv(values: Record<string, string>, run: () => void): void {
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  try {
    run()
  } finally {
    for (const key of Object.keys(values)) delete process.env[key]
  }
}

function scrubbedOnWindowsOnly(label: string, env: NodeJS.ProcessEnv, name: string): void {
  const left = spellings(env, name)
  if (windows) {
    check(`${label} is scrubbed (Windows reads names in any case)`, left.length === 0, `left: ${left.join(', ')}`)
  } else {
    check(`${label} stays (a different variable on POSIX)`, left.length === 1, `left: ${left.join(', ')}`)
  }
}

delete process.env.MERCURY_SUBPROCESS_ENV_SCRUB
delete process.env.MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION

console.log('============================================================')
console.log(' subprocess environment scrub by variable name case')
console.log('============================================================')

withEnv({ mercury_oauth_token: 'proof-not-a-token' }, () => {
  scrubbedOnWindowsOnly('a lower-case session token spelling', subprocessEnv(), 'mercury_oauth_token')
})

withEnv({ Otel_Exporter_Otlp_Headers: 'authorization=proof' }, () => {
  scrubbedOnWindowsOnly('a mixed-case OTEL_ variable', subprocessEnv(), 'Otel_Exporter_Otlp_Headers')
})

withEnv({ mercury_browser_secret_demo: 'proof' }, () => {
  scrubbedOnWindowsOnly('a lower-case browser secret', subprocessEnv(), 'mercury_browser_secret_demo')
})

withEnv({ MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION: '1', anthropic_api_key: 'proof-key' }, () => {
  scrubbedOnWindowsOnly('a lower-case provider key under credential isolation', subprocessEnv(), 'anthropic_api_key')
})

withEnv({ MERCURY_SUBPROCESS_ENV_SCRUB: '1', aws_secret_access_key: 'proof', input_aws_secret_access_key: 'proof' }, () => {
  const env = subprocessEnv()
  scrubbedOnWindowsOnly('a lower-case CI secret under the CI scrub', env, 'aws_secret_access_key')
  scrubbedOnWindowsOnly('its lower-case INPUT_ twin', env, 'input_aws_secret_access_key')
})

withEnv({ openai_api_key: 'proof-key' }, () => {
  scrubbedOnWindowsOnly('a lower-case provider key in the language-server environment', languageServerEnv(), 'openai_api_key')
})

withEnv({ MERCURY_OAUTH_TOKEN: 'proof-not-a-token', MERCURY_OAUTH_TOKEN_NOTE: 'kept' }, () => {
  const env = subprocessEnv()
  check('the exact spelling of the session token is scrubbed', spellings(env, 'MERCURY_OAUTH_TOKEN').length === 0)
  check('a longer name that only contains a scrubbed name stays', env.MERCURY_OAUTH_TOKEN_NOTE === 'kept')
  check('PATH survives the scrub', spellings(env, 'PATH').length === 1, `spellings: ${spellings(env, 'PATH').join(', ')}`)
})

console.log(failures === 0 ? '\nALL ENV SCRUB CASE CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
