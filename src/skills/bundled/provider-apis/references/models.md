# Model and route facts

Source map read 2026-10-08. This skill carries no model inventory: model IDs, output ceilings, effort vocabularies, prices and served windows must come from the current catalogue or a dated provider reading.

- Begin with `src/services/providers/idSpaces.ts` and `src/services/providers/routeLaw.ts` for recognition and wire-ID grammar. `src/services/providers/catalogueOnDemand.ts` reads pending live lists; `src/services/providers/catalogueAdmission.ts` handles catalogue admission.
- Read the selected family's catalogue module and `src/utils/model/capabilities.ts` for capabilities. `src/utils/modelCost.ts` owns pricing use; `src/utils/effort.ts` resolves effort. An offered ID alone proves neither account access nor a context or output limit.
- `/model` shows offered models and `/submodels` shows family selection. Retain carrier identity in stored records: `openrouter/<vendor>/<model>`, `huggingface/<org>/<model>`, `compat/<id>` and `local/<name>` are Mercury identities; the wire receives the validated inner ID.
- A qualified namespace wins before a native prefix. Strip only Mercury's namespace and display annotations; do not strip a vendor segment from its own slug. Let the shared canonicalizer validate the shape rather than duplicating it in a provider client.
- Keep the operator's selected capability. Do not replace max effort with a smaller word, disable thinking, cap output or restrict the tool set to make a failing road pass. If the provider cannot serve a parameter, reproduce that answer and fix the contract rather than silently changing the request's intent.

The vendor index in `live-sources.md` is a starting point for current readings, never evidence that a remembered model still exists.
