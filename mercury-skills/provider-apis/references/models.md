# Model and route facts

This reference carries no model inventory: read model IDs, tiers and display names from `src/services/providers/modelRegistry.ts`, the family `*Catalogue.ts` / `*Pins.ts` modules, and the live reader `src/services/providers/catalogueOnDemand.ts` — the current catalogue, never a copy (`src/services/providers/catalogueAdmission.ts` owns list admission). Capability, effort and pricing owners: `src/utils/model/capabilities.ts`, `src/utils/effort.ts`, `src/utils/modelCost.ts`.

**CODE inspected 2026-11-13:**
- `src/services/providers/idSpaces.ts` (`recognizeModelId`, `PROVIDER_ID_SPACES`, `LIVE_LIST_FAMILIES`) resolves qualified namespace → exact ID → cached live list → aliases/prefixes. `src/services/providers/routeLaw.ts` owns wire-ID grammar: strip only Mercury carrier prefixes/annotations, never the vendor's slug.
- `src/services/providers/mistral/mistralPins.ts` (`MISTRAL_HOSTED_DEEPSEEK_IDS`) overrides native-looking prefixes for exact hosted IDs. `src/services/providers/homeLaneAdmission.ts` owns explicit gateway/pin admission; unrecognised IDs never enter the home lane.

Keep offered list, selected model and served model distinct (a public model page does not prove account access). Before changing capabilities or limits, read the model/endpoint's source in `live-sources.md` and stamp the date; never infer an absent billing API from an inference page.
