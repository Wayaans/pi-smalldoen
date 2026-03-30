import type { ParsedPlan } from "./plan";
import type { ExecutedPackageDetails } from "./types";

export interface ReviewVerdict {
	verdict: "pass" | "pass_with_warnings" | "fail";
	routingHint: "none" | "engineer" | "designer" | "both";
	needRescout: boolean;
	filesReviewed: string[];
	criticalIssues: string[];
	warnings: string[];
	suggestions: string[];
	securityConcerns: string[];
	summary: string;
	rawOutput: string;
}

function extractSection(output: string, heading: string): string {
	const pattern = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, "i");
	const match = output.match(pattern);
	return match?.[1]?.trim() ?? "";
}

function extractBulletValues(section: string): string[] {
	return section
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[-*]/.test(line))
		.map((line) => line.replace(/^[-*]\s*/, "").trim())
		.filter(Boolean);
}

export function parseChangedFiles(output: string): string[] {
	const filesSection = extractSection(output, "Files Changed");
	const paths = extractBulletValues(filesSection).map((line) => {
		const match = line.match(/`([^`]+)`/);
		return (match?.[1] ?? line.split("—")[0] ?? line.split("-")[0]).trim();
	});
	return Array.from(new Set(paths.filter(Boolean)));
}

export function collectChangedFiles(results: ExecutedPackageDetails[]): string[] {
	return Array.from(new Set(results.flatMap((result) => result.changedFiles)));
}

export function collectAffectedFiles(plan: ParsedPlan, results: ExecutedPackageDetails[]): string[] {
	const packageIds = new Set(results.map((result) => result.packageId));
	const relatedPackages = plan.packages.filter((pkg) => packageIds.has(pkg.packageId));
	const files = relatedPackages.flatMap((pkg) => [...pkg.filesToChange, ...pkg.affectedFiles]);
	return Array.from(new Set(files));
}

export function buildReviewTask(input: {
	runId: string;
	plan: ParsedPlan;
	results: ExecutedPackageDetails[];
}): string {
	const changedFiles = collectChangedFiles(input.results);
	const affectedFiles = collectAffectedFiles(input.plan, input.results);
	const packageSummary = input.results
		.map((result) => `- ${result.packageId} (${result.owner}) changed: ${result.changedFiles.join(", ") || "none reported"}`)
		.join("\n");

	return [
		`Review run id: ${input.runId}`,
		`Plan path: ${input.plan.path}`,
		`Feature slug: ${input.plan.frontmatter.feature_slug}`,
		"",
		"Changed files to inspect directly:",
		...(changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`) : ["- none reported"]),
		"",
		"Affected files to inspect if needed:",
		...(affectedFiles.length > 0 ? affectedFiles.map((file) => `- ${file}`) : ["- none identified"]),
		"",
		"Worker package summary:",
		packageSummary || "- none",
		"",
		"Read the changed files directly and inspect nearby affected files as needed before you return the verdict.",
	].join("\n");
}

export function parseReviewOutput(output: string): ReviewVerdict {
	const verdictSection = extractSection(output, "Verdict").toLowerCase();
	const routingSection = extractSection(output, "Routing Hint").toLowerCase();
	const rescoutSection = extractSection(output, "Need Rescout").toLowerCase();
	const summary = extractSection(output, "Summary");

	const verdict = verdictSection.includes("pass_with_warnings")
		? "pass_with_warnings"
		: verdictSection.includes("fail")
			? "fail"
			: "pass";

	const routingHint = routingSection.includes("both")
		? "both"
		: routingSection.includes("designer")
			? "designer"
			: routingSection.includes("engineer")
				? "engineer"
				: "none";

	return {
		verdict,
		routingHint,
		needRescout: rescoutSection.includes("true"),
		filesReviewed: extractBulletValues(extractSection(output, "Files Reviewed")),
		criticalIssues: extractBulletValues(extractSection(output, "Critical Issues")),
		warnings: extractBulletValues(extractSection(output, "Warnings")),
		suggestions: extractBulletValues(extractSection(output, "Suggestions")),
		securityConcerns: extractBulletValues(extractSection(output, "Security Concerns")),
		summary,
		rawOutput: output,
	};
}
