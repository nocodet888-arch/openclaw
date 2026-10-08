// Proves TUI steering ownership against the real embedded-run registry and guarded injection sink.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueMessageOptions,
} from "../agents/embedded-agent-runner/runs.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import type { EmbeddedTuiBackend as EmbeddedTuiBackendType } from "./embedded-backend.js";

type EmbeddedAgentResult = { payloads: Array<{ text: string }>; meta: Record<string, unknown> };

const agentCommandFromIngressMock = vi.fn();
const sessionProjection = {
  dispose: vi.fn(),
  ensureMaterialized: vi.fn(async () => {}),
  describe: vi.fn(() => undefined),
  snapshot: vi.fn(({ key }: { key: string }) => ({ row: { key, sessionId: undefined } })),
  present: vi.fn(),
  withPreparedExactRows: vi.fn(),
};

vi.mock("../agents/agent-command.js", () => ({
  agentCommandFromIngress: (...args: unknown[]) => agentCommandFromIngressMock(...args),
}));
vi.mock("../cli/deps.js", () => ({ createDefaultDeps: () => ({}) }));
vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveAgentDir: (_cfg: unknown, agentId: string) => `/tmp/openclaw-agent-${agentId}/agent`,
  resolveAgentWorkspaceDir: (_cfg: unknown, agentId: string) => `/tmp/openclaw-agent-${agentId}`,
  resolveSessionAgentId: (params: { sessionKey?: string; agentId?: string }) =>
    params.agentId ?? /^agent:([^:]+):/.exec(params.sessionKey ?? "")?.[1] ?? "main",
}));
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: vi.fn(),
}));
vi.mock("../agents/context.js", () => ({ ensureContextWindowCacheLoaded: async () => undefined }));
vi.mock("../agents/prepared-model-runtime.js", () => ({
  refreshPreparedModelRuntimeSnapshots: async () => undefined,
}));
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
  registerConfigWriteListener: () => () => {},
}));
vi.mock("../config/sessions/startup-migration.js", () => ({
  runSessionStartupMigration: async () => undefined,
}));
vi.mock("../gateway/session-row-projection.js", () => ({
  createSessionRowProjection: async () => sessionProjection,
}));
vi.mock("../gateway/session-utils.js", () => ({
  getSessionDefaults: () => ({ modelProvider: null, model: null, contextTokens: null }),
  listAgentsForGateway: () => [],
  loadSessionEntry: (sessionKey: string, opts?: { agentId?: string }) => ({
    cfg: { messages: { queue: { mode: "steer" } } },
    agentId: opts?.agentId ?? parseAgentSessionKey(sessionKey)?.agentId ?? "main",
    canonicalKey: sessionKey,
    storePath: "/tmp/openclaw-sessions.json",
    store: {},
    entry: { queueDebounceMs: 0 },
  }),
  resolveSessionModelRef: () => ({ provider: "openai", model: "gpt-5.4" }),
}));
vi.mock("../gateway/server-methods/agent-timestamp.js", () => ({
  injectTimestamp: (message: string) => message,
  timestampOptsFromConfig: () => ({}),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A guarded (V2) injection sink: records only input admitted by the host's final assertion. */
function registerGuardedSink(params: { sessionId: string; sessionKey: string; agentId?: string }) {
  const answered: string[] = [];
  const steered: string[] = [];
  const handle: EmbeddedAgentQueueHandle = {
    runId: `run-${params.sessionId}-${params.agentId ?? "unset"}`,
    queueMessage: async () => {
      throw new Error("v1 entry must not receive TUI input");
    },
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (
        text,
        options: EmbeddedAgentQueueMessageOptions | undefined,
        assertCurrent,
      ) => {
        assertCurrent();
        steered.push(text);
        options?.onQueueAccepted?.(true);
      },
      // The run is waiting on a question; an admitted answer is consumed here.
      claimPendingUserInputAnswer: async (text, _options, assertCurrent) => {
        assertCurrent();
        answered.push(text);
        return true;
      },
    },
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  };
  setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey, undefined, params.agentId);
  return {
    handle,
    answered,
    steered,
    clear: () => clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey),
  };
}

describe("EmbeddedTuiBackend local input owner at the real injection sink", () => {
  let EmbeddedTuiBackend: typeof EmbeddedTuiBackendType;
  const originalRuntimeLog = defaultRuntime.log;
  const originalRuntimeError = defaultRuntime.error;
  const cleanups: Array<() => void> = [];

  beforeAll(async () => {
    ({ EmbeddedTuiBackend } = await import("./embedded-backend.js"));
  });

  beforeEach(() => {
    agentCommandFromIngressMock.mockReset();
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      cleanup();
    }
    defaultRuntime.log = originalRuntimeLog;
    defaultRuntime.error = originalRuntimeError;
  });

  async function startLocalRun(input: { sessionKey: string; agentId?: string }) {
    const first = deferred<EmbeddedAgentResult>();
    agentCommandFromIngressMock.mockReturnValueOnce(first.promise);
    agentCommandFromIngressMock.mockResolvedValue({ payloads: [{ text: "followup" }], meta: {} });
    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({ ...input, message: "first", runId: "tui-first" });
    cleanups.push(() => first.resolve({ payloads: [], meta: {} }));
    const send = (message: string) =>
      backend.sendChat({ ...input, message, runId: `tui-${message.replaceAll(" ", "-")}` });
    const releaseFirstAndReadFollowup = async () => {
      first.resolve({ payloads: [{ text: "first done" }], meta: {} });
      await vi.waitFor(() => expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(2));
      const call = agentCommandFromIngressMock.mock.calls[1]?.[0] as {
        message?: string;
        agentId?: string;
      };
      return { message: call.message, agentId: call.agentId };
    };
    return { send, releaseFirstAndReadFollowup };
  }

  function log(caseName: string, detail: Record<string, unknown>) {
    process.stdout.write(`[tui-input-owner] ${caseName} ${JSON.stringify(detail)}\n`);
  }

  it("same owner: the answer reaches the selected run's guarded sink", async () => {
    const sink = registerGuardedSink({
      sessionId: "s-same",
      sessionKey: "global",
      agentId: "work",
    });
    cleanups.push(sink.clear);
    const { send } = await startLocalRun({ sessionKey: "global", agentId: "work" });

    const result = await send("same owner answer");

    log("same", {
      result,
      answered: sink.answered,
      extraTurns: agentCommandFromIngressMock.mock.calls.length - 1,
    });
    expect(sink.answered).toEqual(["same owner answer"]);
    expect(result).toEqual({ runId: sink.handle.runId });
    expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
  });

  it("foreign owner: another agent's run on the shared key never receives TUI input", async () => {
    const sink = registerGuardedSink({
      sessionId: "s-foreign",
      sessionKey: "global",
      agentId: "main",
    });
    cleanups.push(sink.clear);
    const { send, releaseFirstAndReadFollowup } = await startLocalRun({
      sessionKey: "global",
      agentId: "work",
    });

    const result = await send("foreign owner input");
    const followup = await releaseFirstAndReadFollowup();

    log("foreign", { result, answered: sink.answered, steered: sink.steered, followup });
    expect(sink.answered).toEqual([]);
    expect(sink.steered).toEqual([]);
    expect(result).toEqual({ runId: "tui-foreign-owner-input" });
    expect(followup).toEqual({ message: "foreign owner input", agentId: "work" });
  });

  it("conflicting metadata: the selected handle's registration owner beats an unattached reply operation", async () => {
    const sessionKey = "agent:work:main";
    // No explicit agentId on the handle; its registration key names `work`.
    const sink = registerGuardedSink({ sessionId: "s-conflict", sessionKey });
    cleanups.push(sink.clear);
    // Same session id, different agent, never attached to the selected handle.
    const unrelated = createReplyOperation({
      sessionKey: "agent:main:conflict-reply",
      sessionId: "s-conflict",
      agentId: "main",
      resetTriggered: false,
    });
    cleanups.push(() => unrelated.complete());
    const { send } = await startLocalRun({ sessionKey });

    const result = await send("conflict answer");

    log("conflict", { result, answered: sink.answered, unattachedReplyAgent: unrelated.agentId });
    expect(sink.answered).toEqual(["conflict answer"]);
    expect(result).toEqual({ runId: sink.handle.runId });
  });

  it("owner replacement: a foreign successor on the same session id does not inherit TUI input", async () => {
    const original = registerGuardedSink({
      sessionId: "s-replace",
      sessionKey: "global",
      agentId: "work",
    });
    const { send, releaseFirstAndReadFollowup } = await startLocalRun({
      sessionKey: "global",
      agentId: "work",
    });
    // The owned run ends and another agent's run takes over the shared slot.
    original.clear();
    const successor = registerGuardedSink({
      sessionId: "s-replace",
      sessionKey: "global",
      agentId: "main",
    });
    cleanups.push(successor.clear);

    const result = await send("replacement input");
    const followup = await releaseFirstAndReadFollowup();

    log("replacement", {
      result,
      originalAnswered: original.answered,
      successorAnswered: successor.answered,
      successorSteered: successor.steered,
      followup,
    });
    expect(original.answered).toEqual([]);
    expect(successor.answered).toEqual([]);
    expect(successor.steered).toEqual([]);
    expect(result).toEqual({ runId: "tui-replacement-input" });
    expect(followup).toEqual({ message: "replacement input", agentId: "work" });
  });
});
