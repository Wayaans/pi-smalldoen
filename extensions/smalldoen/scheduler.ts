import type { ParsedPlan, PlanPackage } from "./plan";

export interface PackageGroup {
	index: number;
	packages: PlanPackage[];
}

function normalizeFile(value: string): string {
	return value.trim().replace(/\\/g, "/");
}

function fileSet(pkg: PlanPackage): Set<string> {
	return new Set([...pkg.filesToChange, ...pkg.affectedFiles].map(normalizeFile));
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
	for (const value of a) {
		if (b.has(value)) return true;
	}
	return false;
}

export function packagesConflict(left: PlanPackage, right: PlanPackage): boolean {
	if (!left.parallelSafe || !right.parallelSafe) return true;
	if (left.dependsOn.includes(right.packageId) || right.dependsOn.includes(left.packageId)) return true;
	return overlaps(fileSet(left), fileSet(right));
}

export function filterPackages(plan: ParsedPlan, packageIds?: string[]): PlanPackage[] {
	if (!packageIds || packageIds.length === 0) return plan.packages;
	const selected = new Set(packageIds);
	const packages = plan.packages.filter((pkg) => selected.has(pkg.packageId));
	const missing = packageIds.filter((packageId) => !packages.some((pkg) => pkg.packageId === packageId));
	if (missing.length > 0) {
		throw new Error(`Unknown package ids: ${missing.join(", ")}`);
	}
	for (const pkg of packages) {
		const unresolved = pkg.dependsOn.filter((dependency) => !selected.has(dependency));
		if (unresolved.length > 0) {
			throw new Error(`Package ${pkg.packageId} depends on unselected packages: ${unresolved.join(", ")}`);
		}
	}
	return packages;
}

export function schedulePackages(plan: ParsedPlan, packageIds?: string[]): PackageGroup[] {
	const packages = filterPackages(plan, packageIds);
	if (!plan.frontmatter.parallel_allowed) {
		return packages.map((pkg, index) => ({ index: index + 1, packages: [pkg] }));
	}

	const remaining = new Map(packages.map((pkg) => [pkg.packageId, pkg]));
	const completed = new Set<string>();
	const groups: PackageGroup[] = [];

	while (remaining.size > 0) {
		const eligible = Array.from(remaining.values()).filter((pkg) => pkg.dependsOn.every((dependency) => completed.has(dependency)));
		if (eligible.length === 0) {
			throw new Error("Could not schedule plan packages. Check for circular or unresolved dependencies.");
		}

		const group: PlanPackage[] = [];
		for (const pkg of eligible) {
			if (!pkg.parallelSafe) continue;
			if (group.some((existing) => packagesConflict(existing, pkg))) continue;
			group.push(pkg);
		}

		if (group.length === 0) {
			group.push(eligible[0]);
		}

		for (const pkg of group) {
			remaining.delete(pkg.packageId);
			completed.add(pkg.packageId);
		}

		groups.push({ index: groups.length + 1, packages: group });
	}

	return groups;
}
