// The regression these pin: a backdrop that closed on mousedown let the
// mouseup fall through to the trigger underneath, which reopened the dialog.
import { describe, expect, it, vi } from "vitest";

import { backdropDismiss } from "./modal-dismiss";

const backdrop = { id: "backdrop" };
const panel = { id: "panel" };
const on = (target: unknown) => ({ target, currentTarget: backdrop });

describe("backdropDismiss", () => {
  it("dismisses only after the click, never on the press itself", () => {
    const dismiss = vi.fn();
    const handlers = backdropDismiss(dismiss);
    handlers.onMouseDown(on(backdrop));
    // The overlay must still be mounted here — this is the whole fix: the
    // mouseup lands on the backdrop instead of the trigger underneath it.
    expect(dismiss).not.toHaveBeenCalled();
    handlers.onClick(on(backdrop));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("ignores a press that started inside the panel and ended on the backdrop", () => {
    const dismiss = vi.fn();
    const handlers = backdropDismiss(dismiss);
    handlers.onMouseDown(on(panel)); // selecting text in a tall textarea…
    handlers.onClick(on(backdrop)); // …and releasing past its edge
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("ignores a press that started on the backdrop and ended inside the panel", () => {
    const dismiss = vi.fn();
    const handlers = backdropDismiss(dismiss);
    handlers.onMouseDown(on(backdrop));
    handlers.onClick(on(panel));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("spends the press: a second click needs its own press", () => {
    const dismiss = vi.fn();
    const handlers = backdropDismiss(dismiss);
    handlers.onMouseDown(on(backdrop));
    handlers.onClick(on(backdrop));
    handlers.onClick(on(backdrop));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps two overlays' presses apart", () => {
    const first = vi.fn();
    const second = vi.fn();
    const a = backdropDismiss(first);
    const b = backdropDismiss(second);
    a.onMouseDown(on(backdrop));
    b.onClick(on(backdrop));
    expect(second).not.toHaveBeenCalled();
    a.onClick(on(backdrop));
    expect(first).toHaveBeenCalledTimes(1);
  });
});
