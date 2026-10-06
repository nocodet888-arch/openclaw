import { TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { createNativeCommandItem } from "./event-projector-command.test-support.js";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  createProjector,
  buildEmptyToolTelemetry,
  forCurrentTurn,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function proofLine(label: string, value: string | number | boolean): void {
  process.stdout.write(`[utf16-echo-proof] ${label}=${String(value)}\n`);
}

describe("CodexAppServerEventProjector UTF-16 echo prefix (native Codex shape)", () => {
  it("suppresses raw tool-output echo and retains distinct same-length assistant via item/completed + empty turn/completed", async () => {
    const projector = await createProjector();
    const asciiPrefix = "a".repeat(9_999);
    const aggregatedOutput = `${asciiPrefix}\u{1F600}${"a".repeat(400)}`;
    const distinctAssistant = `${asciiPrefix}b${"a".repeat(aggregatedOutput.length - 10_000)}`;
    expect(distinctAssistant.length).toBe(aggregatedOutput.length);
    expect(hasLoneSurrogate(aggregatedOutput.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS))).toBe(
      true,
    );

    // Codex 0.144.6 emits completed command items separately, then empty turn items.
    await projector.handleNotification(
      forCurrentTurn("item/completed", {
        item: createNativeCommandItem({
          id: "cmd-aggregate-utf16-native",
          command: "printf output",
          aggregatedOutput,
          status: "completed",
          exitCode: 0,
          durationMs: 42,
        }),
      }),
    );
    await projector.handleNotification(turnCompleted([]));

    const progress = (
      projector as unknown as {
        toolProgressProjection: { matchesEcho: (text: string) => boolean };
      }
    ).toolProgressProjection;

    expect(progress.matchesEcho(aggregatedOutput)).toBe(true);
    expect(progress.matchesEcho(distinctAssistant)).toBe(false);

    // Raw lane is the echo channel; typed agentMessage would bypass raw-only filtering.
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-echo-tool-output",
          role: "assistant",
          content: [{ type: "output_text", text: aggregatedOutput }],
        },
      }),
    );
    await projector.handleNotification(
      forCurrentTurn("rawResponseItem/completed", {
        item: {
          type: "message",
          id: "raw-distinct-assistant",
          role: "assistant",
          content: [{ type: "output_text", text: distinctAssistant }],
        },
      }),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.assistantTexts).toEqual([distinctAssistant]);
    expect(result.assistantTexts.includes(aggregatedOutput)).toBe(false);

    proofLine("caller_path", "item/completed+empty turn/completed+rawResponseItem");
    proofLine("codex_shape", "0.144.6-separate-item-completed-empty-turn-items");
    proofLine("budget", TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS);
    proofLine("echo_matches_tool_output", progress.matchesEcho(aggregatedOutput));
    proofLine("echo_matches_distinct", progress.matchesEcho(distinctAssistant));
    proofLine("raw_echo_suppressed", !result.assistantTexts.includes(aggregatedOutput));
    proofLine("raw_distinct_retained", result.assistantTexts.includes(distinctAssistant));
    proofLine(
      "boundary_prefix_has_lone_surrogate",
      hasLoneSurrogate(aggregatedOutput.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS)),
    );
  });
});
