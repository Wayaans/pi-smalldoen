import { spawn } from "node:child_process";

export interface DocsLookupResult {
	mode: "url" | "query";
	success: boolean;
	provider?: "ctx7" | "fallback";
	libraryId?: string;
	ctx7Attempts?: number;
	fallbackUsed?: boolean;
	url?: string;
	query?: string;
	title?: string;
	content?: string;
	results?: Array<{ title: string; url: string }>;
	warning?: string;
	error?: string;
}

interface Ctx7CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal?: NodeJS.Signals | null;
	timedOut: boolean;
	error?: string;
}

interface Ctx7LibraryCandidate {
	index: number;
	title: string;
	libraryId: string;
	description: string;
	codeSnippets: number;
	sourceReputation: string;
	benchmarkScore: number;
}

const CTX7_TIMEOUT_MS = 15_000;
const CTX7_MAX_ATTEMPTS = 3;
const CTX7_KILL_GRACE_MS = 1_000;

function stripHtml(value: string): string {
	return value
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeLookupText(value: string): string {
	return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function looksLikeUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function looksLikeLibraryId(value: string): boolean {
	return /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(value);
}

function reputationWeight(value: string): number {
	switch (value.toLowerCase()) {
		case "high":
			return 3;
		case "medium":
			return 2;
		case "low":
			return 1;
		default:
			return 0;
	}
}

function scoreLibraryCandidate(candidate: Ctx7LibraryCandidate, query: string): number {
	const normalizedQuery = normalizeLookupText(query);
	const normalizedTitle = normalizeLookupText(candidate.title);
	const normalizedLibraryId = normalizeLookupText(candidate.libraryId);
	let score = candidate.benchmarkScore * 10 + candidate.codeSnippets + reputationWeight(candidate.sourceReputation) * 1_000;

	if (normalizedTitle === normalizedQuery) score += 20_000;
	if (normalizedLibraryId === normalizedQuery) score += 18_000;
	if (normalizedTitle.includes(normalizedQuery)) score += 5_000;
	if (normalizedQuery.includes(normalizedTitle)) score += 4_000;
	if (normalizedLibraryId.includes(normalizedQuery)) score += 3_000;

	return score;
}

function parseCtx7LibraryOutput(stdout: string): Ctx7LibraryCandidate[] {
	const blocks = stdout
		.trim()
		.split(/\n\s*\n(?=\d+\.\s+Title:\s)/g)
		.map((block) => block.trim())
		.filter(Boolean);

	const candidates: Ctx7LibraryCandidate[] = [];

	for (const block of blocks) {
		const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		if (lines.length === 0) continue;

		const indexMatch = lines[0]?.match(/^(\d+)\.\s+Title:\s*(.+)$/);
		const titleLine = lines.find((line) => /^\d+\.\s+Title:\s*/.test(line));
		const libraryIdLine = lines.find((line) => /^Context7-compatible library ID:\s*/.test(line));
		const descriptionLine = lines.find((line) => /^Description:\s*/.test(line));
		const codeSnippetsLine = lines.find((line) => /^Code Snippets:\s*/.test(line));
		const sourceReputationLine = lines.find((line) => /^Source Reputation:\s*/.test(line));
		const benchmarkScoreLine = lines.find((line) => /^Benchmark Score:\s*/.test(line));

		const title = titleLine?.replace(/^\d+\.\s+Title:\s*/, "").trim();
		const libraryId = libraryIdLine?.replace(/^Context7-compatible library ID:\s*/, "").trim();
		const description = descriptionLine?.replace(/^Description:\s*/, "").trim();
		const codeSnippets = Number.parseInt(codeSnippetsLine?.replace(/^Code Snippets:\s*/, "").trim() ?? "", 10);
		const sourceReputation = sourceReputationLine?.replace(/^Source Reputation:\s*/, "").trim();
		const benchmarkScore = Number.parseFloat(benchmarkScoreLine?.replace(/^Benchmark Score:\s*/, "").trim() ?? "");

		if (!title || !libraryId || !Number.isFinite(codeSnippets) || !sourceReputation || !Number.isFinite(benchmarkScore)) {
			continue;
		}

		candidates.push({
			index: Number.parseInt(indexMatch?.[1] ?? "0", 10) || candidates.length + 1,
			title,
			libraryId,
			description: description ?? "",
			codeSnippets,
			sourceReputation,
			benchmarkScore,
		});
	}

	return candidates;
}

function selectBestLibraryCandidate(candidates: Ctx7LibraryCandidate[], query: string): Ctx7LibraryCandidate | undefined {
	return [...candidates].sort((left, right) => scoreLibraryCandidate(right, query) - scoreLibraryCandidate(left, query))[0];
}

function runCtx7Command(args: string[], timeoutMs = CTX7_TIMEOUT_MS): Promise<Ctx7CommandResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		let childExited = false;

		const finish = (result: Ctx7CommandResult): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(result);
		};

		const child = spawn("ctx7", args, {
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			finish({
				stdout,
				stderr: stderr || error.message,
				exitCode: null,
				timedOut,
				error: error.message,
			});
		});
		child.on("close", (exitCode, signal) => {
			childExited = true;
			finish({ stdout, stderr, exitCode, signal, timedOut });
		});

		timer = setTimeout(() => {
			timedOut = true;
			stderr = stderr ? `${stderr}\nctx7 timed out after ${timeoutMs}ms` : `ctx7 timed out after ${timeoutMs}ms`;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!childExited) {
					child.kill("SIGKILL");
					finish({
						stdout,
						stderr,
						exitCode: null,
						timedOut,
						error: `ctx7 timed out after ${timeoutMs}ms`,
					});
				}
			}, CTX7_KILL_GRACE_MS).unref?.();
		}, timeoutMs);
	});
}

function buildCtx7LookupFailure(attempt: number, result: Ctx7CommandResult, step: string): string {
	const detail = [result.error, result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" — ");
	const suffix = detail ? `: ${detail}` : "";
	return `Ctx7 ${step} attempt ${attempt} failed${suffix}`;
}

async function lookupDocsWithCtx7(query: string): Promise<DocsLookupResult> {
	const normalizedQuery = query.trim();
	const directLibraryId = looksLikeLibraryId(normalizedQuery) ? normalizedQuery : undefined;
	const fallbackWarnings: string[] = [];
	let lastFailure = "Ctx7 lookup failed.";

	for (let attempt = 1; attempt <= CTX7_MAX_ATTEMPTS; attempt++) {
		if (directLibraryId) {
			const docsResult = await runCtx7Command(["docs", directLibraryId, "overview"]);
			const docsContent = docsResult.stdout.trim();
			if (docsResult.exitCode === 0 && docsContent) {
				return {
					mode: "query",
					success: true,
					provider: "ctx7",
					query: normalizedQuery,
					libraryId: directLibraryId,
					title: directLibraryId,
					content: docsContent,
					ctx7Attempts: attempt,
				};
			}
			lastFailure = buildCtx7LookupFailure(attempt, docsResult, "docs");
			fallbackWarnings.push(lastFailure);
			continue;
		}

		const libraryResult = await runCtx7Command(["library", normalizedQuery, normalizedQuery]);
		const libraryOutput = libraryResult.stdout.trim();
		const candidates = libraryOutput ? parseCtx7LibraryOutput(libraryOutput) : [];
		const selected = selectBestLibraryCandidate(candidates, normalizedQuery);
		if (!selected) {
			lastFailure = buildCtx7LookupFailure(attempt, libraryResult, "library");
			fallbackWarnings.push(lastFailure);
			continue;
		}

		const docsResult = await runCtx7Command(["docs", selected.libraryId, normalizedQuery]);
		const docsContent = docsResult.stdout.trim();
		if (docsResult.exitCode === 0 && docsContent) {
			return {
				mode: "query",
				success: true,
				provider: "ctx7",
				query: normalizedQuery,
				libraryId: selected.libraryId,
				title: selected.title,
				content: docsContent,
				ctx7Attempts: attempt,
			};
		}

		lastFailure = buildCtx7LookupFailure(attempt, docsResult, "docs");
		fallbackWarnings.push(lastFailure);
	}

	const fallbackResult = await searchDocs(normalizedQuery);
	if (fallbackResult.success) {
		return {
			...fallbackResult,
			provider: "fallback",
			fallbackUsed: true,
			ctx7Attempts: CTX7_MAX_ATTEMPTS,
			warning: fallbackWarnings.length > 0
				? `Ctx7 failed after ${CTX7_MAX_ATTEMPTS} attempts. ${fallbackWarnings[fallbackWarnings.length - 1] ?? lastFailure}. Using fallback search results.`
				: `Ctx7 failed after ${CTX7_MAX_ATTEMPTS} attempts. Using fallback search results.`,
		};
	}

	return {
		...fallbackResult,
		provider: "fallback",
		fallbackUsed: true,
		ctx7Attempts: CTX7_MAX_ATTEMPTS,
		error: fallbackWarnings.length > 0
			? `${fallbackResult.error ?? "Documentation lookup unavailable."} Ctx7 failed after ${CTX7_MAX_ATTEMPTS} attempts. ${fallbackWarnings[fallbackWarnings.length - 1] ?? lastFailure}`
			: fallbackResult.error,
	};
}

export async function fetchUrl(url: string): Promise<DocsLookupResult> {
	try {
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok) {
			return { mode: "url", success: false, url, error: `Request failed with status ${response.status}` };
		}
		const html = await response.text();
		const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		return {
			mode: "url",
			success: true,
			url,
			title: titleMatch?.[1]?.trim() ?? url,
			content: stripHtml(html).slice(0, 5000),
		};
	} catch (error) {
		return {
			mode: "url",
			success: false,
			url,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function searchDocs(query: string): Promise<DocsLookupResult> {
	const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	try {
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok) {
			return { mode: "query", success: false, query, error: `Search failed with status ${response.status}` };
		}
		const html = await response.text();
		const matches = Array.from(html.matchAll(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi))
			.slice(0, 5)
			.map((match) => ({ title: stripHtml(match[2] ?? "result"), url: match[1] ?? "" }))
			.filter((result) => result.url);
		if (matches.length === 0) {
			return {
				mode: "query",
				success: false,
				query,
				error: "No search results could be extracted. Documentation lookup may be unavailable.",
			};
		}
		return { mode: "query", success: true, query, results: matches };
	} catch (error) {
		return {
			mode: "query",
			success: false,
			query,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function lookupDocs(query: string): Promise<DocsLookupResult> {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) {
		return { mode: "query", success: false, query, error: "Provide either url or query." };
	}
	if (looksLikeUrl(normalizedQuery)) {
		return fetchUrl(normalizedQuery);
	}
	return lookupDocsWithCtx7(normalizedQuery);
}

export async function lookupDocumentation(input: { url?: string; query?: string }): Promise<DocsLookupResult> {
	const url = input.url?.trim();
	if (url) return fetchUrl(url);
	const query = input.query?.trim();
	if (!query) return { mode: "query", success: false, query: undefined, error: "Provide either url or query." };
	return lookupDocs(query);
}

export function buildDocsContext(result: DocsLookupResult): string {
	if (!result.success) {
		return `Documentation lookup unavailable: ${result.error ?? "unknown error"}${result.warning ? `\n${result.warning}` : ""}`;
	}
	if (result.mode === "url") {
		return [
			`URL: ${result.url}`,
			result.title ? `Title: ${result.title}` : undefined,
			"",
			result.content,
		].filter(Boolean).join("\n");
	}
	if (result.provider === "ctx7") {
		return [
			`Query: ${result.query}`,
			result.libraryId ? `Library ID: ${result.libraryId}` : undefined,
			result.title ? `Title: ${result.title}` : undefined,
			result.ctx7Attempts && result.ctx7Attempts > 1 ? `Ctx7 attempts: ${result.ctx7Attempts}` : undefined,
			result.warning ? `Note: ${result.warning}` : undefined,
			"",
			result.content?.trim(),
		].filter(Boolean).join("\n");
	}
	return [
		`Query: ${result.query}`,
		result.warning ? `Note: ${result.warning}` : undefined,
		"Results:",
		...(result.results ?? []).map((item, index) => `${index + 1}. ${item.title} — ${item.url}`),
	].join("\n");
}
