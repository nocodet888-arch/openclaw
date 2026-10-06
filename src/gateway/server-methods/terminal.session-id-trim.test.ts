import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import { baseOpenRequest } from "../terminal/session-manager.test-helpers.js";
import { terminalHandlers } from "./terminal.js";

// Real PTY spawn + login-shell args are Unix-specific; keep portable lookup
// coverage elsewhere and restrict this native proof to supported hosts.
describe.skipIf(process.platform === "win32")(
  "terminal.close/attach padded sessionId (real PTY)",
  () => {
    const unixShell = process.env.SHELL?.trim() || "/bin/sh";

    it(
      "closes a live connection-owned real PTY when terminal.close receives a padded sessionId",
      { timeout: 60_000 },
      async () => {
        const manager = new TerminalSessionManager({
          emit: vi.fn(),
          // Default spawnTerminalPty — real process, not makeFakePty.
        });
        try {
          const opened = await manager.open(
            baseOpenRequest({
              owner: { kind: "conn", connId: "conn-pad" },
              cwd: process.cwd(),
              shell: unixShell,
              args: [],
              cols: 80,
              rows: 24,
            }),
          );
          expect(opened.ok).toBe(true);
          if (!opened.ok) {
            return;
          }

          const padded = ` ${opened.sessionId} `;
          expect(padded).not.toBe(opened.sessionId);
          expect(manager.size).toBe(1);

          const respond = vi.fn();
          await expectDefined(
            terminalHandlers["terminal.close"],
            "terminal.close",
          )({
            params: { sessionId: padded },
            respond,
            context: {
              terminalSessions: manager,
              isTerminalEnabled: () => true,
              getRuntimeConfig: () => ({ gateway: { terminal: { enabled: true } } }),
            },
            client: { connId: "conn-pad", connect: {} },
            isWebchatConnect: () => false,
            req: { type: "req", id: "2", method: "terminal.close" },
          } as never);

          expect(respond).toHaveBeenCalledWith(true, { ok: true });
          expect(manager.size).toBe(0);
          console.log(
            `[terminal sessionId trim real-PTY proof] close_ok=true padded=${JSON.stringify(padded)} exact=${opened.sessionId} manager_size=0`,
          );
        } finally {
          manager.disposeAll();
        }
      },
    );

    it(
      "attaches to a detached real PTY when terminal.attach receives a padded sessionId",
      { timeout: 60_000 },
      async () => {
        const emit = vi.fn();
        const manager = new TerminalSessionManager({
          emit,
          detachGraceMs: 60_000,
        });
        try {
          const opened = await manager.open(
            baseOpenRequest({
              owner: { kind: "conn", connId: "conn-owner" },
              cwd: process.cwd(),
              shell: unixShell,
              args: [],
              cols: 80,
              rows: 24,
            }),
          );
          expect(opened.ok).toBe(true);
          if (!opened.ok) {
            return;
          }

          // Seed output before detach so reattach can resume visible buffer content.
          expect(manager.write("conn-owner", opened.sessionId, "echo openclaw-pad-reattach\n")).toBe(
            true,
          );
          await vi.waitFor(
            () => {
              const snap = manager.snapshot(opened.sessionId) ?? "";
              expect(snap).toContain("openclaw-pad-reattach");
            },
            { timeout: 15_000, interval: 50 },
          );

          manager.handleDisconnect("conn-owner");
          expect(manager.size).toBe(1);

          const padded = ` ${opened.sessionId} `;
          const respond = vi.fn();
          await expectDefined(
            terminalHandlers["terminal.attach"],
            "terminal.attach",
          )({
            params: { sessionId: padded },
            respond,
            context: {
              terminalSessions: manager,
              isTerminalEnabled: () => true,
              getRuntimeConfig: () => ({ gateway: { terminal: { enabled: true } } }),
              logGateway: { info: vi.fn() },
            },
            client: { connId: "conn-owner", connect: {} },
            isWebchatConnect: () => false,
            req: { type: "req", id: "3", method: "terminal.attach" },
          } as never);

          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({
              sessionId: opened.sessionId,
              buffer: expect.stringContaining("openclaw-pad-reattach"),
            }),
          );
          console.log(
            `[terminal sessionId trim real-PTY proof] attach_ok=true resumed=true padded=${JSON.stringify(padded)} exact=${opened.sessionId}`,
          );
          manager.close("conn-owner", opened.sessionId);
        } finally {
          manager.disposeAll();
        }
      },
    );
  },
);
