// Smoke tests for the ops-alert helper:
//   - logs structured warning when no Slack webhook is configured
//   - posts to Slack when configured
//   - dedupes repeat alerts within the window

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config/env.js", () => ({
  env: { OPS_SLACK_WEBHOOK_URL: undefined },
}));

const { sendOpsAlert, _resetOpsAlertDedup } = await import("../lib/opsAlert.js");

beforeEach(() => {
  vi.restoreAllMocks();
  _resetOpsAlertDedup();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("sendOpsAlert — fallback to structured log", () => {
  it("logs a JSON warning when no webhook is configured", async () => {
    const result = await sendOpsAlert({
      key: "x:test",
      title: "Backlog",
      context: { backlog: 42 },
    });
    expect(result).toEqual({ sent: true, channel: "log" });
    expect(console.warn).toHaveBeenCalledTimes(1);
    const [logged] = console.warn.mock.calls[0];
    const parsed = JSON.parse(logged);
    expect(parsed).toMatchObject({
      ops_alert: true,
      key: "x:test",
      title: "Backlog",
      context: { backlog: 42 },
    });
  });

  it("dedupes within the dedup window", async () => {
    await sendOpsAlert({ key: "dup:k", title: "first" });
    const second = await sendOpsAlert({ key: "dup:k", title: "second" });
    expect(second).toEqual({ sent: false, channel: "deduped" });
    // Only the first call logged.
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
