import { callMcpTool } from './mcpClient.js';
import { routeQuestion } from './router.js';
import { cite, describeIncident, displayRegion, nothingReported } from './statusText.js';
import type {
  ActiveIncidents,
  Incident,
  LookupResult,
  MaintenanceEvent,
  PlannedMaintenance,
  RegionalHealth
} from './types.js';

function maintenanceEvents(result: PlannedMaintenance): MaintenanceEvent[] {
  return Array.isArray(result) ? result : result.events ?? [];
}

function eventRegions(event: MaintenanceEvent): string[] {
  return [...(event.regions ?? []), ...(event.impactedRegions ?? []), ...(event.region ? [event.region] : [])];
}

function eventServices(event: MaintenanceEvent): string[] {
  return [...(event.services ?? []), ...(event.impactedServices ?? []), ...(event.service ? [event.service] : [])];
}

function allIncidents(result: ActiveIncidents): Incident[] {
  return [...(result.global ?? []), ...(result.regional ?? []), ...(result.maintenance ?? [])];
}

async function answerOverall(): Promise<string> {
  const result = await callMcpTool<ActiveIncidents>('get_active_incidents');
  // Maintenance is reported separately so "what's broken" doesn't get muddied
  // by a scheduled window three weeks out.
  const live = [...(result.global ?? []), ...(result.regional ?? [])];

  if (live.length === 0) {
    const maint = result.maintenance?.length ?? 0;
    const tail = maint > 0 ? ` ${maint} planned maintenance item${maint === 1 ? ' is' : 's are'} on the calendar.` : '';
    return `${nothingReported()}${tail}`;
  }

  const lead = live.slice(0, 5).map(describeIncident).join(' ');
  const more = live.length > 5 ? ` Plus ${live.length - 5} more.` : '';
  return `${lead}${more}`;
}

async function answerRegional(region: string): Promise<string> {
  const health = await callMcpTool<RegionalHealth>('get_regional_health', { region });
  const incidents = health.incidents ?? [];

  if (incidents.length === 0) {
    return `Nothing is currently reported for ${displayRegion(region)}. That means Microsoft has published no incident for that region — it is not a health check of your resources there.`;
  }

  return incidents.slice(0, 5).map(describeIncident).join(' ');
}

async function answerLookup(service: string, region?: string): Promise<string> {
  const args = region ? { service, region } : { service };
  const result = await callMcpTool<LookupResult>('lookup_service_region', args);
  const actualService = result.service ?? service;
  const incidents = result.incidents ?? [];
  const scope = region ? `${actualService} in ${displayRegion(result.region ?? region)}` : actualService;

  if (!result.impacted || incidents.length === 0) {
    return `Nothing is currently reported for ${scope}. Microsoft has published no incident covering that scope — this is not a live probe of the service.`;
  }

  const lead = incidents.slice(0, 3).map(describeIncident).join(' ');
  const more = incidents.length > 3 ? ` Plus ${incidents.length - 3} more.` : '';
  return `${lead}${more}`;
}

async function answerMaintenance(region?: string, service?: string): Promise<string> {
  // Scope server-side. Filtering here on impactedRegions used to miss real
  // events, because Service Health often names the region only in the title and
  // leaves the structured region list empty.
  const args: Record<string, string> = {};
  if (region) args.region = region;
  if (service) args.service = service;
  const events = maintenanceEvents(await callMcpTool<PlannedMaintenance>('get_planned_maintenance', args));

  if (events.length === 0) {
    const scope = [service, region && displayRegion(region)].filter(Boolean).join(' in ');
    return `No planned Azure maintenance found${scope ? ` for ${scope}` : ''}.`;
  }

  return events
    .slice(0, 5)
    .map((event) => {
      const services = eventServices(event).join(', ') || 'Azure service';
      const regions = eventRegions(event).map(displayRegion).join(', ');
      const where = regions ? ` in ${regions}` : '';
      return `${event.title ?? 'Planned maintenance'} affects ${services}${where}${cite(event.trackingId ? [event.trackingId] : [])}.`;
    })
    .join(' ');
}

export async function answer(question: string): Promise<string> {
  const routed = routeQuestion(question);
  if (routed.intent === 'maintenance') return answerMaintenance(routed.region, routed.service);
  if (routed.intent === 'lookup' && routed.service && routed.region) return answerLookup(routed.service, routed.region);
  if (routed.intent === 'service' && routed.service) return answerLookup(routed.service);
  if (routed.intent === 'regional' && routed.region) return answerRegional(routed.region);
  return answerOverall();
}
