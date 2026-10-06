import { describe, expect, it } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GATEWAY_TOKEN = "terminal-sessionid-trim-e2e-token";

describe.skipIf(process.platform === "win32")("terminal.close Gateway E2E", () => {
  it(
    "closes a live host PTY when terminal.close receives a padded sessionId",
    { timeout: 120_000 },
    async () => {
      testState.gatewayAuth = { mode: "token", token: GATEWAY_TOKEN };

      await withGatewayServer(async ({ port }) => {
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: GATEWAY_TOKEN,
          scopes: ["operator.admin"],
          timeoutMs: 60_000,
        });
        try {
          const opened = await client.request<{ sessionId?: string }>("terminal.open", {
            cols: 80,
            rows: 24,
          });
          expect(opened.sessionId).toEqual(expect.any(String));
          const sessionId = opened.sessionId!;
          const padded = ` ${sessionId} `;
          expect(padded).not.toBe(sessionId);

          const closed = await client.request<{ ok?: boolean }>("terminal.close", {
            sessionId: padded,
          });
          expect(closed).toMatchObject({ ok: true });
          process.stdout.write(
            `[terminal sessionId trim Gateway RPC proof] close_ok=true padded=${JSON.stringify(padded)} exact=${sessionId}\n`,
          );
        } finally {
          await disconnectGatewayClient(client);
        }
      });
    },
  );
});
