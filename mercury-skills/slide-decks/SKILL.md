---
name: slide-decks
description: Use when creating or revising PowerPoint slides, layouts and notes. Not for web interfaces or prose documents.
argument-hint: "<file.pptx or new> [operation]"
---
# Slide decks

Map the requested content to the supplied deck's slide order, dimensions, layouts and placeholders. For a new deck, set the requested aspect ratio explicitly: python-pptx's default presentation is 4:3. Check the installed authoring library and renderer before relying on either.

Populate the template rather than imitating it with unrelated shapes. Preserve run formatting, picture proportions and editable charts; move crowded content onto another slide instead of shrinking it beyond readability. Keep speaker notes attached to the right slide.

Reordering or removing slides must preserve package relationships, not merely alter a private slide list. If the toolchain cannot preserve an existing feature, disclose that before converting or rewriting it.

Save separately and reopen to check order, notes and object counts. Render every slide with the available Office renderer, then inspect the pages or images with Mercury `Read` for overlap, clipping and empty placeholders. A parseable PPTX is not a visual pass; report unrendered slides as unverified.
