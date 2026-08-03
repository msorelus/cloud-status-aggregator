const regionAliases = [
  ['East US 2', ['east us 2', 'eastus2']],
  ['West US 2', ['west us 2', 'westus2']],
  ['East US', ['east us', 'eastus']],
  ['West US', ['west us', 'westus']],
  ['West Europe', ['west europe', 'westeurope']],
  ['North Europe', ['north europe', 'northeurope']],
  ['Southeast Asia', ['southeast asia', 'southeastasia']],
  ['East Asia', ['east asia', 'eastasia']],
  ['Central US', ['central us', 'centralus']],
  ['South Central US', ['south central us', 'southcentralus']],
  ['UK South', ['uk south', 'uksouth']],
  ['Canada Central', ['canada central', 'canadacentral']],
  ['Australia East', ['australia east', 'australiaeast']],
  ['Japan East', ['japan east', 'japaneast']],
  ['Global', ['global', 'non-regional', 'non regional', 'worldwide']]
] as const;

const serviceAliases = [
  ['Azure Front Door', ['azure front door', 'front door', 'afd']],
  ['SQL Database', ['azure sql database', 'sql database', 'sql db', 'azure sql']],
  ['Storage', ['azure storage', 'storage', 'blob']],
  ['Virtual Machines', ['virtual machines', 'virtual machine', 'vms', 'vm']],
  ['AKS', ['aks', 'kubernetes', 'azure kubernetes service']],
  ['Azure Functions', ['azure functions', 'function app', 'functions']],
  ['App Service', ['app service', 'web app', 'web apps']],
  ['Cosmos DB', ['cosmos db', 'cosmos']],
  ['Azure Monitor', ['azure monitor', 'monitor']],
  ['Key Vault', ['key vault', 'azure key vault']],
  ['Service Bus', ['service bus']],
  ['Event Hubs', ['event hubs', 'event hub']]
] as const;

export type Intent = 'maintenance' | 'lookup' | 'service' | 'regional' | 'overall';

export type RoutedQuestion = {
  intent: Intent;
  region?: string;
  service?: string;
};

function findAlias(question: string, aliases: readonly (readonly [string, readonly string[]])[]): string | undefined {
  const normalized = question.toLowerCase();
  const sorted = [...aliases].sort((a, b) => b[0].length - a[0].length);
  return sorted.find(([, candidates]) => candidates.some((candidate) => normalized.includes(candidate)))?.[0];
}

export function routeQuestion(question: string): RoutedQuestion {
  const normalized = question.toLowerCase();
  const region = findAlias(question, regionAliases);
  const service = findAlias(question, serviceAliases);
  const asksMaintenance = /planned|scheduled|maintenance|upcoming/.test(normalized);

  if (asksMaintenance) return { intent: 'maintenance', region, service };
  // Naming a place (and optionally a service) is itself the signal. Gating on a
  // health keyword used to drop natural questions like "how is East US 2" and
  // "is Front Door ok in Global" into the catch-all answer.
  if (service && region) return { intent: 'lookup', region, service };
  // A service on its own is a real question ("is Front Door having problems?").
  // Without this it fell through to 'overall' and answered with every unrelated
  // incident in the tenant, which reads as a hallucination.
  if (service) return { intent: 'service', service };
  if (region) return { intent: 'regional', region };
  return { intent: 'overall', region, service };
}

export function matchesFilter(value: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true;
  if (!value) return false;
  return value.toLowerCase().includes(filter.toLowerCase()) || filter.toLowerCase().includes(value.toLowerCase());
}
