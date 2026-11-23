#!/usr/bin/env bun
import {
  isEnvShadowedAuthSource,
  loginShadowWarningFor,
} from '../../src/models/sign-in/credentials/loginShadow.js'

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
  'credentials.keyCommand not in the env-shadow set (different remediation path)',
  !isEnvShadowedAuthSource('credentials.keyCommand'),
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


console.log(failures ? '\n❌ LOGIN-SHADOW RED' : '\n✅ LOGIN-SHADOW GREEN')
process.exit(failures)
