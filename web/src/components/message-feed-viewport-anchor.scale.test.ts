// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  findVisibleFeedAnchorInContainer,
  getFeedElementScrollOffset,
  getFeedViewportScale,
  getViewportAnchorOffset,
} from "./message-feed-viewport-anchor.js";

afterEach(() => document.body.replaceChildren());

describe("feed viewport coordinate units", () => {
  it.each([
    0.9, 1, 1.25,
  ])("keeps scroll offsets in layout pixels and saved anchors in visual pixels at %s scale", (scale) => {
    // Fractional computed height is authoritative; the rounded offsetHeight
    // would introduce residual drift when converting a large paging correction.
    const container = document.createElement("div");
    container.style.height = "881.609px";
    container.style.boxSizing = "border-box";
    Object.defineProperty(container, "offsetHeight", { value: 882 });
    container.getBoundingClientRect = () => DOMRect.fromRect({ y: 40, width: 600, height: 881.609 * scale });
    container.scrollTop = 50;
    const target = document.createElement("div");
    target.dataset.messageId = "retained-message";
    target.dataset.turnId = "human-turn";
    // A nested offsetParent can supply unrelated offsetTop values. Real visual
    // geometry must determine the element's position within this scroll surface.
    Object.defineProperties(target, { offsetTop: { value: 5 }, offsetHeight: { value: 100 } });
    target.getBoundingClientRect = () =>
      DOMRect.fromRect({ y: 40 + (750 - container.scrollTop) * scale, width: 500, height: 100 * scale });
    container.append(target);
    document.body.append(container);

    expect(getFeedViewportScale(container)).toBeCloseTo(scale, 10);
    expect(getFeedElementScrollOffset(container, target, "top")).toBeCloseTo(750, 10);
    expect(getFeedElementScrollOffset(container, target, "bottom")).toBeCloseTo(850, 10);
    const anchor = findVisibleFeedAnchorInContainer(container);
    expect(anchor?.offsetTop).toBeCloseTo(700 * scale, 10);
    expect(
      getViewportAnchorOffset(container, {
        scrollTop: 50,
        scrollHeight: 1000,
        isAtBottom: false,
        anchorMessageId: "retained-message",
      }),
    ).toBeCloseTo(700 * scale, 10);
  });

  it("includes padding and borders when measuring a content-box container", () => {
    const container = document.createElement("div");
    container.style.cssText =
      "box-sizing:content-box;height:700.125px;padding-top:4.25px;padding-bottom:8.75px;border-top:1.5px solid;border-bottom:2.5px solid";
    const borderBoxHeight = 700.125 + 4.25 + 8.75 + 1.5 + 2.5;
    Object.defineProperty(container, "offsetHeight", { value: Math.round(borderBoxHeight) });
    container.getBoundingClientRect = () => DOMRect.fromRect({ height: borderBoxHeight * 0.9 });
    document.body.append(container);

    expect(getFeedViewportScale(container)).toBeCloseTo(0.9, 10);
  });

  it("falls back to available layout dimensions and leaves zero-layout fixtures unscaled", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "offsetHeight", { value: 400 });
    container.getBoundingClientRect = () => DOMRect.fromRect({ height: 360 });
    expect(getFeedViewportScale(container)).toBe(0.9);
    expect(getFeedViewportScale(document.createElement("div"))).toBe(1);
  });
});
