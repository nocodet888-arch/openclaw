import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  GatewaySuspendPrepareResult,
  GatewaySuspendResumeResult,
  GatewaySuspendStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { colorize, isRich, theme } from "../../../packages/terminal-core/src/theme.js";
import type { OutputRuntimeEnv } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import type { callGatewayFromCliWithTransport } from "../gateway-rpc.js";

type SuspendRpcOpts = Parameters<typeof callGatewayFromCliWithTransport>[1];

type SuspendRpcCall = (method: string, opts: SuspendRpcOpts, params?: unknown) => Promise<unknown>;

type SuspendCliDeps = {
  callGateway: SuspendRpcCall;
  runtime: OutputRuntimeEnv;
};

const MIN_SUSPEND_POLL_DELAY_MS = 50;

function parseWaitMs(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = typeof value === "number" ? value : Number(value.trim() || Number.NaN);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("--wait must be a non-negative number of seconds");
  }
  const milliseconds = Math.floor(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("--wait is too large");
  }
  return milliseconds;
}

function resolveRequestId(value: string | undefined): string {
  if (value === undefined) {
    return `cli-${randomBytes(4).toString("hex")}`;
  }
  const requestId = value.trim();
  if (!requestId || requestId.length > 128) {
    throw new Error("--request-id must contain 1 to 128 characters");
  }
  return requestId;
}

function formatBusyResult(
  result: Extract<GatewaySuspendPrepareResult, { status: "busy" }>,
): string {
  const blockers = result.blockers.map((blocker) => `- ${blocker.message}`);
  return [
    `Gateway suspension is busy (${result.reason}; ${result.activeCount} active).`,
    ...(blockers.length > 0 ? ["Blockers:", ...blockers] : []),
  ].join("\n");
}

export async function runGatewaySuspend(
  options: {
    rpcOpts: SuspendRpcOpts;
    requestId?: string;
    waitSeconds?: string | number;
    json?: boolean;
  },
  deps: SuspendCliDeps,
): Promise<void> {
  const requestId = resolveRequestId(options.requestId);
  const waitMs = parseWaitMs(options.waitSeconds);
  const deadlineMs = waitMs === undefined ? undefined : Date.now() + waitMs;
  const maxAttempts = waitMs === undefined ? 1 : Math.ceil(waitMs / MIN_SUSPEND_POLL_DELAY_MS) + 1;
  let latest: GatewaySuspendPrepareResult | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // A sleep can overshoot the deadline; never issue a prepare that could
    // suspend the Gateway after the operator's advertised --wait window.
    if (attempt > 0 && deadlineMs !== undefined && Date.now() >= deadlineMs) {
      break;
    }
    latest = (await deps.callGateway("gateway.suspend.prepare", options.rpcOpts, {
      requestId,
    })) as GatewaySuspendPrepareResult;
    if (latest.status === "ready") {
      if (options.json) {
        deps.runtime.writeJson({ ...latest, requestId });
        return;
      }
      const rich = isRich();
      deps.runtime.log(colorize(rich, theme.success, "Gateway suspension prepared."));
      deps.runtime.log(`${colorize(rich, theme.muted, "Suspension ID:")} ${latest.suspensionId}`);
      deps.runtime.log(
        `${colorize(rich, theme.muted, "Expires:")} ${new Date(latest.expiresAtMs).toISOString()} (${latest.expiresAtMs} ms)`,
      );
      const port = options.rpcOpts.localPortOverride;
      const command = `openclaw gateway resume ${latest.suspensionId}`;
      deps.runtime.log(
        `Resume with: ${formatCliCommand(port === undefined ? command : `${command} --port ${port}`)}`,
      );
      return;
    }
    if (latest.status === "draining") {
      throw new Error("Gateway suspension unexpectedly entered drain mode");
    }

    if (deadlineMs === undefined) {
      break;
    }

    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const delayMs = Math.min(remainingMs, Math.max(MIN_SUSPEND_POLL_DELAY_MS, latest.retryAfterMs));
    await sleep(delayMs);
  }

  if (!latest || latest.status !== "busy") {
    throw new Error("Gateway suspension polling ended without a result");
  }
  if (options.json) {
    deps.runtime.writeJson({ ...latest, requestId });
    deps.runtime.exit(1);
    return;
  }
  const hint =
    deadlineMs === undefined
      ? "Retry later or use --wait <seconds>."
      : "Timed out waiting for the Gateway to become idle.";
  throw new Error(`${formatBusyResult(latest)}\n${hint}`);
}

export async function runGatewayResume(
  options: { rpcOpts: SuspendRpcOpts; suspensionId: string; json?: boolean },
  deps: SuspendCliDeps,
): Promise<void> {
  const result = (await deps.callGateway("gateway.suspend.resume", options.rpcOpts, {
    suspensionId: options.suspensionId,
  })) as GatewaySuspendResumeResult;
  if (options.json) {
    deps.runtime.writeJson(result);
    return;
  }
  deps.runtime.log(
    result.resumed
      ? "Gateway resumed."
      : "No matching suspension was held (lease already expired or resumed); gateway is running.",
  );
}

export async function runGatewaySuspendStatus(
  options: {
    rpcOpts: SuspendRpcOpts;
    suspensionId: string;
    includeLifecycle?: boolean;
    json?: boolean;
  },
  deps: SuspendCliDeps,
): Promise<void> {
  const suspensionId = options.suspensionId.trim();
  if (!suspensionId || suspensionId.length > 128) {
    throw new Error("suspensionId must contain 1 to 128 characters");
  }
  const params: { suspensionId: string; includeLifecycle?: boolean } = { suspensionId };
  if (options.includeLifecycle) {
    params.includeLifecycle = true;
  }
  const result = (await deps.callGateway(
    "gateway.suspend.status",
    options.rpcOpts,
    params,
  )) as GatewaySuspendStatusResult;
  if (options.json) {
    deps.runtime.writeJson(result);
    return;
  }
  const rich = isRich();
  if (result.status === "running") {
    deps.runtime.log(
      colorize(rich, theme.success, "Gateway is running (no matching suspension lease)."),
    );
    return;
  }
  if (result.status === "ready") {
    deps.runtime.log(colorize(rich, theme.success, "Gateway suspension ready."));
    deps.runtime.log(
      `${colorize(rich, theme.muted, "Expires:")} ${new Date(result.expiresAtMs).toISOString()} (${result.expiresAtMs} ms)`,
    );
    if ("ownerId" in result && result.ownerId) {
      deps.runtime.log(`${colorize(rich, theme.muted, "Owner:")} ${result.ownerId}`);
    }
    return;
  }
  deps.runtime.log(
    colorize(
      rich,
      theme.warn,
      `Gateway suspension draining (${result.activeCount} active; retry after ${result.retryAfterMs} ms).`,
    ),
  );
  deps.runtime.log(
    `${colorize(rich, theme.muted, "Expires:")} ${new Date(result.expiresAtMs).toISOString()} (${result.expiresAtMs} ms)`,
  );
  if ("phase" in result && result.phase) {
    deps.runtime.log(`${colorize(rich, theme.muted, "Phase:")} ${result.phase}`);
  }
  if ("ownerId" in result && result.ownerId) {
    deps.runtime.log(`${colorize(rich, theme.muted, "Owner:")} ${result.ownerId}`);
  }
  if (result.blockers.length > 0) {
    deps.runtime.log("Blockers:");
    for (const blocker of result.blockers) {
      deps.runtime.log(`- ${blocker.message}`);
    }
  }
}
