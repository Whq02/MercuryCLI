// The one frame interval behind render throttling and animations: 16ms ≈ 60fps.
export const FRAME_INTERVAL_MS = 16

// Resize settle window: WINCH events closer together than this are one STORM
// (a drag). Full relayout + repaint land ONCE, after this much quiet — an
// intermediate size never pays a reflow; the screen holds the last frame
// clipped to the live size until then.
export const RESIZE_SETTLE_MS = 120
