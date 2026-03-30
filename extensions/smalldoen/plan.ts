import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { getSmalldoenPaths } from "./paths";

const VERSION_PATTERN = /^v(\d{3})\.md$/i;

export interface PlanFrontmatter {
	feature_slug: string;
	plan_version: string;
	created_at: string;
	source_run_id: string;
	parallel_allowed: boolean;
}

export interface PlanPackage {
	packageId: string;
	owner: "engineer" | "designer";
	goal: string;
	filesToChange: string[];
	affectedFiles: string[];
	dependsOn: string[];
	parallelSafe: boolean;
	acceptanceChecks: string[];
}

export interface ParsedPlan {
	path: string;
	frontmatter: PlanFrontmatter;
	markdown: string;
	packages: PlanPackage[];
}

function normalizeCsvCell(value: string): string[] {
	const text = value.replace(/`/g, "").trim();
	if (!text || text.toLowerCase() === "none") return [];
	return text
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeListCell(value: string): string[] {
	const text = value.replace(/`/g, "").trim();
	if (!text || text.toLowerCase() === "none") return [];
	return text
		.split(/[;,]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeBool(value: string): boolean {
	return ["true", "yes", "y", "1"].includes(value.trim().toLowerCase());
}

function parseTableRow(line: string): string[] {
	return line
		.split("|")
		.slice(1, -1)
		.map((value) => value.trim());
}

function extractWorkPackageTable(markdown: string): string[] {
	const sectionMatch = markdown.match(/## Work Packages\s*\n([\s\S]*?)(?:\n## |$)/);
	if (!sectionMatch) return [];
	return sectionMatch[1]
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export function slugifyFeatureName(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.replace(/-{2,}/g, "-") || "feature"
	);
}

export function getPlanDirectory(cwd: string, featureSlug: string): string {
	return path.join(getSmalldoenPaths(cwd).plansDir, featureSlug);
}

export async function getExistingPlanVersions(cwd: string, featureSlug: string): Promise<string[]> {
	const directory = getPlanDirectory(cwd, featureSlug);
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && VERSION_PATTERN.test(entry.name))
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

export async function getLatestPlanPath(cwd: string, featureSlug: string): Promise<string | undefined> {
	const versions = await getExistingPlanVersions(cwd, featureSlug);
	const latest = versions[versions.length - 1];
	return latest ? path.join(getPlanDirectory(cwd, featureSlug), latest) : undefined;
}

export async function getNextPlanPath(cwd: string, featureSlug: string): Promise<string> {
	const directory = getPlanDirectory(cwd, featureSlug);
	await fs.mkdir(directory, { recursive: true });
	const versions = await getExistingPlanVersions(cwd, featureSlug);
	const lastVersion = versions[versions.length - 1];
	const lastNumber = lastVersion ? Number.parseInt(lastVersion.slice(1, 4), 10) : 0;
	const nextNumber = `${lastNumber + 1}`.padStart(3, "0");
	return path.join(directory, `v${nextNumber}.md`);
}

export async function readPlanFile(planPath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(planPath, "utf8");
	} catch {
		return undefined;
	}
}

export function validatePlanFile(markdown: string): string | undefined {
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(markdown);
	const requiredFrontmatter = ["feature_slug", "plan_version", "created_at", "source_run_id", "parallel_allowed"];
	for (const key of requiredFrontmatter) {
		if (!(key in frontmatter)) return `Missing required frontmatter field: ${key}`;
	}

	const requiredSections = ["# Goal", "## Work Packages", "## Execution Order", "## Risks", "## Review Focus"];
	for (const section of requiredSections) {
		if (!markdown.includes(section)) return `Missing required section: ${section}`;
	}

	const requiredHeader = "| Package ID | Owner | Goal | Files To Change | Affected Files | Depends On | Parallel Safe | Acceptance Checks |";
	if (!markdown.includes(requiredHeader)) return "Missing required work package table header.";

	const packageLines = extractWorkPackageTable(markdown);
	if (packageLines.length < 3) return "Work package table must include at least one package row.";

	return undefined;
}

export function parsePlanPackages(markdown: string): PlanPackage[] {
	const lines = extractWorkPackageTable(markdown);
	if (lines.length < 3) return [];

	const rows = lines.filter((line) => line.startsWith("|"));
	const dataRows = rows.slice(2);
	return dataRows.map((row) => {
		const [packageId, owner, goal, filesToChange, affectedFiles, dependsOn, parallelSafe, acceptanceChecks] = parseTableRow(row);
		if (owner !== "engineer" && owner !== "designer") {
			throw new Error(`Invalid package owner: ${owner}`);
		}
		return {
			packageId,
			owner,
			goal,
			filesToChange: normalizeCsvCell(filesToChange),
			affectedFiles: normalizeCsvCell(affectedFiles),
			dependsOn: normalizeListCell(dependsOn),
			parallelSafe: normalizeBool(parallelSafe),
			acceptanceChecks: normalizeListCell(acceptanceChecks),
		};
	});
}

export function parsePlanFile(planPath: string, markdown: string): ParsedPlan {
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(markdown);
	return {
		path: planPath,
		frontmatter: {
			feature_slug: String(frontmatter.feature_slug ?? ""),
			plan_version: String(frontmatter.plan_version ?? ""),
			created_at: String(frontmatter.created_at ?? ""),
			source_run_id: String(frontmatter.source_run_id ?? ""),
			parallel_allowed: normalizeBool(String(frontmatter.parallel_allowed ?? "false")),
		},
		markdown,
		packages: parsePlanPackages(markdown),
	};
}

export async function loadParsedPlan(planPath: string): Promise<ParsedPlan> {
	const markdown = await readPlanFile(planPath);
	if (!markdown) throw new Error(`Plan file not found: ${planPath}`);
	const validationError = validatePlanFile(markdown);
	if (validationError) throw new Error(`Invalid plan file at ${planPath}: ${validationError}`);
	return parsePlanFile(planPath, markdown);
}
