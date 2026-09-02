// ============================================================================
//  loginFamilyRows — THE one owner of the provider-family catalogue rows.
//
//  Every surface that offers "pick a provider family to sign in" derives its
//  rows from here: the /logins card (ConsoleOAuthFlow's opening menu) and the
//  first-run walk's provider station (which mounts that same card). One owner
//  makes drift structurally impossible — a family added here appears on every
//  catalogue at once, worded once, with its honest caveat.
//
//  Row grammar: `Name — how it signs in (what that gets you)`. Honest
//  asymmetry is law: a vendor without an OAuth gets a key row that says so,
//  never a pretended sign-in.
// ============================================================================

/** The provider-family row values — also the pre-focus vocabulary a caller
 *  may name (/logins <family> → ConsoleOAuthFlow's initialFocus). */
export type LoginFamilyValue =
  | 'claudeai'
  | 'openai'
  | 'console'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'moonshot'
  | 'zai'
  | 'deepseek'

export interface LoginFamilyRow {
  label: string
  value: LoginFamilyValue
}

/** The catalogue. `engineLegs` is the settlement gate: a host that cannot
 *  settle engine-leg outcomes (no onOpenaiDone channel) must not offer the
 *  engine rows, and its Console row honestly narrows to the Anthropic arm. */
export function loginFamilyRows({ engineLegs }: { engineLegs: boolean }): LoginFamilyRow[] {
  return [
    { label: 'Claude subscription account', value: 'claudeai' },
    ...(engineLegs
      ? [{ label: 'OpenAI — ChatGPT subscription or API key', value: 'openai' as const }]
      : []),
    // THE SPLIT HOMES (OS-AUTH-1, the operator's ruling: "one should be
    // Anthropic and one should be OpenAI key — they shouldn't share the
    // same home"): the console row is PURELY Anthropic — both its roads
    // (Console sign-in · API key) credential the one family; the OpenAI
    // key lives on the OpenAI family's own row above, beside its
    // subscription (openaiArmPickRows). One spelling for every host — the
    // old engineLegs narrowing existed only for the OpenAI half.
    { label: 'Usage-based billing — Anthropic Console sign-in or API key', value: 'console' },
    ...(engineLegs
      ? [
          {
            label: 'OpenRouter — one credential, the whole catalogue (OAuth or key)',
            value: 'openrouter' as const,
          },
          { label: 'Google Gemini — API key or Google OAuth', value: 'gemini' as const },
          {
            label: 'Hugging Face — device-code sign-in or a Hub token (open models)',
            value: 'huggingface' as const,
          },
          // Honest asymmetry: Kimi has a device-code sign-in; Z.AI and
          // DeepSeek sign in with API keys only, and the row says so instead
          // of pretending an OAuth.
          { label: 'Kimi (Moonshot) — device-code sign-in or API key', value: 'moonshot' as const },
          { label: 'GLM (Z.AI) — API key (general or GLM Coding Plan)', value: 'zai' as const },
          { label: 'DeepSeek — API key', value: 'deepseek' as const },
        ]
      : []),
  ]
}

/** The OpenAI family's two-arm pick — ONE home for the in-chat card, the
 *  face layer and the first-run walk (the OS-AUTH-1 split's by-construction
 *  propagation: the subscription and the key are two credentials of ONE
 *  family, and no surface spells the pair itself — the latent
 *  card-vs-face drift dies here). */
export const openaiArmPickRows = [
  { label: 'ChatGPT subscription — browser sign-in', value: 'subscription' },
  { label: 'OpenAI API key — paste one (stored locally, mode 600)', value: 'key' },
] as const

/** The row the opening menu pre-focuses when no caller named a family: the
 *  operator's RECORDED default provider (config.defaultProvider — the first
 *  login's family, or the /defaultprovider choice), so a sovereign home's
 *  /logins card opens on its own lane instead of the first-party row that
 *  happens to sit first. Unset, or a family with no sign-in row (the compat
 *  slot, local servers), answers undefined — the list's first row stands. */
export function loginFamilyFocusFor(defaultProvider: string | undefined): LoginFamilyValue | undefined {
  switch (defaultProvider) {
    case 'anthropic':
      return 'claudeai'
    case 'openai':
    case 'openrouter':
    case 'gemini':
    case 'huggingface':
    case 'moonshot':
    case 'zai':
    case 'deepseek':
      return defaultProvider
    default:
      return undefined
  }
}

/** The first-run walk's tenth row: enter the harness with NO credential and
 *  look around — the cockpit opens logged-out and says so honestly. The
 *  caveat states plainly that running turns needs a sign-in. Offered only by
 *  hosts that pass ConsoleOAuthFlow an onSkip channel (the walk); inside the
 *  cockpit /logins already closes on esc, so the row never appears there. */
export const SIGN_IN_LATER_ROW = {
  label: 'Sign in later — look around first (running turns needs a sign-in)',
  value: 'later',
} as const
