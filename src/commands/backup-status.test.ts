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

import { backupStatusCommand } from "./backup-status.js";

const status = {
  targets: [
    {
      kind: "external" as const,
      target: "host-restic",
      latest: {
        id: "run-1",
        createdAt: 1_700_000_000_000,
        archivePath: "",
        status: "ok" as const,
        kind: "external" as const,
        target: "host-restic",
        bytes: 1,
      },
      latestOk: {
        id: "run-1",
        createdAt: 1_700_000_000_000,
        archivePath: "",
        status: "ok" as const,
        kind: "external" as const,
        target: "host-restic",
        bytes: 1,
      },
    },
  ],
  schedules: [],
  locations: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.callGateway.mockResolvedValue(status);
});

it("forwards backup.status with empty params and prints JSON", async () => {
  await backupStatusCommand(mocks.runtime, {
    url: "ws://gateway.test",
    token: "tok",
    password: "pw",
    timeout: "12000",
    json: true,
  });
  expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith(
    "backup.status",
    {
      url: "ws://gateway.test",
      token: "tok",
      password: "pw",
      timeout: "12000",
      json: true,
    },
    {},
    { defaultTimeoutMs: 30_000 },
  );
  expect(mocks.runtime.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(status, null, 2));
  expect(mocks.runtime.exit).not.toHaveBeenCalled();
});

it("exits non-zero on Gateway failure without inventing local status", async () => {
  mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
  await backupStatusCommand(mocks.runtime, { json: true });
  expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  const payload = JSON.parse(String(mocks.runtime.log.mock.calls[0]?.[0] ?? "{}"));
  expect(payload).toMatchObject({
    ok: false,
    error: { type: "cli_error", message: "gateway unavailable" },
  });
});
