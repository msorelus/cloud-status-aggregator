// =============================================================================
// Cloud Status Aggregator — entry point
// -----------------------------------------------------------------------------
// Subscription-scoped so it can create its own resource group. This is the
// shape Azure Developer CLI expects, and it is what `azd up` deploys.
//
//   azd up                                  provision + build + deploy
//   az deployment sub create ...            the same template without azd
//
// Everything real lives in resources.bicep.
// =============================================================================

targetScope = 'subscription'

@minLength(1)
@maxLength(64)
@description('Name of the environment. azd supplies this; it names the resource group and tags every resource.')
param environmentName string

@minLength(1)
@description('Primary Azure region for all resources.')
param location string

@description('Existing resource group to deploy into. Empty = create rg-<environmentName>.')
param resourceGroupName string = ''

@description('Workload short name used in resource names.')
param workload string = 'azstatus'

@description('Deployment tier used in resource names and tags.')
@allowed([ 'dev', 'test', 'staging', 'prod' ])
param environment string = 'dev'

@description('Region short code used in resource names (e.g. eus2).')
param regionShort string = 'eus2'

@description('Instance suffix.')
param instance string = '001'

@description('Owner tag (team or individual).')
param owner string = 'platform-team'

@description('Cost center tag.')
param costCenter string = 'TBD'

@description('azd service name. Must match the service key in azure.yaml.')
param serviceName string = 'api'

@description('Container image. Leave empty and let azd build and push it.')
param containerImage string = ''

@description('True when the container app already exists, so its current image survives a re-provision. azd sets this from SERVICE_API_RESOURCE_EXISTS.')
param apiExists bool = false

@description('Object ID of the principal running the deployment. azd supplies this as AZURE_PRINCIPAL_ID.')
param principalId string = ''

@description('Principal type of principalId: User for an interactive deploy, ServicePrincipal from CI.')
@allowed([ 'User', 'ServicePrincipal', 'Group' ])
param principalType string = 'User'

@description('Optional comma-separated subscription IDs for subscription-scoped Service Health and Resource Health. Empty = public sources only.')
param subscriptionIds string = ''

@description('Grant the workload identity Reader on this whole subscription when subscriptionIds is set. Service Health and Resource Health are subscription-scoped APIs, so without this they only ever see the aggregator resource group. Set false if you assign Reader out of band.')
param grantSubscriptionReader bool = true

@description('Turn on the change watcher: poll the sources and publish deltas.')
param watchEnabled bool = true

@description('How often the watcher polls, in seconds. Minimum 15.')
@minValue(15)
@maxValue(3600)
param watchIntervalSeconds int = 60

@description('Endpoint that receives the change webhook. Empty = record changes at /api/status/changes without publishing.')
param webhookUrl string = ''

@description('Shared secret used to HMAC-sign the webhook body. Leave empty to send unsigned (not recommended).')
@secure()
param webhookSecret string = ''

@description('Extra Entra ID object IDs allowed to read the Key Vault secret (e.g. the platform team group).')
param keyVaultAdminObjectIds array = []

@description('Minimum container replicas. Keep at 1 so the watcher baseline survives between polls.')
@minValue(1)
param minReplicas int = 1

@description('Maximum container replicas.')
@minValue(1)
param maxReplicas int = 3

// --- Entra ID protection for the MCP endpoint --------------------------------
// The MCP server is an OAuth 2.0 resource server: it validates Entra-issued
// tokens but never mints them. Leaving this false ships an open endpoint, which
// is fine for an offline demo and not fine for anything reachable.
@description('Require a Microsoft Entra ID access token on /mcp.')
param mcpAuthEnabled bool = false

@description('Directory (tenant) GUID that issues MCP access tokens. Defaults to the deploying tenant.')
param mcpAuthTenantId string = ''

@description('Client ID of the API app registration whose scope guards /mcp. Required when mcpAuthEnabled is true.')
param mcpAuthAudience string = ''

@description('Comma-separated unqualified scope names exposed by that app registration.')
param mcpAuthScopes string = 'status.read'

@description('Override the externally reachable origin. Leave empty to derive it from the Container Apps default domain.')
param publicBaseUrlOverride string = ''

var rgName = !empty(resourceGroupName) ? resourceGroupName : 'rg-${environmentName}'
var resourceToken = toLower(take(uniqueString(subscription().id, environmentName, location), 8))

var tags = {
  // azd uses this tag to discover what belongs to the environment. Keep it.
  'azd-env-name': environmentName
  Environment: environment
  Owner: owner
  CostCenter: costCenter
  Application: 'cloud-status-aggregator'
}

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: rgName
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'csa-resources'
  scope: rg
  params: {
    workload: workload
    environment: environment
    location: location
    regionShort: regionShort
    instance: instance
    resourceToken: resourceToken
    tags: tags
    serviceName: serviceName
    containerImage: containerImage
    apiExists: apiExists
    principalId: principalId
    principalType: principalType
    subscriptionIds: subscriptionIds
    watchEnabled: watchEnabled
    watchIntervalSeconds: watchIntervalSeconds
    webhookUrl: webhookUrl
    webhookSecret: webhookSecret
    keyVaultAdminObjectIds: keyVaultAdminObjectIds
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    mcpAuthEnabled: mcpAuthEnabled
    // Falling back to the deploying tenant keeps the common single-tenant case
    // to one required setting: the audience.
    mcpAuthTenantId: empty(mcpAuthTenantId) ? tenant().tenantId : mcpAuthTenantId
    mcpAuthAudience: mcpAuthAudience
    mcpAuthScopes: mcpAuthScopes
    publicBaseUrlOverride: publicBaseUrlOverride
  }
}

// --- Subscription-scope Reader -----------------------------------------------
// Resource Health (availabilityStatuses) and Service Health only return what the
// caller can read. Reader on the aggregator resource group alone means those two
// layers report on the aggregator's own resources and nothing else — and they do
// it silently, as a successful empty result, which reads as "all healthy".
//
// This grants Reader across the deployment subscription whenever subscriptionIds
// is set. Any OTHER subscription listed in subscriptionIds has to be granted
// separately; a deployment cannot assign roles outside its own scope.
var assignSubscriptionReader = grantSubscriptionReader && !empty(subscriptionIds)

module subscriptionReader 'subscription-reader.bicep' = if (assignSubscriptionReader) {
  name: 'csa-subscription-reader'
  params: {
    principalId: resources.outputs.managedIdentityPrincipalId
  }
}

// --- azd contract outputs ----------------------------------------------------
// azd reads these back into the environment. AZURE_CONTAINER_REGISTRY_ENDPOINT
// is required for the containerapp host to know where to push.
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenant().tenantId
output AZURE_RESOURCE_GROUP string = rg.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.containerRegistryLoginServer
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.containerRegistryName
output SERVICE_API_NAME string = resources.outputs.containerAppName
output SERVICE_API_URI string = resources.outputs.apiUrl

// --- Human-readable outputs --------------------------------------------------
output apiUrl string = resources.outputs.apiUrl
output statusViewUrl string = resources.outputs.statusViewUrl
output changesUrl string = resources.outputs.changesUrl
output mcpUrl string = resources.outputs.mcpUrl
output managedIdentityClientId string = resources.outputs.managedIdentityClientId
output managedIdentityPrincipalId string = resources.outputs.managedIdentityPrincipalId
output logAnalyticsWorkspaceId string = resources.outputs.logAnalyticsWorkspaceId
output keyVaultName string = resources.outputs.keyVaultName
output mcpAuthEnabled bool = resources.outputs.mcpAuthEnabled
output mcpAuthAudience string = resources.outputs.mcpAuthAudience
output mcpProtectedResourceMetadataUrl string = resources.outputs.mcpProtectedResourceMetadataUrl
