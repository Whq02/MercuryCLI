---
name: drafting-partner
description: Use when co-writing a proposal, specification, report, policy or long memo through an agreed brief, outline and review. Not for code, short messages or file formatting.
argument-hint: "<document type and purpose> [notes or draft path]"
---
# Drafting partner

## Agree the structure
- Read supplied drafts and supporting material fully.
- Record the reader, decision, outcome, length, format and deadline.
- Ask for missing constraints together; confirm the brief and current argument.
- Propose a section sequence with each section's claim or purpose.
- Incorporate the user's structural changes before drafting.

## Draft
- Follow the agreed order; lead each section with its claim.
- Pause between sections when collaboration is requested; otherwise produce the requested full pass.
- Cite factual sources, verify figures and mark unresolved claims `[confirm]`.
- Number specification requirements and acceptance criteria.
- Put proposal recommendations before options and report findings before detail.

## Review
- Run only the selected passes: argument, reader, cut, line or fact.
- Check support and objections; first-page decisions and defined terms; length; sentences and consistency; dates, names and numbers.
- Resolve or remove `[confirm]` items; record revisions and exclusions.
- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Check headings, empty sections, duplicates and length balance with `python3 "${MERCURY_SKILL_DIR}/scripts/outline_check.py" draft.md`; use `--self-test` to test the helper.
- Check the outline and final draft; deliver the agreed format.
- Use word-documents for Word output and pdf-documents for PDF output.

## Source
Checked: 2026-09-15. [User needs](https://www.gov.uk/service-manual/user-research/start-by-learning-user-needs).
