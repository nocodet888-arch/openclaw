import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { fetchXaiUsage } from "./usage.js";

describe("fetchXaiUsage hanging-body cancel transport", () => {
  it("returns a usage error while retained unread cancel stays pending", async () => {
    const socketClosed = createDeferred<void>();
    let acceptedConnection = false;
    const server = createServer((_req, res) => {
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
    let resultPromise: Promise<Awaited<ReturnType<typeof fetchXaiUsage>>> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
      const url = `http://127.0.0.1:${address.port}/v1/billing`;
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

      resultPromise = fetchXaiUsage("oauth-token", 5000, loopbackFetch);
      void resultPromise.catch(() => undefined);
      const result = await resultPromise;

      expect(result.error).toMatch(/HTTP 401|Token expired/);
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
        `[xai usage HTTP transport proof] returned=true error=true cancel_pending=${!cancelSettled}`,
      );
      expect(cancelSettled).toBe(false);

      await cancelPending.catch(() => undefined);
      await resultPromise;
      await socketClosed.promise;
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
      if (acceptedConnection) {
        await socketClosed.promise.catch(() => undefined);
      }
    }
  });
});
