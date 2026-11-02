import { describe, expect, it } from "vitest";
import { derivativeHeight, masterSize, targetWidths } from "../src/shared/ladder";

describe("masterSize", () => {
  it("caps the longest edge at 3200", () => {
    expect(masterSize(6240, 4160)).toEqual({ width: 3200, height: 2133 });
    expect(masterSize(4000, 6000)).toEqual({ width: 2133, height: 3200 });
  });
  it("never upscales", () => {
    expect(masterSize(1600, 1067)).toEqual({ width: 1600, height: 1067 });
  });
});

describe("targetWidths", () => {
  it("returns the full ladders for a 3200 master", () => {
    expect(targetWidths(3200)).toEqual({ avif: [320, 640, 1280, 1920, 3200], jpeg: [1280, 3200] });
  });
  it("caps at the master width, rounded down to even", () => {
    expect(targetWidths(2133)).toEqual({ avif: [320, 640, 1280, 1920, 2132], jpeg: [1280, 2132] });
  });
  it("collapses duplicate widths for small masters", () => {
    expect(targetWidths(1001)).toEqual({ avif: [320, 640, 1000], jpeg: [1000] });
  });
});

describe("derivativeHeight", () => {
  it("keeps the aspect ratio and an even height", () => {
    expect(derivativeHeight({ width: 3200, height: 2133 }, 3200)).toBe(2132);
    expect(derivativeHeight({ width: 3200, height: 2133 }, 320)).toBe(212);
    expect(derivativeHeight({ width: 2133, height: 3200 }, 2132)).toBe(3198);
  });
});
