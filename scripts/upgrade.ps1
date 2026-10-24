param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$StorageAccount,
  [Parameter(Mandatory)][string]$Registry,
  [Parameter(Mandatory)][string]$StaticWebApp,
  [Parameter(Mandatory)][string]$BootstrapAdmin,
  [string]$Location = "eastus2",
  [string]$Environment = "cae-fileupload",
  [string]$Identity = "id-fileupload",
  [string]$Version = "v2",
  [int]$DefenderScanCapGB = 2500
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Split-Path $PSScriptRoot -Parent)

function Rest-Put([string]$Url, $Body) {
  $file = Join-Path ([IO.Path]::GetTempPath()) ("fileupload-" + [guid]::NewGuid() + ".json")
  try {
    $Body | ConvertTo-Json -Depth 30 | Set-Content $file
    az rest --method put --url $Url --body "@$file" -o none
  } finally { Remove-Item $file -ErrorAction SilentlyContinue }
}
function Wait-Resource([string]$Url) {
  for ($i = 0; $i -lt 60; $i++) {
    $value = az rest --method get --url $Url -o json | ConvertFrom-Json
    if ($value.properties.provisioningState -eq "Succeeded") { return $value }
    if ($value.properties.provisioningState -eq "Failed") { throw "Provisioning failed." }
    Start-Sleep 5
  }
  throw "Timed out provisioning resource."
}

$subscription = az account show --query id -o tsv
$rgId = "/subscriptions/$subscription/resourceGroups/$ResourceGroup"
$root = "https://management.azure.com$rgId/providers"
$identityInfo = az identity show -g $ResourceGroup -n $Identity -o json | ConvertFrom-Json
$identityId = $identityInfo.id
$clientId = $identityInfo.clientId
$principal = $identityInfo.principalId
$swaHost = az staticwebapp show -g $ResourceGroup -n $StaticWebApp --query defaultHostname -o tsv
$apiHost = az containerapp show -g $ResourceGroup -n ca-upload-api --query properties.configuration.ingress.fqdn -o tsv

foreach ($container in "auth", "config") {
  az storage container-rm create -g $ResourceGroup --storage-account $StorageAccount -n $container --public-access off -o none
}
# Program deadlines are enforced by the API and hourly job, not a shorter legacy rule.
az storage account management-policy create -g $ResourceGroup --account-name $StorageAccount `
  --policy "@lifecycle-policy.json" -o none
$blobSettings = az storage account blob-service-properties show -g $ResourceGroup -n $StorageAccount -o json | ConvertFrom-Json
if ($blobSettings.deleteRetentionPolicy.enabled -or $blobSettings.containerDeleteRetentionPolicy.enabled -or $blobSettings.isVersioningEnabled) {
  throw "Delete-on-retrieval requires disabled Blob/container soft delete and versioning. Resolve applicable retention policy before upgrading."
}

az provider register -n Microsoft.Communication --wait -o none
az provider register -n Microsoft.EventGrid --wait -o none
$emailName = "email-fileupload"
$communicationName = "comm-$Registry"
$emailUrl = "$root/Microsoft.Communication/emailServices/${emailName}?api-version=2023-03-31"
Rest-Put $emailUrl @{ location = "global"; properties = @{ dataLocation = "United States" } }
$null = Wait-Resource $emailUrl
$domainUrl = "$root/Microsoft.Communication/emailServices/$emailName/domains/AzureManagedDomain?api-version=2023-03-31"
Rest-Put $domainUrl @{ location = "global"; properties = @{ domainManagement = "AzureManaged" } }
$domain = Wait-Resource $domainUrl
$communicationUrl = "$root/Microsoft.Communication/communicationServices/${communicationName}?api-version=2023-03-31"
Rest-Put $communicationUrl @{ location = "global"; properties = @{
  dataLocation = "United States"; linkedDomains = @($domain.id)
} }
$communication = Wait-Resource $communicationUrl
$workspaces = az monitor log-analytics workspace list -g $ResourceGroup -o json | ConvertFrom-Json
$logsId = ($workspaces | Where-Object name -eq "law-fileupload" | Select-Object -First 1).id
if ($logsId) {
  Rest-Put "https://management.azure.com$($communication.id)/providers/Microsoft.Insights/diagnosticSettings/email-delivery?api-version=2021-05-01-preview" @{
    properties = @{ workspaceId = $logsId; logs = @(
      @{ category = "EmailSendMailOperational"; enabled = $true },
      @{ category = "EmailStatusUpdateOperational"; enabled = $true }
    ) }
  }
}
$sender = "DoNotReply@$($domain.properties.fromSenderDomain)"
if (!$domain.properties.fromSenderDomain) { throw "Email domain has no sender domain." }
$emailEndpoint = $communication.properties.hostName
if (!$emailEndpoint.StartsWith("https://")) { $emailEndpoint = "https://$emailEndpoint" }
# ACS supports managed-identity send through this resource-scoped role.
az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal `
  --role Contributor --scope $communication.id -o none

$topicName = "eg-fileupload-results"
az eventgrid topic create -g $ResourceGroup -n $topicName -l $Location -o none
$topicId = az eventgrid topic show -g $ResourceGroup -n $topicName --query id -o tsv

# Do not reset the shared event secret on an ordinary application update.
$existing = az containerapp show -g $ResourceGroup -n ca-upload-api --query "properties.configuration.secrets[].name" -o tsv
if ($existing -notcontains "defender-event-key") {
  $eventKey = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
  az containerapp secret set -g $ResourceGroup -n ca-upload-api --secrets "defender-event-key=$eventKey" -o none
} else {
  $eventKey = az containerapp secret list -g $ResourceGroup -n ca-upload-api --show-values `
    --query "[?name=='defender-event-key'].value | [0]" -o tsv
}

az acr build -r $Registry -t "upload-api:$Version" --platform linux/amd64 --no-logs .\api -o none
az acr build -r $Registry -t "clamav-scanner:$Version" --platform linux/amd64 --no-logs .\scanner -o none
az containerapp job update -g $ResourceGroup -n job-clamav-scan --image "$Registry.azurecr.io/clamav-scanner:$Version" -o none

az containerapp update -g $ResourceGroup -n ca-upload-api --image "$Registry.azurecr.io/upload-api:$Version" `
  --set-env-vars "EMAIL_ENDPOINT=$emailEndpoint" "EMAIL_SENDER=$sender" `
  "INTERNAL_ADMIN_EMAILS=$BootstrapAdmin" "PORTAL_URL=https://$swaHost" `
  "DEFENDER_TOPIC_ID=$topicId" "DEFENDER_EVENT_KEY=secretref:defender-event-key" `
  "SCANNER_IMAGE=$Registry.azurecr.io/clamav-scanner:$Version" -o none

# Warm the scale-to-zero broker before Event Grid's short validation deadline.
$ready = $false
for ($attempt = 0; $attempt -lt 5; $attempt++) {
  try {
    $health = Invoke-RestMethod "https://$apiHost/api/health" -TimeoutSec 120
    if ($health.ok -and $health.version -eq "2.0.0") { $ready = $true; break }
  } catch { Start-Sleep 5 }
}
if (!$ready) { throw "Portal API did not become healthy before webhook provisioning." }
az eventgrid event-subscription create -n defender-to-portal --source-resource-id $topicId `
  --endpoint-type webhook --endpoint "https://$apiHost/api/events/defender" `
  --included-event-types Microsoft.Security.MalwareScanningResult `
  --delivery-attribute-mapping X-Defender-Key static $eventKey true -o none
$eventKey = $null

$storageId = "$rgId/providers/Microsoft.Storage/storageAccounts/$StorageAccount"
Rest-Put "https://management.azure.com$storageId/providers/Microsoft.Security/defenderForStorageSettings/current?api-version=2025-06-01" @{
  properties = @{
    isEnabled = $true
    overrideSubscriptionLevelSettings = $true
    sensitiveDataDiscovery = @{ isEnabled = $false }
    malwareScanning = @{
      onUpload = @{
        isEnabled = $true; capGBPerMonth = $DefenderScanCapGB
        filters = @{ excludeBlobsWithPrefix = @("auth/", "config/", "status/", "quarantine/", "infected/") }
      }
      scanResultsEventGridTopicResourceId = $topicId
      blobScanResultsOptions = "blobIndexTags"
    }
  }
}

$maintenanceEnv = @("STORAGE_ACCOUNT_NAME=$StorageAccount", "AZURE_CLIENT_ID=$clientId",
  "EMAIL_ENDPOINT=$emailEndpoint", "EMAIL_SENDER=$sender", "PORTAL_URL=https://$swaHost")
$job = az containerapp job list -g $ResourceGroup --query "[?name=='job-intake-maintenance'].name | [0]" -o tsv
if (!$job) {
  az containerapp job create -g $ResourceGroup -n job-intake-maintenance --environment $Environment `
    --trigger-type Schedule --cron-expression "0 * * * *" --replica-timeout 1800 --replica-retry-limit 1 `
    --image "$Registry.azurecr.io/upload-api:$Version" --cpu 0.25 --memory 0.5Gi `
    --mi-user-assigned $identityId --registry-server "$Registry.azurecr.io" --registry-identity $identityId `
    --env-vars @maintenanceEnv --command node maintenance.js -o none
} else {
  az containerapp job update -g $ResourceGroup -n job-intake-maintenance `
    --image "$Registry.azurecr.io/upload-api:$Version" --set-env-vars @maintenanceEnv -o none
}

# Build in a temporary directory so the committed config stays a generic placeholder.
$frontend = Join-Path ([IO.Path]::GetTempPath()) ("fileupload-site-" + [guid]::NewGuid())
try {
  New-Item -ItemType Directory $frontend | Out-Null
  Copy-Item .\frontend\* $frontend
  "window.APP_CONFIG = { apiBase: `"https://$apiHost`" };" | Set-Content (Join-Path $frontend "config.js")
  $token = az staticwebapp secrets list -g $ResourceGroup -n $StaticWebApp --query properties.apiKey -o tsv
  $env:SWA_CLI_DEPLOYMENT_TOKEN = $token
  npx --yes @azure/static-web-apps-cli deploy $frontend --env production
} finally {
  $env:SWA_CLI_DEPLOYMENT_TOKEN = $null
  $token = $null
  if (Test-Path $frontend) { Remove-Item -LiteralPath $frontend -Recurse -Force }
}
Write-Output "Portal: https://$swaHost"
Write-Output "No WAF or Application Gateway was created."
