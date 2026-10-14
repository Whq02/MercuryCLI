# Engines: the provider estate

Mercury runs models across 13 sign-in provider families plus local servers
and custom endpoints, with per-family credentials, model lists, usage meters
and web tools.

## The routing law

Model-to-provider recognition uses one declarative table of reserved qualified
namespaces and native bare prefixes or aliases. No request ever falls through
from one provider family to another.

| Family | Id space | Display name |
| --- | --- | --- |
| `anthropic` | `claude-*` ids, family aliases (`opus` · `sonnet` · `haiku` · `fable` · `fable51` · `mythos` · `best`), `ANTHROPIC_*` model env pins, and `MERCURY_CUSTOM_MODEL_OPTION`. Unrecognised ids land here for validation and are refused before any network call unless carried by an `ANTHROPIC_*` model pin or a custom `ANTHROPIC_BASE_URL` gateway. | Anthropic |
| `openai` | `gpt-*`, alias `gpt` | OpenAI |
| `zai` | `glm-*`, alias `glm` | Z.AI |
| `moonshot` | `kimi-*`, `moonshot-*`, alias `kimi` | Moonshot |
| `deepseek` | `deepseek-*`, alias `deepseek` | DeepSeek |
| `xai` | `grok-*`, alias `grok` | xAI |
| `meta` | `muse-spark-*`, alias `muse` (other `muse-*` endpoints refuse here) | Meta |
| `gemini` | `gemini-*`, `google/<id>` (non-Gemini roster models on a Google sign-in), alias `gemini` | Gemini |
| `openai-compat` | `compat/<vendor-id>` (qualified; prefix stripped on the request) | Custom endpoint |
| `openrouter` | `openrouter/<vendor-slug>` (qualified; prefix stripped on the request) | OpenRouter |
| `huggingface` | `huggingface/<org>/<model>[:provider\|:policy]` (qualified) | Hugging Face |
| `local` | `local/<model>` (qualified; discovered local server model id) | Local models |
| `mistral` | `mistral-*`, `ministral-*`, `codestral-*`, alias `mistral` (embedding, OCR, moderation and audio ids are refused) | Mistral |
| `nous` | `nous/<vendor>/<model>` and `~vendor/<name>-latest` (qualified; prefix stripped on the request) | Nous Portal |
| `zen` | `zen/<model-id>` (qualified; prefix stripped on the request) | OpenCode Zen |

Across every provider, `/model`, `/logins` and `mercury://models` report the
same selectable live model count (while `mercury://models` also lists
unavailable rows with their reasons), and image, video, speech/TTS, audio and
embedding models are excluded from chat pickers and refused for chat turns.

### Provider catalogues and family words

- **Anthropic**: merges the built-in generation table with the live model list
  fetched from each signed-in credential door (`claude.ai` OAuth, API key, or
  bearer token) when `/model` or `/logins` opens. Unlisted known rows remain
  selectable; newly listed ids appear under their raw id with their family's
  newest defaults. The family words follow each family's newest row: `opus` means Opus 5.5 and
  `sonnet` means Sonnet 5.5, so a saved `sonnet` runs Sonnet 5.5 while a saved
`claude-sonnet-5` stays on Sonnet 5, which keeps its own row under the family
in the picker; Sonnet 5.5 takes the two wire laws Opus 5.5 takes: thinking is
always on (a request with thinking off carries no thinking parameter and
adaptive thinking runs) and a forced tool choice becomes `auto`, the prompt
naming the tool. `haiku` means Haiku 5.5 (`claude-haiku-5-5`; alias `haiku55`,
while Haiku 4.5 keeps its own row), which has a 1M context window, 128K output,
adaptive thinking, `low` · `medium` · `high` · `xhigh` · `max` effort (`medium`
default), forced tool choice support, and $0.10/$0.50 per Mtok up to 100K prompt
tokens ($0.50/$2.50 above 100K, cache tokens included; [overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview),
[effort](https://platform.claude.com/docs/en/build-with-claude/effort),
[pricing](https://platform.claude.com/docs/en/about-claude/pricing)).
  Any `claude-…` id runs before its catalogue row lands whenever an Anthropic
  credential is present. A catalogue row adds the display name, price tier, 1M twin, alias and wire laws.
- **OpenAI (GPT)**: ChatGPT subscription or `OPENAI_API_KEY`; live catalogue
  fetched per credential, with `gpt` selecting the newest usable row.
- **xAI (Grok)**: `/logins xai` connects a Grok subscription (SuperGrok / X
  Premium on `cli-chat-proxy.grok.com`, including its weekly pool) or an API key for Grok, with an optional management key for the team
  usage meter on `api.x.ai`;
  the family word `grok` means the newest Grok row that list serves, as `deepseek`, `kimi` and `glm` mean the newest row of their own family's list.
- **DeepSeek**: live `GET /models` list with `DEEPSEEK_API_KEY` or stored key.
  Retired id `deepseek-v4-flash` resolves automatically to `deepseek-flash`.
- **Moonshot (Kimi)**: live model list from the platform API key or Kimi
  device-code sign-in. Models whose live catalogue declares dynamic-tool
  support (including `kimi-for-coding` and K3 ids, unless explicitly false as
  on `kimi-for-coding-highspeed`) use end-of-messages tool deferral.
- **Z.AI (GLM)**: live `GET /models` list from `https://api.z.ai/api/coding/paas/v4`
  (GLM Coding Plan key) or `https://api.z.ai/api/paas/v4` (general key or
  `ZAI_API_KEY`). `glm-5.3`, `glm-5.3-flash` and `glm-5.3-flashx` have a 1M
  context window, 128K output ceiling and `low` · `high` · `max` effort with
  thinking locked on; `glm-5.2` has a 1M window and seven-level effort.
- **Meta (Muse)**: live `GET /v1/models` list at `https://api.meta.ai/v1/chat/completions`.
  Connect through `/logins meta` (or `/logins muse`):
  1. **Sign in with Meta** (a Muse Code subscription, a device code in your
     browser): exchanges the device code against Meta's OIDC endpoints
     (`https://auth.meta.com/oidc/device/authorization/` and
     `/oidc/device/token/` with `x-api-version: 1.0.0` under Muse Code's public
     client id `1031625952748946`), sends the account token once to
     `POST https://api.meta.ai/muse-code/key` (`{ "onboard": true }`) to mint
     the subscription's API key (and on bounded `/usage` reads for
     `subs_tier_name` and `subs_usage` 5-hour/weekly windows), stores the grant
     at mode 600 in `.meta-auth.json`, and sends only the minted key on model
     requests to `https://api.meta.ai/v1`. If the account has no active plan,
     Meta returns `require_payment` with the subscription URL.
  2. **Pay-as-you-go Model API key** (`/router key meta`, `MODEL_API_KEY` or
     `META_API_KEY`).
  The latest sign-in action is the active source; `/logins` and `/usage` show
  inactive stored sources and `↵` on a `/logins` row switches the active source
  without re-entering credentials. A refused minted key (401/403) reports
  that the Muse Code key was refused and `/logins` signs in with Meta again. The
  family word `muse` selects the newest served Standard Muse Spark row;
  Contributor rows are labelled **training permitted** and are never selected
  automatically. Standard Spark 1.3, 1.2 and 1.1 have a 1,048,576-token window
  ($1.25 input, $0.15 cached, $4.25 output per Mtok; Contributor 1.3/1.2 are
  $0.10/$0.002/$0.20; `max` effort is supported on Standard Spark 1.3).
  Sources: [Muse Code auth](https://dev.meta.ai/docs/muse-code/auth),
  [subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions),
  [models](https://dev.meta.ai/docs/models) and
  [pricing](https://dev.meta.ai/docs/pricing-rate-limits).
- **Mistral**: live `GET /v1/models` list at `https://api.mistral.ai/v1/chat/completions`
  via `/logins mistral`, `/router key mistral` or `MISTRAL_API_KEY` (with
  optional `MISTRAL_ADMIN_API_KEY` / `/router key mistral-admin` for Enterprise
  organisation usage metrics at [backoffice.mistral.ai](https://backoffice.mistral.ai)).
  `mistral` selects the first served recorded row (`mistral-large-4`,
  `mistral-medium-3-5`, `mistral-small-2603`, `mistral-large-2512`, Ministral 3
  and `codestral-2508`).
- **Nous Portal**: live `GET /v1/models` list at
  `https://inference-api.nousresearch.com/v1/chat/completions` via `/logins
  nous`, `/router key nous` or `NOUS_API_KEY`; persisted as
  `nous/<vendor>/<model>` (`| \`nous\` | \`nous/<vendor>/<model>\` |`). Account
  credits and plan usage are read from
  `GET https://portal.nousresearch.com/api/oauth/account`.
- **OpenCode Zen**: live `GET /zen/v1/models` list via `/logins zen`, `/router
  key zen` or `OPENCODE_API_KEY`, persisted as `zen/<model-id>` across Zen's
  Chat Completions and Responses endpoints (`GET /zen/go/v1/usage` reads Go-plan
  windows).

## The runtimes

Three transport families serve model requests:

- **Anthropic Messages API**: first-party or via `ANTHROPIC_BASE_URL`.
- **Native provider APIs**: Z.AI, OpenAI Responses API, and Google Gemini
  `streamGenerateContent` (used by Sign in with Google, your own OAuth client,
  and Gemini API keys under `x-goog-api-key`, preserving signed thought parts
  across tool rounds on every Gemini credential).
- **OpenAI-compatible Chat Completions**: Moonshot/Kimi, DeepSeek, xAI Grok,
  Meta, Mistral, Nous Portal, OpenCode Zen (chat-completions rows), OpenRouter,
  Hugging Face, custom `compat/` endpoints, and local servers (Ollama also uses
  its native `/api/chat` stream).

Across all transports, transient provider overloads (HTTP 503, Anthropic 529 /
`overloaded_error`, Google `UNAVAILABLE`, Z.AI 1305, or `Retry-After`) retry on
a 1 s · 2 s · 4 s · 8 s · 16 s · 30 s backoff ladder (quiet for the first 30 s,
then showing `OpenAI was busy · answered after 2 retries (7 s)` on recovery).
Mid-reply stream cuts continue once (`Continued after 1 stream cut · context
sent again`). Dispatched crewmates that hit an unscheduled overload pause and
probe for up to one hour before resuming automatically.

When a GPT-family model returns a refusal (including an OpenAI content-filter
finish) or a synthetic error row, the refusal is shown to you once in the chat
and omitted from subsequent request histories (after applying any image-refusal
resize stamps), while user prompts and executed tool-call/result pairs stay
paired.

### Local servers (`local/<model>`)

The local runtime discovers Ollama, LM Studio, vLLM and llama.cpp servers and
reads each model's served context window from the server (`/api/ps` on Ollama,
loaded instances on LM Studio, `max_model_len` on vLLM, `/props` on
llama.cpp). `/config` → **Local model window** (`auto`, `server default`,
`32k`, `64k`, `128k`, `trained max` or a custom token count) sizes the window
against available GPU/unified memory and holds `num_ctx` and `num_batch`
constant across the main chat and crewmates so Ollama keeps a single loaded
runner. `/config` also stages Ollama server environment settings
(`local.server`: `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_NUM_PARALLEL`,
`OLLAMA_KEEP_ALIVE`, `OLLAMA_CONTEXT_LENGTH`) with a memory-fit preview and
confirmation step. While a local server ingests a prompt, Mercury probes
server liveness instead of cutting the request on a fixed first-byte timer (up
to a two-hour hard ceiling). Run `/localsetup` to install or configure Ollama
([LOCAL-SETUP.md](LOCAL-SETUP.md)).

## Auth

`/logins` connects provider accounts and `/accounts` manages stored slots:

- **anthropic**: `claude.ai` subscription OAuth (presenting the client-contract
  version from [HEALTH-CERTIFICATE.md](HEALTH-CERTIFICATE.md#client-contract-and-refused-models),
  overridden by `MERCURY_ANTHROPIC_CLIENT_CONTRACT`), Console OAuth, or
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (up to two stored logins).
- **openai**: ChatGPT subscription OAuth and `OPENAI_API_KEY` (up to two stored
  logins).
- **gemini**: Sign in with Google, an API key, or your own OAuth client. Sign
  in with Google runs Gemini on the quota of the plan the Google account holds
  (a free account, Google AI Pro or Google AI Ultra) through Google's own
  Antigravity client: the prompt, the tool schemas and the tool results go to
  Google's Code Assist endpoint under that client and the signed-in account,
  and `/model` lists the roster Google serves the account (Gemini ids bare,
  non-Gemini roster models as `google/<id>`, bare ids with only effort rows
  routed by session effort such as `gemini-4-argon ▸ gemini-4-argon-high`, and
  `-disabled` rows shown as withheld by the plan). An API key
  (`GOOGLE_API_KEY`, `GEMINI_API_KEY` or stored key) or your own OAuth client
  bills a Google Cloud project instead. Both Google sign-ins and Gemini API
  keys (`x-goog-api-key`) use Google's native `streamGenerateContent` endpoint
  and preserve every signed part (`thought_signature`) across tool rounds and
  resumes. The latest sign-in action is the active source: pasting a Gemini API
  key makes the key active immediately even when a Google grant is stored,
  completing a Google sign-in makes that grant active, `/logins` and `/usage`
  show which Gemini source requests ride and name any inactive stored source,
  and pressing `↵` on a stored source's row in `/logins` makes it active
  without re-entering it.
  On the `/logins` Gemini card, Sign in with Google is first, the API key is
  second as `API key — the easiest: create one in AI Studio, paste it here`
  (opening `https://aistudio.google.com/apikey`), and your own OAuth client is
  third with six guided steps: 1. Create a Google Cloud project; 2. Enable the Gemini API on it;
  3. Set up the consent screen for testing (External user type with your address
  under Test users, because Google lets an unpublished app sign in only its listed test users);
  4. Create an OAuth client for a desktop app; 5. Paste the client id;
  6. Sign in with Google in the browser (an `access_denied` refusal returns the
  card to step 3).
- **openrouter**: OAuth or `OPENROUTER_API_KEY`. `/config` → **OpenRouter
  routing policy** (`routing.openrouter`) selects `balanced` (default:
  `dataCollection: "deny"`, `requireParameters: true`, `allowFallbacks: true`,
  `zeroDataRetention: false`), `strict` (`allowFallbacks: false`,
  `zeroDataRetention: true`) or `open`.
- **xai**: Grok subscription or `XAI_API_KEY`, with an optional management key for the API team's
  usage meter (`XAI_MANAGEMENT_API_KEY` or `/router key xai-management`, created at
  <https://console.x.ai/team/default/management-keys> with **Management Keys
  Read + Write**).
- **meta**: Sign in with Meta (`.meta-auth.json` Muse Code subscription) or
  Model API key (`MODEL_API_KEY`, `META_API_KEY` or stored key), with the
  latest sign-in action active.
- **moonshot, zai, deepseek, mistral, nous, zen, huggingface, compat, local**:
  stored credentials and environment variables (`MOONSHOT_API_KEY`,
  `ZAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `NOUS_API_KEY`,
  `OPENCODE_API_KEY`, `HF_TOKEN`, `MERCURY_COMPAT_API_KEY`,
  `MERCURY_LOCAL_API_KEY`).

New unpinned sessions start on the most recently connected provider's newest
usable model (recorded in `.sign-ins.json`; `/defaultprovider` updates that
choice). `/model <words>` echoes your words on the first line and the resolved
switch receipt on the second line; when `settings.json` cannot be written,
`/model` and its `ctrl+e` effort picker report the file path and OS error.

## Web search

`WebSearch` returns a JSON payload under 2,000 estimated tokens (`characters/4`
estimate) for any session model, including local models. Each hit contains
`title`, `url`, `snippet` and `source_type`. The `via` provenance note,
no-source note and unverified-text warning are reserved first so they are never
dropped; if a response exceeds the 2,000-token ceiling, whole trailing hits are
withheld and counted in a note so snippets stay intact.

The automatic search cascade is:

1. **Session provider's native search** (Anthropic or OpenAI), spending the
   session's own account. The provider's own search answer rides as a labelled,
   unverified note (up to 2,400 characters) beside its links; a words-only
   native answer is returned as a valid result.
2. **Brave Search, then Tavily**, when a key is configured (`/router key brave`,
   `/router key tavily`, `BRAVE_API_KEY`, `TAVILY_API_KEY`).
3. **Official APIs** selected by query shape: Stack Exchange for error
   messages; `npm` (the public `/-/v1/search` registry endpoint), `PyPI` (exact
   project names) or `crates` (`crates.io`) for packages; GitHub public code
   search (requires `gh auth login` or `GH_TOKEN`; without one it reports
   `GitHub code search needs a token: \`gh auth login\` or GH_TOKEN` and moves
   to the next source); Hacker News Algolia for news; and Wikipedia for
   concepts. Wikipedia queries the exact quoted phrase first and runs the word
   query one second later only when no page carries the phrase, noting which
   leg answered. For the top three Stack Exchange and Hacker News hits, Mercury
   makes one follow-up request per search to attach a plain-text excerpt (the
   question body, or the story text / highest-ranked `top comment:`), cached
   for the session and counted in the `via` note (`excerpts fetched for N hits`).
4. **Operator-configured SearXNG JSON APIs** (`MERCURY_SEARCH_SEARXNG_INSTANCES`,
   a JSON array of `{ url, terms, apiAllowed: true, checked: "YYYY-MM-DD" }`
   for HTTPS or loopback instances whose policy permits automated JSON API
   queries). No instances are built in; when unset, SearXNG is skipped and
   noted as `no metasearch instance configured`.
5. **DuckDuckGo page scraping**, **on by default**. Turn it off in `/config` →
   **DuckDuckGo page scraping** or with `MERCURY_SEARCH_KEYLESS=0` (`=1`
   overrides a saved off) to keep general queries to official sources and your
   keys. The first use in a session includes a notice linking
   [duckduckgo.com/terms](https://duckduckgo.com/terms) and
   [duckduckgo.com/acceptable-use](https://duckduckgo.com/acceptable-use).
   Requests use the `us-en` region and stop immediately on any challenge or
   refusal without retrying or switching hosts.

`MERCURY_SEARCH_BACKEND` pins `auto`, `brave`, `tavily` or `duckduckgo` without
fallback. `ProviderSearch` runs only the session provider's native search.
Successful queries are cached for 10 minutes.

When a requested model name is absent from both `mercury://models` and
`mercury://models/known`, the agent may search the provider's published model
page (listed in `mercury://models`) with `WebSearch` to inform its
`AskUserQuestion` prompt; web results never launch a model directly.

## Web fetch

`WebFetch` extracts a public page's main content as markdown (Readability +
Turndown) without a model call. Simple tables render as GitHub-style markdown
tables with escaped pipes and captions; tables with cell spans, nesting or
ragged rows render as one line per row with cells separated by ` · `. Passing
`prompt` requests a labelled reading from the session family's helper model (or
the session model).

Each call returns up to 38,000 characters with a `characters/4` token estimate
(code runs higher) and a `from` character offset to continue reading, backed by
a 15-minute cache. When sparse HTML requires a browser, Mercury sends the
page's full URL (query string included, fragment stripped, no cookies or
credentials) to the hosted reader **r.jina.ai** (paced at its keyless
allowance, labelled `read through r.jina.ai`, and disabled by
`MERCURY_FETCH_READER=0`). Preapproved documentation and private, loopback,
single-label, IP-literal or special-use addresses (`localhost`, `.local`,
`.internal`, `.intranet`, `.private`, `.corp`, `.home`, `.lan`, `.test`,
`.example`, `.invalid`, `.onion`, `.arpa`, `.home.arpa`, `.localdomain`) are
never sent to `r.jina.ai`.

`WebFetch` honours `robots.txt` and standard proxy variables (`HTTPS_PROXY`,
`HTTP_PROXY`, `NO_PROXY`), reports cross-host redirects, paywalls (HTTP 402),
browser challenges, sign-in walls and rate-limit waits in plain words, and
saves PDFs and binary documents to disk with their size and path for `Read`
without claiming text extraction.

## Usage, limits, JEV and model transitions

Usage warnings fire at 80% and 90% of the binding window (`<provider>: XX% of
the <window> used[ · resets <t>]`). When `engine.usageNotice` is `true` (off by
default), Mercury also adds a context notice at 80% and 90%; the model decides
what to do, and no percentage, even 100%, holds work, stops a turn or offers a handoff.
When a provider rejects a request for a reached window and the session switches
to another signed-in family, an amber failover line appears above the composer
for two minutes (`MERCURY_FAILOVER_LINE_MS`, minimum `1000` ms) and `/model`
returns home in one keystroke.

`/usage` opens a 150-column popup showing every signed-in provider in
most-recent sign-in order: Anthropic rolling/weekly windows and extra usage,
OpenAI observed bands and credit balance, Kimi plan windows and Extra Usage,
GLM Coding Plan 5-hour/weekly windows and MCP quota, OpenRouter key credit caps,
the DeepSeek and Moonshot balances, xAI's team balance and billing-cycle usage
with a management key (For xAI, the inference key identifies the team and the
optional management key reads its prepaid credits, usage for the current
billing cycle, and its
postpaid invoice preview and spending limit where enabled. These are team figures; this session's spend is tracked separately), Mistral Admin API
organisation usage, Nous Portal account credits, Meta Muse Code subscription
tier and rolling/weekly windows, Hugging Face plan tier (`whoami-v2`), and on a
Google sign-in for Gemini, the account's reported tier, the session model's
quota left and reset (`gemini-4-argon ▸ gemini-4-argon-high`), other models
used this session, and a foldable row for the remaining roster models that `↵`
opens and closes (Google states no usage figure for API keys or custom OAuth
clients). Unpriced turns are tracked by token count and labelled `unpriced` (`+ N unpriced turns`).

### JEV (`JevEval`)

`JevEval` requests a structured second opinion (`noul`, `choice` or `score`;
confidence floor `0.6`, or outside `0.4..0.6` for `noul`) from TypeSafe's Jev.
`/jev` opens the JEV card; `/jev on|off` toggles the official TypeSafe key road
and `/jev or on|off` toggles the OpenRouter road. Each call accepts evidence
records, paragraphs, inline tables or table/text files (up to 100 rows and
1,048,576 bytes per file, checked under `Read` permissions) and runs up to 100
requests/minute on the main thread (50 requests/minute shared across crewmates,
capped at 200 calls per crewmate).

### Model transitions

Switching models in `/model` previews how conversation history, thinking blocks
and images map to the target provider's wire codec and compares the
conversation size against the target model's context window, offering to fold
with `/compact` on the prior model before the first request when the history
exceeds the new window.
