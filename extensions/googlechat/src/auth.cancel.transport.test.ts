// Real HTTP: production fetchChatCerts cancels an unread non-OK certs body
// and releases the loopback socket. URL is rewritten onto loopback only so
// the rest of fetchWithSsrFGuard + fetchChatCerts stays production.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const rewrite = vi.hoisted(() => ({ url: "" }));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (opts: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...opts,
        url: rewrite.url || opts.url,
        policy: { allowPrivateNetwork: true },
      }),
  };
});

vi.mock("./google-auth.runtime.js", () => ({
  loadGoogleAuthRuntime: vi.fn().mockResolvedValue({
    OAuth2Client: class {
      verifySignedJwtWithCertsAsync = vi.fn();
    },
  }),
  getGoogleAuthTransport: vi.fn().mockResolvedValue({}),
  resolveValidatedGoogleChatCredentials: vi.fn().mockResolvedValue(null),
}));

const { verifyGoogleChatRequest } = await import("./auth.js");

describe("Google Chat cert fetch non-OK hanging-body transport", () => {
  afterEach(() => {
    rewrite.url = "";
    vi.restoreAllMocks();
  });

  it("cancels the unread 503 certs stream and closes the loopback socket", async () => {
    let socketClosed = false;
    const server = createServer((_req, res) => {
      res.socket?.once("close", () => {
        socketClosed = true;
      });
      res.writeHead(503, { "Content-Type": "application/json" });
      res.write('{"error":"unavailable"');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    rewrite.url = `http://127.0.0.1:${address.port}/certs`;

    // Expire the process cert cache so fetchChatCerts hits the network.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);

    const startedAt = Date.now();
    try {
      const result = await verifyGoogleChatRequest({
        bearer: "token",
        audienceType: "project-number",
        audience: "123456789",
      });
      expect(result).toEqual({
        ok: false,
        reason: "Failed to fetch Chat certs (503)",
      });
      await vi.waitFor(() => {
        expect(socketClosed).toBe(true);
      });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(2_000);
      console.log(
        `[googlechat certs 503 transport proof] reason=${result.reason} socket_closed=${socketClosed} elapsed_ms=${elapsedMs}`,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });
});
