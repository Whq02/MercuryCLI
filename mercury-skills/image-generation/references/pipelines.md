# Editable pipelines and workflow files

Use when the task requires an editable `.pipeline.json`, ComfyUI workflow import/export, or `media.host` execution. Confirm the pipeline tools are exposed in the session first.

## Editable source

Call `pipeline_describe` for the live document and step schemas. Save `.pipeline.json` with stable step IDs, check with `pipeline_validate`, and preview unfamiliar plans with `pipeline_run` (`dry: true`). Step `inputs` exclude job controls (`cwd`, `wait`, `dry`, `resume`); single-image and image-list outputs are not interchangeable.

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

Edit `.pipeline.json`, never completed run records under `media/`. Resuming from a `step` reruns that step and its dependents, reusing earlier outputs only when inputs and hashes match (`resume` requires `step`; full runs rerun all steps).

## ComfyUI format

Inspect a single-request workflow via `image_generate` (`dry: true`) or import editable steps via `pipeline_import_workflow`, checking mapped/skipped nodes and overrides before rendering (paths resolve beside the workflow; arbitrary custom nodes do not run).

**CODE inspected 2026-11-13, media 0.2.9:** `src/extensions/bundled/mercury-media/server/server.js` runs resolveSampling once for both writeExport and rendering, refusing unknown sampling defaults or unrepresentable custom sigma schedules; do not force explicit CFG/sampler overrides or drop a saved schedule just to export.

`export_workflow` exports one request as API JSON (even with `dry: true`); `pipeline_export_workflow` exports mappable steps only (`downsize`, `palette`, `sheet`, `count` > 1 and `pixel-party-xl` downsize refuse; keep the user's pipeline rather than stripping steps, and choose a new destination path since existing files are never overwritten).

## Remote execution

`media.host` targets an existing SSH rental (never rents one; do not switch hosts silently to fit a render, and check model/adapter hosting + commercial terms first). Only prompts, settings and referenced inputs/adapters transfer to the host; `.pipeline.json` and finished outputs stay local (`pipeline_run` `dry: true` sends only the document, while workflow import/export can transfer referenced inputs). A disconnect does not cancel an async remote job: reconnect and query its job ID via `media_result` rather than resubmitting.
