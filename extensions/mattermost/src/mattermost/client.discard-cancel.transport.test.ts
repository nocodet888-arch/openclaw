import { createServer } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createMattermostClient, sendMattermostTyping } from "./client.js";

describe("Mattermost discardResponse hanging-body cancel transport", () => {
  it("returns from sendMattermostTyping while retained unread cancel stays pending", async () => {
    const socketClosed = createDeferred<void>();
    let acceptedConnection = false;
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      // Leave the body unfinished so a tee/cancel can stay pending.
      res.write('{"status":"OK"');
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
    let resultPromise: Promise<void> | undefined;
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP address");
      }
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
        const response = await fetch(`http://127.0.0.1:${address.port}/users/me/typing`, {
          signal: upstreamAbort.signal,
        });
        // Retain an unread clone so body.cancel() can remain pending (capture-tee case).
        retained = response.clone();
        return response;
      };

      const client = createMattermostClient({
        baseUrl: "https://chat.example.com",
        botToken: "abcdefghijklmnopqrstuvwxyz",
        fetchImpl: loopbackFetch,
      });
      resultPromise = sendMattermostTyping(client, { channelId: "ch1" });
      void resultPromise.catch(() => undefined);
      await resultPromise;

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
        `[mattermost discardResponse HTTP transport proof] returned=true cancel_pending=${!cancelSettled}`,
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

  it("returns from discardResponse without waiting when cancel never settles", async () => {
    const cancelStarted = createDeferred<void>();
    const fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelStarted.resolve();
            return new Promise(() => {});
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const client = createMattermostClient({
      baseUrl: "https://chat.example.com",
      botToken: "abcdefghijklmnopqrstuvwxyz",
      fetchImpl,
    });
    await expect(sendMattermostTyping(client, { channelId: "ch1" })).resolves.toBeUndefined();
    await cancelStarted.promise;
    console.log(`[mattermost discardResponse cancel-nofollow proof] cancel_started=true returned=true`);
  });
});
