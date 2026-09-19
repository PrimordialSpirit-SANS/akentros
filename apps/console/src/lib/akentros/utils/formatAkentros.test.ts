import { describe, expect, it } from "vitest";
import {
  formatAkentrosTimestamp,
  formatLatency,
  formatModelLimit,
  formatPoints,
  formatTokens,
} from "./formatAkentros";

describe("formatPoints", () => {
  it("formats integers with thousand separators", () => {
    expect(formatPoints(1234567)).toBe("1,234,567");
  });

  it("rounds fractional values", () => {
    expect(formatPoints(10.6)).toBe("11");
  });
});

describe("formatTokens", () => {
  it("keeps small values as-is", () => {
    expect(formatTokens(999)).toBe("999");
  });

  it("compacts thousands with one decimal", () => {
    expect(formatTokens(12_500)).toBe("12.5K");
  });

  it("compacts millions", () => {
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});

describe("formatAkentrosTimestamp", () => {
  it("returns placeholder for missing values", () => {
    expect(formatAkentrosTimestamp(null)).toBe("尚未使用");
    expect(formatAkentrosTimestamp(undefined)).toBe("尚未使用");
    expect(formatAkentrosTimestamp("")).toBe("尚未使用");
  });

  it("returns dash for invalid dates", () => {
    expect(formatAkentrosTimestamp("not-a-date")).toBe("—");
  });

  it("formats valid ISO timestamps in Taipei time", () => {
    // ICU 可能以細空格（U+2009）或窄不換行空格（U+202F）分隔日期與時間，斷言前統一正規化。
    const formatted = formatAkentrosTimestamp("2026-01-02T03:04:00Z").replace(/[\u2009\u202F\u00A0]/g, " ");
    expect(formatted).toBe("2026/01/02 11:04");
  });
});

describe("formatLatency", () => {
  it("returns dash for null or non-finite values", () => {
    expect(formatLatency(null)).toBe("—");
    expect(formatLatency(Number.NaN)).toBe("—");
    expect(formatLatency(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats sub-second latency in milliseconds", () => {
    expect(formatLatency(342.4)).toBe("342 ms");
  });

  it("formats second-scale latency with two decimals", () => {
    expect(formatLatency(1500)).toBe("1.50 s");
  });
});

describe("formatModelLimit", () => {
  it("keeps small limits verbatim", () => {
    expect(formatModelLimit(500)).toBe("500");
  });

  it("compacts thousands", () => {
    expect(formatModelLimit(4000)).toBe("4K");
  });
});
