export interface DocsLookupResult {
	mode: "url" | "query";
	success: boolean;
	url?: string;
	query?: string;
	title?: string;
	content?: string;
	results?: Array<{ title: string; url: string }>;
	error?: string;
}

function stripHtml(value: string): string {
	return value
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
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

export function buildDocsContext(result: DocsLookupResult): string {
	if (!result.success) {
		return `Documentation lookup unavailable: ${result.error ?? "unknown error"}`;
	}
	if (result.mode === "url") {
		return [`URL: ${result.url}`, result.title ? `Title: ${result.title}` : undefined, "", result.content].filter(Boolean).join("\n");
	}
	return [
		`Query: ${result.query}`,
		"Results:",
		...(result.results ?? []).map((item, index) => `${index + 1}. ${item.title} — ${item.url}`),
	].join("\n");
}
