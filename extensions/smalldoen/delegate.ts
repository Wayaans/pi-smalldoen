import * as path from "node:path";
import { getAgentConfig } from "./agents";
import { buildSubagentHookContent } from "./hooks";
import { buildRoleMemoryContext, recordRoleExecution } from "./memory";
import {
	getLatestPlanPath,
	getNextPlanPath,
	parsePlanFile,
	readPlanFile,
	slugifyFeatureName,
	validatePlanFile,
	type ParsedPlan,
} from "./plan";
import { getSubagentLogsDir } from "./paths";
import { runChildAgent, type ChildLogCaptureOptions } from "./subprocess";
import type { DelegateToolDetails, SubagentLogMode } from "./types";

export const workerRoles = ["scout", "planner", "engineer", "designer", "reviewer"] as const;
export type WorkerRole = (typeof workerRoles)[number];

export interface RunDelegatedRoleParams {
	cwd: string;
	role: WorkerRole;
	task: string;
	feature?: string;
	runId?: string;
	label?: string;
	packageId?: string;
	signal?: AbortSignal;
	onUpdate?: (details: DelegateToolDetails) => void;
	logMode?: SubagentLogMode;
}

export interface RunDelegatedRoleResult {
	details: DelegateToolDetails;
	parsedPlan?: ParsedPlan;
}

function createRunId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `run-${timestamp}`;
}

function sanitizeLogSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "subagent";
}

function buildLogFilePrefix(role: WorkerRole, label?: string, packageId?: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const identity = sanitizeLogSegment(packageId?.trim() || label?.trim() || role);
	return `${timestamp}-${role}-${identity}`;
}

function buildLogCapture(
	cwd: string,
	role: WorkerRole,
	mode: SubagentLogMode | undefined,
	params: { runId?: string; label?: string; packageId?: string },
): ChildLogCaptureOptions | undefined {
	if (!mode || mode === "off") return undefined;
	const prefix = buildLogFilePrefix(role, params.label, params.packageId);
	const logsDir = getSubagentLogsDir(cwd, params.runId);
	return {
		mode,
		paths: {
			traceLogPath: path.join(logsDir, `${prefix}.trace.log`),
			rawLogPath: mode === "full" ? path.join(logsDir, `${prefix}.jsonl`) : undefined,
			stderrLogPath: mode === "full" ? path.join(logsDir, `${prefix}.stderr.log`) : undefined,
		},
	};
}

function buildDelegateDetails(
	params: {
		role: WorkerRole;
		runId?: string;
		label?: string;
		packageId?: string;
		featureSlug?: string;
		planPath?: string;
		model?: string;
		logCapture?: ChildLogCaptureOptions;
	},
	state: {
		status: DelegateToolDetails["status"];
		exitCode: number;
		finalOutput: string;
		stderr?: string;
		stopReason?: string;
		errorMessage?: string;
	},
): DelegateToolDetails {
	return {
		role: params.role,
		status: state.status,
		runId: params.runId,
		label: params.label,
		packageId: params.packageId,
		featureSlug: params.featureSlug,
		planPath: params.planPath,
		exitCode: state.exitCode,
		stderr: state.stderr,
		finalOutput: state.finalOutput,
		model: params.model,
		stopReason: state.stopReason,
		errorMessage: state.errorMessage,
		traceLogPath: params.logCapture?.paths.traceLogPath,
		rawLogPath: params.logCapture?.paths.rawLogPath,
		stderrLogPath: params.logCapture?.paths.stderrLogPath,
	};
}

function formatLogPathLines(details: Pick<DelegateToolDetails, "traceLogPath" | "rawLogPath" | "stderrLogPath">): string[] {
	return [
		details.traceLogPath ? `Trace Log: ${details.traceLogPath}` : undefined,
		details.rawLogPath ? `Raw Log: ${details.rawLogPath}` : undefined,
		details.stderrLogPath ? `Stderr Log: ${details.stderrLogPath}` : undefined,
	].filter((line): line is string => Boolean(line));
}

function createDelegatedRoleError(message: string, details: DelegateToolDetails): Error {
	const error = new Error([message.trim(), ...formatLogPathLines(details)].filter(Boolean).join("\n"));
	(error as Error & { details?: DelegateToolDetails }).details = details;
	return error;
}

export async function runDelegatedRole(params: RunDelegatedRoleParams): Promise<RunDelegatedRoleResult> {
	const { cwd, role, task, feature, runId, label, packageId, signal, onUpdate, logMode } = params;
	const agent = getAgentConfig(cwd, role);
	if (!agent) throw new Error(`Missing agent definition for role: ${role}`);

	let featureSlug: string | undefined;
	let planPath: string | undefined;
	let appendPrompt: string | undefined;
	const sourceRunId = createRunId();

	const roleMemoryContext = await buildRoleMemoryContext(role, cwd);
	const configuredModel = agent.provider && agent.model ? `${agent.provider}/${agent.model}` : agent.model;

	if (role === "planner") {
		if (!feature?.trim()) throw new Error("Planner delegation requires the feature field.");
		featureSlug = slugifyFeatureName(feature);
		planPath = await getNextPlanPath(cwd, featureSlug);
		const latestPlanPath = await getLatestPlanPath(cwd, featureSlug);
		appendPrompt = [
			roleMemoryContext,
			"Runtime planning context:",
			`- Source run id: ${sourceRunId}`,
			`- Feature slug: ${featureSlug}`,
			`- Required plan path: ${planPath}`,
			latestPlanPath ? `- Previous latest plan version: ${latestPlanPath}` : "- Previous latest plan version: none",
			"- You must write the plan file to the required plan path before you finish.",
		].filter(Boolean).join("\n\n");
	}
	else if (roleMemoryContext) {
		appendPrompt = roleMemoryContext;
	}

	const hookContent = await buildSubagentHookContent(cwd, role);
	if (hookContent) {
		appendPrompt = appendPrompt
			? `${appendPrompt}\n\nProject-local hook:\n${hookContent}`
			: `Project-local hook:\n${hookContent}`;
	}

	const logCapture = buildLogCapture(cwd, role, logMode, { runId, label, packageId });
	const runningDetails = buildDelegateDetails(
		{ role, runId, label, packageId, featureSlug, planPath, model: configuredModel, logCapture },
		{ status: "running", exitCode: 0, finalOutput: "" },
	);
	onUpdate?.(runningDetails);

	const childResult = await runChildAgent({
		cwd,
		role,
		task,
		agent,
		appendPrompt,
		signal,
		logging: logCapture,
		onUpdate: (text) => {
			onUpdate?.(buildDelegateDetails(
				{ role, runId, label, packageId, featureSlug, planPath, model: configuredModel, logCapture },
				{ status: "running", exitCode: 0, finalOutput: text || "" },
			));
		},
	});

	let parsedPlan: ParsedPlan | undefined;
	let runtimeError: string | undefined;
	if (role === "planner" && planPath) {
		const planMarkdown = await readPlanFile(planPath);
		if (!planMarkdown) runtimeError = `Planner did not create the required plan file: ${planPath}`;
		else {
			const validationError = validatePlanFile(planMarkdown);
			if (validationError) runtimeError = `Planner created an invalid plan file at ${planPath}: ${validationError}`;
			else parsedPlan = parsePlanFile(planPath, planMarkdown);
		}
	}

	const childFailed = childResult.exitCode !== 0 || childResult.stopReason === "error" || childResult.stopReason === "aborted";
	const details = buildDelegateDetails(
		{ role, runId, label, packageId, featureSlug, planPath, model: childResult.model || configuredModel, logCapture },
		{
			status: childResult.stopReason === "aborted" ? "aborted" : runtimeError || childFailed ? "error" : "success",
			exitCode: childResult.exitCode,
			stderr: childResult.stderr || undefined,
			finalOutput: childResult.finalOutput,
			stopReason: childResult.stopReason,
			errorMessage: runtimeError || childResult.errorMessage,
		},
	);

	await recordRoleExecution(role, cwd, {
		task,
		status: runtimeError || childFailed ? "error" : "success",
		output: runtimeError || childResult.finalOutput || childResult.stderr || "(no output)",
		metadata: {
			sourceRunId,
			featureSlug,
			planPath,
			model: childResult.model || configuredModel,
			stopReason: childResult.stopReason,
			traceLogPath: details.traceLogPath,
			rawLogPath: details.rawLogPath,
			stderrLogPath: details.stderrLogPath,
		},
	});

	if (runtimeError) throw createDelegatedRoleError(runtimeError, details);
	if (childFailed) {
		throw createDelegatedRoleError(
			childResult.errorMessage || childResult.stderr || childResult.finalOutput || `Delegated role failed: ${role}`,
			details,
		);
	}

	return { details, parsedPlan };
}
