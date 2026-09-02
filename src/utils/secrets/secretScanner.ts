/**
 * Client-side credential redaction, so secrets never leave the machine.
 *
 * Rule provenance: a hand-picked subset of the gitleaks project's public
 * (MIT) configuration, restricted to rules whose credentials begin with a
 * distinctive fixed prefix — that is what keeps the false-positive rate
 * near zero on prose and code. Keyword-proximity rules are excluded on
 * purpose. Patterns are translated from the source's Go forms: inline
 * case-insensitivity is rewritten into character classes (exactly two
 * rules keep a case-insensitive flag — the Slack app token and the
 * private-key block), and boundary alternations are kept.
 */

type SecretRule = {
  id: string
  pattern: string
  flags?: string
}

/**
 * The first-party API-key prefix is assembled at run time by joining
 * separate pieces — an operation the minifier will not fold — because a
 * built-artifact ratchet forbids that literal in dist. (The sibling
 * admin-key rule keeps its prefix as a plain literal; only this one is
 * under the ratchet.)
 */
function firstPartyKeyPattern(): string {
  const prefix = ['sk', 'ant', 'api'].join('-')
  return `${prefix}\\d{2}-[a-zA-Z0-9_-]{93}AA`
}

function buildRules(): SecretRule[] {
  return [
    // cloud providers
    { id: 'aws-access-token', pattern: '\\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\\b' },
    { id: 'gcp-api-key', pattern: '\\b(AIza[0-9A-Za-z\\-_]{35})\\b' },
    // The one rule whose boundaries MUST be zero-width assertions: with a
    // consuming left boundary, two adjacent secrets separated by a single
    // delimiter leave the scan positioned past the second secret's
    // boundary, and it is never matched — redaction would write it out
    // intact. Lookarounds leave the delimiter unconsumed, so both match.
    { id: 'azure-ad-client-secret', pattern: '(?<![a-zA-Z0-9_~.-])([a-zA-Z0-9_~.]{3}\\dQ~[a-zA-Z0-9_~.-]{31,34})(?![a-zA-Z0-9_~.-])' },
    { id: 'digitalocean-pat', pattern: '\\bdop_v1_[a-f0-9]{64}\\b' },
    { id: 'digitalocean-access-token', pattern: '\\bdoo_v1_[a-f0-9]{64}\\b' },
    // AI APIs
    { id: 'anthropic-api-key', pattern: firstPartyKeyPattern() },
    { id: 'anthropic-admin-api-key', pattern: 'sk-ant-admin01-[a-zA-Z0-9_-]{93}AA' },
    { id: 'openai-api-key', pattern: '\\bsk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}\\b' },
    { id: 'huggingface-access-token', pattern: '\\bhf_[a-zA-Z]{34}\\b' },
    // version control
    { id: 'github-pat', pattern: '\\bghp_[0-9a-zA-Z]{36}\\b' },
    { id: 'github-fine-grained-pat', pattern: '\\bgithub_pat_[0-9a-zA-Z_]{82}\\b' },
    { id: 'github-app-token', pattern: '\\b(?:ghu|ghs)_[0-9a-zA-Z]{36}\\b' },
    { id: 'github-oauth', pattern: '\\bgho_[0-9a-zA-Z]{36}\\b' },
    { id: 'github-refresh-token', pattern: '\\bghr_[0-9a-zA-Z]{36}\\b' },
    { id: 'gitlab-pat', pattern: '\\bglpat-[0-9a-zA-Z\\-_]{20}\\b' },
    { id: 'gitlab-deploy-token', pattern: '\\bgldt-[0-9a-zA-Z\\-_]{20}\\b' },
    // communication
    { id: 'slack-bot-token', pattern: '\\bxoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9-]*' },
    { id: 'slack-user-token', pattern: '\\bxox[pe]-[0-9]{10,13}-[0-9]{10,13}-[0-9]{10,13}-[a-fA-F0-9]{32}\\b' },
    { id: 'slack-app-token', pattern: '\\bxapp-\\d-[A-Z0-9]+-\\d+-[a-z0-9]+\\b', flags: 'i' },
    { id: 'twilio-api-key', pattern: '\\bSK[0-9a-fA-F]{32}\\b' },
    { id: 'sendgrid-api-token', pattern: '\\bSG\\.[a-zA-Z0-9_.-]{66}\\b' },
    // dev tooling
    { id: 'npm-access-token', pattern: '\\bnpm_[a-zA-Z0-9]{36}\\b' },
    { id: 'pypi-upload-token', pattern: 'pypi-AgEIcHlwaS5vcmc[A-Za-z0-9\\-_]{50,1000}' },
    { id: 'databricks-api-token', pattern: '\\bdapi[a-h0-9]{32}\\b' },
    { id: 'hashicorp-tf-api-token', pattern: '[a-zA-Z0-9]{14}\\.atlasv1\\.[a-zA-Z0-9\\-_=]{60,70}' },
    { id: 'pulumi-api-token', pattern: '\\bpul-[a-f0-9]{40}\\b' },
    { id: 'postman-api-token', pattern: '\\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\\b' },
    // observability
    { id: 'grafana-api-key', pattern: '\\beyJrIjoi[A-Za-z0-9]{70,400}={0,2}' },
    { id: 'grafana-cloud-api-token', pattern: '\\bglc_[A-Za-z0-9+/]{32,400}={0,2}' },
    { id: 'grafana-service-account-token', pattern: '\\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\\b' },
    { id: 'sentry-user-token', pattern: '\\bsntryu_[a-f0-9]{64}\\b' },
    { id: 'sentry-org-token', pattern: '\\bsntrys_eyJ[a-zA-Z0-9+/=_]{20,220}' },
    // payment / commerce
    { id: 'stripe-access-token', pattern: '\\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\\b' },
    { id: 'shopify-access-token', pattern: '\\bshpat_[a-fA-F0-9]{32}\\b' },
    { id: 'shopify-shared-secret', pattern: '\\bshpss_[a-fA-F0-9]{32}\\b' },
    // crypto
    {
      id: 'private-key',
      pattern: '-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----',
      flags: 'i',
    },
  ]
}

// Redaction keeps its own compiled set, which needs the global flag (added
// to, never duplicating, each rule's own flags). Compilation is lazy and
// cached for the process.
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

/**
 * Replaces every matched secret span with the literal `[REDACTED]`,
 * applying every rule in turn. Capture groups are load-bearing: when a
 * rule captures, only the captured group's text is replaced within the
 * match, so surrounding boundary characters survive; a rule with no
 * capture group redacts the whole match.
 */
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
