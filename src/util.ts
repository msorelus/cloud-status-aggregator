import fetch from "node-fetch";
import { createHash } from "crypto";

/** Fetch with an AbortController-based timeout so a slow source can't hang the API. */
export async function fetchWithTimeout(
  url: string,
  init: Record<string, any> = {},
  timeoutMs = 15000
): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal as any });
    return res as any;
  } finally {
    clearTimeout(timer);
  }
}

/** Deterministic short id used when a source doesn't provide a tracking id. */
export function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
  return `${prefix}-${hash}`;
}

export function stripHtml(input: string | undefined): string {
  if (!input) return "";
  return input
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
