import { afterEach, describe, expect, it, vi } from "vitest";
import { printCommandHelp, printUsage } from "./takode-help.js";

describe("takode help", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits superseded leader authoring commands from public help", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    printUsage();

    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).not.toContain("thread-response");
    expect(output).not.toContain("user-message");
    expect(printCommandHelp("thread-response", [])).toBe(false);
    expect(printCommandHelp("user-message", [])).toBe(false);
  });

  it("documents session-scoped human and timer-firing retrieval on the existing read command", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(printCommandHelp("read", [])).toBe(true);

    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("takode read <session> <history-index|uN|timer-mN>");
    expect(output).toContain("Leader source-envelope IDs such as u12");
    expect(output).toContain("session-scoped");
    expect(output).toContain("timer-m3 (individual timer firing)");
    expect(output).toContain("cannot select an individual firing");
    expect(output).toContain("fN references still select their exact historical messages");
    expect(output).toContain("they are not aliases");
  });
});
