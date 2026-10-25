import { shellCommandSegments } from '../../tools/BashTool/destructiveCommandWarning.js'

export function credentialUploadReason(command: string): string | null {
  for (const { words } of shellCommandSegments(command)) {
    const name = (words[0]?.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '')
    if (name !== 'curl' && name !== 'wget') continue
    for (let index = 1; index < words.length; index++) {
      const word = name === 'curl' ? words[index]!.replace(/^-[0-9aBfgGIijJklLMnNOpqRsSvVZ#]*(?=[dFT])/, '-') : words[index]!
      const option = name === 'curl'
        ? /^(--(?:data|data-raw|data-binary|data-urlencode|form|form-string|upload-file|json))(?:=(.*))?$/.exec(word) ?? /^(-[dFT])(.*)$/.exec(word)
        : /^(--(?:post-data|post-file))(?:=(.*))?$/.exec(word)
      if (option === null) continue
      const payload = option[2] || words[++index] || ''
      if (/\$(?:env:)?\{?(?:[a-z0-9_]*_)?(?:api_key|token|secret)\b/i.test(payload)) {
        return 'This credential upload names a secret-shaped variable in the request body; approve sending it before the command runs.'
      }
      const fileOption = ['-T', '--upload-file', '--post-file'].includes(option[1]!)
      const paths = fileOption ? [payload] : payload.includes('@') ? payload.split('@').slice(1) : []
      if (paths.some(path => /(?:^|[\\/])(?:\.env(?:[.;]|$)|\.netrc(?:;|$)|\.npmrc(?:;|$)|\.pypirc(?:;|$)|\.ssh[\\/]id_[^;\s]+(?<!\.pub)(?:;|$)|\.aws[\\/]credentials(?:;|$))/i.test(path))) {
        return 'This credential upload sends a credential file in the request body; approve sending it before the command runs.'
      }
    }
  }
  return null
}
