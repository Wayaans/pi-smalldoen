import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SMALLDOEN_MODE_ENTRY, SMALLDOEN_STATUS_KEY, type OrchestrationModeEntry, type OrchestrationModeState } from "./types";

export function getOrchestrationMode(state: OrchestrationModeState): boolean {
	return state.enabled;
}

export function restoreOrchestrationMode(ctx: ExtensionContext, state: OrchestrationModeState): boolean {
	let enabled = false;

	for (const entry of ctx.sessionManager.getBranch() as Array<any>) {
		if (entry.type === "custom" && entry.customType === SMALLDOEN_MODE_ENTRY) {
			const data = entry.data as OrchestrationModeEntry | undefined;
			if (typeof data?.enabled === "boolean") enabled = data.enabled;
		}
	}

	state.enabled = enabled;
	applyModeIndicator(ctx, enabled);
	return enabled;
}

export function setOrchestrationMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: OrchestrationModeState,
	enabled: boolean,
): boolean {
	state.enabled = enabled;
	pi.appendEntry<OrchestrationModeEntry>(SMALLDOEN_MODE_ENTRY, {
		enabled,
		updatedAt: new Date().toISOString(),
	});
	applyModeIndicator(ctx, enabled);
	return enabled;
}

export function toggleOrchestrationMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: OrchestrationModeState,
): boolean {
	return setOrchestrationMode(pi, ctx, state, !state.enabled);
}

export function applyModeIndicator(ctx: ExtensionContext, _enabled: boolean): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(SMALLDOEN_STATUS_KEY, undefined);
}
