import {
  MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM,
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isJsonObject, type CodexThreadItem, type JsonObject } from "./protocol.js";

export function collectDynamicToolContentText(
  contentItems: CodexThreadItem["contentItems"],
): string {
  if (!Array.isArray(contentItems)) {
    return "";
  }
  return contentItems
    .flatMap((entry) => {
      if (!isJsonObject(entry)) {
        return [];
      }
      const text = readString(entry, "text");
      return text ? [text] : [];
    })
    .join("\n");
}

export function readCodexResponseOutput(item: JsonObject): string | undefined {
  if (typeof item.output === "string") {
    return item.output;
  }
  if (!Array.isArray(item.output)) {
    return undefined;
  }
  // Preserve text-item boundaries and whitespace. Non-text payloads keep their
  // media owner rather than bypassing display privacy as serialized plaintext.
  return JSON.stringify(
    item.output.map((part) =>
      isJsonObject(part) && part.type === "input_text" && typeof part.text === "string"
        ? { type: part.type, text: part.text }
        : { type: isJsonObject(part) ? part.type : "unknown", omitted: true },
    ),
    null,
    2,
  );
}

export const TOOL_PROGRESS_ECHO_PREFIX_MIN_CHARS = 1_024;
export const TOOL_PROGRESS_ECHO_SIGNATURE_CAP = MAX_TOOL_OUTPUT_DELTA_MESSAGES_PER_ITEM + 4;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Echo-prefix truncation that stays UTF-16-safe while retaining a boundary
 * discriminator. Unlike truncateUtf16Safe (which backs off when the budget
 * lands mid-surrogate), this includes the full scalar so matchesEcho cannot
 * falsely suppress distinct same-length assistant text that only shares the
 * shortened ASCII prefix.
 */
export function truncateUtf16SafeEchoPrefix(input: string, maxLen: number): string {
  const limit = Math.max(0, Math.floor(maxLen));
  if (input.length <= limit) {
    return input;
  }
  if (
    limit > 0 &&
    limit < input.length &&
    isHighSurrogate(input.charCodeAt(limit - 1)) &&
    isLowSurrogate(input.charCodeAt(limit))
  ) {
    return input.slice(0, limit + 1);
  }
  return input.slice(0, limit);
}

export function toolOutputRawEchoSignature(
  text: string,
): { rawLength: number; rawPrefix: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return {
    rawLength: trimmed.length,
    // Prefer a full scalar at the transcript budget so echo matching keeps a
    // boundary discriminator (raw .slice would leave a lone surrogate).
    rawPrefix: truncateUtf16SafeEchoPrefix(trimmed, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS),
  };
}
