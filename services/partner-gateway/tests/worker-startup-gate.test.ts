import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gateWorkerStartup } from "../src/services/worker-startup-gate.js";

describe("standby deployment worker gate", () => {
  let directory: string | undefined;
  afterEach(() => {
    vi.useRealTimers();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });
  it("starts existing deployments immediately when no gate is configured", () => {
    const start = vi.fn(); const stop = gateWorkerStartup(start, "");
    expect(start).toHaveBeenCalledTimes(1); stop();
  });
  it("keeps a standby instance passive, starts exactly once, and resumes correctly after restart", async () => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), "quefa-gate-"));
    const gate = join(directory, "activate-workers");
    const start = vi.fn(), stop = gateWorkerStartup(start, gate);
    await vi.advanceTimersByTimeAsync(10_000); expect(start).not.toHaveBeenCalled();
    writeFileSync(gate, "approved handoff\n");
    await vi.advanceTimersByTimeAsync(5_000); expect(start).toHaveBeenCalledTimes(1); stop();
    const afterRestart = vi.fn(), close = gateWorkerStartup(afterRestart, gate);
    expect(afterRestart).toHaveBeenCalledTimes(1); close();
  });
  it("cannot start workers after the standby app is closed", async () => {
    vi.useFakeTimers();
    directory = mkdtempSync(join(tmpdir(), "quefa-gate-"));
    const gate = join(directory, "activate-workers");
    const start = vi.fn(), stop = gateWorkerStartup(start, gate); stop();
    writeFileSync(gate, "go\n"); await vi.advanceTimersByTimeAsync(2_000);
    expect(start).not.toHaveBeenCalled();
  });
});
