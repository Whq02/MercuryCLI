
export function isEnvShadowedAuthSource(source: string): boolean {
  return (
    source === 'MERCURY_OAUTH_TOKEN' ||
    source === 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR'
  )
}

export function loginShadowWarningFor(source: string): string | null {
  if (!isEnvShadowedAuthSource(source)) return null
  return (
    `Warning: this session authenticates via the ${source} environment ` +
    `variable, which overrides the login you just saved — unset it (or ` +
    `restart Mercury without it) to use this login.`
  )
}
