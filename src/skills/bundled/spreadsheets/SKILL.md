---
name: spreadsheets
description: Use when reading, creating or repairing Excel workbooks, formulas or CSV-to-Excel output. Not for Word, slides, PDFs or databases.
argument-hint: "<file.xlsx or new> [operation]"
---
# Spreadsheets

- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Inspect sheets, dimensions, headers and formulas with `python3 "${MERCURY_SKILL_DIR}/scripts/sheet_summary.py" workbook.xlsx`; use `--self-test` to test the helper.
- Load editable formulas with openpyxl's `load_workbook("workbook.xlsx", data_only=False)`; use a separate `data_only=True` load for cached values.
- Treat missing or stale caches as unknown, not computed results; openpyxl does not calculate formulas.
- Check preservation requirements for macros, links, rich text and unsupported workbook features before saving.
- Keep numbers/dates typed; write untrusted imported text as text, not formulas.
- Write formulas with `=`, English function names and comma separators; quote sheet names in references.
- Apply number formats, header styles, freeze panes, widths and filters; avoid merged data cells.
- Use validation, conditional formatting and editable charts where needed.
- Use pandas for tabular analysis/export; apply formatting explicitly afterwards.
- Recalculate with Excel or LibreOffice; save separately, reopen cached values and inspect formula errors.
- Check sheet names, headers, counts and representative formulas against independent calculations.
- Use `read_only=True` or `write_only=True` for large sequential workloads.

## Sources
Checked: 2026-09-15. [openpyxl](https://openpyxl.readthedocs.io/en/stable/), [pandas](https://pandas.pydata.org/docs/reference/api/pandas.read_excel.html), [LibreOffice](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html).
