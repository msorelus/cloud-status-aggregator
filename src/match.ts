/**
 * Service / region matching against live incidents.
 *
 * These helpers answer "does this incident touch service X / region Y" using
 * only signals the sources actually publish — structured `impactedServices` /
 * `impactedRegions` where present, falling back to region detection inside the
 * free-text title (the public RSS feed carries no structured regions).
 *
 * Nothing here synthesizes state. If no incident matches, the honest answer is
 * "no incident reported", never "green".
 */

import { StatusIssue } from "./types";

/**
 * Broad Azure region vocabulary used to detect region names inside free-text
 * issue titles. This lets us tell "the title names a region we don't care
 * about" apart from "the title names no region at all" (a global event).
 */
export const REGION_VOCAB = [
  // Americas
  "East US 2", "East US", "Central US", "North Central US", "South Central US",
  "West Central US", "West US 3", "West US 2", "West US", "Canada East",
  "Canada Central", "Brazil South", "Brazil Southeast", "Mexico Central",
  "Chile Central",
  // Europe
  "North Europe", "West Europe", "UK South", "UK West", "France Central",
  "France South", "Germany West Central", "Switzerland North", "Norway East",
  "Sweden Central", "Italy North", "Poland Central", "Spain Central",
  // Asia / Pacific
  "Southeast Asia", "East Asia", "Japan East", "Japan West", "Korea Central",
  "Central India", "South India", "West India", "Australia East",
  "Australia Southeast", "Australia Central",
  // Middle East / Africa
  "UAE North", "Qatar Central", "South Africa North", "Israel Central",
];

export function normalizeRegion(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

const GLOBAL_ALIASES = new Set([
  "global",
  "non-regional",
  "non regional",
  "nonregional",
  "worldwide",
]);

export function isGlobalRegion(region: string): boolean {
  return GLOBAL_ALIASES.has(normalizeRegion(region));
}

/**
 * Detect known region names within free text, longest-match-first so that
 * "East US 2" is not mistaken for "East US". Returns canonical region names.
 */
export function detectRegions(text: string): string[] {
  let working = ` ${text} `;
  const found: string[] = [];
  for (const region of [...REGION_VOCAB].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(
      `(^|[^a-z0-9])${region.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
      "i"
    );
    if (re.test(working)) {
      found.push(region);
      working = working.replace(re, " "); // avoid double counting overlaps
    }
  }
  return found;
}

/** Does this issue impact the given service? Case-insensitive substring match. */
export function impactsService(issue: StatusIssue, service: string): boolean {
  const svc = service.toLowerCase().trim();
  if (!svc) return false;
  if (
    issue.impactedServices.some(
      (s) => s.toLowerCase().includes(svc) || svc.includes(s.toLowerCase())
    )
  ) {
    return true;
  }
  // Fall back to the title, which often names the service (e.g. RSS items).
  return issue.title.toLowerCase().includes(svc);
}

/**
 * Does this issue impact the given region?
 *  - Structured regions: exact match; "Global"/"Non-Regional" are equivalent.
 *  - No structured regions: infer from the title. If the title names regions,
 *    only those match; if it names none, the issue is treated as global.
 */
export function impactsRegion(issue: StatusIssue, region: string): boolean {
  const target = normalizeRegion(region);
  const wantGlobal = isGlobalRegion(region);

  if (issue.impactedRegions.length > 0) {
    return issue.impactedRegions.some((r) => {
      if (isGlobalRegion(r)) return wantGlobal;
      return normalizeRegion(r) === target;
    });
  }

  const detected = detectRegions(issue.title);
  if (detected.length > 0) {
    return detected.some((r) => normalizeRegion(r) === target);
  }
  // No region signal anywhere => treat as a global event.
  return wantGlobal;
}

/** Every distinct region named across a set of issues, plus "Global" when implied. */
export function regionsInPlay(issues: StatusIssue[]): string[] {
  const out = new Set<string>();
  for (const issue of issues) {
    if (issue.impactedRegions.length > 0) {
      for (const r of issue.impactedRegions) {
        out.add(isGlobalRegion(r) ? "Global" : r);
      }
      continue;
    }
    const detected = detectRegions(issue.title);
    if (detected.length > 0) detected.forEach((r) => out.add(r));
    else out.add("Global");
  }
  return [...out].sort();
}

/** Every distinct service named across a set of issues. */
export function servicesInPlay(issues: StatusIssue[]): string[] {
  const out = new Set<string>();
  for (const issue of issues) {
    for (const s of issue.impactedServices) if (s.trim()) out.add(s.trim());
  }
  return [...out].sort();
}

export function uniqueTrackingIds(
  issues: StatusIssue[],
  predicate: (i: StatusIssue) => boolean = () => true
): string[] {
  const ids = new Set<string>();
  for (const i of issues) {
    if (i.trackingId && predicate(i)) ids.add(i.trackingId);
  }
  return [...ids];
}
