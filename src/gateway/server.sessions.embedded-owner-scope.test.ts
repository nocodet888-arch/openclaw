// Real Gateway WebSocket proof: session Stop and delete only reach the requesting agent's run.
import { expect, test, vi } from "vitest";
import { ACTIVE_EMBEDDED_RUNS } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  bundleMcpRuntimeMocks,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

const MAIN_KEY = "agent:main:main";
const GROUP_STORE_KEY = "discord:group:dev";
const GROUP_KEY = "agent:main:discord:group:dev";

/** An embedded run registered for `agentId`; abort settles it like the production runner. */
function registerEmbeddedRun(params: { sessionId: string; sessionKey: string; agentId: string }) {
  const controller = new AbortController();
  const aborts = vi.fn();
  const handle: Parameters<typeof setActiveEmbeddedRun>[1] = {
    runId: `run-${params.agentId}-${params.sessionId}`,
    abort: () => {
      aborts();
      controller.abort();
      queueMicrotask(() => clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey));
    },
    isAborted: () => controller.signal.aborted,
    isStreaming: () => !controller.signal.aborted,
    isCompacting: () => false,
    queueMessage: async () => {},
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, undefined, params.agentId);
  return {
    aborts,
    isLive: () =>
      ACTIVE_EMBEDDED_RUNS.get(params.sessionId) === handle && !controller.signal.aborted,
    clear: () => clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey),
  };
}

function log(caseName: string, detail: Record<string, unknown>) {
  process.stdout.write(`[gateway-owner-scope] ${caseName} ${JSON.stringify(detail)}\n`);
}

async function seedSession(storeKey: string, sessionId: string) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [storeKey]: sessionStoreEntry(sessionId) }, storePath });
}

test("sessions.abort from agent main leaves a foreign agent's run on the same session id alone", async () => {
  const sessionId = "shared-session-abort-foreign";
  await seedSession("main", sessionId);
  const foreign = registerEmbeddedRun({
    sessionId,
    sessionKey: "agent:work:main",
    agentId: "work",
  });
  const { ws } = await openClient();
  try {
    const result = await rpcReq(ws, "sessions.abort", { key: MAIN_KEY, clearQueued: true });
    log("abort:foreign", {
      ok: result.ok,
      status: (result.payload as { status?: string } | undefined)?.status,
      foreignAborts: foreign.aborts.mock.calls.length,
      foreignLive: foreign.isLive(),
      mcpRetired: bundleMcpRuntimeMocks.retireSessionMcpRuntime.mock.calls.length,
    });
    expect(result.ok).toBe(true);
    expect(foreign.aborts).not.toHaveBeenCalled();
    expect(foreign.isLive()).toBe(true);
    // The shared session-id MCP runtime still serves the foreign run.
    expect(bundleMcpRuntimeMocks.retireSessionMcpRuntime).not.toHaveBeenCalled();
  } finally {
    foreign.clear();
    ws.close();
  }
});

test("sessions.abort from agent main stops main's own run on that session id", async () => {
  const sessionId = "shared-session-abort-owned";
  await seedSession("main", sessionId);
  const owned = registerEmbeddedRun({ sessionId, sessionKey: MAIN_KEY, agentId: "main" });
  const { ws } = await openClient();
  try {
    const result = await rpcReq(ws, "sessions.abort", { key: MAIN_KEY });
    await vi.waitFor(() => expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false));
    log("abort:owned", {
      ok: result.ok,
      status: (result.payload as { status?: string } | undefined)?.status,
      ownedAborts: owned.aborts.mock.calls.length,
      ownedLive: owned.isLive(),
    });
    expect(result.ok).toBe(true);
    expect(owned.aborts).toHaveBeenCalledTimes(1);
    expect(owned.isLive()).toBe(false);
  } finally {
    owned.clear();
    ws.close();
  }
});

test("sessions.delete for agent main drains only main's work, not a foreign run sharing the id", async () => {
  const sessionId = "shared-session-delete-foreign";
  await seedSession(GROUP_STORE_KEY, sessionId);
  const foreign = registerEmbeddedRun({
    sessionId,
    sessionKey: "agent:work:discord:group:dev",
    agentId: "work",
  });
  const { ws } = await openClient();
  try {
    const result = await rpcReq(ws, "sessions.delete", { key: GROUP_KEY }, 30_000);
    log("delete:foreign", {
      ok: result.ok,
      deleted: (result.payload as { deleted?: boolean } | undefined)?.deleted,
      error: result.ok ? undefined : result.error?.message,
      foreignAborts: foreign.aborts.mock.calls.length,
      foreignLive: foreign.isLive(),
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ deleted: true });
    expect(foreign.aborts).not.toHaveBeenCalled();
    expect(foreign.isLive()).toBe(true);
  } finally {
    foreign.clear();
    ws.close();
  }
});

test("sessions.delete for agent main cancels and drains main's own run", async () => {
  const sessionId = "shared-session-delete-owned";
  await seedSession(GROUP_STORE_KEY, sessionId);
  const owned = registerEmbeddedRun({ sessionId, sessionKey: GROUP_KEY, agentId: "main" });
  const { ws } = await openClient();
  try {
    const result = await rpcReq(ws, "sessions.delete", { key: GROUP_KEY }, 30_000);
    log("delete:owned", {
      ok: result.ok,
      deleted: (result.payload as { deleted?: boolean } | undefined)?.deleted,
      error: result.ok ? undefined : result.error?.message,
      ownedAborts: owned.aborts.mock.calls.length,
      ownedLive: owned.isLive(),
    });
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({ deleted: true });
    expect(owned.aborts).toHaveBeenCalledTimes(1);
    expect(owned.isLive()).toBe(false);
  } finally {
    owned.clear();
    ws.close();
  }
});
