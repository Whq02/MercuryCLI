# Model and route facts

**CODE inspected 2026-11-04:** `src/services/providers/idSpaces.ts` (recognizeModelId) resolves qualified namespace → exact ID → cached live list → aliases/prefixes. Its `PROVIDER_ID_SPACES` and `LIVE_LIST_FAMILIES` are the inventory; do not maintain another here. `src/services/providers/routeLaw.ts` owns wire-ID grammar; strip only Mercury's carrier/annotations, not the vendor's slug.

**CODE inspected 2026-11-04:** exact hosted IDs in `src/services/providers/mistral/mistralPins.ts` (MISTRAL_HOSTED_DEEPSEEK_IDS) can override a native-looking prefix. Check that owner and the classifier before assigning a model to its apparent publisher. `src/services/providers/homeLaneAdmission.ts` owns explicit gateway/pin admission; an unrecognised ID does not establish a home-lane identity.

For the chosen family, open its `*Catalogue.ts` / `*Pins.ts` through `src/services/providers/modelRegistry.ts`; `src/services/providers/catalogueOnDemand.ts` and `src/services/providers/catalogueAdmission.ts` own list refresh and admission. Capability and effort owners are `src/utils/model/capabilities.ts` and `src/utils/effort.ts`; pricing use belongs to `src/utils/modelCost.ts`. Model facts come from the live reader, `src/services/providers/catalogueOnDemand.ts` — the current catalogue, never a copy; this skill keeps no model inventory, price or limit table.

The account's offered list, the selected model and the served model are separate observations. A published model page does not prove account access. Before changing a capability or limit, read the exact model/endpoint's current source from the vendor index and record its date. Do not infer a billing API's absence from an inference page.
