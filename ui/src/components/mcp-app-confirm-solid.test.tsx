import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppConfirmation } from "./mcp-app-confirm-solid.tsx";
import { createMcpAppConfirm } from "./mcp-app-confirm.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

it("focuses each pending decision once and returns focus after keyboard completion", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const confirmation = createMcpAppConfirm();
  const mounted = mountSolid(() => <McpAppConfirmation confirmation={confirmation} />);
  const request = () =>
    confirmation.request({
      frame,
      title: "Parts library",
      text: "parts.txt",
      kind: "file",
      isCurrent: () => true,
    });

  for (const key of ["Enter", "Escape"]) {
    frame.focus();
    const decision = request();
    await expect(request()).resolves.toBe(false);
    await waitForSolid(() => expect(document.activeElement).toBe(mounted.getByRole("alertdialog")));
    const strip = mounted.getByRole("alertdialog");
    const cancel = mounted.getByRole("button", { name: "Cancel" });
    cancel.focus();
    confirmation.update();
    expect(document.activeElement).toBe(cancel);
    strip.focus();
    strip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(frame);
    await expect(decision).resolves.toBe(key === "Enter");
    await waitForSolid(() => expect(mounted.queryByRole("alertdialog")).toBeNull());
  }
});

function hasLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

it("keeps confirm preview valid when the 200-unit boundary bisects an emoji", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const confirmation = createMcpAppConfirm();
  const mounted = mountSolid(() => <McpAppConfirmation confirmation={confirmation} />);
  const text = `${"a".repeat(199)}😀`;
  expect(text.length).toBe(201);
  expect(hasLoneUtf16Surrogate(text.slice(0, 200))).toBe(true);
  const decision = confirmation.request({
    frame,
    title: "Unicode preview",
    text,
    kind: "message",
    isCurrent: () => true,
  });
  await waitForSolid(() => expect(mounted.getByRole("alertdialog")).toBeTruthy());
  const preview = mounted.container.querySelector(".mcp-app-confirm__preview");
  expect(preview).not.toBeNull();
  const shown = (preview!.textContent ?? "").trim();
  expect(hasLoneUtf16Surrogate(shown)).toBe(false);
  expect(shown.includes("\uFFFD")).toBe(false);
  expect(shown.endsWith("…")).toBe(true);
  expect(shown.length).toBeLessThanOrEqual(201);
  expect(preview!.getAttribute("title")).toBe(text);
  confirmation.cancel();
  await expect(decision).resolves.toBe(false);
});
