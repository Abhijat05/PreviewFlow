// frontend/src/tests/metrics.test.js
import { describe, it, expect } from "vitest";
import {
  formatBytes,
  formatPercent,
  formatUptime,
  bytesToMB,
  getChartTimestamp
} from "../lib/metrics.js";

describe("8. Metrics Utility Functions", () => {
  describe("formatBytes", () => {
    it("returns '—' when bytes is undefined or null", () => {
      expect(formatBytes(undefined)).toBe("—");
      expect(formatBytes(null)).toBe("—");
    });

    it("returns '0 MB' when bytes is 0", () => {
      expect(formatBytes(0)).toBe("0 MB");
    });

    it("formats bytes into MB and GB correctly", () => {
      expect(formatBytes(1048576)).toBe("1 MB");
      expect(formatBytes(524288000)).toBe("500 MB");
      expect(formatBytes(1073741824)).toBe("1 GB");
      expect(formatBytes(2147483648, 2)).toBe("2 GB");
    });
  });

  describe("formatPercent", () => {
    it("returns '—' when value is undefined or null", () => {
      expect(formatPercent(undefined)).toBe("—");
      expect(formatPercent(null)).toBe("—");
    });

    it("formats numbers into percentages with specified decimals", () => {
      expect(formatPercent(45.678)).toBe("45.7%");
      expect(formatPercent(100, 0)).toBe("100%");
      expect(formatPercent(0)).toBe("0.0%");
    });
  });

  describe("formatUptime", () => {
    it("returns '—' when seconds is undefined or null", () => {
      expect(formatUptime(undefined)).toBe("—");
      expect(formatUptime(null)).toBe("—");
    });

    it("formats elapsed seconds into hh:mm:ss", () => {
      expect(formatUptime(0)).toBe("00:00:00");
      expect(formatUptime(65)).toBe("00:01:05");
      expect(formatUptime(3665)).toBe("01:01:05");
      expect(formatUptime(86400)).toBe("24:00:00");
    });
  });

  describe("bytesToMB", () => {
    it("returns 0 for falsy or 0 byte inputs", () => {
      expect(bytesToMB(0)).toBe(0);
      expect(bytesToMB(null)).toBe(0);
    });

    it("converts bytes to MB rounded to 1 decimal place", () => {
      expect(bytesToMB(104857600)).toBe(100);
      expect(bytesToMB(52428800)).toBe(50);
    });
  });

  describe("getChartTimestamp", () => {
    it("produces formatted 2-digit time string", () => {
      const fixedDate = new Date(2026, 0, 1, 14, 30, 45);
      const str = getChartTimestamp(fixedDate);
      expect(str).toMatch(/\d{2}:\d{2}:\d{2}/);
    });
  });
});
