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
| `anthropic` | `claude-*` ids (the mark anywhere in the id — gateway spellings included), the setting aliases (`opus` · `sonnet` · `haiku` · `fable` · `fable51` · `mythos` · `best` · `opusplan`), the `ANTHROPIC_*` model env pins and `MERCURY_CUSTOM_MODEL_OPTION`. An id NO family declares also classes here (the routing law's total remainder), but the ride is earned, never the remainder's accident: it is recognised as *unrecognised*, `/model`, `/health` and the dispatch seam name it, and bound for the first-party origin it refuses before the wire, credentialed or not, unless an operator-owned fact carries it — an `ANTHROPIC_*` model pin, or `ANTHROPIC_BASE_URL` re-pointed at a gateway | Anthropic |
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

DeepSeek's rows come from its live model list. With a DeepSeek key present,
Mercury reads the provider's models endpoint when the picker composes its
rows (never without a key, and never while catalogue traffic is switched
off) and paints the ids the list names, the group line saying how many are
live. The list states ids only, so a listed id keeps the label, window and
prices recorded from the pricing page, and an id the page has not recorded
paints under its own name at the conservative window Mercury budgets for an
unrecorded id; while the list is unreachable the recorded rows stand in
with their date.

A retired DeepSeek id resolves to its current one wherever a model id is
read — a saved setting, `MERCURY_MODEL`, `/model`, a sub-agent's model —
and paints as the current id: `deepseek-v4-flash` is `deepseek-flash`, and
the wire is sent the current id.

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
joins the one session cost ledger. On the wires that hand Mercury a tool
call's arguments as text, an optional field the model sent empty (an empty
string, an empty array, a null) reads as omitted, as the Anthropic wire
carries it; a required field sent empty stays, and the tool's own refusal
names it. On the OpenAI Responses wire, a curly quote in a field whose
value is a command, a pattern, a symbol or a path (the shell command; Grep's
pattern, path and glob; every tool's file path; the language-server tool's
symbol names and file fields; the debugger's expressions) reads as its
straight twin, since none of those ever wants one; a field that carries
content or prose — a Write's content, an Edit's new text, a Workshop cell —
stays exactly as typed, and every other wire carries every byte as typed.

Each wire carries its provider's documented quirks, the same pins the wire
sends from: reasoning-effort vocabularies, sampling restrictions
(the Kimi reasoning models fix their sampling, so that lane never sends
temperature), output-knob names, and usage-field spellings. The local lane
serves discovered servers (Ollama, LM Studio, vLLM, llama.cpp) at each
model's own base URL, omitting what a server kind does not support. The
Hugging Face and local lanes carry an explicit deferred-live caveat in
their readiness detail until verified against a live endpoint.

## Typed refusals

On the Anthropic wire, an authentication refusal never enters the backoff
ladder. Mercury attempts credential recovery once when the active sign-in or
key helper can refresh it. A changed credential gets one immediate retry;
a failed refresh, an unchanged credential, or another authentication refusal
ends the request. The blocker names the account when known and the sign-in
command, or the environment variable or helper that supplied the rejected
credential. A retry hint on an authentication refusal does not schedule a wait.

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

On the `/accounts` board each family's header carries the family name
alone, never a count of sign-ins against the ceiling; the rows beneath it
name each sign-in with its kind and identity, and a family with no ceiling
shows how many sign-ins it holds beside its name.

A claude.ai sign-in stores the account it landed, taken from the profile the
token exchange returned, beside the credential the moment the credential
lands. The sign-in's own receipt names that account, and every surface that
names the account (the face's account chip and its Logins roster, `/status`,
`/accounts`) reads it at once; a sign-in whose result carries no account
names none rather than the account stored before it. The `/accounts` board's
live verification still heals the stored identity whenever the two disagree.

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
row falls through to the next most recent sign-in. The `/model` readout
and the doctor's Default model row say which and why.
`/defaultprovider` makes a provider the most recent sign-in by the operator's
word (an entry in the same ledger). Credentials that landed before the ledger
existed, env-pinned keys included, order after every recorded sign-in — the
config's older `defaultProvider` record first, so a home keeps its lane until
its next sign-in. With no sign-in anywhere there is no default: the face and
`/model` say so and point at `/logins`. An explicit `/model` choice,
`MERCURY_MODEL` or a session override always outranks the default.

## Capabilities

One model→capability edge answers everything the harness asks of a model:
identity, context window and output ceilings, thinking
(supported/adaptive/interleaved), sampling, effort (vocabulary and ceiling
per family, from the same pins the wires send), tools (structured outputs,
auto mode, tool-search header), media (PDF and
image support), and beta-header emission. It re-reads live state on every
call by design.

A context window can come from a dated pin while the account's live list has
not answered yet — the GPT pin table, the Hugging Face pins. The rail's
context figure then carries the word `pin` after the size (`ctx 12% · 1050k
pin`), so a pin reads apart from a fact; when the list answers, the mark goes
and the figure is the list's. A pin no live list ever replaces — the
first-party rows, the GLM, Kimi and DeepSeek pins — carries no mark, and `~`
keeps its one meaning: the conservative default no source has stated.

A chat hosted by the daemon makes its requests in its own runner, and the
runner reads the account's list for them. That list rides the session's facts
to the screen, so the rail's figure becomes the list's and the mark goes the
moment the seat reports it, with no picker opened; opening the picker still
reads the list afresh.

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
  provider account. A rate limit is a wait, not a wall: a door that
  throttles or challenges the client (the 202 challenge page, a 429/503) is
  retried once after a short jittered back-off, then cools down (30 s,
  doubling per repeat, capped at ten minutes) and is not knocked again
  inside its window; a query that already landed answers from the session's
  cache for ten minutes and says so; when every door refused, the model gets
  ONE line naming what refused, the cool-down left, the key commands, and —
  where the family has one — the `ProviderSearch` door. The first keyless
  answer of a session carries the key-door hint once (both keyed engines
  offer a free tier); no later result repeats it.

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

`WebFetch` asks no policy service before a fetch, on any family: every
fetch runs under Mercury's own URL validation and the hostname-scoped
permission gate alone. A keyless home searches — and fetches — with zero
first-party requests and zero model calls; a prompted fetch's extraction
leg is the one model call, and it rides the session's own family through
the routed seam, never a first-party hop.

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

The same derivation puts one notice into the session's own context when the
binding window crosses that threshold, so an agent working in the session can
save its work before the provider stops it. At the next turn boundary — the
next submission or the next tool round — the model reads the provider and the
window, the percent used, the reset when the wire stated one, and what to do:
finish the step in hand, commit what is done, write down where the work stands.
The notice enters once per window per session and returns only after the window
has reset and the next one closes in; a resumed session remembers the windows it
was told about. A lane that serves no usage signal gets no notice, and a
headless run gets it by the same road. Nothing on the screen changes for it.

A usage-window verdict is what a reply's headers or a refusal said, observed
by the process that made the request. A daemon-hosted chat's requests are its
runner's, so the runner's verdict rides the session facts to the screen: the
window state, when it was seen, the reset the wire named, and the account slot
it was seen for. The screen folds it into its own record as a fresher
observation of the same slot, and the offer card marks the lane as it would
from a reply of its own. A verdict seen for another slot never enters, an
older observation never replaces a newer one, and a sign-in change clears it.

When a window walls and the session hands off to another signed-in family's
lane (the offer card, or the unattended posture), the session runs on a
failover lane until the home window is observed to reset. One amber sentence
above the composer says so — `on the anthropic failover lane · Opus 5 · OpenAI
window resets 24 Sept, 8:15 pm · /model to return` — for two minutes after the
switch, and again for two minutes whenever the facts it states change: the
served model, the lane, the home window's stated reset changing or passing,
the way home opening. Then it clears, and the strip's model segment carries a
short amber mark beside the served model (`Opus 5 · failover`) for as long as
the session runs on the lane; the mark leaves when the session is back on its
home family. `/model` returns home in one keystroke throughout.
`MERCURY_FAILOVER_LINE_MS` sets the sentence's window in milliseconds
(1000 or more; the default is two minutes).

Every meter surface — the telemetry rail's USAGE panel, `/deck`, the frame
band, `/usage` and the doctor's per-family usage rows — reads one owner and
paints one grammar: a family's shared windows first, then every per-model
weekly pool it reports beside them (the first-party subscription's Fable,
Opus and Sonnet weeks, folded into the same block; a family that reports
no pools shows none), each with its percent and its reset in the operator's
local time. The frame band's second chip is the binding window for the
session model, under its own label. Every figure names its feed and age —
endpoint-fed or header-fed, "read N ago", the rail's and the band's "↻12s" —
and a read older than twice its reader's cadence says "stale" ("stale ↻2h",
"stale · last read 2 h ago") rather than passing as live; a lane that has
observed nothing says "no usage read", never 0%. The first-party subscription's
reader samples the usage endpoint once a minute while the screen is up and
again after every completed turn (a daemon-hosted chat's replies land in the
runner's process, so the screen never waits on them); one request at a time,
and the freshest observation wins each window — a reply's headers the instant
they land, the endpoint's next answer a minute later. A read that fails (an
HTTP status, a timeout, an unreachable host, an expired sign-in token) is on
screen beside the last figure with the status and the host, backs off four
minutes, is logged once per episode, and is written once to the doctor's record
in the config home (`usage-reader.json`) with its recovery — `mercury doctor`
names it from another process. `/usage` and its retry key ask at once regardless.
A sign-in or a removal (the sign-in ledger's epoch, the one signal every family
raises) forgets the reader's state and asks for the account now signed in at
once — the meter never keeps a departed account's figure or waits out its
cadence.

A sign-in or a removal also reaches the engines behind the open chats. The
daemon tells every runner it hosts to read the account again, so a delegated
agent is never refused with a departed account's usage window; a runner that
missed the word is covered anyway — a limit verdict is trusted only for the
account that observed it, and reads as unknown once the signed-in account is
another, so the refusal for a reached window names the account it belongs to,
when it was seen, and the reset it knows. That verdict lapses at the reset the
reply named — or after a bounded span when the reply named none — so a
delegated agent is not refused after the window has reset, and the next reply
that says allowed clears it at once. An expired sign-in is reported as an
expired sign-in, never as a used-up window: the delegation refusal, the chat's
notice and the doctor speak the one sign-in line (sign in again with
`/logins anthropic`), and an authentication failure never sets the limit
verdict.

The OpenAI lane keeps the same law in its own shape. A reached OpenAI window
is observed on a reply's own reset fact and belongs to the sign-in or key that
observed it: it lapses at the reset the reply named, and it reads clear the
moment the credential behind that source is another one (a sign-in again, a
switch, a sign-out), so a delegated agent on a GPT row is never refused with a
departed sign-in's window. The runner's copy of the OpenAI model list follows
the same credential: told to read the account again, it drops the departed
sign-in's rows and reads the signed-in account's list once, bounded, and a
delegated dispatch on the OpenAI route reads that list before it decides. The
refusal for a reached window names the window that blocks; the state of the
model list is never named as if it were the block.

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

The plan also counts the conversation against the target's window before
the first request on it. The count is Mercury's own: the larger of the last
count the wire reported for the conversation and the character estimate.
The window is the target's as Mercury resolves it — the live catalogue's
figure for the account when it has been read, else the pinned figure. When
the conversation does not fit, the preview says so with both numbers and
where the window came from, and confirming folds the conversation before
the first request on the new model; the fold's summary is written by the
model the conversation was built on, whose window holds it. A conversation
that fits switches as before.
