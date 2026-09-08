// Dismissing a modal by its backdrop must happen on the CLICK, never on the
// mousedown — and only when the press both started and ended on the backdrop.
//
// Closing on mousedown unmounts the overlay while the button is still down,
// so the mouseup (and the click the browser then synthesizes) land on
// whatever sits underneath. Under the bot settings dialog that is the chat
// header, whose avatar and rename pencil open the very same dialog: the
// person clicks to dismiss, the dialog reopens under their cursor, and it
// reads as "the X does nothing" or "several dialogs stacked up".
//
// Requiring the press to start on the backdrop also keeps a drag that began
// inside the panel — selecting text in a tall SOUL textarea, dragging a
// slider — from dismissing when the pointer is released outside it.
export interface BackdropDismissHandlers<E extends { target: unknown; currentTarget: unknown }> {
  onMouseDown: (event: E) => void;
  onClick: (event: E) => void;
}

/** Backdrop handlers for a modal overlay: `dismiss` runs once per press that
 * both began and ended on the backdrop element itself. */
export function backdropDismiss<E extends { target: unknown; currentTarget: unknown }>(
  dismiss: () => void,
): BackdropDismissHandlers<E> {
  // Per-overlay, not per-module: two overlays on screen keep separate presses.
  let armed = false;
  const onBackdrop = (event: E) => event.target === event.currentTarget;
  return {
    onMouseDown: (event) => {
      armed = onBackdrop(event);
    },
    onClick: (event) => {
      const dismissing = armed && onBackdrop(event);
      // A press that ended inside the panel is spent either way: the next
      // dismissal needs its own press on the backdrop.
      armed = false;
      if (dismissing) dismiss();
    },
  };
}
