---
name: extension-maker
description: Use when building or repairing a Mercury extension or catalogue. Not for installing or approving one for the operator.
---
# Extension maker

Establish what the extension contributes, scaffold locally with `mercury extensions scaffold <name>`, and inspect the generated `mercury-extension.json` before editing. Declare only needed contributions.

Read on demand under this skill's base directory:
- `references/CONTRACT.md` — manifest and catalogue schemas, path containment, substitutions, sensitive-option environment rules and contributions-hash approval.
- `references/README-template.md` — operator setup README template when building a source catalogue (match catalogue names and versions to each extension's manifest).

Validate with `mercury extensions inspect <path>` and exercise every declared contribution, not just the JSON. Deliver the validated folder and the operator's next step: never add a source on their behalf, never approve an extension for them, and require separate authorisation before publishing.
