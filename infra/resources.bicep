// =============================================================================
// Cloud Status Aggregator — resources
// -----------------------------------------------------------------------------
// Everything that lives inside the resource group. Deployed as a module from
// main.bicep so the same template works for `azd up` and for a plain
// `az deployment sub create`.
//
// The aggregator API runs on Azure Container Apps behind a user-assigned
// managed identity. That identity is granted the built-in Reader role, which is
// all that is required to read Microsoft.ResourceHealth/emergingIssues,
// Microsoft.ResourceHealth/availabilityStatuses and ServiceHealthResources.
//
// The webhook shared secret is held in Key Vault as the system of record for
// rotation and audit. It reaches the container as a platform-managed Container
// Apps secret, and WEBHOOK_SECRET is always a secretRef, never a literal value.
// It travels as a @secure() parameter, so it never appears in deployment output.
//
// Naming and tags follow CAF. This is a baseline sized for a pilot: for
// production, add VNet integration with private endpoints, a custom domain
// with WAF, and resource locks. Those are called out in handoff/index.html.
// =============================================================================

targetScope = 'resourceGroup'

@description('Workload short name used in resource names.')
@minLength(3)
@maxLength(12)
param workload string = 'azstatus'

@description('Environment: dev | test | staging | prod')
@allowed([ 'dev', 'test', 'staging', 'prod' ])
param environment string = 'dev'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Region short code used in resource names (e.g. eus2).')
param regionShort string = 'eus2'

@description('Instance suffix.')
param instance string = '001'

@description('Short deterministic suffix that keeps globally unique names collision free.')
@minLength(6)
@maxLength(12)
param resourceToken string

@description('Tags applied to every resource. Must include azd-env-name for azd environments.')
param tags object = {}

@description('azd service name. Tags the container app so `azd deploy` can find it.')
param serviceName string = 'api'

@description('Container image. Leave empty to keep the image already running, or to start from a placeholder on a first deployment.')
param containerImage string = ''

@description('True when the container app already exists, so its current image survives a re-provision.')
param apiExists bool = false

@description('Object ID of the principal running the deployment. Granted push rights on the registry and read rights on the signing secret.')
param principalId string = ''

@description('Principal type of principalId: User for an interactive deploy, ServicePrincipal from CI.')
@allowed([ 'User', 'ServicePrincipal', 'Group' ])
param principalType string = 'User'

@description('Optional comma-separated subscription IDs for subscription-scoped Service Health and Resource Health. Empty = public sources only.')
param subscriptionIds string = ''

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
@description('Require a Microsoft Entra ID access token on /mcp. Leave false to run the endpoint open (pilot only).')
param mcpAuthEnabled bool = false

@description('Directory (tenant) GUID that issues MCP access tokens. Required when mcpAuthEnabled is true.')
param mcpAuthTenantId string = ''

@description('Client ID of the API app registration. Becomes the accepted token audience. Required when mcpAuthEnabled is true.')
param mcpAuthAudience string = ''

@description('Comma-separated unqualified scope names exposed by the API app registration.')
param mcpAuthScopes string = 'status.read'

@description('Override the externally reachable origin. Leave empty to derive it from the Container Apps default domain; set it when fronting the app with a custom domain, Front Door or Application Gateway.')
param publicBaseUrlOverride string = ''

var namePart = '${workload}-${environment}-${regionShort}-${instance}'
var appName = 'ca-${namePart}'
// Key Vault and container registry names are globally unique, so they carry the
// resource token. Key Vault is capped at 24 characters and may not contain '--'.
var kvName = take('kv-${workload}-${resourceToken}', 24)
var acrName = take('cr${workload}${resourceToken}', 50)

var publishWebhook = !empty(webhookUrl)
var signWebhook = !empty(webhookSecret)
var grantPrincipal = !empty(principalId)

// Built-in role definition IDs.
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPushRoleId = '8311e382-0749-4cb8-b61a-304f252e45ec'

// On a first deployment there is no image yet, so the app starts on a
// placeholder and `azd deploy` swaps in the real one. On every deployment after
// that the running image is read back so re-provisioning never rolls it back.
// The read happens in a separate module because an `existing` reference to the
// app being deployed would be a circular dependency.
var placeholderImage = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'
module fetchImage 'fetch-container-image.bicep' = {
  name: 'fetch-${appName}'
  params: {
    exists: apiExists
    name: appName
  }
}
var runningImage = length(fetchImage.outputs.containers) > 0 ? fetchImage.outputs.containers[0].image : ''
var effectiveImage = !empty(containerImage) ? containerImage : (!empty(runningImage) ? runningImage : placeholderImage)
var isPlaceholder = effectiveImage == placeholderImage

// Ingress always points at the port the real application listens on. Binding it
// to the placeholder's port instead would leave a first-time `azd up` serving
// traffic on the wrong port after `azd deploy` swapped the image in, and would
// only correct itself on a second provision.
var appPort = 8080

// --- Observability -----------------------------------------------------------
resource law 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${namePart}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// --- Container registry ------------------------------------------------------
// Admin user stays off: both the build push and the runtime pull are done with
// Entra identities.
resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled' // Pilot only — switch to a private endpoint for production.
  }
}

// --- User-assigned Managed Identity -----------------------------------------
// All service-to-service auth runs through this identity. No secrets in config.
resource uami 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${namePart}'
  location: location
  tags: tags
}

// Reader at resource-group scope satisfies the provider-level emergingIssues
// read, which is not tied to any subscription. Service Health and Resource
// Health ARE subscription-scoped and need more: main.bicep adds Reader across
// the subscription whenever subscriptionIds is set.
resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, uami.id, readerRoleId)
  scope: resourceGroup()
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, uami.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Lets `azd deploy` (or `az acr build`) push from the operator's own identity
// instead of a registry admin password.
resource acrPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (grantPrincipal) {
  name: guid(acr.id, principalId, acrPushRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPushRoleId)
    principalId: principalId
    principalType: principalType
  }
}

// --- Key Vault for the webhook signing secret --------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = if (signWebhook) {
  name: kvName
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled' // Pilot only — switch to a private endpoint for production.
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource webhookSecretEntry 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (signWebhook) {
  parent: kv
  name: 'webhook-signing-secret'
  properties: {
    value: webhookSecret
    contentType: 'text/plain'
  }
}

// The container's identity may read the secret; nothing else is granted.
resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (signWebhook) {
  name: guid(kv.id, uami.id, keyVaultSecretsUserRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: uami.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource kvAdmins 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for objectId in keyVaultAdminObjectIds: if (signWebhook) {
  name: guid(kv.id, objectId, keyVaultSecretsUserRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: objectId
  }
}]

resource kvDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (signWebhook) {
  name: 'diag-to-law'
  scope: kv
  properties: {
    workspaceId: law.id
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

// --- Container Apps environment ---------------------------------------------
resource cae 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${namePart}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: law.properties.customerId
        sharedKey: law.listKeys().primarySharedKey
      }
    }
  }
}

// --- The API container app ---------------------------------------------------
// The MCP `resource` identifier must be the origin clients actually dial, and it
// is baked into the container's environment. Reading it back from the app's own
// ingress would be a self-reference, so it is composed from the environment's
// default domain instead — known before the app exists, and identical to the
// FQDN the platform will assign.
var derivedBaseUrl = 'https://${appName}.${cae.properties.defaultDomain}'
var publicBaseUrl = empty(publicBaseUrlOverride) ? derivedBaseUrl : publicBaseUrlOverride

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  // azd finds the app to deploy into by this tag. Renaming it breaks `azd deploy`.
  tags: union(tags, { 'azd-service-name': serviceName })
  dependsOn: signWebhook ? [ webhookSecretEntry, kvSecretsUser, acrPull ] : [ acrPull ]
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${uami.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: cae.id
    configuration: {
      ingress: {
        external: true
        targetPort: appPort
        transport: 'auto'
        allowInsecure: false // TLS enforced; Container Apps terminates at 1.2+.
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: uami.id
        }
      ]
      // The value comes in as a @secure() parameter, so it is never logged and
      // never surfaces in deployment output. It is deliberately NOT a Key Vault
      // secret reference: the platform resolves those at revision-provisioning
      // time using the app's identity, and a brand-new RBAC assignment has not
      // reliably reached the Key Vault data plane by then, so a first-time
      // `azd up` fails. Key Vault remains the system of record for the secret.
      secrets: signWebhook ? [
        {
          name: 'webhook-signing-secret'
          value: webhookSecret
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'api'
          image: effectiveImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(
            [
              { name: 'PORT', value: string(appPort) }
              { name: 'MOCK', value: 'false' }
              // DefaultAzureCredential picks up the user-assigned identity.
              { name: 'AZURE_CLIENT_ID', value: uami.properties.clientId }
              { name: 'SUBSCRIPTION_IDS', value: subscriptionIds }
              { name: 'WATCH_ENABLED', value: string(watchEnabled) }
              { name: 'WATCH_INTERVAL_MS', value: string(watchIntervalSeconds * 1000) }
              { name: 'WEBHOOK_URL', value: publishWebhook ? webhookUrl : '' }
            ],
            signWebhook ? [
              { name: 'WEBHOOK_SECRET', secretRef: 'webhook-signing-secret' }
            ] : [],
            mcpAuthEnabled ? [
              { name: 'MCP_AUTH_ENABLED', value: 'true' }
              { name: 'MCP_AUTH_TENANT_ID', value: mcpAuthTenantId }
              { name: 'MCP_AUTH_AUDIENCE', value: mcpAuthAudience }
              { name: 'MCP_AUTH_SCOPES', value: mcpAuthScopes }
              { name: 'PUBLIC_BASE_URL', value: publicBaseUrl }
            ] : []
          )
          // The placeholder image has no /healthz, so probes only attach once
          // the real image is running.
          probes: isPlaceholder ? [] : [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        // The watcher keeps its last-seen baseline in memory, so each replica
        // diffs independently. Keep this at 1 unless you move the baseline to
        // shared state, or subscribers will receive duplicate notifications.
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output apiFqdn string = app.properties.configuration.ingress.fqdn
output apiUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output statusViewUrl string = 'https://${app.properties.configuration.ingress.fqdn}/api/status/view'
output changesUrl string = 'https://${app.properties.configuration.ingress.fqdn}/api/status/changes'
output mcpUrl string = 'https://${app.properties.configuration.ingress.fqdn}/mcp'
output containerAppName string = app.name
output containerRegistryName string = acr.name
output containerRegistryLoginServer string = acr.properties.loginServer
output managedIdentityClientId string = uami.properties.clientId
output managedIdentityPrincipalId string = uami.properties.principalId
output logAnalyticsWorkspaceId string = law.id
output keyVaultName string = signWebhook ? kvName : ''
output mcpAuthEnabled bool = mcpAuthEnabled
output mcpAuthAudience string = mcpAuthAudience
// Surfaced so a mismatch between the advertised resource identifier and the
// URL clients actually dial is visible at deploy time rather than as a 401.
output publicBaseUrl string = publicBaseUrl
output mcpProtectedResourceMetadataUrl string = '${publicBaseUrl}/.well-known/oauth-protected-resource/mcp'
