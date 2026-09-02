---
name: drafting-partner
description: Co-write a substantial document with the user — a proposal, spec, report, policy, or long memo — by agreeing the brief, building the outline together, drafting section by section, and running review passes that the user steers. Use when the user wants to write something with you rather than have it generated in one shot; not for code, short messages, or editing a finished file's formatting.
when_to_use: The user says "help me write", "let's draft", "I need a document for…", shares notes to turn into a document, or wants structured feedback on a draft.
argument-hint: "<document type and purpose> [existing notes or draft path]"
---

# Drafting partner

Long documents fail when the writer drafts before the reader is known. Work in
four moves, each closing with something the user can react to, and never
skip a move because the answer seems obvious.

## 1. The brief (one exchange)

Ask, in one message, for what is missing from: the reader and what they
decide after reading; the outcome the author wants; length and form; the
material that exists (notes, data, prior versions); and the deadline.
Restate the brief in four lines and get a yes. If the user gave a draft, read
it fully first and restate what it currently argues.

## 2. The outline (agree before drafting)

Propose an outline with one line per section stating the section's claim or
job, not its topic ("Costs rise 12% under option B" rather than "Costs").
Keep it to what the reader needs to decide; cut sections that only show
work. Ask the user to strike, reorder, or add, then freeze it. Check the
structure mechanically:

```bash
python3 scripts/outline_check.py draft.md     # heading levels, empty sections, duplicates, length balance
python3 scripts/outline_check.py --self-test
```

## 3. Drafting

- Draft one section at a time in the agreed order, lead each with its claim,
  and stop after each for a steer when the user asked to be involved; draft
  the whole when they asked for a full pass.
- Use the user's material verbatim for facts and figures; mark every number
  you did not get from them as `[confirm]`. Never invent a statistic, quote,
  or citation.
- Match the form: a spec gets numbered requirements and acceptance criteria;
  a proposal gets a recommendation first and options after; a report leads
  with findings.
- Keep the voice the user writes in. Read two paragraphs of their prior
  writing and hold to that register.

## 4. Review passes (the user picks which)

Offer these as separate passes and run only the ones chosen:

- **Argument** — does each section deliver its claim; is anything asserted
  without support; would the reader's first objection be answered?
- **Reader** — can the decision be made from the first page; is every term
  defined the first time it appears?
- **Cut** — remove what the reader does not need; target a length.
- **Line** — sentences, transitions, consistency of names and numbers.
- **Fact** — every `[confirm]` resolved or removed; dates, figures, and names
  checked against the source material.

After each pass, list what changed and what you left alone on purpose.

## Finishing

Deliver in the form agreed (Markdown, a Word file via the word-documents
skill, a PDF via the pdf-documents skill). Run the outline check once more
on the final draft and hand over with the three open questions the reader
will most likely raise.
