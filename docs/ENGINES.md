# Engines — the provider estate

Mercury's main loop can run on models from ten provider families. One pure law decides
which family serves an id, one dispatch seam routes the call, and each family's runtime
owns its own wire, credentials, and refusals. Nothing ever falls through from one
provider to another.

## The routing law

One pure law owns model→provider recognition. Every family declares its id
space in one data table: a reserved qualified namespace (checked first —
reserved words can never be shadowed) and/or native bare spellings
(prefixes + class aliases). A new family is one data row, never a bespoke
arm.

| Family | Id space | Display name |
| --- | --- | --- |
| `anthropic` | `claude-*` ids (the mark anywhere in the id — gateway spellings included), the setting aliases (`opus` · `sonnet` · `haiku` · `fable` · `fable51` · `mythos` · `best` · `opusplan`), the `ANTHROPIC_*` model env pins and `ANTHROPIC_CUSTOM_MODEL_OPTION`. An id NO family declares also classes here (the routing law's total remainder), but the ride is earned, never the remainder's accident: it is recognised as *unrecognised*, `/model`, `/health` and the dispatch seam name it, and bound for the first-party origin it refuses before the wire, credentialed or not, unless an operator-owned fact carries it — an `ANTHROPIC_*` model pin, or `ANTHROPIC_BASE_URL` re-pointed at a gateway | Anthropic |
| `openai` | `gpt-*`, alias `gpt` | OpenAI |
| `zai` | `glm-*`, alias `glm` | Z.AI |
| `moonshot` | `kimi-*`, `moonshot-*`, alias `kimi` | Moonshot |
| `deepseek` | `deepseek-*`, alias `deepseek` | DeepSeek |
| `gemini` | `gemini-*`, alias `gemini` | Gemini |
| `openai-compat` | `compat/<vendor-id>` (qualified; stripped before the wire) | Custom endpoint |
| `openrouter` | `openrouter/<vendor-slug>` (qualified; stripped — OpenRouter ids are themselves vendor/model slugs, so only a namespace disambiguates them) | OpenRouter |
| `huggingface` | `huggingface/<org>/<model>[:provider\|:policy]` (qualified) | Hugging Face |
| `local` | `local/<model>` (qualified; the model as the discovered local server lists it) | Local models |

Display names have the same one-owner rule: every surface that names a
family derives its label from it, and an unknown id shows itself. Persisted
ids stay provider-qualified; the namespace detaches for the wire.

## Dispatch

Every call dispatches on the resolved route to that family's own runtime;
the default arm is the Anthropic path. An id no family declares dispatches
there too, but only through the home-lane admission, read by `/model`'s
typing door and the dispatch seam alike: on the first-party origin a
carrier-shaped id is refused before any request — no first-party id carries
a `/` — and an unrecognised id is a typed refusal before any HTTP,
credentialed or not, naming the id, the declared families and both earned
roads. The earned roads are the operator's own facts: an `ANTHROPIC_*`
model pin naming the id, or a gateway base URL (the operator named an
endpoint that owns its ids — it admits carrier-shaped and unrecognised ids
alike). A credential is not an earned fact.

## The runtimes

Three wires serve the ten families:

- **The Anthropic home lane** — the first-party API, directly or through a
  base-URL proxy.
- **Native wires** — Z.AI, and OpenAI through its Responses API.
- **The OpenAI-compatible chat wire** — Moonshot/Kimi, DeepSeek, the
  operator-named compat slot, OpenRouter, Gemini (through Google's
  OpenAI-compatibility surface, a refreshed OAuth token serving each call),
  Hugging Face (the Hub router, Hub slugs with an optional backend suffix),
  and local servers.

Whichever wire a session runs on, a turn behaves the same way: text and
tool calls stream as they arrive; the final usage and stop reason are
recorded; a provider fault never crashes the turn — a terminal fault lands
as an API-error message in the chat, cancellation returns quietly, and a
retryable fault before any content is retried once; every request's usage
joins the one session cost ledger.

Each wire carries its provider's documented quirks, the same pins the wire
sends from: reasoning-effort vocabularies, sampling restrictions
(the Kimi reasoning models fix their sampling, so that lane never sends
temperature), output-knob names, and usage-field spellings. The local lane
serves discovered servers (Ollama, LM Studio, vLLM, llama.cpp) at each
model's own base URL, omitting what a server kind does not support. The
Hugging Face and local lanes carry an explicit deferred-live caveat in
their readiness detail until verified against a live endpoint.

## Typed refusals

Recognition is the law's fact; dispatch is the runtime's. A routed id can never
silently fall through to another provider — each runtime owns honest, typed refusals:

- a lane whose credential does not resolve refuses with text that names the attach
  route (where to sign in or store a key), never a generic error;
- a tool-bearing request on a model that cannot take tools is refused pre-flight with
  a typed reason instead of a broken turn (the local lane's tool-capability facts);
- an undiscovered `local/<id>` refuses with the probe route rather than guessing a
  port;
- sub-model containers surface the owning catalogue's refusal reasons verbatim.

Two vocabularies decide what may run where, and what a picker shows is what
dispatch allows. The
**session** arm is pure product capability: a session dispatches on every family
the account holds a credential for, the economy tier included; a family with no
credential refuses typed (`no-credential:<family>`) with the one action that fixes
it riding the refusal — except the account-less local family, whose miss is a gone
server, not a missing credential: it refuses `unreachable:local` with the probe
route. The **crew** arm is the bounded crew's narrower vocabulary:
economy-tier rows refuse typed (`worker-policy:frontier-only`), and engine rows
refuse typed until the crew runtimes take them. Every refusal names its class and
carries one machine-readable action line — a coordinator or operator relays the
real fix, never an invented reason.

## Auth

The `/accounts` slots derive one per signed-in identity across every family
the router catalogue knows — derived, never hardcoded. Each family's slots
come from its owning account resolvers:

- **anthropic** — the account scope ring plus the API-key ladder, source-honest;
- **openai** — the subscription store and the stored key, both shown when both exist;
- **gemini** — OAuth connection or stored key;
- **moonshot** — stored OAuth tokens or stored key;
- **openrouter** — an OAuth-minted key or a stored key, env pin winning honestly;
- **zai, deepseek, huggingface, local, compat** — env pins and stored keys.

Slots carry presence facts and masked key tails only — never a secret value.
Removal is routed to each slot's owning store, never inlined. Env-pinned
keys are the shell's: shown, precedence-honored, refused for editing, never
a Mercury-held sign-in. A ceiling caps concurrent Mercury-held sign-ins
(two for anthropic, two for openai), and one typed refusal is consulted by
every sign-in path before adding a concurrent login.

On the claude.ai sign-in door the subscription endpoint gates models on a
minimum client version it reads from the billing attribution line Mercury
writes into the system prompt (never from the User-Agent, which stays
`mercury/<version>` on every wire), so Mercury presents a declared
client-contract version there and nowhere else:
`MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version>` raises it without a rebuild
when the floor moves, the doctor's Client contract row shows what is
presented, and the gate's refusal names the version read, the version
required and that override.

The default provider is the provider of the most recent sign-in. Every sign-in
door records when a family's credential landed (the sign-in ledger,
`.sign-ins.json` beside the credential stores; a token refresh never records),
and a fresh, unpinned session starts on that provider's newest model the
credential can use — a gated row is never chosen, a provider with no usable
row falls through to the next most recent sign-in, and `/model`, the
Recommended row and the doctor's Default model row say which and why.
`/defaultprovider` makes a provider the most recent sign-in by the operator's
word (an entry in the same ledger). Credentials that landed before the ledger
existed, env-pinned keys included, order after every recorded sign-in — the
config's older `defaultProvider` record first, so a home keeps its lane until
its next sign-in. With no sign-in anywhere there is no default: the face and
`/model` say so and point at `/logins`. An explicit `/model` choice,
`ANTHROPIC_MODEL` or a session override always outranks the default.

## Capabilities

One model→capability edge answers everything the harness asks of a model:
identity, context window and output ceilings, thinking
(supported/adaptive/interleaved), sampling, effort (vocabulary and ceiling
per family, from the same pins the wires send), tools (structured outputs,
context management, auto mode, tool-search header, advisor), media (PDF and
image support), and beta-header emission. It re-reads live state on every
call by design.

## Web search

The web-search estate is one provider-neutral contract and TWO tools under
the model-chooses law — so any session model can search, a local model
included, and the result is plain hit groups (title · url · snippet) every
wire's models read.

- **`ProviderSearch`** — the provider's OWN live search, listed exactly when
  the main model's family carries a native search construct Mercury speaks
  (Anthropic's `web_search_20250305` server tool; the OpenAI Responses hosted
  `web_search`). It runs inside a provider-side call on the session's own
  account, and its prompt says so; a failure is one typed line naming the
  vendored alternative — the model's fallback is choosing `WebSearch`, never
  a silent harness fallthrough. A native construct is offered only to its own
  family's main model: the vendored door type cannot even express a
  provider-account door (the cross-account law, held structurally).
- **`WebSearch`** — Mercury's VENDORED search, for every session. The harness
  picks only its backend: a **keyed** door first — a Brave Search or Tavily
  API key, stored auth-scoped (mode 600) in the engines' secret store by
  `/router key brave` · `/router key tavily` (env pins `BRAVE_API_KEY` /
  `TAVILY_API_KEY` win, and are filtered from eval kernels like every
  credential); Brave before Tavily — then the **keyless** door: DuckDuckGo's
  no-JS endpoints (html, then lite), form-POSTed under the stable
  no-disclosure agent (`Mozilla/5.0 (compatible; Mercury/<version>)`), no
  cookies, one deadline each. The keyless door works the moment Mercury is
  installed, with no account anywhere; the vendored tool never spends a
  provider account.

Where both tools are listed, the MODEL chooses per query — the harness never
forces one or hides the other. `MERCURY_SEARCH_BACKEND` names one vendored
door (`auto` · `brave` · `tavily` · `duckduckgo`), and a named door that
cannot open is a typed refusal — never a silent fallback;
`MERCURY_SEARCH_KEYLESS=0` closes the keyless door (an egress posture). Every
result carries `via`: the transcript row and the model-facing result both say
which backend answered, and a vendored door that failed on the way leaves its
one honest line as a note. Failures are typed values (`rate-limited` ·
`parse-failed` · `no-backend` · `network` · `key-refused` ·
`provider-refused`) rendered as one line — a changed page or body shape is
parse-failed, never a guessed hit. `/health`'s AUTH section states both
doors' facts for the session's model.

The same family law covers `WebFetch`'s domain preflight: the first party's
policy endpoint is consulted only for an anthropic-routed session — every
other family fetches with no first-party call, under Mercury's own URL
validation and the hostname-scoped permission gate. A keyless home searches
— and fetches — with zero first-party requests and zero model calls; a
prompted fetch's extraction leg is the one model call, and it rides the
session's own family through the routed seam, never a first-party hop.

## Usability, usage, and readiness

Two facades separate two questions: "can this provider take work right now,
and if not, why" — credential + catalogue + live limit state, composed
strictly over the existing owners (a capped window also caps delegation:
subagent dispatch is not a failover to another provider) — and "who am I on
it, what did this session spend, where are its limits" — identity from the
wallet, limits from each lane's observed state, session spend from the one
provider-neutral ledger partitioned by the routing law.

The approaching-limit warning has one owner and fires for
whichever provider the session actually runs on, from that provider's own signals,
in one grammar — `<provider>: XX% of <window> used[ · resets <t>]`: the Anthropic
subscription meters and header states, the OpenAI observed usage bands, the
OpenRouter per-key credit cap, the Kimi sign-in's managed windows. The window it
names is the one that binds the session model hardest — on the first-party
subscription the shared session and weekly windows plus the per-model weekly
pool of the model's own family (a Fable week at 87% warns a Fable session and
never a Sonnet one). A lane that serves no percent-shaped usage signal warns
never — an absent signal is an absent warning, not a fabricated meter. The engine
feeders read the same window views the settings tab and the rail meters read, so
the strip and the meters can never disagree about a percent.

Every meter surface — the telemetry rail's USAGE panel, `/deck`, the frame
band, `/usage` and the doctor's per-family usage rows — reads one owner and
paints one grammar: a family's shared windows first, then every per-model
weekly pool it reports beside them (the first-party subscription's Fable,
Opus and Sonnet weeks, folded into the same block; a family that reports
no pools shows none), each with its percent and its reset in the operator's
local time. The frame band's second chip is the binding window for the
session model, under its own label. Every figure names its feed and age —
endpoint-fed or header-fed, "read N ago" — and a read older than its reader's
own refresh cadence says "stale · last read N min ago" rather than passing as
live; a lane that has observed nothing says "no usage read", never 0%.

`/usage` lists every provider, the signed-in ones first in the order of their
most recent sign-in — the same sign-in record the computed default reads — and
each in its own shape: the first-party subscription's rolling windows and
weekly pools, the OpenAI account's observed bands, a Kimi sign-in's plan
windows, an OpenRouter key's credit totals and cap, the DeepSeek and Moonshot
balances, and an honest one-line absence for a lane whose provider publishes
no usage Mercury can read (Z.AI, Gemini, Hugging Face, a custom endpoint, an
API key on a subscription lane, a local server). Every API-key slot carries a
credits line: the provider-stated balance with its feed and age where the
family exposes one (the DeepSeek and Moonshot balance endpoints, the remaining
credit under an OpenRouter key cap), and "credits: not reported by the
provider" where none exists — never a computed spend presented as a balance.
Every figure is a reader's last observation with its stamp, sampled on the tab
through one door and dropped the moment the credential it belongs to changes —
never remembered, never invented.

The cost ledger prices every request at its own provider's published rates
from one pricing owner per family: the first-party tier table; the GPT,
DeepSeek, Kimi, GLM and Gemini price tables (a longer-prompt tier applied per
request); the OpenRouter catalogue row when the wire states no cost of its
own; the Hugging Face listed floor as a flagged estimate; a recorded zero for
a local server. A turn on a model with no rate on file lands in the ledger
with its tokens counted and its cost unrecorded: it is counted as an unpriced
turn, never priced at zero, and every cost readout says so — a lane that
priced nothing reads "unpriced", and a figure that includes such turns says
"+ N unpriced turns" beside itself, on the `/usage` spend lines, the `/cost`
headline and rows, and the deck and frame vitals alike. No family is ever
priced at another family's rates.

## Transitions

A model switch previews as a frozen plan — what would switching this
history to the target do — with per-item typed dispositions computed
against the real encode truth of the target lane's codec: replay carry,
thinking drops, image handling.
