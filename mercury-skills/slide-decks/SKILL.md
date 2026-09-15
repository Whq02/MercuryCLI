---
name: slide-decks
description: Use when creating, reading or revising PowerPoint decks, layouts or speaker notes. Not for Word, spreadsheets, PDFs or web interfaces.
argument-hint: "<file.pptx or new> [operation]"
---
# Slide decks

- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Inspect titles, layouts, text, notes and image relationships with `python3 "${MERCURY_SKILL_DIR}/scripts/deck_outline.py" deck.pptx`; use `--self-test` to test the helper.
- Load the supplied template with `Presentation(path)` from python-pptx.
- Check `slide_width` and `slide_height`; `Presentation()` defaults to 4:3, not 16:9.
- Inspect layout names and placeholder indices before adding slides.
- Fill template placeholders; add free shapes only when no placeholder fits.
- Edit run text to preserve formatting; replacing a text frame replaces its paragraphs and runs.
- Use `add_table` for tables and `add_chart` with `CategoryChartData` for editable charts.
- Size pictures with one dimension to preserve aspect ratio; align to the slide grid.
- Write notes through `notes_slide.notes_text_frame` when present.
- Treat slide reordering/deletion as package-level work; preserve slide relationships rather than blindly editing private lists.
- Split crowded content rather than shrinking it indefinitely.
- Save separately; render with `soffice --headless --convert-to pdf deck.pptx`.
- Inspect every rendered slide for clipping, overlap and empty placeholders; recheck slide order, notes and editability.

## Sources
Checked: 2026-09-15. [python-pptx](https://python-pptx.readthedocs.io/en/latest/user/presentations.html), [API source](https://github.com/scanny/python-pptx/tree/master/src/pptx), [LibreOffice](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html).
