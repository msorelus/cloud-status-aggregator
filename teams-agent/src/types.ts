/**
 * Shapes returned by the aggregator's MCP tools.
 *
 * These mirror the incident-first contract: every field describes something a
 * source actually published. There is no synthesized service-by-region matrix,
 * so there is no "good" state — the absence of an incident is just an empty
 * list, and the agent must phrase it as "nothing reported".
 */

export type IssueCategory = 'global' | 'regional' | 'maintenance';

export type IssueStatus =
  | 'active'
  | 'resolved'
  | 'scheduled'
  | 'in-progress'
  | 'information'
  | 'unknown';

export type Incident = {
  id?: string;
  category?: IssueCategory;
  status?: IssueStatus;
  title?: string;
  summary?: string;
  impactedServices?: string[];
  impactedRegions?: string[];
  trackingId?: string;
  startTime?: string;
  lastUpdateTime?: string;
  link?: string;
  source?: string;
};

export type ActiveIncidents = {
  generatedAt?: string;
  overall?: 'healthy' | 'advisory' | 'degraded';
  counts?: { global: number; regional: number; maintenance: number };
  global?: Incident[];
  regional?: Incident[];
  maintenance?: Incident[];
  regionsAffected?: string[];
  servicesAffected?: string[];
  activeTrackingIds?: string[];
  note?: string;
};

export type RegionalHealth = {
  region?: string;
  incidentCount?: number;
  incidents?: Incident[];
  servicesAffected?: string[];
  activeTrackingIds?: string[];
  note?: string;
};

export type MaintenanceEvent = Incident & {
  region?: string;
  regions?: string[];
  service?: string;
  services?: string[];
};

export type PlannedMaintenance =
  | MaintenanceEvent[]
  | {
      events?: MaintenanceEvent[];
      count?: number;
      generatedAt?: string;
    };

export type LookupResult = {
  service?: string;
  region?: string;
  impacted?: boolean;
  incidentCount?: number;
  incidents?: Incident[];
  activeTrackingIds?: string[];
  note?: string;
};
