# Engines — the provider estate

Mercury's main loop can run on models from its provider families. One pure law decides
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
| `anthropic` | `claude-*` ids (the mark anywhere in the id — gateway spellings included), the setting aliases (`opus` · `sonnet` · `haiku` · `fable` · `fable51` · `mythos` · `best`), the `ANTHROPIC_*` model env pins and `MERCURY_CUSTOM_MODEL_OPTION`. An id NO family declares also classes here (the routing law's total remainder), but the ride is earned, never the remainder's accident: it is recognised as *unrecognised*, `/model`, `/health` and the dispatch seam name it, and bound for the first-party origin it refuses before the wire, credentialed or not, unless an operator-owned fact carries it — an `ANTHROPIC_*` model pin, or `ANTHROPIC_BASE_URL` re-pointed at a gateway | Anthropic |
| `openai` | `gpt-*`, alias `gpt` | OpenAI |
| `zai` | `glm-*`, alias `glm` | Z.AI |
| `moonshot` | `kimi-*`, `moonshot-*`, alias `kimi` | Moonshot |
| `deepseek` | `deepseek-*`, alias `deepseek` | DeepSeek |
| `xai` | `grok-*`, alias `grok` | xAI |
| `meta` | `muse-spark-*`, alias `muse` (other `muse-*` endpoints refuse here) | Meta |
| `gemini` | `gemini-*`, alias `gemini` | Gemini |
| `openai-compat` | `compat/<vendor-id>` (qualified; stripped before the wire) | Custom endpoint |
| `openrouter` | `openrouter/<vendor-slug>` (qualified; stripped — OpenRouter ids are themselves vendor/model slugs, so only a namespace disambiguates them) | OpenRouter |
| `huggingface` | `huggingface/<org>/<model>[:provider\|:policy]` (qualified) | Hugging Face |
| `local` | `local/<model>` (qualified; the model as the discovered local server lists it) | Local models |
| `nous` | `nous/<vendor>/<model>` (qualified; stripped — the Portal's ids are vendor/model slugs, so only a namespace disambiguates them; the `~vendor/<name>-latest` alias rows ride the same way) | Nous Portal |

Display names have the same one-owner rule: every surface that names a
family derives its label from it, and an unknown id shows itself. Persisted
ids stay provider-qualified; the namespace detaches for the wire.

Anthropic's rows are the built-in table — the names, prices, effort ladders
and capability facts Mercury knows for each generation — joined by the live
model list of every signed-in door. When `/model` or `/logins` opens, Mercury
reads the models endpoint once through each credential it holds (a claude.ai
sign-in with its bearer, an API key, an environment bearer token), never at
boot and never from a passive reader, and never without a credential or
while catalogue traffic is switched off. A listed id the table knows changes
nothing; an id the table does not know paints as one row under its raw id at
the end of its family's block, selectable, served with its family's newest
defaults — the cost as an estimate at that row's rates, its effort ladder,
its window, its launch effort, its wire laws — and with no invented display
name or knowledge cutoff. A new generation never folds onto an older one:
`claude-opus-5-7` keeps its own identity while a dated snapshot or a gateway
spelling of a known generation still reads as that generation. A row the
lists do not carry stands as before — a list can be partial per door, and a
door whose list the endpoint refuses is that door's own catalogue error,
never a fault of the picker. The health check's Model lists row says what the
doors this process read serve and what they lack.

The family words follow each family's newest row — `opus` means Opus 5.5 and
`sonnet` means Sonnet 5.5 — so a saved `sonnet` runs Sonnet 5.5 while a saved
`claude-sonnet-5` stays on Sonnet 5, which keeps its own row under the family
in the picker; Sonnet 5.5 takes the two wire laws Opus 5.5 takes: thinking is
always on (a request with thinking off carries no thinking parameter and
adaptive thinking runs) and a forced tool choice becomes `auto`, the prompt
naming the tool.

`haiku` means Haiku 5.5 (`claude-haiku-5-5`); `haiku55` names that generation
explicitly. Haiku 4.5 keeps its own picker row, and a saved full id stays on
that generation. Haiku 5.5 has a native 1M context window, 128K output and
adaptive thinking, with `low`, `medium`, `high`, `xhigh` and `max` effort;
without an effort choice it uses the documented `medium` default. Forced
tool choice is supported. Input/output prices per million tokens are
$0.10/$0.50 through 100K prompt tokens and $0.50/$2.50 above that threshold;
cache reads and writes count toward the prompt length. These are the
[model facts](https://platform.claude.com/docs/en/models/haiku-5-5/overview),
[effort levels](https://platform.claude.com/docs/en/build-with-claude/effort)
and [prices](https://platform.claude.com/docs/en/about-claude/pricing)
read on 2026-10-08.

A new Anthropic model runs before its catalogue row lands: any id inside the
first-party space (`claude-…`) starts from every door — the boot face's new
session, `/clear`, `--model`, a saved setting, the crew and workflow seats,
the advisor and console picks, the coordinator's assist model, `/model` in
the chat — the moment the account holds an Anthropic credential, and the
wire decides whether it serves the id; no door judges a Claude id by whether
the picker lists it. A catalogue row adds what only a row can: the display
name, the price tier (until then the spend views say the figure is a family
estimate), the 1M twin and the alias, and the row's wire laws (thinking
always on, forced tool choice folded to `auto`); until it lands the id is
served under its raw name with the family's defaults.

DeepSeek's rows come from its live model list. With a DeepSeek key present,
Mercury reads the provider's models endpoint when the picker composes its
rows (never without a key, and never while catalogue traffic is switched
off) and paints the ids the list names, the group line saying how many are
live. The list states ids only, so a listed id keeps the label, window and
prices recorded from the pricing page, and an id the page has not recorded
paints under its own name at the conservative window Mercury budgets for an
unrecorded id; while the list is unreachable the recorded rows stand in
with their date.

`/logins xai` offers Grok subscription sign-in (SuperGrok / X Premium) beside the API key, with the subscription selected by default; a subscription lists, chats and reads its included weekly pool on cli-chat-proxy.grok.com, while an API key stays on api.x.ai.

xAI's Grok rows follow the same road: with a Grok sign-in or xAI key present, Mercury reads
the account's model list when the picker composes its rows and paints the
Grok ids it names; the family word `grok` means the newest Grok row that list
serves — as `deepseek`, `kimi` and `glm` mean the newest row of their own
family's list — and while the list is unreachable the recorded rows stand in
with their date.

Meta's Muse Spark rows come only from the account's live `GET /v1/models`
list, newest creation time first, with the id breaking ties. Connect through
`/logins meta` (or `/logins muse`), `/router key meta`, or `MODEL_API_KEY`;
`META_API_KEY`, the spelling Muse Code documents, is also accepted, after
`MODEL_API_KEY` and before the stored key. These are pay-as-you-go Model API
keys. `/accounts` manages the stored key. The family word `muse` selects the
newest served Standard Muse Spark row. A successful empty list stays empty;
no unfetched row becomes selectable. A named id can be sent with an honest
notice when the list is unreachable, but an id missing from a fetched list
is refused before chat.

Contributor rows are labelled **training permitted** and must be selected
explicitly: neither `muse` nor the computed default silently opts an account
into training on its prompts and completions. Meta's documented Spark 1.3,
1.2 and 1.1 rows have a 1,048,576-token context. Standard pricing is $1.25
input, $0.15 cached input and $4.25 output per million tokens; the 1.3 and 1.2
Contributor rows are $0.10, $0.002 and $0.20 respectively, with no long-context
premium. Unrecorded served ids keep their raw names and unknown prices.

Mercury uses Meta's OpenAI-compatible Chat Completions endpoint at
`https://api.meta.ai/v1/chat/completions`, with streaming, function tools,
JSON-schema output and the model's documented reasoning effort. `none` is
not supported; `max` is documented only for Standard Muse Spark 1.3. No
reasoning-off flag is sent. Meta also offers Responses and Messages APIs;
its Chat Completions API does **not** preserve private reasoning across
turns. Mercury's Meta road therefore replays the conversation and tool
results, not encrypted reasoning. Meta recommends Responses for reasoning
continuity in agentic work; that is not claimed by this road.

Meta's subscription page says: “This credential is for use with Muse Code
only” and a subscription “works only through the Muse Code CLI”. Mercury
does not reuse Muse Code's browser session, client identity or subscription
credential. No public third-party OAuth client registration or device flow
was documented in the sources read on **2026-09-30**: [quickstart](https://dev.meta.ai/docs/quickstart),
[models](https://dev.meta.ai/docs/models), [pricing](https://dev.meta.ai/docs/pricing-rate-limits),
[reasoning](https://dev.meta.ai/docs/reasoning), [authentication](https://dev.meta.ai/docs/authentication),
[Muse Code sign-in](https://dev.meta.ai/docs/muse-code/auth) and
[subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions).

Nous Research's Portal is a model gateway: one API key, billed to the
Portal credits or subscription behind it, serves a live catalogue of
third-party models (Claude, GPT, Gemini, DeepSeek, Qwen, Kimi, GLM, Grok and
more) at the Portal's own `vendor/model` slugs, plus `~vendor/<name>-latest`
rows that always point at the newest model of a family. Mercury persists
these ids as `nous/<vendor>/<model>`; the namespace detaches for the wire.
Connect through `/logins nous`, `/router key nous`, or `NOUS_API_KEY`; the
key is made at `portal.nousresearch.com` after adding credits or a
subscription, and `/accounts` manages the stored key. The rows come only
from the account's live `GET /v1/models` list: `/model` paints the Portal's
recommended agentic rows first, then the catalogue's own order, with a door
to the full list behind a filter; a typed `nous/<vendor>/<model>` id is
refused before chat when a fetched list lacks it. Each row's context window,
output ceiling, image input, tool support, reasoning dial and price are the
facts the live row states — never a first-party table joined by name — and a
row whose supported parameters omit tools refuses a tool-bearing turn before
the wire. Nous's own Hermes models are not on the Portal's list as of
**2026-10-09**: the live catalogue carries no Hermes row and the inference API
answers the documented Hermes ids with "This model has been retired".

Mercury uses the Portal's OpenAI-compatible Chat Completions endpoint at
`https://inference-api.nousresearch.com/v1/chat/completions`, with streaming,
function tools and the row's stated `reasoning.effort` vocabulary; the
Portal's usage object settles each turn. The Portal answers HTTP 401 for a
key that is invalid, blocked **or out of funds**, so the refusal names all
three and the Portal's billing page. The key's meter is the Portal account
endpoint, `GET https://portal.nousresearch.com/api/oauth/account`: when it
resolves the key it states the plan, the usable credits, the subscription and
purchased credits and any organisation spend cap, and `/usage` paints them
with their feed and age; when it does not, the reader note says what the
endpoint answered and points at the Portal. The Portal's documented
authentication for third-party clients is the API key (its OpenAPI spec,
"Option 1: Using API keys & account credits", read **2026-10-09**); its
sign-in flow is reserved for Nous's own clients, so Mercury offers none.
Sources: [the Portal OpenAPI spec](https://portal.nousresearch.com/api/openapi)
and [the live model list](https://inference-api.nousresearch.com/v1/models).

Moonshot's default, picker and specialist choices follow the account's live
model list. An API key reads the platform list; a Kimi sign-in reads its
region's coding list with the same credential used for chat. The newest
creation time leads, with provider order preserved when times are absent
or equal. A successful empty list offers no row. With no fetched list,
the recorded rows stand in with their observation date. An id missing from
a fetched list is refused before chat, with the account label and offered
ids; an unreachable catalogue permits a named id with an explicit note.
An unnamed first chat reads the catalogue within the existing bounded
allowance; idle boot and explicit model choices remain unchanged.

Kimi models whose live catalogue declares dynamic-tool support use the
end-of-messages deferral form: admitted schemas append as system tool rows,
while the initial tools array and earlier messages stay unchanged. This
includes the K2 coding alias `kimi-for-coding`; an explicit live false
keeps deferral off, including on `kimi-for-coding-highspeed`. Without a
capability observation, only the recorded K3 ids and supported K2 coding
alias use this form; other K2 ids are not assumed to support it.

Z.AI's GLM rows follow the same road: with a Z.AI key present, Mercury reads
the account's model list (`GET /models` on the base the key is valid on — a
GLM Coding Plan key reads `https://api.z.ai/api/coding/paas/v4`, a general
key or `ZAI_API_KEY` reads `https://api.z.ai/api/paas/v4`) when the picker
composes its rows, and paints the GLM ids it names, newest first. The list
states ids only; each row's window and reasoning dial are the facts
docs.z.ai states for that id (read 2026-10-05): `glm-5.3`, `glm-5.3-flash`
and `glm-5.3-flashx` have a 1M-token window, a 128K output ceiling and the
dial `low` · `high` · `max` with thinking always on; `glm-5.2` has the 1M
window and the seven-level dial; older ids keep their documented windows
and offer no dial. An id the docs do not name paints under its raw name
with no window and no dial. The family word `glm` means the newest row the
list serves. While no list has landed, the recorded rows (`glm-5.3`,
`glm-5.3-flash`, `glm-5.2`) stand in with their date; a model the list no
longer carries leaves the group. On the Coding Plan, Z.AI serves `glm-5.3`
and `glm-5.3-flash` under their own names and answers an older id with one
of those two; a model the plan does not include is refused with Z.AI's own
reason after the status, as every chat refusal is.

A retired DeepSeek id resolves to its current one wherever a model id is
read — a saved setting, `MERCURY_MODEL`, `/model`, a crewmate's (sub-agent's) model —
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

Three wire families serve the providers:

- **The Anthropic home lane** — the first-party API, directly or through a
  base-URL proxy.
- **Native wires** — Z.AI, OpenAI through its Responses API, and Gemini
  through generateContent when using a Google account.
- **The OpenAI-compatible chat wire** — Moonshot/Kimi, DeepSeek, xAI's Grok
  models, Meta, the operator-named compat slot, OpenRouter, Gemini with an API key,
  Hugging Face (the Hub router, Hub slugs with an optional backend suffix),
  and local servers.

Whichever wire a session runs on, a turn behaves the same way: text and
tool calls stream as they arrive; the final usage and stop reason are
recorded; a provider fault never crashes the turn — a terminal fault lands
as an API-error message in the chat, cancellation returns quietly, and a
retryable fault before any content is retried once; every request's usage
joins the one session cost ledger. A refusal that says the provider is busy
(an HTTP 503, the Anthropic wire's HTTP 529 or `overloaded_error` — inside a
stream too — Google's UNAVAILABLE, OpenAI's overloaded model, DeepSeek's
overloaded server, OpenRouter's no available provider, Z.AI's code 1305, or a
vendor's own overloaded or unavailable word) is retried quietly on a growing
wait on every road — 1 s, 2 s, 4 s, 8 s, 16 s and 30 s, about a minute in
all — before the chat gives up: nothing is painted for the first thirty
seconds, then the retry line shows the true wait and the true count, and the
red error line comes only once the whole ladder is spent, saying how many
retries it took and how long (on the Anthropic wire it carries the
provider's own answer; with an API key and an Opus model, a spent ladder
ends the turn with the repeated-overload line, or switches to the fallback
model when one was named at launch). A rate limit that names its own wait
(Retry-After) rides the same ladder with that wait in place of the rung; a
rate limit without one keeps the single retry. A reply that arrives inside
the ladder shows one calm grey line above it, naming the provider —
`OpenAI was busy · answered after 2 retries (7 s)` — whose ctrl+o expansion
carries the provider's words and every wait; the debug log carries every
retry either way. Escape ends a wait at once. A stream the provider cuts
after some of the reply has arrived is continued once: Mercury asks the model
to pick up where it stopped, the reply so far stands, and the chat shows one
quiet line,
`Continued after 1 stream cut · context sent again`, whose expansion names
the road, what the provider sent and the code. The cost is in those last
three words: the continuation sends the turn's context again — on a
subscription that is usage-window consumption, on an API key it is input
tokens, and prompt cache hits reduce it. A second cut in the same turn is
not continued; it stands as a failure and reads as one. On the OpenAI
Responses wire every cut also writes one line to the debug log naming the
road, the protocol, the milliseconds since the request started and since the
last byte, the bytes and events received, whether the model was mid-reasoning
or mid-text, the request's size class and the response headers that name the
edge. On the wires that hand Mercury a tool
call's arguments as text, an optional field the model sent empty (an empty
string, an empty array, a null) reads as omitted, as the Anthropic wire
carries it; a required field sent empty stays, and the tool's own refusal
names it. On the OpenAI Responses wire, a curly quote in a field whose
value is a command, a pattern, a symbol or a path (the shell command; Grep's
pattern, path and glob; every tool's file path; the language-server tool's
symbol names and file fields; the debugger's expressions) reads as its
straight twin, since none of those ever wants one; a field that carries
content or prose — a Write's content, an Edit's new text, an Eval cell —
stays exactly as typed, and every other wire carries every byte as typed.

A dispatched crewmate whose turn ends on the provider's overload — the busy
refusal above on any road (the Anthropic wire's 529 or `overloaded_error`,
another provider's spent busy ladder), with no wait stated — is not
failed: it pauses, its row says why — `paused — provider overloaded ·
resumes by itself when the provider answers` — its work so far is kept, and
Mercury probes the provider with one small request at a slow, bounded
cadence — 30 s after the pause, then every minute for ten minutes, then
every five minutes, for up to one hour — and resumes the agent by itself
when a probe is answered; the agent continues from where its transcript
ends. The parent's chat carries one calm line per agent per outage — the
first pause names the provider and the probing; a later death and the
resume itself add no line, the agent's row on the crew view carries them —
and the agent's completion follows as its own line; a message to the agent
resumes it sooner, and the crew view stops it. The line names the status
the provider answered with — 529 on the Anthropic wire, 503 elsewhere, none
when the refusal carried none. A helper the parent waited
on inline takes the same road, and so does one handed to the background
mid-turn: its result to the parent leads with the
pause, the probing brings it back in the background, and its completion
follows as a notification. If the
outage outlasts the probing, the row is a failed one again and a message is
the way back.

A session's side jobs — the chat's title, the away summary, the tool-use
summaries, the state read, the feedback card, a prompt hook's default model,
the date parser and the fetch tool's summary — ride the session's own family
on its helper tier. On the Anthropic lane that is the small family default
(`MERCURY_SMALL_FAST_MODEL` pins it). On a GPT session it is the cheapest
text model the account's live list serves, by the prices the GPT table
records (a mini or nano row when the list serves one); no id the list lacks
is ever asked for, and while the list has not answered, or serves no priced
row, the side job runs on the session's own model. The hook agent's tier
follows the same rule: the newest plain GPT row the list serves below the
frontier, else the session's own model.

Each wire carries its provider's documented quirks, the same pins the wire
sends from: reasoning-effort vocabularies, sampling restrictions
(the Kimi reasoning models fix their sampling, so that lane never sends
temperature), output-knob names, and usage-field spellings. The local lane
serves discovered servers (Ollama, LM Studio, vLLM, llama.cpp) at each
model's own base URL, omitting what a server kind does not support. Its
context window is never a number Mercury decides: a model's served window is
read from the server before a request is judged against it (Ollama loads the
model and `/api/ps` states the window; LM Studio's loaded instance, vLLM's
`max_model_len` and llama.cpp's `/props` state theirs), a window the server
has not stated yet refuses nothing, and the fit guard refuses only a request
more than a third larger than a window the server, its Modelfile or the
session's own hold states (counted at the wire's measured 3.9 bytes per
token, the tools weighed as the request carries them — the never-deferred
schemas in full, the rest by name; anything closer is sent, and the server's
own refusal is the truth). The window a local
model is served with is a setting inside Mercury (`/config` → Local model
window, per model): `auto` (unset) chooses the biggest of 32k · 64k · 128k ·
256k, never above the trained maximum, whose projected load (the weights plus
the KV cache of the layers that keep one — a hybrid such as Qwen 3.5/3.8
states `full_attention_interval` in its own metadata, so one layer in four
counts — at the server's cache type and slots, from the model's own
geometry; once the model is loaded, the size `/api/ps` measures at its
window outranks that formula) fits the memory usable for models — the
server's own gpu-memory line when it states one, the same rule
`/localsetup`'s step 5 uses — at the
model's first send and holds it for the session on every dispatch — the main
thread, crewmates and workflow agents alike, so a crewmate never reloads the
runner (when the machine's memory cannot be read — the server states no
geometry, or the read fails — the window comes out bigger, not smaller: the
trained maximum when the model states one, else the served window, else twice
the first request rounded up to 16k and never under 64k, and the words say so);
the rail's ctx row names the reason (`max` · `fit` · `set` · `srv`) and the
deck's ctx row carries the figures; `server default` leaves the choice to the
server (Ollama loads the model and `/api/ps` states the figure); `32k` · `64k`
· `128k` · `trained max` or a number pin it — a pinned rung whose load does not
fit this machine says so on the row and names the biggest rung that does, and
is still saved. On Ollama the chosen window rides as `options.num_ctx` on every request
over the native `/api/chat` stream (with `truncate: false`, so an over-window
prompt is refused by the server rather than truncated), and every request the
session sends that model — the chat, the pre-warm, the keep-alive touch, the
served-window load and every crewmate or workflow seat — carries the same
`num_ctx` and `num_batch`, so the scheduler keeps one runner and its prompt
cache for the whole session; a runner the server already holds at a window
that fits the turn and is no smaller than the session's own choice is adopted
rather than reloaded (under auto and `server default` — a window you set is
honoured, and a smaller stale runner is reloaded once, up to the full window),
and the row names it as the server's; LM Studio takes it
when the model is loaded (`POST /api/v1/models/load {model, context_length}`);
vLLM and llama.cpp fix their window at server start, so the row shows the
served figure and reads as not applicable. When no local server answers,
`/localsetup` sets one up inside Mercury — it finds or installs Ollama, starts
it, asks which model to use, pulls the chosen model if needed, sets its window
from this machine's memory and checks a reply, each step asking before it runs
([LOCAL-SETUP.md](LOCAL-SETUP.md)). The lane is verified
against a live Ollama for discovery, streamed text, streamed reasoning and
multi-round tool loops, and against a live llama.cpp (2026-09-27, Qwen3.5 9B
served as `qwen3.5:9b`, server build b11146) for the same three legs —
discovery with the served window read from `/props`, a streamed reply with
its reasoning block, and a tool loop that also dispatched a crewmate and a
workflow agent on the model; and against a live LM Studio (2026-09-27, Qwen3.5
9B served as `qwen3.5-9b`) for the same legs — discovery from `/api/v1/models`
with the loaded instance's window, a streamed reply with its reasoning block,
a direct tool loop, a crewmate and a workflow agent — where the product
reloads the instance at its chosen window on the first send (the documented
load road) unless the window setting is `server default`. vLLM is unverified
— it needs a Linux box with an NVIDIA card. The search-door and SATURN-fire legs remain operator-deferred
drill lines. The Hugging Face lane carries an explicit deferred-live caveat
in its readiness detail until verified against a live endpoint.

On the local lane no watchdog cuts a request while the server answers. The
first-byte budget there is a promise the status row speaks, not a deadline:
it is sized from the model's measured ingestion pace — the uncached prompt
tokens the wire reports over the time to the first byte, remembered per
model in `local-ingest-pace.json` under the config home — with a quarter's
margin; before a measurement, a default by parameter count (300 tokens/s up
to 10B, 100 up to 35B, 40 above, 100 when the server states no size). When
the promise runs out, Mercury asks the server a cheap liveness question
(Ollama `/api/version`, LM Studio `/api/v1/models`, llama.cpp `/health`,
vLLM `/v1/models`): an answer extends the promise and the row says so
(`still ingesting … — about 3m 23s more (its server answered at 6m 46s)`);
two unanswered probes in a row cut the request with the dead-server words
(`no answer from Ollama at 127.0.0.1:11434 for 10 s while ingesting — the
local server is not responding (its window, its load, or a crash); /model
re-probes`), and that cut is never reissued. After the first byte the idle
watchdog follows the same law at the patience setting's quiet number (15
minutes, the OpenAI road's): the row warns at the warning point (`no bytes
for 7m 30s — <model>'s server is asked at 15m`), the server is asked at the
idle number, and the turn holds while it answers (`no bytes for 15m —
<model>'s server still answers`; esc interrupts). While the server is still
loading the model the row says `loading <model> (<size> GB)`, and the
ingestion clock starts once the server lists it. The hard cap on a local
request is two hours. Ollama's native `/api/chat` road rides the same law as
the `/v1` road, and hands its fetch a dispatcher whose HTTP headers and body
budgets are raised to that cap, so nothing beneath the law cuts first (the
shared API dispatcher's 600 s headers budget once ended a long ingest with
`UND_ERR_HEADERS_TIMEOUT` and a re-ingest). On that road a turn whose every
row was thinking — no reply, no tool call — settles with
`reasoningOnly: true` on the message, and the debug log carries the stream's
shape and its first 2,000 characters (`[compat:local] /api/chat stream from
<model>: …`). Every other lane keeps its first-byte budget, its idle number
and its whole-request ceiling unchanged.

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
- an undiscovered `local/<id>` refuses with the probe route and the pull (`ollama
  pull <id>` when an Ollama server answers) rather than guessing a port; a
  request larger than a local model's stated served window refuses before the
  send, naming the window, its source and the in-app road that raises it, since
  the server would silently truncate it;
- sub-model containers surface the owning catalogue's refusal reasons verbatim.

One vocabulary decides what may run where, and what a picker shows is what
dispatch allows. The
**session** arm is pure product capability: a session dispatches on every family
the account holds a credential for, every tier included; a family with no
credential refuses typed (`no-credential:<family>`) with the one action that fixes
it riding the refusal — except the account-less local family, whose miss is a gone
server, not a missing credential: it refuses `unreachable:local` with the probe
route. The **crew** arm carries the same verdict row for row: a crewmate is
the same product child a session runs, so every row a session may run, a crew
seat may run. Every refusal names its class and
carries one machine-readable action line — a coordinator or operator relays the
real fix, never an invented reason.

## Auth

The `/accounts` slots derive one per signed-in identity across every family
the router catalogue knows — derived, never hardcoded. Each family's slots
come from its owning account resolvers:

- **anthropic** — the account scope ring plus the API-key ladder, source-honest;
- **openai** — the subscription store and the stored key, both shown when both exist;
- **gemini** — API key or your own OAuth client; Cloud project billing: free Flash ~20 requests/day, Pro 0; billing enables paid limits. AI Pro/Ultra plans don't apply. Consumer Google sign-in ended June 18, 2026 (Gemini CLI too). The cockpit, daemon and session
  runner read OAuth and locally stored keys from the same auth-scoped store.
  The `/logins` card offers the API key first, as
  `API key — the easiest: create one in AI Studio, paste it here`: choosing it
  opens https://aistudio.google.com/apikey in the browser, prints the address
  for a box without one, and takes the key by one paste. The Google account is
  six numbered steps, each opening its Console page: 1. Create a Google Cloud project;
  2. Enable the Gemini API on it (that page picks the project, or creates one);
  3. Set up the consent screen for testing (on the Audience page: the user type
  External, and your own Google address under Test users —
  Google lets an unpublished app sign in only its listed test users);
  4. Create an OAuth client for a desktop app; 5. Paste the client id (the
  secret is optional; the id is kept for good, so the next sign-in starts at
  step 6); 6. Sign in with Google in the browser (Continue past "Google
  hasn't verified this app", then Allow). A sign-in Google refuses with
  `access_denied` returns the card to step 3 with its page open. The Console
  addresses are dated facts (observed 2026-09-20) kept beside the words; the
  release-day check fetches each one and refuses a dead host, and a page that
  moved still shows its words and its address on the card. The scopes stay
  Google's two.
  Google-account chats use the native generation endpoint and preserve signed
  response parts across tool rounds and resume, exactly as Google returned
  them (a signature that streams in after the text rides the text part it
  closes); a tool call the history carries without a signed record (a chat
  switched from another model) replays under Google's documented
  skip-validation signature. An image the model generates is refused as
  content this chat cannot display. API-key chats keep the compatibility
  endpoint. A native token refusal names the Google account and `/logins`,
  with a receipt when a refresh was attempted and Google's own reason after
  it; a billing refusal on the Google sign-in says its quota and billing
  cannot be changed from here and points at a Gemini API key on a project of
  the operator's own.
  A refusal that says try again later (Google's HTTP 503, its own words about
  high demand) is retried quietly on the growing wait every road takes — 1 s,
  2 s, 4 s, 8 s, 16 s and 30 s, about a minute in all — before the chat gives
  up: nothing is painted for the first thirty seconds, then the retry line
  shows the true wait and the true count, and the red error line comes only
  once the whole ladder is spent, saying how many retries it took and how
  long. A reply that arrives inside the ladder shows one calm grey line above
  it, `Gemini was busy · answered after 2 retries (7 s)`, whose ctrl+o
  expansion carries Google's words and every wait; the debug log carries every
  retry either way. Escape ends a wait at once. A wait Google itself asks for
  (Retry-After) is honoured in place of the ladder's own when it fits the
  retry budget, as on every road. On a chat without a screen (`mercury run`
  or a dispatched agent) the same ladder runs, and its `wait` rows with
  `state: "retry"` reach the caller only past the quiet window; a dispatched
  agent's retry budget counts every wait of the ladder, the quiet ones
  included, so a six-second budget
  ends the ladder six seconds in whether or not a retry line has painted.
  The API-key resolver takes `GOOGLE_API_KEY` before `GEMINI_API_KEY`, then the
  stored key; environment keys must be available to the process that uses them.
  A launch naming `gemini` needs the live catalogue to choose a model. A present
  credential with a refused, unavailable or unselectable catalogue is a catalogue
  refusal, not a missing sign-in; `no-credential:gemini` means no credential is
  present. An explicit Gemini model id can still dispatch with a credential,
  and the model endpoint decides whether to accept it. When Google refuses the
  catalogue read, the `/model` group heading names the credential it tried and
  the status it got — `the Google account's token was refused (HTTP 403) ·
  /logins re-connects`, `the stored Gemini API key was refused (HTTP 403) ·
  /logins replaces it`, or the environment key by its variable name (the
  middle dot lets the picker's detail row wrap the remedy whole) — and the
  debug log (`mercury --debug`; `debug/latest` under the config home) carries
  one line per refused read with the source, the status and Google's error
  body, every token, key and client secret masked;
- **moonshot** — stored OAuth tokens or stored key;
- **openrouter** — an OAuth-minted key or a stored key, env pin winning honestly;
  `/config → OpenRouter routing policy` chooses strict, balanced or open routing. Balanced is on from the start: model requests deny data collection and require every parameter, with fallbacks on and zero data retention off. An absent or empty `routing.openrouter` setting selects these defaults; strict turns fallbacks off and zero data retention on. Choose open to allow collection and make parameters optional, leaving routing to OpenRouter; only an explicit all-off policy sends no request-level routing preference. A no-provider refusal points back to this row to widen the policy;
- **xai** — a Grok subscription sign-in or an API key, with an optional management key for the API team's
  usage meter. The API-key leg of `/logins xai` offers the management key as its second step;
  leave it empty or press escape to keep using just the API key. An existing
  API key can be kept by pressing enter on the first step. Create the management
  key on [the console's settings page](https://console.x.ai/team/default/management-keys)
  with the **Management Keys Read + Write** permission. Both keys are stored
  auth-scoped (mode 600); env pins `XAI_API_KEY` and `XAI_MANAGEMENT_API_KEY`
  win independently. `/router key xai-management` adds the management key
  directly, and its `clear` road or its own `/accounts` row removes only that
  key — the inference key stays. A management key alone cannot run Grok;
- **zai, deepseek, meta, huggingface, local, compat, nous** — env pins and stored keys.

Slots carry presence facts and masked key tails only — never a secret value.
Removal is routed to each slot's owning store, never inlined. Env-pinned
keys are the shell's: shown, precedence-honored, refused for editing, never
a Mercury-held sign-in. A ceiling caps concurrent Mercury-held sign-ins
(two for anthropic, two for openai), and one typed refusal is consulted by
every sign-in path before adding a concurrent login.

On the `/accounts` board each family's header carries the family name
alone, never a count of sign-ins against the ceiling; the rows beneath it
name each sign-in with its kind and identity, and a family with no ceiling
shows how many sign-ins it holds beside its name. A sign-in row in either
of the concourse's model pickers, or in the Boot face's own, opens the Boot
face's Logins screen on that row's family; a completed sign-in, or escape,
returns to the picker that opened it, which lists the new family's models.

A claude.ai sign-in stores the account it landed, taken from the profile the
token exchange returned, beside the credential the moment the credential
lands. The sign-in's own receipt names that account, and every surface that
names the account (the face's account chip and its Logins roster,
`/accounts`, the `/usage` popup's Anthropic block, the cockpit's usage
card and the `auth status` verb) reads the email stored beside the token
itself — the profile, else the exchange's receipt — never a recorded copy or
a fresh probe while painting; a credential with neither names none, in each
surface's own words, rather than the account stored before it. A hosted
session's `session/facts` answer names that same address in
`identity.account_email`, so the cockpit's connector and any reader of the
session's facts see the credential's own account. The
`/accounts` board's live verification still heals the stored identity
whenever the two disagree; until it answers, the board names the recorded
copy beside the credential's own address, labelled as a snapshot, only when
the two differ.

Every provider's usage block, on the cockpit's usage card and in the
`/usage` popup, prints one identity line under its title, and no block goes
without one: the signed-in account when the family's own store recorded one
(the Claude and ChatGPT sign-ins' emails, the Hugging Face username), else
the credential's own words — a key as the model picker's heading words it,
its kind and masked tail (`API key · …4321`, `Coding Plan key · …YtbT`,
`OAuth key · …abcd`, `token · …abcd`), a nameless sign-in or a local server
by the label its resolver gives it — else `no account`. The popup says
`Signed in as <account>` for an account and prints a credential's words
bare; the card prints the bare value at its own width. One composer answers
for every family, over the presence enumeration and the accounts roster's
slots, so the block, the roster and the picker never disagree about who a
family is signed in as.
Organisation roles enrich only the account and authentication scope that
requested them; changing accounts or leaving the sign-in flow discards a
late reply without delaying sign-in.

On the claude.ai sign-in door the subscription endpoint gates models on a
minimum client version it reads from the billing attribution line Mercury
writes into the system prompt (never from the User-Agent, which stays
`mercury/<version>` on every wire), so Mercury presents a declared
client-contract version there and nowhere else: the built-in version, a
newer one Mercury learned from the npm registry, or
`MERCURY_ANTHROPIC_CLIENT_CONTRACT=<version>`, which wins over both and
raises it without a rebuild when the floor moves. When the gate refuses the
presented number as too old, Mercury reads the registry once (a 3-second
deadline) and, if it answers a newer number, retries the refused request
once carrying it; a session boot also reads it in the background once a
day. The learned number is kept in the config home and presented only while
it is newer than the built-in one; at most one registry read goes out per
config home in ten minutes, and `MERCURY_DISABLE_NONESSENTIAL_TRAFFIC` keeps
every registry read dark. The health check's Client contract row shows what is
presented and its source, and the gate's refusal names the version
required, what Mercury presented, what the registry read did, and that
override.

The default provider is the provider of the most recent sign-in. Every sign-in
door records when a family's credential landed (the sign-in ledger,
`.sign-ins.json` beside the credential stores; a token refresh never records),
and a fresh, unpinned session starts on that provider's newest model the
credential can use — a gated row is never chosen, a provider with no usable
row falls through to the next most recent sign-in. The `/model` readout
and the health check's Default model row say which and why.
`/defaultprovider` makes a provider the most recent sign-in by the operator's
word (an entry in the same ledger). Credentials that landed before the ledger
existed, env-pinned keys included, order after every recorded sign-in — the
config's older `defaultProvider` record first, so a home keeps its lane until
its next sign-in. With no sign-in anywhere there is no default: the face and
`/model` say so and point at `/logins`. An explicit `/model` choice,
`MERCURY_MODEL` or a session override always outranks the default. A saved
`/model` choice whose family cannot run when a chat is born — no sign-in for
it here, or a credential its catalogue refused (a Google, OpenRouter or
Hugging Face refusal with its status; an OpenAI sign-in the authorisation
server killed) — falls back to the computed default for that chat, with one
receipt naming why; the saved choice stays. A catalogue still being fetched,
unreachable, switched off or otherwise unsettled is not a refusal: the chat
starts on the saved choice and the runner reads the catalogue itself. A stored
Gemini key with the test fixture's shape (`zz-SECRE…`) is named a test key
on its `/logins` and `/accounts` rows, with the gesture that removes it.

## Capabilities

One model→capability edge answers everything the harness asks of a model:
identity, context window and output ceilings, thinking
(supported/adaptive/interleaved), sampling, effort (vocabulary and ceiling
per family, from the same pins the wires send), tools (structured outputs,
tool-search header), media (PDF and
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
moment the seat reports it, with no picker opened. The model picker paints
its cached rows at once and refreshes every signed-in family's list in the
background on every open, even when that cache is fresh: the Anthropic list
through each signed-in door, the GPT, OpenRouter, Gemini and Hugging Face
catalogues, and the local servers' discovery. The `/logins` card asks for the
lists its readiness rows read when it opens and repaints them as they land,
so an OpenAI sign-in on a Claude session reads its catalogue's own state
there within one refresh instead of "not fetched yet" until `/model` opens. The
crewmate model choice in `/config` refreshes the same lists
when its picker opens. A changed
list replaces the rows in place, keeps the highlighted model and adds a notice
naming the family; an unchanged list stays quiet. A family with no credential,
or with catalogue traffic switched off, sends nothing. The retry action shares
any refresh already in flight.

A local server has knobs of its own that no request can set: how many models
it keeps loaded at once, how many requests one loaded model answers at once,
how long an idle model stays loaded, and the context length a request gets
when it names none. On Ollama they are `OLLAMA_MAX_LOADED_MODELS`,
`OLLAMA_NUM_PARALLEL`, `OLLAMA_KEEP_ALIVE` and `OLLAMA_CONTEXT_LENGTH` in the
server's environment (its FAQ documents 3 per GPU, 1, 5m and 4096 when
unset). `/config` shows them under the Local account row beside the live
truth: the server and its version, the loaded models with their windows and
memory from `/api/ps`, the runner's slot count and context from its command
line, and the launch form Mercury found — a launch agent plist, the Homebrew
plist, the Ollama app, a systemd override, Windows, or unknown. Each knob row
is a Mercury setting (`local.server` in the user settings) with the memory
arithmetic beside it, read from the model geometry `/api/show` states: a
slot costs a full window of cache, so one loaded copy with several slots
serves a crew where several copies would not fit. The ceiling the
arithmetic measures against is the usable memory the server itself states —
the `gpu memory … available` line in its log when Mercury can read it, else
`iogpu.wired_limit_mb` when set, else about three quarters of unified memory
on macOS, else the box's total — and the row names which. A choice whose
projected load (the largest models the count allows, each at the chosen
window with the chosen slots) does not fit is refused in red with the
figures on the knob rows and on the Apply row, which then has no door: nothing
is applied until the choice fits. Nothing reaches the server until the Apply
row's review is confirmed: for a launch agent or a systemd override the
review names the file, the exact lines that change, the backup written beside
the file and the restart command; for the Ollama app it names one `launchctl
setenv` line per changed knob with the previous value, the quit, the wait for
the port to close, the `open -a Ollama` and the wait for `/api/version`, and
the revert lines (the FAQ's road for the app); `↵` applies, `esc` leaves
everything as it was. On Windows, or where Mercury may not write the file,
the review shows the values to set by hand.

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
the routed seam, never a first-party hop. The leg asks the family's helper
tier first and the session's own model when that fails; a helper that
answers an API error is a failed leg, never the summary, and only when both
roads fail does the page come back under a note naming each road and its
reason.

## Usability, usage, and readiness

Two facades separate two questions: "can this provider take work right now,
and if not, why" — credential + catalogue + live limit state, composed
strictly over the existing owners (a capped window also caps delegation:
crewmate dispatch is not a failover to another provider) — and "who am I on
it, what did this session spend, where are its limits" — identity from the
wallet, limits from each lane's observed state, session spend from the one
provider-neutral ledger partitioned by the routing law.

The usage warning has one owner and fires at 80% and again at 90% for
whichever provider the session actually runs on, from that provider's own signals,
in one grammar — `<provider>: XX% of the <window> used[ · resets <t>]`: the Anthropic
subscription meters and header states, the OpenAI observed usage bands, the
OpenRouter per-key credit cap, the Kimi sign-in's managed windows. The window it
names is the one that binds the session model hardest — on the first-party
subscription the shared session and weekly windows plus the per-model weekly
pool of the model's own family (a Fable week at 87% warns a Fable session and
never a Sonnet one). A lane that serves no percent-shaped usage signal warns
never — an absent signal is an absent warning, not a fabricated meter. The engine
feeders read the same window views the `/usage` popup and the rail meters read,
so the strip and the meters can never disagree about a percent. An OpenAI
band past its reset, or older than its response freshness horizon, keeps its
last-read words on the card and meters rather than pretending to be a live
reading. That stale band does not trigger another warning.

The same derivation puts a notice into the context at each threshold, once at
80% and once at 90% per window, when the `engine.usageNotice` setting is on —
it is off unless you turn it on, and off, the model is told nothing: the
meters, the strip warning and the headless limit row stay yours alone. With
the setting on, at 80% the notice states the provider, percent, window
and reset, and that the provider stops work only when the window is used up.
At 90% it also advises keeping the work resumable: finish the step in hand,
commit what is done and write down where it stands. A spending limit near
(the Anthropic extra-usage state) rides the same notice. The model decides what to
do; no percentage, even 100%, holds work, stops a turn or offers a handoff.
Only a rejected request or a provider-stated reached window takes the wall's
normal road. A resumed
conversation remembers which thresholds it was told about. A source without
a percentage gets no window notice.

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
above the composer says so — `on the anthropic failover lane · Opus 5.5 · OpenAI
window resets 24 Sept, 8:15 pm · /model to return` — for two minutes after the
switch, and again for two minutes whenever the facts it states change: the
served model, the lane, the home window's stated reset changing or passing,
the way home opening. Then it clears, and the strip's model segment carries a
short amber mark beside the served model (`Opus 5.5 · failover`) for as long as
the session runs on the lane; the mark leaves when the session is back on its
home family. On a window too narrow for the whole sentence it is cut to what
fits, an ellipsis closing the cut, and keeps its `/model to return` tail.
`/model` returns home in one keystroke throughout.
`MERCURY_FAILOVER_LINE_MS` sets the sentence's window in milliseconds
(1000 or more; the default is two minutes).

Every meter surface — the vitals rail's USAGE panel, the frame
band, `/usage` and the health check's per-family usage rows — reads one owner and
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
minutes, is logged once per episode, and is written once to the health check's record
in the config home (`usage-reader.json`) with its recovery — `mercury health`
names it from another process. `/usage` and its retry key ask at once regardless.
An expired sign-in token is renewed by the read itself through the ordinary
refresh grant — the same road a reply takes — before the endpoint is asked, so
an idle session paints live numbers without sending a message; one grant per
read, never a loop, and a grant the sign-in server refuses is reported as an
expired sign-in (`/logins anthropic` signs in again).
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
that says allowed clears it at once. A reply speaks for the moment its request
began, so a reply that started before the refusal cannot clear it, however late
it ends; only a reply that began after the refusal does. An expired sign-in is reported as an
expired sign-in, never as a used-up window: the delegation refusal, the chat's
notice and the health check speak the one sign-in line (sign in again with
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
model list is never named as if it were the block. The OpenAI bands a reply's
headers stated are one record for every surface: a band stays a stated band
however old it grows, and the rail's rows, the frame's chips and the `/usage`
popup all paint it with its age ("stale ↻55m", "header-fed · stale · last read
55 min ago") — never "no usage read" on one screen beside a read on another.

`/usage` opens a popup over the chat — 150 columns, centred, three providers
side by side above 120 columns and stacked below it, six providers in view
and the rest on `↑↓` scroll with a "↓ n more" row naming them; `esc` or a
click outside closes it. It lists every provider, the signed-in ones first in
the order of their most recent sign-in — the same sign-in record the computed
default reads — and each in its own shape: the first-party subscription's
rolling windows and weekly pools, the OpenAI account's observed bands, a Kimi
sign-in's plan windows, a GLM Coding Plan key's credit windows, an OpenRouter
key's credit totals and cap, the DeepSeek and Moonshot balances, xAI's team
balance and billing-cycle usage with a management key, a Nous Portal key's
plan and usable credits when the Portal account endpoint resolves the key,
and an honest one-line
absence for a lane whose provider publishes no usage Mercury can read
(a general Z.AI key, Gemini, Hugging Face, Meta, a custom endpoint, an API key
on a subscription lane, a local server).
Every API-key slot carries a credits line: the provider-stated balance with
its feed and age where the family exposes one (the DeepSeek and Moonshot
balance endpoints, xAI's management-key balance, the Nous Portal account
endpoint's usable credits, the remaining credit under
an OpenRouter key cap), and
"credits: not reported by the provider" where none exists — never a computed
spend presented as a balance. The Claude subscription carries the same line
with its extra-usage figure as Anthropic states it ("credits: extra usage USD
12.40 of 50.00 this month", read from the usage endpoint together with the
windows and stamped with them), "extra usage off" while the account has it
turned off, and "not stated by the endpoint" when the answer carries no such
figure; an Anthropic API key — the Console sign-in mints one — still reads
"not reported by the provider", because Anthropic publishes no balance for a
key (the Console's billing page is the view, and the admin usage and cost
reports state spend, not a balance). Every figure is a reader's last
observation with its stamp, sampled in the popup through one door and dropped
the moment the credential it belongs to changes — never remembered, never
invented.

For xAI, the inference key identifies the team and the optional management
key reads its prepaid credits, usage for the current billing cycle, and its
postpaid invoice preview and spending limit where enabled. These are team
figures, not this session's spend; a postpaid cap does not cap prepaid usage.
A partial usage query is labelled partial, never mistaken for a reached
spending limit. With only the inference key, `/usage` says "add a management
key from the console's settings page to read usage — /logins xai". A refused
management key is named plainly, with the last successful read and its age
left visible. No management key is not an error.

A Google sign-in on the Gemini lane shows its credits line and an absence line
naming the view (the Cloud console Quotas page for the Generative Language
API, or Google AI Studio), because Google states no usage, quota or credit
figure to it: the Gemini API has no usage endpoint, its replies carry no quota
headers, and the Code Assist, Cloud Quotas and Cloud Monitoring roads refuse a
sign-in made with your own OAuth client.
A Hugging Face sign-in or token shows the plan the Hub states to it
(`whoami-v2`: PRO or free, whether a payment method is on file, when the
billing period ends) as its tier and a plan line with the read's age, sampled
through the same door as every reader, while the credits line says the credits
used and left are not stated to a token and the absence line names the billing
page.

A Kimi sign-in shows its Extra Usage balance in the stated currency beside its plan windows, or says when the managed-usage endpoint reports no balance.
OpenRouter OAuth-minted keys show the same remaining credit under the key cap as API keys, with the read's age and any refusal under the affected account. Below Mercury's $10 floor, `/usage` names the remaining amount and the credits page; an uncapped key has no balance notice. This is the key's remaining allowance, not the account balance.

The ChatGPT sign-in shows OpenAI's credit balance or unlimited credits beside its usage windows, with the last read's age, in `/usage`, the rail and its account row.

A window that reads reached — 100%, or a refused request — says what carries the requests from there, from the vendor's own statement: a Claude subscription on extra usage names its figure ("on extra usage · USD 12.40 of 50.00 this month") or says "extra usage off — nothing carries requests until the reset" with the reason Anthropic gives, a ChatGPT sign-in says "on credits · 62,500 left" or "no credits — nothing carries requests until the reset", a Kimi sign-in names its Extra Usage balance, and a family that states nothing about it says so in one clause; the words ride the rail's and `/deck`'s reached line, the `/usage` tab's reached sentence, the strip warning at 100%, the account-slot offer, the handoff notice, the refusal rows and blockers, and the health check's usage row.

A GLM Coding Plan key shows its windows the way a Kimi sign-in does: the
5-hour and weekly credit windows as used-percent bars with their resets, on
the rail's USAGE block and in `/usage`, read from Z.AI's own quota endpoint on
the coding base (the one the Z.AI console and Z.AI's own usage extension read; it
is not a documented API, so its shape is decoded by the window's unit and
length and the stated percent, and an answer Mercury cannot decode is a
labelled "no usage read" line, never a wrong meter). The read is asked the
way every plan read is — when a meter is shown, on a sign-in, on the
operator's retry, no more than once a minute and never on a clock. The key
goes in the Authorization header as Z.AI's own tooling sends it; a key the
endpoint refuses in that form is retried once as a bearer token and the form
that answered is kept for the next read. The plan tier the endpoint states
("GLM Coding Pro") is the block's tier line, and the monthly MCP tool-call
quota rides as one figure in `/usage`. A general Z.AI key has no usage road
and keeps its one line; a Coding Plan key whose account the endpoint says has
no plan reads "usage: not on a coding plan".

The cost ledger prices every request at its own provider's published rates
from one pricing owner per family: the first-party tier table; the GPT,
DeepSeek, Meta, Kimi, GLM and Gemini price tables (a longer-prompt tier applied per
request); the OpenRouter catalogue row when the wire states no cost of its
own; the Hugging Face listed floor as a flagged estimate; a recorded zero for
a local server. A turn on a model with no rate on file lands in the ledger
with its tokens counted and its cost unrecorded: it is counted as an unpriced
turn, never priced at zero, and every cost readout says so — a lane that
priced nothing reads "unpriced", and a figure that includes such turns says
"+ N unpriced turns" beside itself, on the `/usage` spend lines, the cost
summary at exit, and the deck and frame vitals alike. No family is ever
priced at another family's rates.

### JEV

JevEval is a second opinion from TypeSafe's Jev, not the model running the
chat. Bare `/jev` opens its card. `/jev on` selects the official road with
its own TypeSafe key; `/jev or on` selects the OpenRouter road using the
credential already connected through `/logins`. `/jev off` and `/jev or off`
turn JEV off. The card's Road row shows the selected road, and the JEV
switches in `/config` and the Boot face preserve that choice. A sign-in
never switches JEV on, and a missing key never falls through to the other
road.

Each road keeps its own session spend meter and allowance cap. `/clear`
starts a fresh chat with fresh meters; the stored caps stay unchanged.
The main model's default pace is 100 requests a minute. Crewmates receive
JevEval by default when JEV is on and its road has a key; the card's
Crewmates row turns that off by choice. They share 50 requests a minute
per session on each road, separately from the main pace, with a cap of 200
calls per crewmate. An explicitly stored main pace stays as the operator
set it.
OpenRouter's meter uses the response's `usage.cost` when stated, or the
published token rate when unstated. Its requests deny data collection and
provider fallback. The card and the tool result name the model that
answered, the stated cost and the generation id, or the refusal's own code
and words.

A JevEval call takes a list of evidence items — each a record of named
facts, a bare paragraph, a file or an inline table — and one question
set; every item is judged against every question in its own request, all
sent at once and each counted against the pace and the budget, and one
table comes back: rows the items, columns the questions, a row that no
answer reached saying so in place. A file item names a path the tool
reads under the same rules as Read (deny and ask rules, the working
directories): a table file — tsv, csv, a markdown pipe table or jsonl, by
its extension or a stated format — becomes one item per row with the
header's names as the facts' names, and a column named `id` (or the
stated id column) keys the row and is never sent; a text file is one item,
or one per paragraph when the format says so. An inline table
(`columns` and `rows`) does the same without a file, so a session never
pastes every row. The result names each file or table source after the
rows with its row count and bytes. The size rule is stated in the tool's
own words and never trims: files and tables add at most 100 rows to one
call and a file is at most 1,048,576 bytes; above either, or on a ragged
row, the call is refused naming the count or the line and nothing is
sent. A cell under the confidence floor (0.6; for a yes/no answer, a
probability from 0.4 through 0.6) opens with "unsure" and keeps its
numbers. The tool's prompt asks the model to put to Jev only what the
evidence in front of it answers: whether a run was killed from outside,
whether a capture starved, whether the output names a fixture fault — the
words settle those. Whether the product is wrong or the proof stale, and
whether a fold's intent changed a check, they do not; those need the proof
run on the tip and the source read.

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
that fits switches as before. A switch back to a model the conversation
already ran on re-sends the system prompt that model first saw, so the
thinking it left behind stays bound to its prefix; a working directory
added in between reached the model on its own row and never rewrites that
prompt.
