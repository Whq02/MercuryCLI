// ============================================================================
//  router/providers/types — the provider-neutral routing contracts.
//
//  One provider abstraction for the route kernel: Anthropic is COMPLETE;
//  Z.AI/GLM and OpenAI/GPT (native Responses, the external
//  Codex engine retired) are LIVE adapters behind the engines gate — OFF they
//  report `available: false` with a stable reason code and can never resolve
//  a model.
//
//  Model classes are Mercury's REAL seat families (seatSlots.ts
//  SEAT_ALLOWED_FAMILIES): opus / sonnet(-5) / fable(-5) — never Haiku — plus
//  the two future-provider classes. This file is frozen shared surface: the
//  compiler, registry, adapters, store, and UI all import these names.
// ============================================================================

export type RouterProviderId =
  | 'anthropic'
  | 'openai'
  | 'zai'
  // Provider-08-21 — each a first-class engine family:
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  // Fold seam: the auth lane's families (recognized here; their
  // adapters/runtimes land with that fold — union-of-adds at merge).
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'
export type RouterModelClass =
  | 'opus'
  | 'sonnet'
  | 'fable'
  | 'gpt'
  | 'glm'
  // Provider-08-21:
  | 'kimi'
  | 'deepseek'
  | 'compat'
  | 'huggingface'
  | 'local'
export type RouteEffortLevel = 'high' | 'xhigh' | 'max'
export type RouterPosture = 'adaptive' | 'quality' | 'balanced' | 'fast' | 'fixed'

// ── additions: the typed provider description surface ────
//  Additive evolution — the S1 freeze proof (scripts/agent-dispatch/prove-s1-contracts)
//  was updated in the same change set. status() stays the cheap availability
//  projection; describe() is the richer typed surface (transport · capability
//  · account · role eligibility · catalogue provenance). Both remain
//  cheap+sync+never-network: live probing belongs to the SEPARATE async
//  bounded-cache owner (../providerDiscovery.ts) whose cached snapshot these
//  methods may read synchronously.

/** How a provider's turns actually run — the wire, not the vendor. */
export type RouterTransport =
  | 'anthropic-messages' // the in-process Anthropic SDK stream (streamCore)
  | 'openai-responses' // native OpenAI Responses HTTP + SSE at the callModel seam (in-process; no external engine)
  | 'zai-chat-completions' // native Z.AI HTTP + SSE at the callModel seam
  | 'openrouter-chat-completions' // OpenRouter's OpenAI-compatible surface
  | 'gemini-generate-content' // Google generativelanguage generateContent
  | 'openai-compat-chat-completions' // the shared chat-completions SSE dialect (Moonshot · DeepSeek · the operator-named compat slot)

/** The ONE specialist-role vocabulary (S5's role registry keys on this). */
export const SPECIALIST_ROLES = [
  'advisor',
  'planner',
  'reviewer',
  'debugger',
  'implementer',
  'test-author',
] as const
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number]
export const isSpecialistRole = (v: unknown): v is SpecialistRole =>
  typeof v === 'string' && (SPECIALIST_ROLES as readonly string[]).includes(v)

/** Role → access law: advisory roles observe the LIVE
 *  checkout read-only; authoring roles ride the EXISTING agent-worktree +
 *  keep-if-changed review path with writes confined to the worktree. Both
 *  engine backends run in-process since, so the law is enforced by the
 *  worktree/tool machinery, never a provider sandbox. */
export const SPECIALIST_ROLE_ACCESS: Record<SpecialistRole, 'advisory' | 'authoring'> = {
  advisor: 'advisory',
  planner: 'advisory',
  reviewer: 'advisory',
  debugger: 'authoring',
  implementer: 'authoring',
  'test-author': 'authoring',
}

export type ProviderCapabilityKey =
  | 'streaming'
  | 'tool-calls' // Mercury tools execute the provider's tool calls in-process
  | 'structured-output' // the wire carries a schema-forced output format end to end
  | 'own-agent-loop' // the engine runs its OWN loop + tools (no live adapter claims this since the codex retirement — kept for stored-record compat)
  | 'reasoning-deltas'
  | 'usage-accounting'
  | 'cancellation'
  | 'worktree-authoring'

/** Account posture for display/readiness — NEVER carries a secret value.
 *  'provider-oauth' is a provider-native managed sign-in that is neither the
 *  inherited Anthropic credential nor a ChatGPT login (the Gemini lane's
 *  Google account, the Kimi device flow); 'keyless' is a configured
 *  auth-free endpoint (the compat slot's local-server case) — configured
 *  and usable, no credential to show. */
export interface ProviderAccountView {
  kind: 'inherited-main' | 'chatgpt-login' | 'provider-oauth' | 'api-key' | 'keyless' | 'none'
  label: string
}

/** One catalogue-verified model a provider offers for specialist work.
 *  `id` is an EXACT vendor id (live-fetched or operator-pinned) — invented or
 *  guessed ids must never enter this table. `contextWindow` is omitted when
 *  the vendor does not document it; it is never guessed. */
export interface ProviderCatalogueEntry {
  id: string
  displayLabel: string
  modelClass: RouterModelClass
  contextWindow?: number
  /** Vendor-native effort vocabulary for this model (empty = not tunable). */
  efforts: readonly string[]
  roles: readonly SpecialistRole[]
}

export interface ProviderDescription {
  transport: RouterTransport
  capabilities: readonly ProviderCapabilityKey[]
  /** Roles this provider is eligible for AT ALL (per-model detail rides the
   *  catalogue entries). */
  roles: readonly SpecialistRole[]
  account: ProviderAccountView
  catalogue: readonly ProviderCatalogueEntry[]
  /** Provenance label the UI must render honestly: a static pin table until
   *  live discovery has run, then the discovered truth with its timestamp. */
  catalogueSource: 'static-pin' | 'live-discovery'
  discoveredAtMs?: number
}

export interface RouteModelRef {
  provider: RouterProviderId
  /** Exact resolved id, e.g. 'claude-sonnet-5', 'claude-opus-4-8[1m]'. */
  model: string
  modelClass: RouterModelClass
  effort: RouteEffortLevel
  /** Tokens. */
  contextWindow: number
}

export interface RouterProviderModel {
  ref: RouteModelRef
  displayLabel: string
}

/** `reason` is a STABLE code (e.g. 'no-account:openai'), never prose. */
export interface RouterProviderStatus {
  available: boolean
  reason?: string
}

export interface RouterProviderAdapter {
  id: RouterProviderId
  /** The wire this provider's turns run on. */
  transport: RouterTransport
  /** Cheap + pure; never a network call. */
  status(): RouterProviderStatus
  /** The typed description surface: transport · capabilities ·
   *  role eligibility · account posture (never a secret) · catalogue with
   *  honest provenance (static-pin vs live-discovery). Cheap+sync — may read
   *  the discovery CACHE, never probe. */
  describe(): ProviderDescription
  /** Empty when unavailable. */
  listModels(): RouterProviderModel[]
  /** Resolve a model CLASS to an exact ref honoring the posture; null when the
   *  class is not this provider's or the provider is unavailable. Never throws. */
  resolveModel(modelClass: RouterModelClass, posture: RouterPosture): RouteModelRef | null
  /** The reconfigure patch for roster.reconfigureLongLived. MUST throw for an
   *  unavailable provider (guarded unreachable — covered by the proof). */
  buildLaunchPatch(ref: RouteModelRef): { model: string; effort: string }
}
