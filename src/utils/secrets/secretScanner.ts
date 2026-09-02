
type SecretRule = {
  id: string
  pattern: string
  flags?: string
}

function firstPartyKeyPattern(): string {
  const prefix = ['sk', 'ant', 'api'].join('-')
  return `${prefix}\\d{2}-[a-zA-Z0-9_-]{93}AA`
}

function buildRules(): SecretRule[] {
  return [
    { id: 'aws-access-token', pattern: '\\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\\b' },
    { id: 'gcp-api-key', pattern: '\\b(AIza[0-9A-Za-z\\-_]{35})\\b' },
    { id: 'azure-ad-client-secret', pattern: '(?<![a-zA-Z0-9_~.-])([a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{31,34})(?![a-zA-Z0-9_~.-])' },
    { id: 'digitalocean-pat', pattern: '\\bdop_v1_[a-f0-9]{64}\\b' },
    { id: 'digitalocean-access-token', pattern: '\\bdoo_v1_[a-f0-9]{64}\\b' },
    { id: 'anthropic-api-key', pattern: firstPartyKeyPattern() },
    { id: 'anthropic-admin-api-key', pattern: 'sk-ant-admin01-[a-zA-Z0-9_-]{93}AA' },
    { id: 'openai-api-key', pattern: '\\bsk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}\\b' },
    { id: 'huggingface-access-token', pattern: '\\bhf_[a-zA-Z]{34}\\b' },
    { id: 'github-pat', pattern: '\\bghp_[0-9a-zA-Z]{36}\\b' },
    { id: 'github-fine-grained-pat', pattern: '\\bgithub_pat_[0-9a-zA-Z_]{82}\\b' },
    { id: 'github-app-token', pattern: '\\b(?:ghu|ghs)_[0-9a-zA-Z]{36}\\b' },
    { id: 'github-oauth', pattern: '\\bgho_[0-9a-zA-Z]{36}\\b' },
    { id: 'github-refresh-token', pattern: '\\bghr_[0-9a-zA-Z]{36}\\b' },
    { id: 'gitlab-pat', pattern: '\\bglpat-[0-9a-zA-Z\\-_]{20}\\b' },
    { id: 'gitlab-deploy-token', pattern: '\\bgldt-[0-9a-zA-Z\\-_]{20}\\b' },
    { id: 'slack-bot-token', pattern: '\\bxoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9-]*' },
    { id: 'slack-user-token', pattern: '\\bxox[pe]-[0-9]{10,13}-[0-9]{10,13}-[0-9]{10,13}-[a-fA-F0-9]{32}\\b' },
    { id: 'slack-app-token', pattern: '\\bxapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+\\b', flags: 'i' },
    { id: 'twilio-api-key', pattern: '\\bSK[0-9a-fA-F]{32}\\b' },
    { id: 'sendgrid-api-token', pattern: '\\bSG\\.[a-zA-Z0-9_.-]{66}\\b' },
    { id: 'npm-access-token', pattern: '\\bnpm_[a-zA-Z0-9]{36}\\b' },
    { id: 'pypi-upload-token', pattern: 'pypi-AgEIcHlwaS5vcmc[A-Za-z0-9\\-_]{50,1000}' },
    { id: 'databricks-api-token', pattern: '\\bdapi[a-h0-9]{32}\\b' },
    { id: 'hashicorp-tf-api-token', pattern: '[a-zA-Z0-9]{14}\\.atlasv1\\.[a-zA-Z0-9\\-_=]{60,70}' },
    { id: 'pulumi-api-token', pattern: '\\bpul-[a-f0-9]{40}\\b' },
    { id: 'postman-api-token', pattern: '\\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\\b' },
    { id: 'grafana-api-key', pattern: '\\beyJrIjoi[A-Za-z0-9]{70,400}={0,2}' },
    { id: 'grafana-cloud-api-token', pattern: '\\bglc_[A-Za-z0-9+/]{32,400}={0,2}' },
    { id: 'grafana-service-account-token', pattern: '\\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\\b' },
    { id: 'sentry-user-token', pattern: '\\bsntryu_[a-f0-9]{64}\\b' },
    { id: 'sentry-org-token', pattern: '\\bsntrys_eyJ[a-zA-Z0-9+/=_]{20,220}' },
    { id: 'stripe-access-token', pattern: '\\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\\b' },
    { id: 'shopify-access-token', pattern: '\\bshpat_[a-fA-F0-9]{32}\\b' },
    { id: 'shopify-shared-secret', pattern: '\\bshpss_[a-fA-F0-9]{32}\\b' },
    {
      id: 'private-key',
      pattern: '-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----',
      flags: 'i',
    },
  ]
}

let redactionRules: Array<{ id: string; regex: RegExp }> | null = null

function getRedactionRules(): Array<{ id: string; regex: RegExp }> {
  if (redactionRules === null) {
    redactionRules = buildRules().map(rule => ({
      id: rule.id,
      regex: new RegExp(rule.pattern, `${rule.flags ?? ''}g`),
    }))
  }
  return redactionRules
}

export function redactSecrets(content: string): string {
  let result = content
  for (const { regex } of getRedactionRules()) {
    result = result.replace(regex, (match: string, ...args: unknown[]) => {
      const groups = args.slice(0, -2).filter((value): value is string => typeof value === 'string')
      if (groups.length === 0 || groups[0] === undefined) return '[REDACTED]'
      return match.replace(groups[0], () => '[REDACTED]')
    })
  }
  return result
}
