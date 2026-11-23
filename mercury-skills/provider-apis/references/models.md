# Model and route facts

This reference carries no model inventory: read model IDs, tiers and display names from `src/models/roads/modelRegistry.ts`, the family `*Catalogue.ts` modules, the `src/models/facts/pins/*Pins.ts` tables, and the live reader `src/models/roads/catalogueOnDemand.ts` — the current catalogue, never a copy (`src/models/roads/catalogueAdmission.ts` owns list admission). Capability, effort and pricing owners: `src/models/facts/capabilities.ts`, `src/models/effort/effort.ts`, `src/models/usage/modelCost.ts`.

**CODE inspected 2026-11-22:**
- `src/models/roads/idSpaces.ts` (`recognizeModelId`, `PROVIDER_ID_SPACES`, `LIVE_LIST_FAMILIES`) resolves qualified namespace → exact ID → cached live list → aliases/prefixes. `src/models/roads/routeLaw.ts` owns wire-ID grammar: strip only Mercury carrier prefixes/annotations, never the vendor's slug.
- `src/models/facts/pins/mistralPins.ts` (`MISTRAL_HOSTED_DEEPSEEK_IDS`) overrides native-looking prefixes for exact hosted IDs. `src/models/roads/homeLaneAdmission.ts` owns explicit gateway/pin admission; unrecognised IDs never enter the home lane.

Keep offered list, selected model and served model distinct (a public model page does not prove account access). Before changing capabilities or limits, read the model/endpoint's source in `live-sources.md` and stamp the date; never infer an absent billing API from an inference page.
