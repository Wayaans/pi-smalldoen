import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	SMALLDOEN_MODE_ENTRY,
	SMALLDOEN_STATUS_KEY,
	type OrchestrationModeEntry,
	type OrchestrationModeState,
	type SmalldoenMode,
} from "./types";

export function getSmalldoenMode(state: OrchestrationModeState): SmalldoenMode {
	return state.mode;
}

export function getOrchestrationMode(state: OrchestrationModeState): boolean {
	return state.mode === "orchestrate";
}

export function restoreOrchestrationMode(ctx: ExtensionContext, state: OrchestrationModeState): SmalldoenMode {
	let mode: SmalldoenMode = "off";

	for (const entry of ctx.sessionManager.getBranch() as Array<any>) {
		if (entry.type !== "custom" || entry.customType !== SMALLDOEN_MODE_ENTRY) continue;
		const data = entry.data as OrchestrationModeEntry | undefined;
		if (data?.mode === "off" || data?.mode === "orchestrate" || data?.mode === "ask" || data?.mode === "brainstorm") mode = data.mode;
		else if (typeof data?.enabled === "boolean") mode = data.enabled ? "orchestrate" : "off";
	}

	state.mode = mode;
	applyModeIndicator(ctx, mode);
	return mode;
}

export function setOrchestrationMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: OrchestrationModeState,
	mode: SmalldoenMode,
): SmalldoenMode {
	state.mode = mode;
	pi.appendEntry<OrchestrationModeEntry>(SMALLDOEN_MODE_ENTRY, {
		mode,
		enabled: mode !== "off",
		updatedAt: new Date().toISOString(),
	});
	applyModeIndicator(ctx, mode);
	return mode;
}

export function toggleOrchestrationMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: OrchestrationModeState,
): SmalldoenMode {
	return setOrchestrationMode(pi, ctx, state, state.mode === "off" ? "orchestrate" : "off");
}

export function applyModeIndicator(ctx: ExtensionContext, _mode: SmalldoenMode): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(SMALLDOEN_STATUS_KEY, undefined);
}
