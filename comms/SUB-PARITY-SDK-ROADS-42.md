# SUB-PARITY-SDK-ROADS-42

## 2026-10-22 22:28 BST — START

Base `2a37ed2bdf`; branch `lane/beta42-sub-parity-sdk-roads`. All three lane briefs read. Dependency links and copied native packs verified. Assigned Astra max retained. Auditing the headless and SDK model-selection, resume, runner, rows and structured roads; fixture-only proofs run singly. Audit table follows within 30 minutes.

## 2026-10-22 22:31 BST — INITIAL AUDIT

Code-backed verdicts at the base; rows marked source parity receive new fixture legs before DONE. The base CLI built successfully; manifest `degraded: []`. Existing `prove-compat-assistant-usage.ts` (16 checks) and `prove-compat-reasoning-usage.ts` (19 checks) each ran alone, rc 0.

| Road | Anthropic road | Compat road at base | File:line | Verdict |
| --- | --- | --- | --- | --- |
| Explicit headless model, first turn, rows, exit | Run passes the requested id and projects the turn | Same path; existing compat usage proof green; named endpoint/store/tool leg to add | `src/cli/run.ts:530,998,1428`; `sdk/src/client.ts:91` | same |
| `--model local/compat/huggingface` | First-party class words resolve through model parser | These three class words pass through the parser unchanged, unlike Crewmate's resolver; a gateway can receive the class word as an Anthropic id | `src/cli/run.ts:531,1001`; `src/utils/model/model.ts:175-258`; `src/utils/crew/engineDispatch.ts:609-657` | wrong |
| Unknown compat id | Home admission validates unknown ids | Named compat refusal exists at dispatch, not at the headless/runner admission seam | `src/services/providers/openaicompat/compatAccounts.ts:155`; `src/cli/run.ts:530,2172` | wrong |
| Cold headless resume | Restores recorded model unless explicitly overridden | Qualified compat ids use the same retention; refusal branch substitutes the default; replay fixture leg to add | `src/cli/run.ts:764-774`; `src/cli/headless/resume.ts:109-140` | wrong |
| Warm runner resume | Claim reloads transcript | Claim without an explicit model does not restore the recorded model, so compat can become the default provider | `src/cli/run.ts:2241-2278` | wrong |
| TS `run`, input/output rows | Generic string model and shared row schema | Source parity; new named-compat store/tool/rows leg to add | `sdk/src/client.ts:35,91,389`; `sdk/src/rows.ts:1` | same |
| TS runner model switching | Wire forwards exact requested model | Shared handler accepts unresolved class and unknown compat ids without validation | `sdk/src/runner.ts:301`; `src/cli/run.ts:2172-2185` | wrong |
| TS structured result | Shared schema tool and decoder | Source parity; compat fixture leg to add | `src/cli/run.ts:1174,1430`; `sdk/src/structured.ts:63` | same |
| TS inline agent model | Definition accepts a model string | Same string survives agent-def serialization; compat crewmate fixture leg to add | `sdk/src/helpers.ts:12`; `sdk/src/client.ts:95` | same |
| Python client/rows | String model forwarded and generated row schemas | Source parity, same headless defects inherited | `sdk-py/src/mercury_cli_sdk/client.py:43,148,238` | same |
| Python runner | Shared wire method | Inherits the same unresolved model-switch and warm-resume defects | `sdk-py/src/mercury_cli_sdk/runner.py:395,410` | wrong |
| Python structured/agent | Schema decoder and model string | Source parity; fixture legs to add | `sdk-py/src/mercury_cli_sdk/structured.py:122`; `sdk-py/src/mercury_cli_sdk/helpers.py:22,39` | same |
| Review streams and packaging model words | Review stream fixtures use generic ids; README relies on CLI defaults | Both READMEs omit a compat route example and the class/refusal contract | `sdk/README.md:14,45,69`; `sdk-py/README.md:16,83`; `scripts/sdk/prove-review-streams.ts:9-10` | missing |
| `/run` inspector | Projects lifecycle, effects, evidence and context | Provider-neutral projection, no separate model path | `src/commands/run/runInspectorModel.ts:48-153` | same |

Fix order: model resolution/refusal at headless and runner admission; resume without provider substitution; SDK compat examples and end-to-end legs. `prove-review-packaging.ts` invokes publish scripts/builds packages, so it will be read only under the explicit no-artifact rule; packaging words will be checked without executing it.

## 2026-10-22 22:38 BST — LANDING 1

`139e18c705` — headless and both SDKs resolve the `compat`/`local`/`huggingface` class words through the existing Crewmate resolver, and refuse unknown compat endpoints/models before boot, model switch or warm claim mutates the seat. Row runs expose typed refusals. `scripts/sdk/prove-compat-model-admission.ts`: base `2a37ed2bdf` rc 1 (eight failed groups), landing rc 0; explicit Anthropic and named compat turns, stored fixture credential, both SDKs, runner switch/back and atomic claim refusal. `bun run typecheck` rc 0. CLI build rc 0; `degraded: []`. Next: cold/warm resume retention and replay.

## 2026-10-22 22:44 BST — LANDING 2

`c505fa7235` — cold and warm resume retain the recorded compat model; an unavailable saved endpoint refuses before any model request or warm identity adoption. Explicit caller model overrides still work. `scripts/sdk/prove-compat-resume.ts`: preserved base `2a37ed2bdf` bundle rc 1 (compat warm resume actually answered through the Anthropic fixture), tip rc 0, including both SDKs and reasoning replay. `prove-compat-model-admission.ts` rerun alone rc 0; `bun run typecheck` rc 0. Next: SDK tools, rows, structured output, inline-agent model and README route examples.

## 2026-10-22 22:51 BST — LANDING 3

`100f1eb00d` — both SDK READMEs now name compat route syntax, discovery, class choices and resume retention. `prove-sdk-compat-roads.ts` runs real TS and Python CLI children through tool turns, partial rows, exact model/usage rows, recorded-row replay, run and runner structured output, and inline agents whose declared model is a compat route. All behavioural legs passed on the base; the missing README contract was red. Tip rc 0; typecheck rc 0. Privacy grep matches only the pre-existing product outcome word `blocked`.

## 2026-10-22 23:03 BST — LANDING 4

`aebe44bccc` — disabled class words now use the existing Crewmate refusal rather than a null-property exception. The final admission proof additionally checks successful `local` and `huggingface` class resolution on loopback, no Anthropic credential for compat, and exact mid-session compat switches/back in both SDKs. Final SDK parity also checks permission/authentication exit codes and closing-ask usage. Final admission: base rc 1 (eleven failed groups), tip rc 0. Final SDK roads: base rc 1 (README contract only), tip rc 0. Resume recheck rc 0. Typecheck rc 0; CLI manifest `degraded: []`.

## 2026-10-22 23:04 BST — DONE

Product tip `aebe44bccc`; receipt `receipts/sub-parity-sdk-roads-42/REPORT.md` carries the final audit and all verification. Backlog: 0 product defects found within this lane. No final check is red. No provider/host/crew-owned file changed, no suite or package/publish script ran, and no real provider was contacted. Release all leases after the receipt lands; stop for the lead and owner.
