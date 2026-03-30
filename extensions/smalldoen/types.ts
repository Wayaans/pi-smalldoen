export const SMALLDOEN_MODE_ENTRY = "smalldoen-mode" as const;
export const SMALLDOEN_STATUS_KEY = "smalldoen-status" as const;
export const DELEGATE_TOOL_NAME = "delegate" as const;

export const AGENT_ROLES = ["orchestrator", "scout", "planner", "engineer", "designer", "reviewer"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export interface OrchestrationModeState {
	enabled: boolean;
	previousModelSpec?: string;
}

export interface OrchestrationModeEntry {
	enabled: boolean;
	updatedAt: string;
}

export interface DelegateToolDetails {
	role: Exclude<AgentRole, "orchestrator">;
	planPath?: string;
	featureSlug?: string;
	exitCode: number;
	stderr?: string;
	finalOutput: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export interface PlanFeatureDetails {
	scoutUsed: boolean;
	featureSlug: string;
	planPath: string;
	packageCount: number;
	parallelAllowed: boolean;
	scoutSummary?: string;
	plannerSummary: string;
}

export interface ExecutedPackageDetails {
	packageId: string;
	owner: "engineer" | "designer";
	goal: string;
	filesToChange: string[];
	affectedFiles: string[];
	changedFiles: string[];
	exitCode: number;
	finalOutput: string;
	stderr?: string;
	model?: string;
}

export interface ExecutePlanDetails {
	featureSlug: string;
	planPath: string;
	groupCount: number;
	packageCount: number;
	groups: Array<{ index: number; packageIds: string[] }>;
	results: ExecutedPackageDetails[];
}

export interface ReviewExecutionDetails {
	runId: string;
	featureSlug: string;
	planPath: string;
	reportPath: string;
	verdict: "pass" | "pass_with_warnings" | "fail";
	routingHint: "none" | "engineer" | "designer" | "both";
	needRescout: boolean;
	summary: string;
	filesReviewed: string[];
	criticalIssueCount: number;
	warningCount: number;
}

export interface RunFeatureDetails {
	runId: string;
	featureSlug: string;
	planPath: string;
	reviewLoops: number;
	finalVerdict: "pass" | "pass_with_warnings" | "fail";
	reportPath: string;
	scoutUsed: boolean;
	packageCount: number;
}
