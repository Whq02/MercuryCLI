# Editable pipelines and workflow files

## Save, run, change one step

1. Call `pipeline_describe` with no pipeline. It returns the schema and step kinds; Mercury also lists the project's pipeline files. Read an existing file before editing it.
2. Save a JSON document as a project file ending in .pipeline.json, beside `media/`. It has `version` 1, a `name`, and ordered `steps`. Each step has a unique `id`, a `kind` and `inputs`. The id begins with a letter and uses letters, digits, dots, underscores or hyphens, at most 128 characters.
3. Use a local path or an earlier output reference for image inputs. `{"step":"draw","output":"image"}` means one image; output `images` means the batch, usable as a sheet's image list. Never reference a later step.
4. Call `pipeline_validate` with `pipeline` as the file path or document, and `cwd` when the project is not supplied by the session. Read every returned step/field error. Call `pipeline_run` with `dry: true` to see the expanded plan without rendering or writing run files.
5. Call `pipeline_run` without dry. `wait: true` waits for completion; otherwise use `media_jobs` and `media_result` with the returned job id. Inspect the saved images.
6. Edit one step's inputs in the source file, retaining its id. Validate again, then run with `step` set to that id. The selected step and every later step run again. Earlier outputs are reused only if inputs and saved file hashes match; changed or missing ancestors run again. A whole run, without step, does not reuse results. Optional `resume` names a compatible earlier run record and requires `step`; omitted, the latest compatible record is used.
7. Outputs and the record `media/pipeline-<run-id>.json` land under the project even if normal images use a different output folder. The result's record path locates it; it holds the source document, settings, models, seeds, saved paths and hashes. Source edits do not rewrite old records. The permission details name the pipeline and start step.

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

Tool: `pipeline_validate`
```json
{"pipeline":"landscape.pipeline.json"}
```

Tool: `pipeline_run`
```json
{"pipeline":"landscape.pipeline.json","dry":true}
```

After changing small's factor, rerun it and the output step:

Tool: `pipeline_run`
```json
{"pipeline":"landscape.pipeline.json","step":"small","wait":true}
```

## Step inputs

Read the schema from `pipeline_describe` for the complete generation settings; its step schemas, not the job schema, own these inputs. In particular, `cwd`, `wait`, `dry`, `resume` and `export_workflow` are not generation-step fields.

| Kind | Inputs and purpose |
| --- | --- |
| `generate` | Image settings, including `prompt` or `workflow`; no job controls. |
| `edit` | Generation settings with required `reference_image`, which may be an earlier output. |
| `control` | Generation settings with required `control`, including its `image` and `kind`. |
| `upscale` | `image`, integer `factor` at least 2, optional `upscaler`; can enlarge a saved file without diffusion. |
| `downsize` | `image`, integer `factor` 1 to 64; nearest-neighbour reduction. |
| `palette` | `image`, `palette` as a colour count or palette file. |
| `sheet` | `images` as an array of image inputs or an earlier batch reference, `columns` 1 to 16, no greater than the image count. |
| `file` | `path` to copy into the run. Optional `mask` has `channel` (alpha, red, green or blue) and integer `grow` 0 to 4096 pixels. |
| `output` | `image` to return as a selected output. |
| `workflow-import` | `path` to a workflow file to expand into steps. |

Every completed step produces a single-image output and an image-list output; that does not mean every kind accepts both as inputs.

## Import and export

- **One render request:** call `image_generate` with `workflow` and `dry: true` first. It reads ComfyUI UI or API JSON, returns the node-to-field mapping, skipped nodes and overrides. Explicit fields in the call override the file, so omit `model` unless deliberately replacing its selection. Paths in the workflow resolve beside it; checkpoints must match a catalogue row or registered file. Inspect the mapping, then omit dry to render.
- **Editable document:** call `pipeline_import_workflow` with `workflow`; optional `name` labels it and `destination` saves a new .pipeline.json. Read the returned steps, validate and run as above. Omit destination to inspect without saving a pipeline file.
- **One request out:** `image_generate` with `export_workflow` writes ComfyUI API JSON; adding `dry: true` exports without rendering. Effective defaults and the chosen seed are written into it. The path must not exist.
- **Pipeline out:** `pipeline_export_workflow` needs `pipeline` and a new `destination`. It exports only what the mapper can represent: one render with supported inputs and optional upscale/output steps. Multiple renders, downsize, palette or sheet processing cannot be exported; an effective Pixel Party downsize also prevents export. Read the named step failures and explain the unsupported part. Never delete steps or change the user's intended image merely to obtain an export. The small-landscape example above is deliberately not exportable because it downsizes.
- Unsupported workflow nodes, incompatible branches, unrepresentable samplers or schedulers, and differing model/CLIP LoRA strengths are refused by name. Mercury does not run arbitrary workflow custom nodes. Both export tools refuse existing destinations instead of overwriting.

Tool: `image_generate`
```json
{"workflow":"portrait.json","dry":true}
```

Tool: `pipeline_import_workflow`
```json
{"workflow":"portrait.json","destination":"portrait.pipeline.json"}
```

For a pipeline whose steps can be represented by the workflow format:

Tool: `pipeline_export_workflow`
```json
{"pipeline":"portrait.pipeline.json","destination":"portrait-api.json"}
```

Tool: `image_generate`
```json
{"prompt":"a cottage beside a river","seed":42,"dry":true,"export_workflow":"cottage-api.json"}
```

Import/export may read image dependencies and create mask files. On a rented host they can transfer referenced inputs even without rendering; a pipeline dry run sends only the document. Do not describe export as a render or as a no-file operation. Sources and engine revision: `references/sources.md`.
