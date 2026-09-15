---
name: aesthetic-direction
description: Use when designing or restyling a web interface's typography, colour, layout and motion. Not for terminal interfaces, print or brand-guideline documents.
argument-hint: "<interface> [audience] [constraints]"
---
# Aesthetic direction

- Read the interface and brand constraints.
- State the audience, intended impression and visual reference in one sentence.
- Derive reusable type, colour, spacing, geometry and motion tokens.

## Type and layout
- Choose display and text faces; reserve a third for code or data.
- Define body size, scale, line heights, tracking and reading measure.
- Start body text at 16–18px, line-height at 1.5–1.65 and measure at 60–75 characters.
- Use `font-display: swap` with a metric-compatible fallback; test loading for layout shift.
- Define spacing units, columns, gutters and maximum width.
- Assign a focal element and consistent depth treatment.

## Colour and interaction
- Define ground, ink, accent and semantic colours; derive supporting shades.
- Design each light or dark theme separately.
- Check normal text at 4.5:1 and large text at 3:1; large means 18pt regular or 14pt bold.
- Check necessary control, state and graphical cues at 3:1; exempt inactive and unmodified native controls.
- Resolve `${MERCURY_SKILL_DIR}` from the supplied base directory.
- Check colour pairs with `python3 "${MERCURY_SKILL_DIR}/scripts/palette_check.py" '#111111' '#ffffff'`; use `--self-test` to test the helper.
- Define focus rings, underlines, field radii, table rules and empty states as tokens.
- Remove non-essential motion under `prefers-reduced-motion`.
- Inspect at 360px, 768px and 1440px; use `references/anti-defaults.md` to review generic results.

## Sources
Checked: 2026-09-15.
[Text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), [font loading](https://web.dev/articles/font-best-practices), [reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion).
