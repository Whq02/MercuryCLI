#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import {
  isEnvShadowedAuthSource,
  loginShadowWarningFor,
} from '../../src/utils/loginShadow.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

console.log('— the leaf predicate (real behavior) —')
t('MERCURY_OAUTH_TOKEN shadows', isEnvShadowedAuthSource('MERCURY_OAUTH_TOKEN'))
t(
  'the FD variant shadows',
  isEnvShadowedAuthSource('MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR'),
)
t('a keychain login does NOT shadow', !isEnvShadowedAuthSource('claude.ai'))
t("'none' does NOT shadow", !isEnvShadowedAuthSource('none'))
t(
  'apiKeyHelper not in the env-shadow set (different remediation path)',
  !isEnvShadowedAuthSource('apiKeyHelper'),
)
const w = loginShadowWarningFor('MERCURY_OAUTH_TOKEN')
t('warning names the variable', w !== null && w.includes('MERCURY_OAUTH_TOKEN'))
t(
  'warning names the fix (unset / restart)',
  w !== null && /unset/.test(w) && /restart/i.test(w),
)
t(
  'warning says the saved login is overridden',
  w !== null && /overrides the login you just saved/.test(w),
)
t('live source → no warning', loginShadowWarningFor('claude.ai') === null)

console.log('— the wrapper + the success surfaces —')
const auth = readFileSync('src/utils/auth.ts', 'utf8')
t(
  'auth.ts exports loginShadowWarning() over the CURRENT source',
  auth.includes('export function loginShadowWarning(') &&
    auth.includes('loginShadowWarningFor(getAuthTokenSource().source)'),
)
for (const file of [
  'src/commands/login/login.tsx',
  'src/components/mercury-ui/screens/anthropicLoginModel.ts',
] as const) {
  const src = readFileSync(file, 'utf8')
  t(`${file} consults the shadow check on success`, src.includes('loginShadowWarning()'))
}
const cli = readFileSync('src/cli/handlers/auth.ts', 'utf8')
t(
  '`mercury login` warns on BOTH paths (env-refresh + browser flow)',
  (cli.match(/loginShadowWarning\(\)/g) ?? []).length === 2,
)
{
  const flow = readFileSync('src/components/mercury-ui/screens/anthropicLoginModel.ts', 'utf8')
  const earlyReturn = flow.indexOf('arm(() => options.onDone(), TOKEN_FINISH_MS)')
  const shadowRead = flow.indexOf('shadowWarning = deps.shadowWarning()')
  t(
    'the machine skips the warning for setup-token (that flow MINTS an env token)',
    earlyReturn !== -1 && shadowRead !== -1 && earlyReturn < shadowRead,
  )
}

console.log('— the 401-time hint shares the predicate —')
const errors = readFileSync('src/services/api/errors.ts', 'utf8')
t('errors.ts routes through isEnvShadowedAuthSource', errors.includes('isEnvShadowedAuthSource(authSource)'))
t(
  'no duplicated source-name literals left in errors.ts',
  !errors.includes("authSource === 'MERCURY_OAUTH_TOKEN'"),
)

console.log(failures ? '\n❌ LOGIN-SHADOW RED' : '\n✅ LOGIN-SHADOW GREEN')
process.exit(failures)
