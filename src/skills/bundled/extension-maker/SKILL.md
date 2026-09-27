---
name: extension-maker
description: Use when building or repairing a Mercury extension or catalogue. Not for installing or approving one for the operator.
---
# Extension maker

Establish what the extension contributes. Scaffold locally with `mercury extensions init <name>`; inspect the resulting `mercury-extension.json` before editing.

Read `references/CONTRACT.md` under the supplied skill base for manifest fields and substitutions. Declare only needed contributions and keep paths inside the root. Sensitive options belong in script environments, not model-visible text. Approval binds to contributions, needs and delivered file bytes; a version-only change preserves it.

Run `mercury extensions validate <path>`. Exercise the declared contributions, not just the JSON. For a source catalogue, match names and versions to its manifests; use `references/README-template.md` for operator setup.

Deliver the validated folder and the next operator action. Never add a source on their behalf; never approve an extension for them. Publication requires separate authorisation.
