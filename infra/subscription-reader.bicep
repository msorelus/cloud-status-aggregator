// Grants Reader across the whole subscription to the workload identity.
//
// This lives in its own module because a role assignment name must be
// computable at the start of the deployment, and the principal ID only exists
// after resources.bicep has created the managed identity. Passing it in as a
// module parameter makes it a known value by the time this module starts.

targetScope = 'subscription'

@description('Object ID of the workload managed identity.')
param principalId string

var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'

resource readerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, principalId, readerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
