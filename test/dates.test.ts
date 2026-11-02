import { describe, expect, it } from "vitest";
import { dayFromPath, longDate, monthLabel, permalink, shortDate, todayInBerlin } from "../src/worker/lib/dates";

describe("dates", () => {
  it("formats a day without time zone shifts", () => {
    expect(permalink("2026-10-18")).toBe("/2026/10/18");
    expect(longDate("2026-10-08")).toBe("08 October 2026");
    expect(shortDate("2026-10-08")).toBe("08 Oct");
    expect(monthLabel("2026-01-31")).toBe("January 2026");
  });

  it("validates and normalises permalink paths", () => {
    expect(dayFromPath("2026", "1", "5")).toBe("2026-01-05");
    expect(dayFromPath("2026", "02", "30")).toBeNull();
    expect(dayFromPath("2026", "13", "01")).toBeNull();
  });

  it("uses the Berlin calendar day", () => {
    // 23:30 UTC on 31 Dec is already 1 Jan in Berlin.
    expect(todayInBerlin(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    expect(todayInBerlin(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01");
  });
});
