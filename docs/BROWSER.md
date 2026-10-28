# Browser

Browser drives a separate browser for each agent. An approval belongs to that agent and lasts only while its browser remains open.

## Sessions

Each parent session allows three child browsers by default, with an additional slot reserved for the lead. `MERCURY_BROWSER_MAX_SESSIONS` changes the child allowance. Children cannot consume the lead's slot, and separate parent sessions have separate allowances.

A browser closes after five minutes without an operation. This leaves time to read and reason between acts while releasing unused browsers. Running operations keep their browser alive; the five-minute lease starts again when the last operation finishes. Closing or expiry clears origin approvals and secret-fill approvals. Use `op:"open"` to start another browser, or `op:"close"` to release one immediately.

## Frames

`extract` lists child-frame indices and URLs. Pass `frame: 1` for the first child frame, `frame: 0` for the main frame, or a unique URL substring such as `frame: "/embedded-form"`. Use this with click, type, scroll, waitFor, select, hover, extract or an element screenshot. CSS, accessible-name, text, XPath and `>>>` shadow selectors resolve inside the selected frame. Missing or ambiguous frames fail rather than targeting the main page.

Frame acts require approval for the frame's own origin. The embedding page's approval does not cover a different origin; secret fills keep their separate secret-origin approval. An opaque sandboxed frame cannot borrow the embedding page's origin for a secret fill.

## Covered targets

A selector click checks for overlays in the frame and its embedding frames. When another element covers the target, the result names it and suggests clicking it to dismiss it or scrolling the target into view.

After reading the overlay, `force: true` with a selector dispatches a DOM click directly to the covered target. This is not a pointer click through the overlay. The default actionability check remains in place, and disabled controls still refuse.
