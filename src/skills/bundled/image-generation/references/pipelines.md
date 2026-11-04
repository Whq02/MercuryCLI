# Editable pipelines and workflow files

Use this only when the deliverable needs an editable source, import/export or remote execution. Discover the connected pipeline tools first; the shipped implementation is not a guarantee they are exposed.

## Editable source

`pipeline_describe` returns the actual document and step schemas. Save a .pipeline.json with stable step IDs, validate it with `pipeline_validate`, and inspect the expanded plan with `pipeline_run` dry before an unfamiliar run. Step inputs do not take job controls such as cwd, wait, dry or resume. References point to earlier outputs; an image and an image list are not interchangeable inputs.

Document: `pipeline`
```json
{
  "version": 1,
  "name": "Small landscape",
  "steps": [
    {"id":"draw","kind":"generate","inputs":{"prompt":"a small landscape with a blue lake","seed":42}},
    {"id":"small","kind":"downsize","inputs":{"image":{"step":"draw","output":"image"},"factor":2}},
    {"id":"save","kind":"output","inputs":{"image":{"step":"small","output":"image"}}}
  ]
}
```

Edit the source, not a completed record. Running from a step reruns it and its successors; earlier outputs are reusable only when inputs and saved hashes match. Changed/missing ancestors run again. A whole run does not imply reuse; an explicit resume needs a starting step. Result paths locate the images and separate run record under media/. Old records retain their source/settings; changing the source does not rewrite history. These are implementation rules (E in `references/sources.md`), not freshly rendered replay evidence.

## ComfyUI format

For one request, inspect a workflow with `image_generate` dry; for editable steps, use `pipeline_import_workflow`. Read the node mapping, skipped nodes and explicit overrides before rendering. Paths resolve beside the workflow; arbitrary custom nodes are not executed. Model/CLIP LoRA strengths, branches and sampling representations must be mappable, not silently dropped.

**CODE inspected 2026-11-04, media 0.2.9:** `src/extensions/bundled/mercury-media/server/server.js` computes resolveSampling once and passes the same effective settings to writeExport and the render. Export refuses unknown sampling defaults and unrepresentable custom sigma schedules. Do not require explicit CFG/sampler overrides for every export or silently replace a saved schedule to obtain one. Historical 0.2.6 default-divergence advice is superseded, not a current workaround.

`export_workflow` writes one request as API JSON, including when dry; `pipeline_export_workflow` exports only the mapper's supported steps. Downsize, palette, sheets, multiple renders and an effective Pixel Party downsize can be unrepresentable; the landscape above intentionally includes such a step. Keep the pipeline instead of deleting the user's processing to make export pass. Existing destinations refuse rather than overwrite. Inspect the saved settings and outputs; a source inspection is not a visual round-trip test.

## Remote execution

`media.host` chooses an existing SSH rental; it does not rent a machine. Do not change it merely to make a render fit. Check the model/adapter's hosting terms as well as commercial-use terms before sending it there.

Prompts/settings and required images, masks, maps, palettes and local adapters travel to that host; the whole project does not. Pipeline source and downloaded outputs stay local. Import/export can transfer referenced inputs even without diffusion; pipeline dry sends only the document. Runtime/weights and ongoing rental billing are remote. Disconnection does not prove an asynchronous job stopped; reconnect to retrieve its ID, never replace the host or duplicate the job silently. The entry owns model-choice/refusal authority; this section names the transfer effect. Source owners: E in `references/sources.md`.
