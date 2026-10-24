import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCliWithTransport: mocks.callGateway,
}));

import { sessionsProcessesListCommand, sessionsProcessesStopCommand } from "./sessions-processes.js";

const listResult = {
  sessionId: "sess-1",
  processes: [
    {
      processId: "proc-1",
      instanceId: "inst-1",
      name: "sleep",
      status: "running" as const,
      startedAt: 1,
      tail: "",
      truncated: false,
      canStop: true,
    },
  ],
  truncated: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callGateway.mockResolvedValue(listResult);
});

it("forwards sessions.processes.list with key and optional agentId", async () => {
  await sessionsProcessesListCommand(
    {
      key: "agent:main:main",
      agent: "main",
      url: "ws://gateway.test",
      token: "tok",
      password: "pw",
      timeout: "12000",
      json: true,
    },
    mocks.runtime,
  );
  expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
    "sessions.processes.list",
    {
      url: "ws://gateway.test",
      token: "tok",
      password: "pw",
      timeout: "12000",
      json: true,
    },
    { key: "agent:main:main", agentId: "main" },
    { defaultTimeoutMs: 30_000 },
  );
  expect(mocks.runtime.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(listResult, null, 2));
});

it("forwards sessions.processes.stop with required identity fields", async () => {
  mocks.callGateway.mockResolvedValue({ requested: true });
  await sessionsProcessesStopCommand(
    {
      key: "agent:main:main",
      processId: "proc-1",
      sessionId: "sess-1",
      instanceId: "inst-1",
      json: true,
    },
    mocks.runtime,
  );
  expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
    "sessions.processes.stop",
    {
      url: undefined,
      token: undefined,
      password: undefined,
      timeout: undefined,
      json: true,
    },
    {
      key: "agent:main:main",
      processId: "proc-1",
      sessionId: "sess-1",
      instanceId: "inst-1",
    },
    { defaultTimeoutMs: 30_000 },
  );
  expect(mocks.runtime.log).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ requested: true }, null, 2),
  );
});

it("exits non-zero on Gateway failure without inventing process rows", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  await sessionsProcessesListCommand({ key: "agent:main:main", json: true }, mocks.runtime);
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  const payload = JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0] ?? "{}"));
  expect(payload).toMatchObject({
    ok: false,
    error: { type: "cli_error", message: "gateway unavailable" },
  });
});
