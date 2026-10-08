// Owner-scoped session abort/wait helpers used by Gateway Stop and session lifecycle drains.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  abortOwnedEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isOwnedEmbeddedAgentRunInProgress,
  setActiveEmbeddedRun,
  waitForOwnedEmbeddedAgentRunEnd,
} from "./runs.js";
import { createEmbeddedRunHandle, testing } from "./runs.test-support.js";

const sessionId = "shared-session";
const main = { agentId: "main", defaultAgentId: "main" };

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyRunTesting.resetReplyRunRegistry();
});

describe("owner-scoped embedded run helpers", () => {
  it("leaves another agent's run on the same session id alone", async () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, runId: "work-run" });
    setActiveEmbeddedRun(sessionId, handle, "agent:work:main", undefined, "work");

    expect(isOwnedEmbeddedAgentRunInProgress(sessionId, main)).toBe(false);
    expect(abortOwnedEmbeddedAgentRun(sessionId, main)).toBe(false);
    await expect(waitForOwnedEmbeddedAgentRunEnd(sessionId, 50, main)).resolves.toBe(true);
    expect(abort).not.toHaveBeenCalled();
    expect(isOwnedEmbeddedAgentRunInProgress(sessionId, { agentId: "work" })).toBe(true);
  });

  it("aborts and waits for the owner's run", async () => {
    const abort = vi.fn();
    const handle = createEmbeddedRunHandle({ abort, runId: "main-run" });
    setActiveEmbeddedRun(sessionId, handle, "agent:main:main", undefined, "main");

    expect(isOwnedEmbeddedAgentRunInProgress(sessionId, main)).toBe(true);
    const ended = waitForOwnedEmbeddedAgentRunEnd(sessionId, 1_000, main);
    expect(abortOwnedEmbeddedAgentRun(sessionId, main)).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    clearActiveEmbeddedRun(sessionId, handle, "agent:main:main");
    await expect(ended).resolves.toBe(true);
  });

  it("resolves an unscoped key through the default agent", () => {
    const abort = vi.fn();
    setActiveEmbeddedRun(sessionId, createEmbeddedRunHandle({ abort }), "main");

    expect(abortOwnedEmbeddedAgentRun(sessionId, { agentId: "work", defaultAgentId: "main" })).toBe(
      false,
    );
    expect(abortOwnedEmbeddedAgentRun(sessionId, main)).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("only cancels a reply operation owned by the requesting agent", () => {
    const operation = createReplyOperation({
      sessionId,
      sessionKey: "agent:work:main",
      agentId: "work",
      resetTriggered: false,
    });
    operation.setPhase("running");

    expect(abortOwnedEmbeddedAgentRun(sessionId, main)).toBe(false);
    expect(operation.abortSignal.aborted).toBe(false);
    expect(abortOwnedEmbeddedAgentRun(sessionId, { agentId: "work" })).toBe(true);
    expect(operation.abortSignal.aborted).toBe(true);
  });
});
