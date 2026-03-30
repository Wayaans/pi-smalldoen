import { getAgentConfig } from "./agents";
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
import { runChildAgent } from "./subprocess";
import type { DelegateToolDetails } from "./types";

export const workerRoles = ["scout", "planner", "engineer", "designer", "reviewer"] as const;
export type WorkerRole = (typeof workerRoles)[number];

export interface RunDelegatedRoleParams {
	cwd: string;
	role: WorkerRole;
	task: string;
	feature?: string;
	signal?: AbortSignal;
	onUpdate?: (details: DelegateToolDetails) => void;
}

export interface RunDelegatedRoleResult {
	details: DelegateToolDetails;
	parsedPlan?: ParsedPlan;
}

function createRunId(): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `run-${timestamp}`;
}

export async function runDelegatedRole(params: RunDelegatedRoleParams): Promise<RunDelegatedRoleResult> {
	const { cwd, role, task, feature, signal, onUpdate } = params;
	const agent = getAgentConfig(cwd, role);
	if (!agent) throw new Error(`Missing agent definition for role: ${role}`);

	let featureSlug: string | undefined;
	let planPath: string | undefined;
	let appendPrompt: string | undefined;
	const sourceRunId = createRunId();

	const roleMemoryContext = await buildRoleMemoryContext(role, cwd);

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

	const childResult = await runChildAgent({
		cwd,
		role,
		task,
		agent,
		appendPrompt,
		signal,
		onUpdate: (text) => {
			onUpdate?.({
				role,
				featureSlug,
				planPath,
				exitCode: 0,
				finalOutput: text || "",
			});
		},
	});

	let parsedPlan: ParsedPlan | undefined;
	if (role === "planner" && planPath) {
		const planMarkdown = await readPlanFile(planPath);
		if (!planMarkdown) throw new Error(`Planner did not create the required plan file: ${planPath}`);
		const validationError = validatePlanFile(planMarkdown);
		if (validationError) throw new Error(`Planner created an invalid plan file at ${planPath}: ${validationError}`);
		parsedPlan = parsePlanFile(planPath, planMarkdown);
	}

	const details: DelegateToolDetails = {
		role,
		featureSlug,
		planPath,
		exitCode: childResult.exitCode,
		stderr: childResult.stderr || undefined,
		finalOutput: childResult.finalOutput,
		model: childResult.model,
		stopReason: childResult.stopReason,
		errorMessage: childResult.errorMessage,
	};

	const isError = childResult.exitCode !== 0 || childResult.stopReason === "error" || childResult.stopReason === "aborted";
	await recordRoleExecution(role, cwd, {
		task,
		status: isError ? "error" : "success",
		output: childResult.finalOutput || childResult.stderr || "(no output)",
		metadata: {
			sourceRunId,
			featureSlug,
			planPath,
			model: childResult.model,
			stopReason: childResult.stopReason,
		},
	});

	if (isError) {
		throw new Error(childResult.errorMessage || childResult.stderr || childResult.finalOutput || `Delegated role failed: ${role}`);
	}

	return { details, parsedPlan };
}
