import type { Incident } from './types.js';

const statusText: Record<string, string> = {
  active: 'active incident',
  'in-progress': 'investigation in progress',
  scheduled: 'scheduled',
  information: 'advisory',
  resolved: 'resolved',
  unknown: 'unconfirmed'
};

export function readableStatus(status: string | undefined): string {
  if (!status) return 'unconfirmed';
  return statusText[status] ?? status;
}

export function cite(ids: unknown): string {
  const values = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  if (values.length === 0) return '';
  return ` (tracking ID${values.length === 1 ? '' : 's'} ${values.join(', ')})`;
}

export function displayRegion(region: string): string {
  const normalized = region.toLowerCase();
  return normalized === 'global' || normalized === 'non-regional' ? 'Non-Regional' : region;
}

/**
 * The line the agent must use when no incident matches. It deliberately does
 * not say "healthy" — the aggregator measures published incidents, not service
 * health, and the agent should never imply otherwise.
 */
export function nothingReported(): string {
  return 'No Azure incidents are currently reported by Microsoft across the configured sources. That means nothing has been published — it is not a per-service health check.';
}

/** One sentence describing a single incident, with its tracking ID cited. */
export function describeIncident(incident: Incident): string {
  const title = incident.title ?? 'An Azure incident';
  const where = [...(incident.impactedServices ?? []), ...(incident.impactedRegions ?? [])]
    .slice(0, 4)
    .map(displayRegion)
    .join(', ');
  const scope = where ? ` affecting ${where}` : '';
  const ids = incident.trackingId ? [incident.trackingId] : [];
  // A maintenance window carries status "active" once it is published, which
  // would otherwise read as an outage.
  const kind = incident.category === 'maintenance' ? 'planned maintenance' : readableStatus(incident.status);
  return `${title} — ${kind}${scope}${cite(ids)}.`;
}
