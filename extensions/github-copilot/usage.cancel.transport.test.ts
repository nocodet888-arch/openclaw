import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { fetchCopilotUsage } from "./usage.js";

describe("fetchCopilotUsage hanging-body cancel transport", () => {
  it("returns a usage error while retained unread cancel stays pending", async ({ signal }) => {
    const socketClosed = createDeferred<void>();
    let acceptedConnection = false;
    const server = createServer((req, res) => {
      res.writeHead(401, { "content-type": "application/json", connection: "close" });
      // Leave the body unfinished so a tee/cancel can stay pending.
      res.write('{"message":"unauthorized"');
    });
    server.on("connection", (socket) => {
      acceptedConnection = true;
      socket.once("close", () => {
        socketClosed.resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });

    let retained: Response | undefined;
    let upstreamAbort: AbortController | undefined;
    let resultPromise: Promise<Awaited<ReturnType<typeof fetchCopilotUsage>>> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const url = `http://127.0.0.1:${address.port}/copilot_internal/user`;
      const loopbackFetch: typeof fetch = async (_input, init) => {
        upstreamAbort = new AbortController();
        if (init?.signal) {
          if (init.signal.aborted) {
            upstreamAbort.abort();
          } else {
            init.signal.addEventListener(
              "abort",
              () => {
                upstreamAbort?.abort();
              },
              { once: true },
            );
          }
        }
        const response = await fetch(url, { signal: upstreamAbort.signal });
        // Retain an unread clone so body.cancel() can remain pending (capture-tee case).
        retained = response.clone();
        return response;
      };

      resultPromise = fetchCopilotUsage("token", 5000, loopbackFetch);
      // Keep rejections owned so a failed usage call cannot strand finally cleanup.
      void resultPromise.catch(() => undefined);
      const result = await withinTest(resultPromise, signal);

      expect(result.error).toMatch(/HTTP 401/);
      expect(result.windows).toEqual([]);

      const cancelPending = retained?.body?.cancel() ?? Promise.resolve();
      let cancelSettled = false;
      void cancelPending.then(
        () => {
          cancelSettled = true;
        },
        () => {
          cancelSettled = true;
        },
      );
      await Promise.resolve();
      console.log(
        `[copilot usage HTTP transport proof] returned=true error=true cancel_pending=${!cancelSettled}`,
      );
      expect(cancelSettled).toBe(false);

      await cancelPending.catch(() => undefined);
      await withinTest(resultPromise, signal);
      await withinTest(socketClosed.promise, signal);
    } finally {
      upstreamAbort?.abort();
      if (retained && !retained.bodyUsed) {
        void retained.body?.cancel().catch(() => undefined);
      }
      if (resultPromise) {
        await resultPromise.catch(() => undefined);
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      // Only join socket close when a connection was accepted; early fetch/test
      // failure must not hang forever on an unresolved deferred.
      if (acceptedConnection) {
        await socketClosed.promise.catch(() => undefined);
      }
    }
  });
});
