import { describe, expect, test } from "bun:test";
import { validateConfigValue } from "../be/swarm-config-guard";

const BOOLEAN_KEYS = [
  "DREAMING_ENABLED",
  "DREAMING_LANE_HEARTBEAT",
  "DREAMING_LANE_TRIM",
  "DREAMING_LANE_IDENTITY",
  "DREAMING_LANE_MEMORY",
  "DREAMING_LANE_SKILLIFY",
  "DREAMING_LANE_SCRIPTIFY",
] as const;

const CAP_KEYS = [
  "DREAMING_CAP_IDENTITY_TOTAL",
  "DREAMING_CAP_IDENTITY_PER_AGENT",
  "DREAMING_CAP_MEMORY_STORE",
  "DREAMING_CAP_MEMORY_EDIT",
  "DREAMING_CAP_MEMORY_DELETE",
  "DREAMING_CAP_SKILL_CREATE",
  "DREAMING_CAP_SKILL_UPDATE",
  "DREAMING_CAP_SCRIPT_BUILDS",
  // 0 turns the adoption gate's retirement off, so it shares the cap rule.
  "DREAMING_ADOPTION_GATE_DAYS",
] as const;

describe("dreaming boolean validators", () => {
  for (const key of BOOLEAN_KEYS) {
    test(`${key} accepts boolean literals`, () => {
      for (const value of ["true", "false", "1", "0", "TRUE", " false "]) {
        expect(validateConfigValue(key, value)).toBeNull();
      }
    });

    test(`${key} rejects non-boolean values`, () => {
      for (const value of ["yes", "on", "", "2"]) {
        expect(typeof validateConfigValue(key, value)).toBe("string");
      }
    });
  }
});

describe("dreaming cap validators", () => {
  for (const key of CAP_KEYS) {
    test(`${key} accepts non-negative integers`, () => {
      expect(validateConfigValue(key, "0")).toBeNull();
      expect(validateConfigValue(key, "3")).toBeNull();
      expect(validateConfigValue(key, "100")).toBeNull();
    });

    test(`${key} rejects negative, fractional and non-numeric values`, () => {
      for (const value of ["-1", "1.5", "x", ""]) {
        expect(typeof validateConfigValue(key, value)).toBe("string");
      }
    });
  }

  test("DREAMING_CAP_TRIMS accepts 0..12, the dream-trim ceiling, and rejects the rest", () => {
    for (const value of ["0", "3", "12"]) {
      expect(validateConfigValue("DREAMING_CAP_TRIMS", value)).toBeNull();
    }
    for (const value of ["13", "100", "1.5", "x", ""]) {
      expect(typeof validateConfigValue("DREAMING_CAP_TRIMS", value)).toBe("string");
    }
    expect(validateConfigValue("DREAMING_CAP_TRIMS", "-1")).toBe(
      "Invalid DREAMING_CAP_TRIMS (must be an integer between 0 and 12)",
    );
  });
});

describe("DREAMING_BUDGET_USD validator", () => {
  const KEY = "DREAMING_BUDGET_USD";

  test("accepts integers between 1 and 1000", () => {
    expect(validateConfigValue(KEY, "1")).toBeNull();
    expect(validateConfigValue(KEY, "25")).toBeNull();
    expect(validateConfigValue(KEY, "1000")).toBeNull();
  });

  test("rejects out-of-range and non-integer values", () => {
    for (const value of ["0", "1001", "-5", "12.5", "abc"]) {
      expect(typeof validateConfigValue(KEY, value)).toBe("string");
    }
  });
});

describe("DREAMING_REPORT_TARGET validator", () => {
  const KEY = "DREAMING_REPORT_TARGET";

  test("accepts page, agent-fs and none", () => {
    for (const value of ["page", "agent-fs", "none"]) {
      expect(validateConfigValue(KEY, value)).toBeNull();
    }
  });

  test("rejects anything else", () => {
    for (const value of ["slack", "", "PAGE", "agentfs"]) {
      expect(typeof validateConfigValue(KEY, value)).toBe("string");
    }
  });
});

describe("DREAMING_WORKER_AGENT_ID validator", () => {
  const KEY = "DREAMING_WORKER_AGENT_ID";

  test("accepts a UUID or empty", () => {
    expect(validateConfigValue(KEY, "")).toBeNull();
    expect(validateConfigValue(KEY, "   ")).toBeNull();
    const id = crypto.randomUUID();
    expect(validateConfigValue(KEY, id)).toBeNull();
    expect(validateConfigValue(KEY, id.toUpperCase())).toBeNull();
  });

  test("rejects non-UUID values", () => {
    for (const value of ["lead", "123e4567-e89b-12d3-a456", "not-a-uuid-at-all-0000000000000000"]) {
      expect(typeof validateConfigValue(KEY, value)).toBe("string");
    }
    expect(typeof validateConfigValue(KEY, 42)).toBe("string");
  });
});

describe("DREAMING_SLACK_CHANNEL", () => {
  test("is free-form (no validator)", () => {
    expect(validateConfigValue("DREAMING_SLACK_CHANNEL", "")).toBeNull();
    expect(validateConfigValue("DREAMING_SLACK_CHANNEL", "#dreams")).toBeNull();
  });
});
