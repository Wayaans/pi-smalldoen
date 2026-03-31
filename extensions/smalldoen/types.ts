export const SMALLDOEN_MODE_ENTRY = "smalldoen-mode" as const;
export const SMALLDOEN_STATUS_KEY = "smalldoen-status" as const;
export const DELEGATE_TOOL_NAME = "delegate" as const;

export const AGENT_ROLES = ["orchestrator", "scout", "planner", "engineer", "designer", "reviewer"] as const;
export const SUBAGENT_LOG_MODES = ["off", "trace", "full"] as const;

export type SubagentLogMode = (typeof SUBAGENT_LOG_MODES)[number];

export type AgentRole = (typeof AGENT_ROLES)[number];

export interface OrchestrationModeState {
	enabled: boolean;
	previousModelSpec?: string;
}

export interface OrchestrationModeEntry {
	enabled: boolean;
	updatedAt: string;
}

export interface ReviewSummary {
	verdict: "pass" | "pass_with_warnings" | "fail";
	routingHint: "none" | "engineer" | "designer" | "both";
	needRescout: boolean;
	summary: string;
}

export interface DelegateToolDetails {
	role: Exclude<AgentRole, "orchestrator">;
	status: "running" | "success" | "error" | "aborted";
	runId?: string;
	label?: string;
	packageId?: string;
	planPath?: string;
	reportPath?: string;
	featureSlug?: string;
	exitCode: number;
	stderr?: string;
	finalOutput: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	traceLogPath?: string;
	rawLogPath?: string;
	stderrLogPath?: string;
	changedFiles?: string[];
	review?: ReviewSummary;
}

export interface PlanInspectionPackage {
	packageId: string;
	owner: "engineer" | "designer";
	goal: string;
	filesToChange: string[];
	affectedFiles: string[];
	dependsOn: string[];
	parallelSafe: boolean;
	acceptanceChecks: string[];
}

export interface PlanInspectionDetails {
	featureSlug: string;
	planPath: string;
	parallelAllowed: boolean;
	packageCount: number;
	groups: Array<{ index: number; packageIds: string[] }>;
	packages: PlanInspectionPackage[];
}

export interface ManageRunDetails {
	action: "start" | "status" | "stage" | "package" | "review" | "finish";
	runId: string;
	feature: string;
	featureSlug: string;
	status: "active" | "stale" | "failed" | "completed";
	stage: string;
	updatedAt: string;
	planPath?: string;
	review?: ReviewSummary;
	packageCount: number;
	activeSubagentCount: number;
	completedPackageCount: number;
	failedPackageCount: number;
	packageId?: string;
}
