// The profile's merge/deploy switches. Their state is the bot record and
// nothing else: absent reads as off, and each switch names itself so a
// screen reader can tell the two apart.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BotCapabilitiesCard } from "./BotCapabilitiesCard";
import type { BotCapabilities } from "../../shared/workflow";

const card = (bot: BotCapabilities) =>
  renderToStaticMarkup(createElement(BotCapabilitiesCard, { bot, onPatch: vi.fn() }));

const switchState = (markup: string, label: string): string | null =>
  new RegExp(`aria-label="${label}"[^>]*aria-checked="(true|false)"`).exec(markup)?.[1] ?? null;

describe("BotCapabilitiesCard", () => {
  it("reads each switch off the bot record, with absent meaning off", () => {
    const merging = card({ canMerge: true });
    expect(switchState(merging, "Can merge pull requests")).toBe("true");
    expect(switchState(merging, "Can deploy to production")).toBe("false");

    const deploying = card({ canDeploy: true, canMerge: false });
    expect(switchState(deploying, "Can merge pull requests")).toBe("false");
    expect(switchState(deploying, "Can deploy to production")).toBe("true");

    const neither = card({});
    expect(switchState(neither, "Can merge pull requests")).toBe("false");
    expect(switchState(neither, "Can deploy to production")).toBe("false");
  });

  it("says what each permission gates, in visible text", () => {
    const text = card({}).replace(/<[^>]*>/g, " ");
    expect(text).toContain("Workflow steps that merge will refuse to run on this bot otherwise.");
    expect(text).toContain("Workflow steps that deploy will refuse to run on this bot otherwise.");
    expect(card({})).not.toContain("title=");
  });
});
