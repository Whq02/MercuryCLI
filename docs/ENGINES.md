# Engines: the provider estate

Mercury runs models across 20 sign-in provider families plus local servers
and custom endpoints, with per-family credentials, model lists, usage meters
and web tools.

One pure law decides
which family serves an id, one dispatch seam routes the call, and each family's runtime
owns its own wire, credentials, and refusals. Nothing ever falls through from one
provider to another.

## The routing law

One pure law owns model→provider recognition. Every family declares its id
space in one data table: a reserved qualified namespace (checked first so
reserved words can never be shadowed) and/or native bare spellings
(prefixes + class aliases). A new family is one data row, never a bespoke
arm.

| Family | Id space | Display name |
| --- | --- | --- |
| `anthropic` | `claude-*` ids (the mark anywhere in the id, gateway spellings included), the setting aliases (`opus` · `sonnet` · `haiku` · `fable` · `fable51` · `mythos` · `best`), the `ANTHROPIC_*` model env pins and `MERCURY_CUSTOM_MODEL_OPTION`; see [Dispatch](#dispatch) for unrecognised model ids | Anthropic |
| `openai` | `gpt-*`, alias `gpt` | OpenAI |
| `zai` | `glm-*`, alias `glm` | Z.AI |
| `moonshot` | `kimi-*`, `moonshot-*`, alias `kimi` | Moonshot |
| `deepseek` | `deepseek-*`, alias `deepseek` | DeepSeek |
| `xai` | `grok-*`, alias `grok` | xAI |
| `meta` | `muse-spark-*`, alias `muse` (other `muse-*` endpoints refuse here) | Meta |
| `gemini` | `gemini-*`, `google/<id>` (non-Gemini roster models on a Google sign-in), alias `gemini` | Gemini |
| `openai-compat` | `compat/<vendor-id>` (qualified; stripped before the wire) | Custom endpoint |
| `openrouter` | `openrouter/<vendor-slug>` (qualified; stripped because OpenRouter ids are vendor/model slugs, so the namespace disambiguates them) | OpenRouter |
| `orcarouter` | `orcarouter/<vendor>/<model>` or `orcarouter/<alias>`; named routers use `orcarouter/orcarouter/<name>` | OrcaRouter |
| `huggingface` | `huggingface/<org>/<model>[:provider\|:policy]` (qualified) | Hugging Face |
| `local` | `local/<model>` (qualified; the model as the discovered local server lists it) | Local models |
| `mistral` | `mistral-*`, `ministral-*`, `codestral-*`, alias `mistral` (the embedding, OCR, moderation and audio ids refuse here) | Mistral |
| `nous` | `nous/<vendor>/<model>` (qualified; stripped because the Portal's ids are vendor/model slugs, so the namespace disambiguates them; the `~vendor/<name>-latest` alias rows ride the same way) | Nous Portal |
| `zen` | `zen/<model-id>` (qualified; stripped before the request is sent because the gateway's own ids are bare vendor names such as `glm-5.3` or `gpt-5.5`, so the namespace tells a Zen row from the native family's) | OpenCode Zen |
| `minimax` | `minimax-*`, alias `minimax` (the text line, `MiniMax-M*`; the video, speech, music and image ids refuse here) | MiniMax |
| `together` | `together/<org>/<model>` (qualified; stripped because Together's ids are org/model slugs, so the namespace tells a Together row from a native family's) | Together AI |
| `cohere` | `command-*`, `north-*`, `c4ai-aya-*`, alias `cohere` (the embed, rerank and classify ids refuse here) | Cohere |
| `groq` | `groq/<model-id>` (qualified; text models only) | Groq |
| `melious` | `melious/<model-id>[:speed\|:price\|:eco]` (qualified; chat models) | Melious AI |
| `cerebras` | `cerebras/<model-id>` (qualified; text models only) | Cerebras |
| `fireworks` | `fireworks/<model-id>` (qualified; text models only) | Fireworks |
| `qwen` | `qwen-*`, `qwen3*`, `qwen2*`, `qwq-*`, `qvq-*`, alias `qwen` (QwenCloud and Alibaba Cloud Model Studio's own Qwen text models; the speech, image, video, embedding and rerank ids refuse here) | Qwen |

Display names have the same one-owner rule: every surface that names a
family derives its label from it, and an unknown id shows itself. Persisted
ids stay provider-qualified; the namespace detaches for the wire.

Across every provider, `/model`, `/logins` and `mercury://models` report the same selectable
live model count (while `mercury://models` also lists unavailable rows with
their reasons), and image, video, speech/TTS, audio and embedding models are
excluded from chat pickers and refused for chat turns.

Anthropic's rows are the built-in table (the names, prices, effort ladders
and capability facts Mercury knows for each generation) joined by the live
model list of every signed-in door. When `/model` or `/logins` opens, Mercury
reads the models endpoint once through each credential it holds (a claude.ai
sign-in with its bearer, an API key, an environment bearer token), never at
boot and never from a passive reader, and never without a credential or
while catalogue traffic is switched off. A listed id the table knows changes
nothing; an id the table does not know paints as one row under its raw id at
the end of its family's block, selectable, served with its family's newest
defaults (the cost as an estimate at that row's rates, its effort ladder,
its window, its launch effort, its wire laws) and with no invented display
name or knowledge cutoff. A new generation never folds onto an older one:
`claude-opus-5-7` keeps its own identity while a dated snapshot or a gateway
spelling of a known generation still reads as that generation. A row the
lists do not carry remains available (a list can be partial per door, and a
door whose list the endpoint refuses is that door's own catalogue error,
never a fault of the picker). The health check's Model lists row says what the
doors this process read serve and what they lack.

The family words follow each family's newest row (`opus` means Opus 5.5 and
`sonnet` means Sonnet 5.5), so a saved `sonnet` runs Sonnet 5.5 while a saved
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
first-party space (`claude-…`) starts from every door (the home screen's new
session, `/clear`, `--model`, a saved setting, the crew and workflow seats,
the advisor and console picks, the coordinator's assist model, and `/model` in
the chat) the moment the account holds an Anthropic credential, and the
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

`/logins xai` connects a Grok subscription sign-in (SuperGrok / X Premium) beside the API key, with the subscription selected by default; a subscription lists, chats and reads its included weekly pool on cli-chat-proxy.grok.com, while an API key stays on api.x.ai.

xAI's Grok rows follow the same road: with a Grok sign-in or xAI key present, Mercury reads
the account's model list when the picker composes its rows and paints the
Grok ids it names; the family word `grok` means the newest Grok row that list
serves (as `deepseek`, `kimi` and `glm` mean the newest row of their own
family's list), and while the list is unreachable the recorded rows stand in
with their date.

Meta's Muse Spark rows come only from the account's live `GET /v1/models`
list, newest creation time first, with the id breaking ties. Connect through
`/logins meta` (or `/logins muse`): the card’s first row is **Sign in with
Meta (a Muse Code subscription, a device code in your browser)**, and the
second is a pay-as-you-go Model API key (`/logins meta`, `MODEL_API_KEY`,
or `META_API_KEY`, which is accepted after `MODEL_API_KEY` and before the
stored key). Sign in with Meta requests a device code from
`https://auth.meta.com/oidc/device/authorization/` and polls
`https://auth.meta.com/oidc/device/token/` with `Accept: application/json` and
`x-api-version: 1.0.0` under Muse Code’s public client id (`1031625952748946`),
then sends the resulting account token once to
`POST https://api.meta.ai/muse-code/key` (`Authorization: Bearer <account token>`,
`x-api-version: 1.0.0`, `{ "onboard": true }`), which mints the subscription’s
API key (`api_key`) and states `user_email`, `subs_tier_name` and `subs_usage`
(`window` and `weekly` used percent and reset timestamps). The grant is stored
auth-scoped at mode 600 in `.meta-auth.json` beside the API key. Model requests
send only the minted key to `https://api.meta.ai/v1` and never send the account token.
When an account has no active plan, Meta answers `require_payment` with the
`action_url` / `require_payment_action_url` page to visit, and nothing is
stored as active. The latest sign-in action is the active source; `/logins` and
`/usage` name a stored source that is not active, and `↵` on its `/logins` row
makes it active without re-entering. A refused minted key (401/403) reports
`the Muse Code key was refused — /logins signs in with Meta again` and never
falls through silently to another source. `/accounts` manages both slots. The
family word `muse` selects the newest served Standard Muse Spark row. A
successful empty list stays empty; no unfetched row becomes selectable. A named
id can be sent with an honest notice when the list is unreachable, but an id
missing from a fetched list is refused before chat.

Contributor rows are labelled **training permitted** and must be selected
explicitly: neither `muse` nor the computed default silently opts an account
into training on its prompts and completions. Meta’s documented Spark 1.3,
1.2 and 1.1 rows have a 1,048,576-token context. Standard pricing is $1.25
input, $0.15 cached input and $4.25 output per million tokens; the 1.3 and 1.2
Contributor rows are $0.10, $0.002 and $0.20 respectively, with no long-context
premium. Unrecorded served ids keep their raw names and unknown prices.

Mercury uses Meta’s OpenAI-compatible Chat Completions endpoint at
`https://api.meta.ai/v1/chat/completions`, with streaming, function tools,
JSON-schema output and the model’s documented reasoning effort. `none` is
not supported; `max` is documented only for Standard Muse Spark 1.3. No
reasoning-off flag is sent. Meta also provides Responses and Messages APIs;
its Chat Completions API does **not** preserve private reasoning across
turns. Mercury’s Meta road therefore replays the conversation and tool
results without encrypted reasoning. Meta recommends Responses for reasoning
continuity in agentic work; that is not claimed by this road.

Sources: [quickstart](https://dev.meta.ai/docs/quickstart),
[models](https://dev.meta.ai/docs/models), [pricing](https://dev.meta.ai/docs/pricing-rate-limits),
[reasoning](https://dev.meta.ai/docs/reasoning), [authentication](https://dev.meta.ai/docs/authentication),
[Muse Code sign-in](https://dev.meta.ai/docs/muse-code/auth) and
[subscriptions](https://dev.meta.ai/docs/muse-code/subscriptions).

Mistral's rows come from the account's live `GET /v1/models` list, read
through the key: the recorded rows lead in their order (Mistral Large 4,
`mistral-large-4`, the public preview Mistral calls Le Chonk with a 1,048,576-token
context; Mistral Medium 3.5, `mistral-medium-3-5`; Mistral Small 4,
`mistral-small-2603`; Mistral Large 3, `mistral-large-2512`; the three
Ministral 3 sizes; and Codestral, `codestral-2508`), and any further chat row
the list serves follows by creation time. The vendor's aliases
(`mistral-medium-latest`, `mistral-small-latest`, `mistral-large-latest`,
which still names Large 3, `codestral-latest`) are listed ids too and
dispatch as the row they name. Connect through `/logins mistral`
or `MISTRAL_API_KEY`; keys are made at
[console.mistral.ai/api-keys](https://console.mistral.ai/api-keys), and the
key is proven on the model list and the identity endpoint before it is
stored. `/accounts` manages the stored key. The family word `mistral`
selects the first served recorded row. A successful empty list stays empty;
an id missing from a fetched list, a retired id or a non-chat id (embedding,
OCR, moderation, audio) is refused before chat like any unknown input.

Mercury uses Mistral's Chat Completions endpoint at
`https://api.mistral.ai/v1/chat/completions`, with streaming, function
tools, JSON-schema output and the vendor's reasoning dial: `reasoning_effort`
is `high` while thinking is on (the model's thinking arrives as a thinking
chunk inside the reply) and `none` while it is off; a row the vendor lists
without reasoning sends no effort word. An explicit output ceiling rides
`max_tokens`. Thinking is not replayed across turns on this road: Mercury
replays the conversation and tool results. Recorded list prices per million
tokens: Large 4 $1.36 input, $0.14 cached input, $4.18 output (the vendor's
two-week launch discount is not recorded); Medium 3.5 $1.50 and $7.50; Small 4
$0.15 and $0.60; Large 3 $0.50 and $1.50; Ministral 3 14B $0.20, 8B $0.15,
3B $0.10 each way; Codestral $0.30 and $0.90.

Mistral provides no OAuth to third-party clients: no client registration,
device flow or token endpoint is documented. Its open-source Vibe CLI signs in
through a browser door of the Vibe product that mints an API key; that door is
absent from the public API reference and Mistral's Commercial Terms of Service
forbid integrating Vibe into other products without written authorisation, so
Mercury does not use it. A standard key reads the account's identity
(`GET /v1/users/me`) and no usage, balance or credits endpoint; the plan's
included monthly usage is read in the console. The organisation meter
(month-to-date usage against the monthly spend limit and the rate limits) is
read through the Admin API with an optional **Admin API key** stored beside the
inference key (`/logins mistral` prompts for it after the key;
`MISTRAL_ADMIN_API_KEY`), which Mistral issues on Enterprise
plans at [backoffice.mistral.ai](https://backoffice.mistral.ai). Sources read
on **2026-10-09**: the public OpenAPI specification and the model cards in
[mistralai/platform-docs-public](https://github.com/mistralai/platform-docs-public),
[reasoning](https://docs.mistral.ai/studio/conversations/reasoning),
[the Admin API](https://docs.mistral.ai/admin/admin-api/overview) and its
[authentication](https://docs.mistral.ai/admin/admin-api/authentication) and
[usage metrics](https://docs.mistral.ai/admin/admin-api/usage-metrics),
[subscriptions](https://docs.mistral.ai/admin/billing-usage/subscriptions),
[the error glossary](https://docs.mistral.ai/resources/error-glossary),
[Vibe CLI API keys](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles) and
[mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe), and the
[Commercial Terms of Service](https://legal.mistral.ai/terms/commercial-terms-of-service).

Nous Research's Portal is a model gateway: one API key, billed to the
Portal credits or subscription behind it, serves a live catalogue of
third-party models (Claude, GPT, Gemini, DeepSeek, Qwen, Kimi, GLM, Grok and
more) at the Portal's own `vendor/model` slugs, plus `~vendor/<name>-latest`
rows that always point at the newest model of a family. Mercury persists
these ids as `nous/<vendor>/<model>`; the namespace detaches for the wire.
Connect through `/logins nous`: sign in with your Nous Portal account (a
browser approval, the device sign-in described below), or paste an API key
made at `portal.nousresearch.com` after adding credits or a subscription;
`NOUS_API_KEY` pins a key for a session, and `/accounts` shows and removes
the sign-in or the stored key. The rows come only
from the account's live `GET /v1/models` list: `/model` paints the Portal's
recommended agentic rows first, then the catalogue's own order, with a door
to the full list behind a filter; a typed `nous/<vendor>/<model>` id is
refused before chat when a fetched list lacks it. Each row's context window,
output ceiling, image input, tool support, reasoning dial and price are the
facts the live row states (never a first-party table joined by name), and a
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
endpoint answered and points at the Portal. The sign-in is the Portal's
OAuth device flow: Mercury asks
`POST https://portal.nousresearch.com/api/oauth/device/code` for a device
code, presenting the Portal client id that Nous's own Hermes agent presents
(`hermes-cli`, scope `inference:invoke`, read from
`hermes_cli/auth_constants.py` in the NousResearch/hermes-agent repository
at its release **0.22.2** as of **2026-10-17**; Mercury re-reads that file
once a day and presents a newer id or scope when it changes), you approve in
the browser at the address the Portal names, Mercury polls
`POST /api/oauth/token` with the device-code grant, keeps the tokens
auth-scoped and refreshes them with the refresh token, and requests then
carry that sign-in's access token. The API key is the other road, the one
the Portal's OpenAPI spec documents as "Option 1: Using API keys & account
credits" (read **2026-10-09**).
Sources: [the Portal OpenAPI spec](https://portal.nousresearch.com/api/openapi),
[the live model list](https://inference-api.nousresearch.com/v1/models) and
[the Hermes agent's auth constants](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_constants.py).

OpenCode Zen (opencode.ai) is a model gateway: one API key, pasted, reaches
every model the gateway lists, billed at the vendor's pay-as-you-go prices
from a prepaid balance. Sign in at [opencode.ai/auth](https://opencode.ai/auth),
add billing details, create a key, then `/logins zen` (or `/logins opencode`)
or `OPENCODE_API_KEY`. The key is checked on the gateway's
usage endpoint before it is stored, and a refused key is never stored. Zen has no
OAuth or device sign-in for a third-party client, and its keyless free tier
answers third-party clients with a typed refusal; Mercury does not present
itself as another client to reach it.

Zen rows are persisted as `zen/<model-id>` and come from the gateway's live
`GET /zen/v1/models` list, joined with Mercury's recorded pins (display name,
context window, output ceiling, prices, effort vocabulary, observed
**2026-10-09** from the vendor's [Zen page](https://opencode.ai/docs/zen/) and
its model metadata). The gateway serves each model in one fixed wire shape and
refuses another: this build carries its **chat-completions** shape (GLM, Kimi,
DeepSeek, MiniMax, Mistral Large 4, Qwen3.8 Max, Big Pickle and the free
models) and its **Responses** shape (GPT, Grok and Muse Spark rows); rows the
gateway serves only in its Anthropic Messages or Gemini shapes are not listed
on this road, and an id outside the list is refused like any other unlisted
id. A live-listed id without a pin rides the chat-completions shape under its
raw name. Free rows are labelled `(free)`.

The chat shape sends streaming with usage, function tools, the model's
documented `reasoning_effort` vocabulary (the thinking-off word where the
vocabulary carries one) and, for the models that document it, the
`thinking` toggle; Kimi's preserved-thinking rows return their historical
reasoning as Moonshot documents. The Responses shape sends `store: false`,
asks for encrypted reasoning and replays the recorded output items in order.
Every Zen request carries Mercury's own user agent and an `x-opencode-session`
header with the session id, which the vendor asks of clients for routing and
prompt caching. The gateway's errors are typed: a refused or exhausted key
(`AuthError`, `CreditsError`, `MonthlyLimitError`, `UserLimitError`) names the
console page to fix it; a Go-plan window reached (`GoUsageLimitError`) carries
its `retry-after`.

The meter: the session's spend at the recorded prices, and, for a key that
carries an **OpenCode Go** plan, the plan's 5-hour, weekly and monthly windows
from `GET /zen/go/v1/usage`. The pay-as-you-go balance is shown only in the
OpenCode console (the gateway states no balance to clients, and the opencode
client itself reads none); `/usage` says so instead of inventing a figure. The
Go plan bills only on its own base (`/zen/go/v1`), which this build does not
address (a Go key on the Zen base draws the balance).

MiniMax (platform.minimax.io) serves its M-series text models on an
OpenAI-compatible Chat Completions endpoint at
`https://api.minimax.io/v1/chat/completions`. Connect through `/logins minimax`
or `MINIMAX_API_KEY`; the key is a pay-as-you-go API key
from the Open Platform's key page or an M Plan Subscription Key from
`platform.minimax.io/console/plan` (the two are separate keys on the same base).
The key is checked on the account's `GET /v1/models` list before it is stored,
and a refused key is never stored. Rows are persisted under the vendor's own
ids (`MiniMax-M3`, `MiniMax-M2.7`), typed in any case; the bare word `minimax`
runs the newest text row the account lists. The list keeps the text line only:
the video (H3), speech, music and image ids never ride this road. Mercury's
recorded pins (display name, window, prices, thinking dial; observed
**2026-10-17** from the vendor's chat-completions reference and pricing pages)
stand in when the live list cannot be read, labelled as pins.

Every MiniMax request sends `reasoning_split: true` so thinking arrives in
`reasoning_content` instead of `<think>` tags in the text, and asks for usage
on the final chunk; historical reasoning returns with the assistant turn, as
the vendor's tool-calling guide asks. The thinking dial follows the model:
`MiniMax-M3.1-Flash-Preview` (M Plan only) tunes depth through
`reasoning_effort` (`low` · `medium` · `high` · `xhigh` · `max`, default
`max`) and cannot stop thinking, so thinking-off sends `low` and `none` is
never sent (the vendor answers it with HTTP 400); `MiniMax-M3` takes the
`thinking` toggle (`adaptive` on, `disabled` off); the M2.x rows always think
and take no dial. An explicit output ceiling rides `max_completion_tokens`.
The vendor's own status codes (`1004`/`2049` key, `1008` balance, `1002`/`2056`
rate and usage limits) are read wherever they arrive, on the HTTP status or in
the `base_resp` envelope of a 200 body, and typed as the refusal they name.

The meter: the session's spend at the recorded prices (the >512K-token tier of
`MiniMax-M3` priced at its own rate), and, for an M Plan key, the plan's 5-hour
and weekly windows per model from `GET /v1/token_plan/remains`. The
pay-as-you-go balance is shown only on the platform (the API states none);
`/usage` says so instead of inventing a figure.

Together AI (together.ai) is a serverless gateway: one API key, billed from a
prepaid balance at each model's price, serves a live catalogue of open-weights
models (Kimi, GLM, DeepSeek, Qwen, MiniMax, Muse, GPT-OSS and more) at the
gateway's `org/model` slugs. Mercury persists these ids as
`together/<org>/<model>`; the namespace detaches for the wire. Connect through
`/logins together`, `TOGETHER_API_KEY` or
`TOGETHER_AI_API_KEY`; the key is made at the project's API-keys page and
checked on the account's `GET /v1/models` list before it is stored. Only the
list's chat rows are offered (its image, video, audio and moderation rows are
set aside and refused for chat); a typed `together/<org>/<model>` id is refused
before chat when a fetched list lacks it, and the recorded pins (display name,
window, prices; observed **2026-10-17** from the vendor's serverless-models
page) stand in, labelled as pins, when the list cannot be read. The free
`Prism-ML/Ternary-Bonsai-27B` row is labelled `(free)`.

Mercury uses the gateway's Chat Completions endpoint at
`https://api.together.ai/v1/chat/completions` with streaming and usage,
function tools, a `prompt_cache_key` carrying the session id (the vendor's
routing-stickiness knob for its prefix cache) and the model's documented
reasoning knobs: the hybrid rows (Kimi K3, GLM 5.2/5.3, DeepSeek V4 Pro,
MiniMax M3, Qwen 3.6 Plus) take `reasoning: { enabled }` from the session's
thinking switch; `openai/gpt-oss-120b` takes `reasoning_effort` (`low` ·
`medium` · `high`) and DeepSeek V4 Pro `high` · `max`, the lowest rung standing
in for thinking-off where the model cannot stop. The gateway streams reasoning
as `reasoning` or `reasoning_content` and cached tokens flat or nested; both
spellings decode. The meter is the session's spend at the recorded prices; the
balance lives at `api.together.ai/settings/billing` (the billing-usage API is
a beta the vendor enables per organisation, which this build does not read).

Cohere (cohere.com) serves its Command, North and Aya chat models on an
OpenAI-compatible endpoint at
`https://api.cohere.ai/compatibility/v1/chat/completions`. Connect through
`/logins cohere`, `COHERE_API_KEY` or `CO_API_KEY`; the
key is made at `dashboard.cohere.com/api-keys` (a trial key is free,
rate-limited and for evaluation; a production key bills pay-as-you-go) and
checked on the account's `GET /compatibility/v1/models` list before it is
stored. The bare word `cohere` runs the newest row the account lists; the
embed, rerank and classify ids refuse here. The recorded pins (display name,
window, output ceiling, prices where the vendor states them; observed
**2026-10-17** from the vendor's models and pricing pages) stand in, labelled
as pins, when the list cannot be read.

The wire is Mistral's near-twin: streaming, function tools, `max_tokens` on an
explicit ceiling, structured output as `response_format: { type:
'json_object', schema }`, and on the reasoning rows (Command A+, North Mini
Code, Command A Reasoning) a two-word `reasoning_effort` dial: `high` with
thinking on, `none` with it off, because the compatibility endpoint accepts
no other value (`low` and `medium` answer HTTP 400). `parallel_tool_calls`
is never sent (the vendor lists it unsupported). The meter is the session's
spend at the recorded prices; a standard key reads no usage endpoint, and the
dashboard shows the account's spend.

OrcaRouter connects through `/logins orcarouter` with device-code sign-in
or an API key from [the console](https://www.orcarouter.ai/console/token).
`ORCAROUTER_API_KEY` takes precedence over the stored key. If sign-in cannot
start, paste an API key instead. Requests use
`https://api.orcarouter.ai/v1/chat/completions` and bill OrcaRouter credits.
The [live catalogue](https://docs.orcarouter.ai/getting-started/models) supplies
model ids, context windows and output limits; published catalogue prices
apply when a response carries no call cost. `/usage` shows session spend,
total usage and the key's credit allowance.

Models use `orcarouter/<vendor>/<model>`, for example
`orcarouter/openai/gpt-4o-mini`. Choose `orcarouter/orcarouter/auto` or a
[named router](https://docs.orcarouter.ai/routing/named-routers) to use the
routing policy configured in the OrcaRouter console. Model suffixes such
as `-high` and `-free` stay intact. Chat streams text, tool calls, reasoning
and usage through the shared OpenAI-compatible transport. Explicit
[reasoning effort](https://docs.orcarouter.ai/advanced/reasoning) is sent
unchanged; accepted levels depend on the model. A conversation cache key
keeps related turns together for
[session affinity](https://docs.orcarouter.ai/routing/session-affinity).
[Call costs](https://docs.orcarouter.ai/operations/per-request-cost) returned
in the final usage chunk take precedence over catalogue token rates.

Groq connects through `/logins groq` or `GROQ_API_KEY`, with keys from
[console.groq.com/keys](https://console.groq.com/keys). Its live text models
use qualified ids such as `groq/openai/gpt-oss-120b`; speech and moderation
rows stay out of the picker. If the list cannot be read, dated pins are
labelled as such. Chat streams text, reasoning, tool calls and token usage
through Groq's OpenAI-compatible endpoint. Reasoning uses each model's
documented format and highest supported effort when max is selected.
`/usage` shows session spend and observed rate limits; account spend and
monthly limits live in the Groq console. Free-tier token limits can be too
small for tool-bearing turns; the Developer tier has higher limits.
Sources read **2026-10-18**: [API reference](https://console.groq.com/docs/api-reference),
[models](https://console.groq.com/docs/models), [reasoning](https://console.groq.com/docs/reasoning),
[rate limits](https://console.groq.com/docs/rate-limits) and
[spend limits](https://console.groq.com/docs/spend-limits).

Melious AI connects through `/logins melious` or `MELIOUS_API_KEY`, with keys
from [melious.ai/account/api/keys](https://melious.ai/account/api/keys).
Give the key `inference.models` and `inference.chat` scopes. `/model` lists
the account's chat models as `melious/<model-id>`, including `:speed`,
`:price` and `:eco` routing variants. Text, reasoning, tool calls and token
usage stream through [Chat Completions](https://melious.ai/docs/reference/chat-completions).
Reasoning effort, including max, is sent to Melious unchanged. The provider
serves open-weight models on European infrastructure.

[Catalogue prices](https://melious.ai/docs/reference/models) are the lowest
available input and output rates in EUR. `/usage` shows token counts, request
limits and the last request's EUR cost and payment source. Account spend
is at [melious.ai/account/usage](https://melious.ai/account/usage).

Cerebras connects through `/logins cerebras` or `CEREBRAS_API_KEY`, with
keys from [cloud.cerebras.ai](https://cloud.cerebras.ai). Its live text
models use qualified ids such as `cerebras/gpt-oss-120b`; dated pins are
labelled when the list cannot be read. Requests carry the model's documented
reasoning effort and a stable conversation cache key. No output ceiling is
sent, so the server's model limit applies without reserving a large token
estimate before the turn runs. Cached input has the same price as fresh
input. `/usage` counts session tokens and spend and reports observed retry
waits; account credits and limits are shown in the cloud console. Trial
and paid accounts have different context and rate limits. Sources read
**2026-10-18**: [API reference](https://inference-docs.cerebras.ai/api-reference/chat-completions),
[models](https://inference-docs.cerebras.ai/models/overview),
[reasoning](https://inference-docs.cerebras.ai/capabilities/reasoning),
[prompt caching](https://inference-docs.cerebras.ai/capabilities/prompt-caching),
[rate limits](https://inference-docs.cerebras.ai/support/rate-limits) and
[errors](https://inference-docs.cerebras.ai/support/error).

Fireworks AI connects through `/logins fireworks` or `FIREWORKS_API_KEY`,
with keys from [app.fireworks.ai/api-keys](https://app.fireworks.ai/api-keys).
The live text catalogue uses qualified resource ids; `fireworks/kimi-k3`
also names `fireworks/accounts/fireworks/models/kimi-k3`, while
`fireworks/kimi-fast-latest` names the Fire Pass router. Dated pins are
labelled when the catalogue is unavailable. Requests carry top-level
reasoning effort, tool calls and a stable session-affinity header for prompt
caching. `/usage` shows session spend and the three reported TPM limits;
account credits and costs are shown in the Fireworks console. Sources read
**2026-10-18**: [API reference](https://docs.fireworks.ai/api-reference/post-chatcompletions),
[reasoning](https://docs.fireworks.ai/guides/reasoning),
[prompt caching](https://docs.fireworks.ai/guides/prompt-caching),
[serverless pricing](https://docs.fireworks.ai/serverless/pricing),
[rate limits](https://docs.fireworks.ai/serverless/rate-limits) and
[Fire Pass](https://docs.fireworks.ai/firepass).

Qwen connects through `/logins qwen` or `DASHSCOPE_API_KEY` with a QwenCloud
API key from qwencloud.com (API Keys) or a Model Studio API key from the Alibaba
Cloud Model Studio console for the account's region: a Model Studio
pay-as-you-go or Token Plan key (`sk-…`), a QwenCloud pay-as-you-go key
(`sk-…`), a QwenCloud Token Plan key (`sk-sp-…`), or a Model Studio Coding Plan
key (`sk-sp-…`). Each key answers only the region and plan it was minted in. A
key beginning `sk-sp-` probes the QwenCloud Token Plan endpoint
(`token-plan.maas.qwencloudapi.com/compatible-mode/v1`) first by its model
list, which authenticates the key, and then the two Model Studio Coding Plan
endpoints (international, then China), whose model lists answer every caller
and therefore authenticate the key with one chat call of one token on the first
listed model. Any other key is probed on the endpoints whose model list
authenticates it, in turn (International (Singapore), China (Beijing), China
(Hong Kong), QwenCloud pay-as-you-go at
`maas.qwencloudapi.com/compatible-mode/v1`, and the Model Studio Token Plan in
Singapore and Beijing), and bound to the first that accepts it; the endpoint is
stored beside the key. A key no endpoint accepts is refused with the endpoints,
both consoles and the service's words named, and nothing is stored.
`DASHSCOPE_BASE_URL` names an endpoint instead of the probe (a
workspace-dedicated domain such as
`https://<workspace>.us-east-1.maas.aliyuncs.com/compatible-mode/v1`), and
`DASHSCOPE_WORKSPACE_ID` adds the six workspace-dedicated domains to the probe.
On a pay-as-you-go endpoint the picker lists the text models the endpoint
serves live together with the dated pins this build knows (Qwen3.8 Max,
Qwen3.7 Max, Qwen3.7 Plus, Qwen3.8 Flash, Qwen3.8 Omni Flash, Qwen3.7 Flash,
Qwen3.6 Flash and Qwen3 Coder Flash, with their context windows and prices): a
live row wins on a shared id, a pinned id the list does not name still shows
from the pin and is sent for the bound endpoint's console to decide, and the pins alone stand,
labelled as pins, when the list cannot be read. On the QwenCloud Token Plan
endpoint the picker unites the live Qwen text rows with the plan's documented
pins (Qwen3.8 Max first, Qwen3.7 Max, Qwen3.7 Plus, Qwen3.8 Flash, Qwen3.6
Flash and the plan's Auto row, `qwen-auto`, sent as `auto`) while setting the
gateway's non-Qwen and non-text rows aside. On a Model Studio Coding Plan
endpoint the rows are those six plan pins alone, because that endpoint's model
list answers every caller and is not the plan's list; on both plans the account
and `/usage` rows name the plan. The family word `qwen` runs Qwen3.8 Max
wherever it is a row. Requests carry Qwen's own `enable_thinking` switch and
`preserve_thinking` on the rows that take them, the effort dial as
`reasoning_effort` in Qwen's vocabulary (`low`, `medium`, `xhigh`) on the Qwen3.8
rows that document it, a stated `models.<id>.thinkingBudget` as `thinking_budget`
in place of the effort word, the system prompt in `messages[0]` alone, and tool
calls on the shared wire. A 401 from the bound endpoint names the region and the
re-bind road. `/usage` shows session spend; neither console exposes a usage or
balance endpoint an API key can read, so the account's balance and plan windows
are shown in the QwenCloud or Model Studio console. Sources read **2026-10-18**:
[regions and endpoints](https://www.alibabacloud.com/help/en/model-studio/regions),
[Chat Completions](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions),
[deep thinking](https://www.alibabacloud.com/help/en/model-studio/deep-thinking),
[models](https://www.alibabacloud.com/help/en/model-studio/getting-started/models),
[text generation models](https://www.alibabacloud.com/help/en/model-studio/text-generation-model)
and [error codes](https://www.alibabacloud.com/help/en/model-studio/error-code).

Moonshot's default, picker and specialist choices follow the account's live
model list. An API key reads the platform list; a Kimi sign-in reads its
region's coding list with the same credential used for chat. The newest
creation time leads, with provider order preserved when times are absent
or equal. A successful empty list shows no row. With no fetched list,
the recorded rows stand in with their observation date. An id missing from
a fetched list is refused before chat, with the account label and available
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
the account's model list (`GET /models` on the base the key is valid on: a
GLM Coding Plan key reads `https://api.z.ai/api/coding/paas/v4`, and a general
key reads `https://api.z.ai/api/paas/v4`) when the picker composes its rows,
and paints the GLM ids it names, newest first. A key stored through `/logins
zai` carries the plan it was proven under; a key given as `ZAI_API_KEY` (or by
a key command) rides the plan `ZAI_KEY_PLAN` names (`coding` or `general`),
and with it unset Mercury reads the plan from the key's own models list once
per process (the general base first, then the Coding Plan base), so a GLM
Coding Plan key in the environment reaches the Coding Plan base. The list
states ids only; each row's window and reasoning dial are the facts
docs.z.ai states for that id (read 2026-10-05): `glm-5.3`, `glm-5.3-flash`
and `glm-5.3-flashx` have a 1M-token window, a 128K output ceiling and the
dial `low` · `high` · `max` with thinking always on; `glm-5.2` has the 1M
window and the seven-level dial; older ids keep their documented windows
and have no dial. An id the docs do not name paints under its raw name
with no window and no dial. The family word `glm` means the newest row the
list serves. While no list has landed, the recorded rows (`glm-5.3`,
`glm-5.3-flash`, `glm-5.2`) stand in with their date; a model the list no
longer carries leaves the group. On the Coding Plan, Z.AI serves `glm-5.3`
and `glm-5.3-flash` under their own names and answers an older id with one
of those two; a model the plan does not include is refused with Z.AI's own
reason after the status, as every chat refusal is.

A retired DeepSeek id resolves to its current one wherever a model id is
read (a saved setting, `MERCURY_MODEL`, `/model`, or a crewmate's model)
and paints as the current id: `deepseek-v4-flash` is `deepseek-flash`, and
the wire is sent the current id.

## Dispatch

Every call dispatches on the resolved route to that family's own runtime;
the default arm is the Anthropic path. Any model id that does not match a known
provider prefix is refused before Mercury makes a network request (including any
id containing `/` on the first-party endpoint), naming the id and the declared
provider families, unless you explicitly pinned that id with an `ANTHROPIC_*`
model variable or set `ANTHROPIC_BASE_URL` to a custom gateway.

## The runtimes

Three wire families serve the providers:

- **The Anthropic home lane**: the first-party API, directly or through a
  base-URL proxy.
- **Native wires**: Z.AI, OpenAI through its Responses API, and Gemini
  through `streamGenerateContent` (used by Sign in with Google, your own OAuth
  client, and Gemini API keys under `x-goog-api-key`, preserving signed
  `thought_signature` parts across tool rounds on every Gemini credential).
- **The OpenAI-compatible chat wire**: Moonshot/Kimi, DeepSeek, xAI's Grok
  models, Meta, Mistral, Nous Portal, OpenCode Zen (chat-completions rows),
  MiniMax, Together AI, Cohere, Groq, Melious AI, Cerebras, Fireworks AI, Qwen,
  custom `compat/` endpoints, OpenRouter,
  Hugging Face (the Hub router, Hub slugs with an optional backend suffix),
  and local servers.

Whichever wire a session runs on, a turn behaves the same way: text and
tool calls stream as they arrive; the final usage and stop reason are
recorded; a provider fault never crashes the turn (a terminal fault lands
as an API-error message in the chat, cancellation returns clean, and a
retryable fault before any content is retried once); every request's usage
joins the one session cost ledger. A refusal that says the provider is busy
(an HTTP 503, the Anthropic wire's HTTP 529 or `overloaded_error`, inside a
stream too, Google's UNAVAILABLE, OpenAI's overloaded model, DeepSeek's
overloaded server, OpenRouter's no available provider, Z.AI's code 1305, or a
vendor's own overloaded or unavailable word) is retried on a growing
wait on every road (1 s, 2 s, 4 s, 8 s, 16 s and 30 s, about a minute in
all) before the chat gives up: nothing is painted for the first thirty
seconds, then the retry line shows the true wait and the true count, and the
red error line comes only once the whole ladder is spent, saying how many
retries it took and how long (on the Anthropic wire it carries the
provider's own answer; with an API key and an Opus model, a spent ladder
ends the turn with the repeated-overload line, or switches to the fallback
model when one was named at launch). A rate limit that names its own wait
(`Retry-After`) rides the same ladder with that wait in place of the rung; a
rate limit without one keeps the single retry. A reply that arrives inside
the ladder shows one calm grey line above it, naming the provider
(`OpenAI was busy · answered after 2 retries (7 s)`), whose `ctrl+o` expansion
carries the provider's words and every wait; the debug log carries every
retry either way. Escape ends a wait at once. A stream the provider cuts
after some of the reply has arrived is continued once: Mercury asks the model
to pick up where it stopped, the reply so far stands, and the chat shows one
quiet line,
`Continued after 1 stream cut · context sent again`, whose expansion names
the road, what the provider sent and the code. The cost is in those last
three words: the continuation sends the turn's context again (on a
subscription that is usage-window consumption, on an API key it is input
tokens, and prompt cache hits reduce it). A second cut in the same turn is
not continued; it is recorded as a failure. On the OpenAI
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
content or prose (a Write's content, an Edit's new text, an Eval cell)
stays as typed, and every other wire carries every byte as typed.
When a GPT-family model returns a refusal (including an OpenAI content-filter
finish) or a synthetic error row, the refusal is shown to you once in the chat
and omitted from subsequent request histories (after applying any image-refusal
resize stamps), while user prompts and executed tool-call/result pairs stay
paired.

A dispatched crewmate whose turn ends on the provider's overload (the busy
refusal above on any road, such as the Anthropic wire's 529 or `overloaded_error` or
another provider's spent busy ladder, with no wait stated) does not
fail: it pauses, its row says why (`paused — provider overloaded ·
resumes by itself when the provider answers`), its work so far is kept, and
Mercury probes the provider with one small request at a slow, bounded
cadence (30 s after the pause, then every minute for ten minutes, then
every five minutes, for up to one hour) and resumes the crewmate automatically
when a probe is answered; the crewmate continues from where its transcript
ends. The parent's chat carries one calm line per crewmate per outage (the
first pause names the provider and the probing; a later stop and the
resume itself add no line, as the crewmate's row on the Crew view shows them),
and the crewmate's completion follows as its own line; a message to the crewmate
resumes it sooner, and the Crew view stops it. The line names the status
the provider answered with (529 on the Anthropic wire, 503 elsewhere, or none
when the refusal carried none). A crewmate the parent waited
on inline takes the same road, and so does one handed to the background
mid-turn: its result to the parent leads with the
pause, the probing brings it back in the background, and its completion
follows as a notification. If the
outage outlasts the probing, the row marks the run failed and sending a message
resumes it.

A session's side jobs (the chat's title, the away summary, the tool-use
summaries, the state read, the feedback card, a question hook's default model,
the date parser and the fetch tool's summary) ride the session's own family
on its helper tier. On the Anthropic lane that is the small family default
(`MERCURY_SMALL_FAST_MODEL` pins it). On a GPT session it is the cheapest
text model the account's live list serves, by the prices the GPT table
records (a mini or nano row when the list serves one); no id the list lacks
is ever asked for, and while the list has not answered, or serves no priced
row, the side job runs on the session's own model. A crewmate hook's tier
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
token, the tools weighed as the request carries them, with the non-deferred
schemas in full and the rest by name; anything closer is sent, and the server's
own refusal is the truth). The window a local
model is served with is a setting inside Mercury (`/config` → Local model
window, per model): `auto` (unset) chooses the biggest of 32k · 64k · 128k ·
256k, never above the trained maximum, whose projected load (the weights plus
the KV cache of the layers that keep one; a hybrid such as Qwen 3.5/3.8
states `full_attention_interval` in its own metadata so one layer in four
counts, at the server's cache type and slots, from the model's own
geometry; once the model is loaded, the size `/api/ps` measures at its
window outranks that formula) fits the memory usable for models (the
server's own gpu-memory line when it states one, the same rule
`/localsetup`'s step 5 uses) at the
model's first send and holds it for the session on every dispatch (the main
thread, crewmates and workflow crewmates alike, so a crewmate never reloads the
runner; when the machine's memory cannot be read because the server states no
geometry or the read fails, the window comes out larger: the
trained maximum when the model states one, else the served window, else twice
the first request rounded up to 16k and never under 64k, and the words say so);
the rail's ctx row names the reason (`max` · `fit` · `set` · `srv`) and the
deck's ctx row carries the figures; `server default` leaves the choice to the
server (Ollama loads the model and `/api/ps` states the figure); `32k` · `64k`
· `128k` · `trained max` or a number pin it (a pinned rung whose load does not
fit the available memory says so on the row, names the largest rung that does, and
is still saved). On Ollama the chosen window rides as `options.num_ctx` on every request
over the native `/api/chat` stream (with `truncate: false`, so an over-window
prompt is refused by the server instead of truncated), and every request the
session sends that model (the chat, the pre-warm, the keep-alive touch, the
served-window load and every crewmate or workflow seat) carries the same
`num_ctx` and `num_batch`, so the scheduler keeps one runner and its prompt
cache for the whole session; a runner the server already holds at a window
that fits the turn and is no smaller than the session's own choice is adopted
without reloading (under `auto` and `server default`; a window you set is
honoured, and a smaller stale runner is reloaded once, up to the full window),
and the row names it as the server's; LM Studio takes it
when the model is loaded (`POST /api/v1/models/load {model, context_length}`);
vLLM and llama.cpp fix their window at server start, so the row shows the
served figure and reads as not applicable. When no local server answers,
`/localsetup` sets one up inside Mercury: it finds or installs Ollama, starts
it, asks which model to use, pulls the chosen model if needed, sets its window
from your machine's memory and checks a reply, each step asking before it runs
([LOCAL-SETUP.md](LOCAL-SETUP.md)). The lane is verified
against a live Ollama for discovery, streamed text, streamed reasoning and
multi-round tool loops, and against a live llama.cpp (2026-09-27, Qwen3.5 9B
served as `qwen3.5:9b`, server build b11146) for the same three legs
(discovery with the served window read from `/props`, a streamed reply with
its reasoning block, and a tool loop that also dispatched a crewmate and a
workflow crewmate on the model); and against a live LM Studio (2026-09-27, Qwen3.5
9B served as `qwen3.5-9b`) for the same legs (discovery from `/api/v1/models`
with the loaded instance's window, a streamed reply with its reasoning block,
a direct tool loop, a crewmate and a workflow crewmate), where the product
reloads the instance at its chosen window on the first send (the documented
load road) unless the window setting is `server default`. vLLM has not been
checked against a live server yet. The Hugging Face lane carries an explicit deferred-live caveat
in its readiness detail until verified against a live endpoint.

On the local lane no watchdog cuts a request while the server answers. The
first-byte budget there is an estimate the status row shows:
it is sized from the model's measured ingestion pace (the uncached prompt
tokens the wire reports over the time to the first byte, remembered per
model in `local-ingest-pace.json` under the config home) with a quarter's
margin; before a measurement, a default by parameter count (300 tokens/s up
to 10B, 100 up to 35B, 40 above, 100 when the server states no size). When
the estimate runs out, Mercury asks the server a liveness question
(Ollama `/api/version`, LM Studio `/api/v1/models`, llama.cpp `/health`,
vLLM `/v1/models`): an answer extends the estimate and the row says so
(`still ingesting … — about 3m 23s more (its server answered at 6m 46s)`);
two unanswered probes in a row cut the request with the dead-server words
(`no answer from Ollama at 127.0.0.1:11434 for 10 s while ingesting — the
local server is not responding (its window, its load, or a crash); /model
re-probes`), and that cut is never reissued. After the first byte the idle
watchdog follows the same law at the patience setting's quiet number (15
minutes, the OpenAI road's): the row warns at the warning point (`no bytes
for 7m 30s — <model>'s server is asked at 15m`), the server is asked at the
idle number, and the turn holds while it answers (`no bytes for 15m —
<model>'s server still answers`; `Esc` interrupts). While the server is still
loading the model the row says `loading <model> (<size> GB)`, and the
ingestion clock starts once the server lists it. The hard cap on a local
request is two hours. Ollama's native `/api/chat` road rides the same law as
the `/v1` road, and hands its fetch a dispatcher whose HTTP headers and body
budgets are raised to that cap, so nothing beneath the law cuts first (the
shared API dispatcher's 600 s headers budget once ended a long ingest with
`UND_ERR_HEADERS_TIMEOUT` and a re-ingest). On that road a turn whose every
row was thinking (no reply and no tool call) settles with
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
silently fall through to another provider; each runtime returns typed refusals:

- a lane whose credential does not resolve refuses with text that names the attach
  route (where to sign in or store a key), never a generic error;
- a tool-bearing request on a model whose catalogue states it cannot take tools is
  refused pre-flight with a typed reason instead of a broken turn; a local model whose
  server declares no tool support takes its tools through the prompt instead: the
  catalogue rendered into the system text as JSON, calls written as `<tool_call>`
  blocks holding `{"name", "arguments"}` and read back by the local lane's markup
  readers, results returned as `<tool_result>` blocks. A model with native tool
  calling is sent them on the wire as before;
- an undiscovered `local/<id>` refuses with the probe route and the pull (`ollama
  pull <id>` when an Ollama server answers) instead of guessing a port; a
  request larger than a local model's stated served window refuses before the
  send, naming the window, its source and the in-app road that raises it, since
  the server would silently truncate it;
- sub-model containers surface the owning catalogue's refusal reasons verbatim.

One vocabulary decides what may run where, and what a picker shows is what
dispatch allows. The
**session** arm is pure product capability: a session dispatches on every family
the account holds a credential for, every tier included; a family with no
credential refuses typed (`no-credential:<family>`) with the one action that fixes
it riding the refusal, except the account-less local family, whose miss is a stopped
server (`unreachable:local` with the probe
route). The **crew** arm carries the same verdict row for row: a crewmate is
the same product child a session runs, so every row a session may run, a crew
seat may run. Every refusal names its class and
carries one machine-readable action line so the coordinator or you can see the
exact fix.

## Auth

Run `/accounts` to see every connected account and API key across all providers:

- **anthropic**: the account scope ring plus the API-key ladder, source-honest;
- **openai**: the subscription store and the stored key, both shown when both exist;
- **gemini**: Sign in with Google (your plan's quota), an API key, or your
  own OAuth client. Sign in with Google runs Gemini on the plan of the Google
  account you pick (a free account, Google AI Pro, Google AI Ultra, or a
  Gemini Code Assist licence) the way Google's own Antigravity client does:
  Mercury presents Google's Antigravity OAuth client (its public installed-app
  client id and secret, the five scopes cloud-platform, userinfo.email,
  userinfo.profile, cclog and experimentsandconfigs, offline access, the
  consent prompt) on a loopback callback at 127.0.0.1:51121/oauth-callback with
  PKCE; after the exchange it reads the account's e-mail, asks Google's Code
  Assist endpoint (daily-cloudcode-pa.googleapis.com, its sandbox host as the
  failover) for the tier and the project (`loadCodeAssist`; a free account is
  provisioned once with `onboardUser`, a bounded operation), and stores the
  grant auth-scoped (mode 600) beside the other sources. The models `/model`
  lists on that sign-in are the roster Google serves the account
  (`fetchAvailableModels`): every chat model it names and nothing else,
  with the roster's own display name, context window, output ceiling,
  thinking and image flags; the image models stay out of chat. A Gemini id
  keeps its bare spelling; a model of another vendor on the roster (Claude,
  GPT-OSS, …) is listed as `google/<id>` (Google's own id behind the
  prefix) so it rides this Google sign-in and never shadows that vendor's
  own lane (`/model claude-…` stays the Anthropic lane). A roster row whose
  id ends in `-disabled` is a model Antigravity withholds from the plan:
  Google's own plan table (antigravity.google/docs/models, read
  2026-10-14) lists Gemini 4 Argon as not available on Free, Google AI Plus
  and Google AI Pro and available on Google AI Ultra and Enterprise, a
  Google AI Pro roster served `gemini-4-argon-disabled` ("Gemini 4 Argon",
  no quota) and no other Argon row, and that id sent verbatim under the
  then-current client version (2.23.0, the newest the update manifest
  published on 2026-10-14) answered 404 "Requested entity was not found." (the gate is the plan,
  and the public Antigravity client has no override). Such a row is listed under the Google sign-in with its
  state (`"withheld from Google AI Pro today — Google's roster names it …
  and answers 404 to the id; antigravity.google/docs/models says which plans
  include it; not offered as runnable"`) and is not selectable; a bare id
  with no served row answers Google's 404, and the refusal names the
  roster's kin: the `-disabled` row with that state, or the effort siblings
  Google serves instead (`…-low`, `…-medium`, `…-high`, selectable in `/model`).
  When the roster names only effort rows for a model, the bare id
  rides the row of the session's effort the way Google's own client's
  collapse table routes it (low → `-low`, medium → `-medium`, high, max,
  xhigh or no effort → `-high`, a missing tier taking the nearest present)
  and the status row says the ride (`gemini-4-argon ▸ gemini-4-argon-high`);
  a crewmate named onto the bare id takes the high row. The roster is never
  read only at sign-in: before a chat it is re-read when older than five
  minutes (a bounded wait, the chat proceeds on the cached roster after two
  seconds), and a bare id's 404 forces one re-read (a row that appeared
  meanwhile is taken and the chat retried once, else the 404 words carry the
  kin; never a loop). An INVALID_ARGUMENT Google gives without detail
  ("Request contains an invalid argument."), whether in flight or as an HTTP
  400 after the server worked on the request, is retried once with the same
  shape and once more with plain function calling (AUTO in place of
  VALIDATED); the words that end the turn say where it came from ("HTTP 400
  after 15 s, before any answer byte" or "in flight at 15 s") and which
  attempts ran; a 400 with detail is never retried and carries Google's
  words. `MERCURY_GEMINI_WIRE_DUMP=<file>` makes the wire append every
  request body it sends (one JSON line each, never the bearer) so such a
  refusal can be read from the exact request. A long history rides
  as recorded: every model turn with its own signature, a synthetic refusal
  row never on the wire, every call paired with its result, a resume
  message beside the result it follows. A Claude row on
  this road takes the request shape Google's own client sends it: thinking
  as a token budget (low 1024, medium 8192, high 24576, thoughts included),
  function calling VALIDATED even with no tools, an output ceiling of at
  most 64000 tokens, Google's signed parts replayed as sent and no
  signature placeholder (that placeholder is Gemini 3's own contract). The
  tool schemas are reduced per row to what the endpoint accepts: a Gemini
  row gets Google's Schema grammar (`const` becomes a one-member enum, an
  exclusive bound becomes words in the description, keywords outside the
  grammar drop); a row of another vendor (Claude, GPT-OSS) gets the smaller
  subset Google's own client sends for it (type, title, description, enum,
  items, properties, required, anyOf, oneOf, default) with every bound
  (minimum, maximum, item and length counts, pattern, format) carried as
  words in the description, because the Anthropic side behind Code Assist
  validates the schema as JSON Schema draft 2020-12 after Google's own
  conversion and refused the fuller grammar live. A
  model the roster names but Google does not serve answers 404 in Google's
  words. A chat goes to that endpoint's `streamGenerateContent` under
  Antigravity's own User-Agent (`antigravity/hub/<version> …`), whose version
  follows Antigravity's update manifest (one bounded read a day, the shipped
  2.24.0 as the fallback, skipped under traffic-off) because Google gates
  newer models on it; the request wraps the Gemini request with the project
  and a request id, the system instruction tagged as a user part, the tools'
  schemas in the shape the endpoint accepts. What leaves the machine on this
  road: the prompt, the tool schemas and the tool results, under Google's
  Antigravity client id and the account you signed in (sent to Google alone). No
  Cloud project, no client of your own, no API key. On June 18, 2026 Google
  replaced the unpaid tier's Gemini CLI with Antigravity; a Google AI Pro or
  Ultra plan rides this road, whereas an API key or your own OAuth client bills a
  Cloud project (free Flash ~20 requests/day, Pro 0; billing enables paid
  limits). The token is refreshed single-flight with the project kept; a
  revoked refresh token drops the sign-in and every surface names `/logins`;
  a refusal from the endpoint carries Google's words (an ineligible account
  with its validation link, an exhausted quota with Google's retry words, a
  model Google does not serve the account as a 404 naming the roster). The
  terminal UI, daemon and session runner read the three sources from the same
  auth-scoped store; the latest sign-in action is the active source (a
  pasted key makes the key active, and a completed Google sign-in makes that
  grant active), every receipt names the source requests ride, `/logins` and
  `/usage` name a stored source that is not active, and `↵` on its row makes it
  active without re-entering it.
  The `/logins` card lists Sign in with Google first, as
  `Sign in with Google — your plan's quota: AI Pro, AI Ultra or a free account`
  (the browser opens Google's consent page for the Antigravity client; the
  receipt names the tier, the e-mail and the roster count), the API key second, as
  `API key — the easiest: create one in AI Studio, paste it here`: choosing it
  opens https://aistudio.google.com/apikey in the browser, prints the address
  for a box without one, and takes the key by one paste. The Google account (your own OAuth client) is third,
  six numbered steps, each opening its Console page: 1. Create a Google Cloud project;
  2. Enable the Gemini API on it (that page picks the project, or creates one);
  3. Set up the consent screen for testing (on the Audience page: the user type
  External, and your own Google address under Test users, because
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
  response parts across tool rounds and resume, as Google returned
  them (a signature that streams in after the text rides the text part it
  closes); a tool call the history carries without a signed record (a chat
  switched from another model) replays under Google's documented
  skip-validation signature. An image the model generates is refused as
  content this chat cannot display. API-key chats ride the same native
  endpoint under the key header (`x-goog-api-key`), so their signed parts
  are kept the same way. A native token refusal names the Google account and `/logins`,
  with a receipt when a refresh was attempted and Google's own reason after
  it; a billing refusal on the Google sign-in says its quota and billing
  cannot be changed from here and points at a Gemini API key on a project of
  your own.
  Google's HTTP 503 busy refusals follow the one-minute retry ladder in
  [The runtimes](#the-runtimes) (showing `Gemini was busy · answered after 2
  retries (7 s)` when a retry succeeds). On a chat without a screen (`mercury run`
  or a dispatched crewmate) the same ladder runs, and its `wait` rows with
  `state: "retry"` reach the caller only past the quiet window; a dispatched
  crewmate's retry budget counts every wait of the ladder, the quiet ones
  included, so a six-second budget
  ends the ladder six seconds in whether or not a retry line has painted.
  The API-key resolver takes `GOOGLE_API_KEY` before `GEMINI_API_KEY`, then the
  stored key; environment keys must be available to the process that uses them.
  A launch naming `gemini` needs the live catalogue to choose a model. A present
  credential with a refused, unavailable or unselectable catalogue is a catalogue
  refusal; `no-credential:gemini` means no credential is
  present. An explicit Gemini model id can still dispatch with a credential,
  and the model endpoint decides whether to accept it. When Google refuses the
  catalogue read, the `/model` group heading names the credential it tried and
  the status it got (`the Google account's token was refused (HTTP 403) ·
  /logins re-connects`, `the stored Gemini API key was refused (HTTP 403) ·
  /logins replaces it`, or the environment key by its variable name, where the
  middle dot lets the picker's detail row wrap the remedy whole), and the
  debug log (`mercury --debug`; `debug/latest` under the config home) carries
  one line per refused read with the source, the status and Google's error
  body, every token, key and client secret masked;
- **moonshot**: stored OAuth tokens or stored key;
- **openrouter**: an OAuth-minted key or a stored key, env pin winning honestly;
  `/config → OpenRouter routing policy` chooses strict, balanced or open routing. Balanced is on from the start: model requests deny data collection and require every parameter, with fallbacks on and zero data retention off. An absent or empty `routing.openrouter` setting selects these defaults; strict turns fallbacks off and zero data retention on. Choose open to allow collection and make parameters optional, leaving routing to OpenRouter; only an explicit all-off policy sends no request-level routing preference. A no-provider refusal points back to this row to widen the policy;
- **xai**: a Grok subscription sign-in or an API key, with an optional management key for the API team's
  usage meter. The API-key leg of `/logins xai` prompts for the management key as its second step;
  leave it empty or press escape to keep using just the API key. An existing
  API key can be kept by pressing enter on the first step. Create the management
  key on [the console's settings page](https://console.x.ai/team/default/management-keys)
  with the **Management Keys Read + Write** permission. Both keys are stored
  auth-scoped (mode 600); env pins `XAI_API_KEY` and `XAI_MANAGEMENT_API_KEY`
  win independently. `/logins xai` adds the management key after the
  inference key, and its own `/accounts` row removes only that
  key while keeping the inference key. A management key alone cannot run Grok;
- **meta**: a Muse Code subscription sign-in (`.meta-auth.json`, mode 600, holding the account token, the minted key, the e-mail, the tier and the usage windows) or an API key (`MODEL_API_KEY`, `META_API_KEY` or stored key), the latest sign-in action active;
- **zai, deepseek, zen, local, compat, minimax, together, cohere, groq, melious, cerebras, fireworks, qwen**: env pins and stored keys.
- **huggingface**: `/logins huggingface` signs in by device code or takes a stored Hub
  token (`HF_TOKEN` takes precedence). Sign-in requests `openid profile inference-api
  write-endpoints`: identity, Inference Providers calls and Inference Endpoints
  management. If `/llmhost` reports that the sign-in lacks endpoint management,
  sign in again with `/logins huggingface` to grant it.
- **nous**: a browser device sign-in or a stored API key (`NOUS_API_KEY` pins one).
- **mistral**: an env pin or a stored key, with an optional Admin API key
  beside it (`MISTRAL_ADMIN_API_KEY`, or `/logins mistral` after the key) that reads
  the organisation meter and never runs a turn; its own `/accounts` row
  removes only that key.

Slots carry presence facts and masked key tails only, never a secret value.
Removal is routed to each slot's owning store. Environment-variable keys belong
to the shell: they are shown with their precedence and cannot be edited in
`/accounts`. You can keep up to two saved Anthropic accounts and two saved
OpenAI accounts at once (environment-variable keys do not count toward that
limit), and every sign-in path checks that limit before adding another saved
account.

On the `/accounts` board each family's header carries the family name
alone; the rows beneath it
name each sign-in with its kind and identity, and a family with no limit
shows how many sign-ins it holds beside its name. A sign-in row in either
of the concourse's model pickers, or on the home screen, opens the
Logins screen on that row's family; a completed sign-in, or escape,
returns to the picker that opened it, which lists the new family's models.

A claude.ai sign-in stores the account it landed, taken from the profile the
token exchange returned, beside the credential the moment the credential
lands. The sign-in's own receipt names that account, and every surface that
names the account (the home screen's account chip and its Logins roster,
`/accounts`, the `/usage` popup's Anthropic block, the usage
card and the `auth status` verb) reads the email stored beside the token
itself (from the profile or the exchange's receipt), never a cached copy or
a fresh probe while painting; a credential with neither shows no account, in each
surface's own words, instead of an earlier account. A hosted
session's `session/facts` answer names that same address in
`identity.account_email`, so the UI connector and any reader of the
session's facts see the credential's own account. The
`/accounts` board's live verification still updates the stored identity
whenever the two disagree; until it answers, the board names the recorded
copy beside the credential's own address, labelled as a snapshot, only when
the two differ.

Every provider's usage block, on the usage card and in the
`/usage` popup, prints one identity line under its title, and no block goes
without one: the signed-in account when the family's own store recorded one
(the Claude and ChatGPT sign-ins' emails, the Hugging Face username), else
the credential's own words (a key as the model picker's heading words it,
its kind and masked tail such as `API key · …4321`, `Coding Plan key · …YtbT`,
`OAuth key · …abcd`, `token · …abcd`, or a nameless sign-in or local server
by the label its resolver gives it), else `no account`. The popup says
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
credential can use (a gated row is never chosen, and a provider with no usable
row falls through to the next most recent sign-in). The `/model` readout
and the health check's Default model row say which and why.
`/defaultprovider` makes a provider the most recent sign-in explicitly
(an entry in the same ledger). Credentials that landed before the ledger
existed, env-pinned keys included, order after every recorded sign-in (the
config's older `defaultProvider` record first, so a home keeps its lane until
its next sign-in). With no sign-in anywhere there is no default: the home screen and
`/model` say so and point at `/logins`. An explicit `/model` choice,
`MERCURY_MODEL` or a session override always outranks the default. A saved
`/model` choice whose family cannot run when a chat starts (no sign-in for
it here, or a credential its catalogue refused, such as a Google, OpenRouter or
Hugging Face refusal with its status or an OpenAI sign-in the authorisation
server revoked) falls back to the computed default for that chat, with one
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
not answered yet (the GPT pin table and the Hugging Face pins). The rail's
context figure then carries the word `pin` after the size (`ctx 12% · 1050k
pin`), so a pin reads apart from a fact; when the list answers, the mark goes
and the figure is the list's. A pin no live list ever replaces (the
first-party rows, the GLM, Kimi and DeepSeek pins) carries no mark, and `~`
keeps its one meaning: the conservative default no source has stated.

A chat hosted by the daemon makes its requests in its own runner, and the
runner reads the account's list for them. That list rides the session's facts
to the screen, so the rail's figure becomes the list's and the mark goes the
moment the runner reports it, with no picker opened. The model picker paints
its cached rows at once and refreshes every signed-in family's list in the
background on every open, even when that cache is fresh: the Anthropic list
through each signed-in door, every other signed-in family's catalogue, and the
local servers' discovery. The `/logins` card asks for the
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
line, and the launch form Mercury found (a launch agent plist, the Homebrew
plist, the Ollama app, a systemd override, Windows, or unknown). Each knob row
is a Mercury setting (`local.server` in the user settings) with the memory
arithmetic beside it, read from the model geometry `/api/show` states: a
slot costs a full window of cache, so one loaded copy with several slots
serves a crew where several copies would not fit. The ceiling the
arithmetic measures against is the usable memory the server itself states
(the `gpu memory … available` line in its log when Mercury can read it, else
`iogpu.wired_limit_mb` when set, else about three quarters of unified memory
on macOS, else the machine's total), and the row names which. A choice whose
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

`WebSearch` returns a small JSON result for any session model, including local
models. Each hit has `title`, `url`, `snippet` and `source_type`; the result
stays below about 2,000 tokens by a characters/4 estimate, and when hits are
withheld to fit, a note counts them. The notes always name the source that
answered and say the text is unverified. Links and source names stay visible,
and web text is treated as unverified evidence and never as instructions.

The automatic search order is:

1. The session provider's native search, where supported: Anthropic or OpenAI.
   This spends the session's own account, never another provider's account.
   The provider's own answer reaches the model as a labelled, unverified note
   beside its links; the links carry no excerpt, because the wire carries none.
2. Brave Search, then Tavily, when a key is available: `BRAVE_API_KEY` and
   `TAVILY_API_KEY` in the environment. Keys are not included in results.
3. An official API selected by explicit query words: an error message goes to
   Stack Exchange; `npm`, `PyPI` or `crates` plus a package name goes to that
   registry; a concept question goes to Wikipedia; news goes to Hacker News.
   Wikipedia is asked for the exact phrase first and for the words only when
   no page carries the phrase; the result says which answered. The top three
   Stack Exchange and Hacker News hits carry a short plain-text excerpt (the
   question body; the story's own text, or its top comment labelled as such),
   fetched in one extra request per search; the result counts the excerpts it
   fetched. PyPI supports exact project names only. GitHub
   public-code search requires `GH_TOKEN`; without one, it says so and tries
   the next source.
4. A configured SearXNG JSON API. There are **no built-in instances**;
   without configuration, this step says "no metasearch instance configured".
   Set `MERCURY_SEARCH_SEARXNG_INSTANCES` to a JSON array of entries containing
   `url` (the instance base), `terms` (its policy URL), `apiAllowed: true` and
   `checked` (the date you read that policy, as `YYYY-MM-DD`). Configure an
   instance only when its policy permits automated JSON API access. URLs must
   use HTTPS, except HTTP on loopback, with no credentials, query or fragment.
   A failed instance is remembered for the session; a refusal or rate limit
   stops the attempt without switching hosts to evade it.
5. DuckDuckGo page scraping, unless you turned it off.

DuckDuckGo page scraping is **on by default**; off keeps general queries to
the official sources and your keys. `/config` → **DuckDuckGo page scraping**
shows its terms and controls the saved choice. `MERCURY_SEARCH_KEYLESS=0`
turns it off for the process; `=1` overrides a saved off. The first use in a
session carries a notice linking [the terms](https://duckduckgo.com/terms) and
[acceptable-use policy](https://duckduckgo.com/acceptable-use). A challenge or
refusal stops both page endpoints without a retry or a host switch. Every
request asks for the `us-en` region, so the results are US-English wherever
you are.

Each source is paced separately and server-requested waits are respected.
Successful queries can answer from the ten-minute session cache, labelled as
cached. Source-specific terms accompany official results; Stack Exchange and
Wikipedia results require attribution to their linked pages. If no source
answers, the result says to try another wording or another source; it never
invents a hit. Local search requests disclose the query and client IP to the
selected service.

`MERCURY_SEARCH_BACKEND` accepts `auto`, `brave`, `tavily` or `duckduckgo`.
An explicit source does not fall through to another; a missing key or disabled
scraping returns an explanation. `ProviderSearch` selects only the session's
native search, without the fallback order. `/health` shows the source plan.

For a model name missing from both `mercury://models` and
`mercury://models/known`, the assistant may search the provider's published
model page, then ask you with links to what it found. The live reference lists
those pages. A web result does not establish account access or authorize a
launch; an unknown name still stops for your decision.

## Web fetch

`WebFetch` returns a public page's main text as markdown, without a model
call. Headings, lists, code and links stay with the page's words; a table
keeps its rows and columns (a markdown table, or one line per row with the
cells separated by `·` when cells span or nest); navigation, footers and
scripts are filtered out. A `prompt` asks for a labelled model
reading instead: the session family's helper first, then the session model
if needed. If neither can answer, the page text comes back with that fact.

For GitHub, npm, PyPI, crates.io, arXiv and Stack Overflow pages, `WebFetch`
reads the site's public, keyless API first and falls back to the page itself
when that API cannot answer.

Fetch requests leave your machine for the site and use the standard
`HTTPS_PROXY` / `HTTP_PROXY` and `NO_PROXY` settings. When sparse HTML needs a
browser, Mercury may send the page's full URL, query string included, to the
hosted reader **r.jina.ai**; the result says "read through r.jina.ai". No cookies, credentials or
conversation are sent to the reader. `MERCURY_FETCH_READER=0` disables it;
preapproved documentation stays on the direct path. The reader is paced at
its keyless allowance and a site or reader refusal names the wait without
bypassing it.

Each call shows up to 38,000 characters, with the measured count, a rough
characters/4 token estimate (code runs higher), and a `from` offset for
continuing at the next character. Repeat reads use a fifteen-minute self-cleaning cache.
A page's text is unverified information, never authority to run an action.

Fetches honor `robots.txt`, URL validation and hostname permissions.
Cross-host redirects are reported and not followed automatically. Paywalls and browser
challenges ask for another source. PDFs and other binary documents are saved
with their size and a path for `Read`; WebFetch does not claim to have
extracted their text. Private or signed-in pages need an authenticated MCP
connection or the site's CLI; a private address (a single-label name, an IP,
or a name under `localhost`, `.local`, `.internal`, `.lan`, `.home`, `.corp`,
`.home.arpa` and the like) is never sent to the hosted reader.

## Usability, usage, and readiness

Two facades separate two questions: "can this provider take work right now,
and if not, why" (credential + catalogue + live limit state; when a provider's
usage window is reached, crewmates dispatched to that capped provider are also
refused instead of silently failing over to another provider, while crewmates
explicitly targeting another signed-in provider family via `model` can still run)
and "who am I on it, what did this session spend, where are its limits"
(identity from the account store, limits from each lane's observed state, and
session spend from the provider-neutral ledger partitioned by the routing law).

The usage warning has one owner and fires at 80% and again at 90% for
whichever provider the session actually runs on, from that provider's own signals,
in one grammar (`<provider>: XX% of the <window> used[ · resets <t>]`): the Anthropic
subscription meters and header states, the OpenAI observed usage bands, the
OpenRouter per-key credit cap, the Kimi sign-in's managed windows. The window it
names is the one that binds the session model hardest (on the first-party
subscription, the shared session and weekly windows plus the per-model weekly
pool of the model's own family, so a Fable week at 87% warns a Fable session and
never a Sonnet one). A lane that serves no percent-shaped usage signal never
warns (an absent signal produces no warning and never fabricates a meter). The engine
feeders read the same window views the `/usage` popup and the rail meters read,
so the strip and the meters never disagree about a percent. An OpenAI
band past its reset, or older than its response freshness horizon, keeps its
last-read words on the card and meters with its age instead of appearing as a fresh
reading. That stale band does not trigger another warning.

The same derivation puts a notice into the context at each threshold, once at
80% and once at 90% per window, when the `engine.usageNotice` setting is on
(it is off unless you turn it on, and when off, the model is told nothing while the
meters, the strip warning and the headless limit row stay yours alone). With
the setting on, at 80% the notice states the provider, percent, window
and reset, and that the provider stops work only when the window is used up.
At 90% it also advises keeping the work resumable: finish the step in hand,
commit what is done and write down where it stands. A spending limit near
(the Anthropic extra-usage state) rides the same notice. The model decides what to
do; no percentage, even 100%, holds work, stops a turn or shows a handoff card.
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

If your current provider hits its usage cap and you confirm a handoff card to
another signed-in provider (or unattended failover is enabled), the session runs
on that backup provider (the failover lane) until your original provider's usage
window resets. One amber sentence above the composer says so (`on the anthropic
failover lane · Opus 5.5 · OpenAI window resets 24 Sept, 8:15 pm · /model to
return`) for two minutes after the
switch, and again for two minutes whenever the facts it states change: the
served model, the lane, the original provider's stated reset changing or passing,
or the original provider becoming available again. Then it clears, and the strip's model segment carries a
short amber mark beside the served model (`Opus 5.5 · failover`) for as long as
the session runs on the backup provider; the mark clears when the session returns to its
original provider. On a window too narrow for the whole sentence it is cut to what
fits, an ellipsis closing the cut, and keeps its `/model to return` tail.
`/model` returns to the original provider in one keystroke throughout.
`MERCURY_FAILOVER_LINE_MS` sets the sentence's window in milliseconds
(1000 or more; the default is two minutes).

Every meter surface (the rail's USAGE panel, the frame
band, `/usage` and the health check's per-family usage rows) reads one owner and
paints one grammar: a family's shared windows first, then every per-model
weekly pool it reports beside them (the first-party subscription's Fable,
Opus and Sonnet weeks, folded into the same block; a family that reports
no pools shows none), each with its percent and its reset in your
local time. The frame band's second chip is the binding window for the
session model, under its own label. Every figure names its feed and age
(endpoint-fed or header-fed, `"read N ago"`, and the rail's and the band's `"↻12s"`),
and a read older than twice its reader's cadence says `"stale"` (`"stale ↻2h"`,
`"stale · last read 2 h ago"`) instead of appearing live; a lane that has
observed nothing says `"no usage read"`, never `0%`. The first-party subscription's
reader samples the usage endpoint once a minute while the screen is up and
again after every completed turn (a daemon-hosted chat's replies land in the
runner's process, so the screen never waits on them); one request at a time,
and the freshest observation wins each window (a reply's headers the instant
they land, or the endpoint's next answer a minute later). A read that fails (an
HTTP status, a timeout, an unreachable host, an expired sign-in token) is on
screen beside the last figure with the status and the host, backs off four
minutes, is logged once per episode, and is written once to the health check's record
in the config home (`usage-reader.json`) with its recovery so `mercury health`
names it from another process. `/usage` and its retry key ask at once regardless.
An expired sign-in token is renewed by the read itself through the ordinary
refresh grant (the same road a reply takes) before the endpoint is asked, so
an idle session paints live numbers without sending a message; one grant per
read, never a loop, and a grant the sign-in server refuses is reported as an
expired sign-in (`/logins anthropic` signs in again).
A sign-in or a removal (the sign-in ledger's epoch, the one signal every family
raises) forgets the reader's state and asks for the account now signed in at
once, so the meter never keeps a departed account's figure or waits out its
cadence.

A sign-in or a removal also reaches the engines behind the open chats. The
daemon tells every runner it hosts to read the account again, so a delegated
crewmate is never refused with a departed account's usage window; a runner that
missed the word is covered anyway, because a limit verdict is trusted only for the
account that observed it and reads as unknown once the signed-in account is
another, so the refusal for a reached window names the account it belongs to,
when it was seen, and the reset it knows. That verdict lapses at the reset the
reply named (or after a bounded span when the reply named none), so a
delegated crewmate is not refused after the window has reset, and the next reply
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
switch, a sign-out), so a delegated crewmate on a GPT row is never refused with a
departed sign-in's window. The runner's copy of the OpenAI model list follows
the same credential: told to read the account again, it drops the departed
sign-in's rows and reads the signed-in account's list once, bounded, and a
delegated dispatch on the OpenAI route reads that list before it decides. The
refusal for a reached window names the window that blocks; the state of the
model list is never named as if it were the block. The OpenAI bands a reply's
headers stated are one record for every surface: a band stays a stated band
however old it grows, and the rail's rows, the frame's chips and the `/usage`
popup all paint it with its age (`"stale ↻55m"`, `"header-fed · stale · last read
55 min ago"`), never showing `"no usage read"` on one screen beside a read on another.

`/usage` opens a popup over the chat (150 columns, centred, three providers
side by side above 120 columns and stacked below it, six providers in view
and the rest on `↑↓` scroll with a `"↓ n more"` row naming them; `esc` or a
click outside closes it). It lists every provider, the signed-in ones first in
the order of their most recent sign-in (the same sign-in record the computed
default reads) and each in its own shape: the first-party subscription's
rolling windows and weekly pools, the OpenAI account's observed bands, a Kimi
sign-in's plan windows, a GLM Coding Plan key's credit windows, an OpenRouter
key's credit totals and cap, the DeepSeek and Moonshot balances, xAI's team
balance and billing-cycle usage with a management key, Mistral's organisation
usage against its monthly limit with an Admin API key, a Nous Portal key's
plan and usable credits when the Portal account endpoint resolves the key,
a Meta Muse Code sign-in's tier and rolling/weekly windows (bounded re-read
through `POST https://api.meta.ai/muse-code/key`), a MiniMax M Plan key's
5-hour and weekly windows per model, an OpenCode Go key's plan windows, the
observed rate limits of Groq and Fireworks AI and the observed retry waits of
Cerebras, and an honest one-line absence for a lane whose provider publishes
no usage Mercury can read (a general Z.AI key, a Gemini API key or your own
OAuth client, a Meta API key, a custom endpoint, an API key on a subscription
lane, a local server).
Every API-key slot carries a credits line: the provider-stated balance with
its feed and age where the family exposes one (the DeepSeek and Moonshot
balance endpoints, xAI's management-key balance, the Nous Portal account
endpoint's usable credits, the remaining credit under
an OpenRouter key cap), and
`"credits: not reported by the provider"` where none exists (never a computed
spend presented as a balance). The Claude subscription carries the same line
with its extra-usage figure as Anthropic states it (`"credits: extra usage USD
12.40 of 50.00 this month"`, read from the usage endpoint together with the
windows and stamped with them), `"extra usage off"` while the account has it
turned off, and `"not stated by the endpoint"` when the answer carries no such
figure; an Anthropic API key (including one minted by Console sign-in) still reads
`"not reported by the provider"`, because Anthropic publishes no balance for a
key (the Console's billing page is the view, and the admin usage and cost
reports state spend only). Every figure is a reader's last
observation with its stamp, sampled in the popup through one door and dropped
the moment the credential it belongs to changes (never remembered or
invented).

For xAI, the inference key identifies the team and the optional management
key reads its prepaid credits, usage for the current billing cycle, and its
postpaid invoice preview and spending limit where enabled. These are team
figures, separate from this session's spend; a postpaid cap does not cap prepaid usage.
A partial usage query is labelled partial, never mistaken for a reached
spending limit. With only the inference key, `/usage` says `"add a management
key from the console's settings page to read usage — /logins xai"`. A refused
management key is named plainly, with the last successful read and its age
left visible. No management key is not an error.

A Sign in with Google on the Gemini lane shows, under its own slot, the tier
Google reports for the account (free, the paid plan's own name such as Google
AI Pro, or a Code Assist licence) with the read's age, then the quota left
that Google's roster states (with its reset time, read with the model list,
re-reading the figures once on open when the last read is a minute old or more)
in one order: the session's own model first, resolved to its effort row
(`gemini-4-argon ▸ gemini-4-argon-high`), then every model this session used
on the lane (crewmates included) in order of last use, then one folded line
(`"24 other roster models — ↵ lists them"`) that `↵` opens and folds again; the
slot's session lines give the input and output tokens of each model this
session used on the lane, with no cost.
Google states no account spend or credit balance for the sign-in, and the absence line says so and names the
plan's own page. The compact view's one figures line keeps the same order
with the rest counted, and the popup's header line and the `/logins` row
carry the session model's own figure (`gemini-4-argon-high 42% left`) beside
the tier and the read's age. A Google account signed in with your own OAuth client shows its
credits line and an absence line naming the view (the Cloud console Quotas
page for the Generative Language API, or Google AI Studio), because Google
states no usage, quota or credit figure to it: the Gemini API has no usage
endpoint, its replies carry no quota headers, and the Code Assist, Cloud
Quotas and Cloud Monitoring roads refuse a sign-in made with your own OAuth
client.
A Hugging Face sign-in or token shows the plan the Hub states to it
(`whoami-v2`: PRO or free, whether a payment method is on file, when the
billing period ends) as its tier and a plan line with the read's age, sampled
through the same door as every reader, while the credits line says the credits
used and left are not stated to a token and the absence line names the billing
page.

A Kimi sign-in shows its Extra Usage balance in the stated currency beside its plan windows, or says when the managed-usage endpoint reports no balance.
OpenRouter OAuth-minted keys show the same remaining credit under the key cap as API keys, with the read's age and any refusal under the affected account. Below Mercury's $10 floor, `/usage` names the remaining amount and the credits page; an uncapped key has no balance notice. This is the key's remaining allowance (distinct from the account balance).

The ChatGPT sign-in shows OpenAI's credit balance or unlimited credits beside its usage windows, with the last read's age, in `/usage`, the rail and its account row.

A window that reads reached (100%, or a refused request) says what carries the requests from there, from the vendor's own statement: a Claude subscription on extra usage names its figure (`"on extra usage · USD 12.40 of 50.00 this month"`) or says `"extra usage off — nothing carries requests until the reset"` with the reason Anthropic gives, a ChatGPT sign-in says `"on credits · 62,500 left"` or `"no credits — nothing carries requests until the reset"`, a Kimi sign-in names its Extra Usage balance, and a family that states nothing about it says so in one clause; the words ride the rail's and the deck's reached line, the `/usage` tab's reached sentence, the strip warning at 100%, the account-slot offer, the handoff notice, the refusal rows and blockers, and the health check's usage row.

A GLM Coding Plan key shows its windows the way a Kimi sign-in does: the
5-hour and weekly credit windows as used-percent bars with their resets, on
the rail's USAGE block and in `/usage`, read from Z.AI's own quota endpoint on
the coding base (the one the Z.AI console and Z.AI's own usage extension read; it
is not a documented API, so its shape is decoded by the window's unit and
length and the stated percent, and an answer Mercury cannot decode is a
labelled `"no usage read"` line, never a wrong meter). The read is asked the
way every plan read is (when a meter is shown, on a sign-in, or on your
retry, no more than once a minute and never on a clock). The key
goes in the Authorization header as Z.AI's own tooling sends it; a key the
endpoint refuses in that form is retried once as a bearer token and the form
that answered is kept for the next read. The plan tier the endpoint states
("GLM Coding Pro") is the block's tier line, and the monthly MCP tool-call
quota rides as one figure in `/usage`. A general Z.AI key has no usage road
and keeps its one line; a Coding Plan key whose account the endpoint says has
no plan reads "usage: not on a coding plan".

The cost ledger prices every request at its own provider's published rates
from one pricing owner per family: the first-party tier table; the GPT,
DeepSeek, xAI, Meta, Mistral, Kimi, GLM, Gemini, OpenCode Zen, MiniMax,
Together AI, Cohere, Groq, Cerebras, Fireworks AI and Qwen price tables (a
longer-prompt tier applied per request); the OpenRouter catalogue row when the
wire states no cost of its own, and the Nous Portal catalogue row; the Hugging Face listed floor as a flagged estimate; a recorded zero for
a local server. A turn on a model with no rate on file lands in the ledger
with its tokens counted and its cost unrecorded: it is counted as an unpriced
turn, never priced at zero, and every cost readout says so (a lane that
priced nothing reads `"unpriced"`, and a figure that includes such turns says
`"+ N unpriced turns"` beside itself, on the `/usage` spend lines, the cost
summary at exit, and the deck and frame vitals alike). No family is ever
priced at another family's rates.

### JEV

JevEval provides a second opinion from TypeSafe's Jev, separate from the model running the
chat. Bare `/jev` opens its card. `/jev on` selects the official road with
its own TypeSafe key; `/jev or on` selects the OpenRouter road using the
credential already connected through `/logins`. `/jev off` and `/jev or off`
turn JEV off. The card's Road row shows the selected road, and the JEV
switches in `/config` and the home screen's Boot Menu preserve that choice. A sign-in
never switches JEV on, and a missing key never falls through to the other
road.

Each road keeps its own session spend meter and allowance cap. `/clear`
starts a fresh chat with fresh meters; the stored caps stay unchanged.
The main model's default pace is 100 requests a minute. Crewmates receive
JevEval by default when JEV is on and its road has a key; the card's
Crewmates row turns that off by choice. They share 50 requests a minute
per session on each road, separately from the main pace, with a cap of 200
calls per crewmate. An explicitly stored main pace stays as you
set it.
OpenRouter's meter uses the response's `usage.cost` when stated, or the
published token rate when unstated. Its requests deny data collection and
provider fallback. The card and the tool result name the model that
answered, the stated cost and the generation id, or the refusal's own code
and words.

A JevEval call takes a list of evidence items (each a record of named
facts, a bare paragraph, a file or an inline table) and one question
set; every item is judged against every question in its own request, all
sent at once and each counted against the pace and the budget, and one
table comes back: rows the items, columns the questions, a row that no
answer reached saying so in place. A file item names a path the tool
reads under the same rules as Read (deny and ask rules, the working
directories): a table file (tsv, csv, a markdown pipe table or jsonl, by
its extension or a stated format) becomes one item per row with the
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
evidence in front of it answers (whether a run was killed from outside,
whether a capture starved, or whether the output names a fixture fault; the
words settle those). Whether the product is wrong or the proof stale, and
whether a fold's intent changed a check, they do not; those need the proof
run on the tip and the source read.

## Transitions

A model switch previews as a frozen plan (what switching this
history to the target will do) with per-item typed dispositions computed
against the real encode truth of the target lane's codec: replay carry,
thinking drops, image handling.

The plan also counts the conversation against the target's window before
the first request on it. The count is Mercury's own: the larger of the last
count the wire reported for the conversation and the character estimate.
The window is the target's as Mercury resolves it (the live catalogue's
figure for the account when it has been read, else the pinned figure). When
the conversation does not fit, the preview says so with both numbers and
where the window came from, and confirming folds the conversation before
the first request on the new model; the fold's summary is written by the
model the conversation was built on, whose window holds it. A conversation
that fits switches as before. A switch back to a model the conversation
already ran on re-sends the system prompt that model first saw, so the
thinking it left behind stays bound to its prefix; a working directory
added in between reached the model on its own row and never rewrites that
prompt.
