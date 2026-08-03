// Reads the image already running on the container app.
//
// This lives in its own module on purpose. Referencing an `existing` resource
// that has the same name as a resource being deployed in the same template
// creates a circular dependency in ARM. A module boundary breaks the cycle.

targetScope = 'resourceGroup'

@description('True when the container app already exists.')
param exists bool

@description('Name of the container app to read.')
param name string

resource existingApp 'Microsoft.App/containerApps@2024-03-01' existing = if (exists) {
  name: name
}

// Safe-dereference so a deleted app resolves to null instead of failing the
// deployment. `azd` rewrites SERVICE_API_RESOURCE_EXISTS from its own cached
// state, so `exists` can be true even after the app has been removed.
output containers array = exists ? (existingApp.?properties.template.containers ?? []) : []
