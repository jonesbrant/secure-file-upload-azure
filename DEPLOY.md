# Deploying to your own Azure environment

This guide creates every resource in **your** subscription. Nothing in this
repository contains secrets, keys, connection strings, or tenant-specific values:
all authentication uses a **managed identity**, and the only deploy-time
credential (the Static Web App deployment token) is generated in your
environment and never committed.

Commands are PowerShell (`az` CLI). Run them in order in one session so the
variables carry over.

## 0. Prerequisites

| Need | Notes |
| --- | --- |
| Azure subscription | You need **Owner**, or **Contributor + User Access Administrator**, to create role assignments |
| [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) 2.60+ | `az login` |
| Container Apps extension | `az extension add --name containerapp --upgrade` |
| [Node.js 20+](https://nodejs.org) and SWA CLI | `npm install -g @azure/static-web-apps-cli` |

No local Docker is required; images are built in Azure Container Registry.

## 1. Set variables

```powershell
az login
az account set --subscription "<your-subscription-id-or-name>"

$suffix   = -join ((97..122) + (48..57) | Get-Random -Count 6 | % {[char]$_})   # keeps global names unique
$rg       = "rg-fileupload"          # any name you like
$location = "eastus2"                # any region that supports Container Apps + Static Web Apps
$storage  = "stfileup$suffix"        # 3-24 chars, lowercase/digits
$acr      = "acrfileup$suffix"
$swaName  = "swa-fileupload-$suffix"
$identity = "id-fileupload"
$vnet     = "vnet-fileupload"
$env      = "cae-fileupload"
$law      = "law-fileupload"

az provider register -n Microsoft.App --wait
az provider register -n Microsoft.OperationalInsights --wait
az provider register -n Microsoft.ContainerRegistry --wait
az provider register -n Microsoft.Network --wait
az provider register -n Microsoft.Storage --wait
```

## 2. Resource group and managed identity

```powershell
az group create -n $rg -l $location
az identity create -g $rg -n $identity
$idId        = az identity show -g $rg -n $identity --query id -o tsv
$idClientId  = az identity show -g $rg -n $identity --query clientId -o tsv
$idPrincipal = az identity show -g $rg -n $identity --query principalId -o tsv
```

## 3. Storage (private, no shared keys)

```powershell
az storage account create -g $rg -n $storage -l $location `
  --sku Standard_LRS --kind StorageV2 --access-tier Hot `
  --allow-shared-key-access false --allow-blob-public-access false `
  --min-tls-version TLS1_2 --public-network-access Disabled

$storageId = az storage account show -g $rg -n $storage --query id -o tsv

# Containers are created with Azure AD auth because shared keys are disabled.
# Public network access is off, so create them through ARM instead:
foreach ($c in "quarantine","sheriff","public-health","corrections","infected","status") {
  az storage container-rm create --storage-account $storage -g $rg --name $c --public-access off | Out-Null
}

# Retention: quarantine 7 days, infected/status 30 days (edit the JSON to taste)
az storage account management-policy create -g $rg --account-name $storage --policy "@lifecycle-policy.json"

az role assignment create --assignee-object-id $idPrincipal --assignee-principal-type ServicePrincipal `
  --role "Storage Blob Data Contributor" --scope $storageId
```

## 4. Network: VNet, private endpoint, private DNS

```powershell
az network vnet create -g $rg -n $vnet -l $location --address-prefixes 10.20.0.0/16
az network vnet subnet create -g $rg --vnet-name $vnet -n snet-aca `
  --address-prefixes 10.20.0.0/23 --delegations Microsoft.App/environments
az network vnet subnet create -g $rg --vnet-name $vnet -n snet-pe `
  --address-prefixes 10.20.2.0/27

az network private-endpoint create -g $rg -n pe-blob -l $location `
  --vnet-name $vnet --subnet snet-pe `
  --private-connection-resource-id $storageId --group-id blob --connection-name pe-blob-conn

az network private-dns zone create -g $rg -n privatelink.blob.core.windows.net
az network private-dns link vnet create -g $rg -n link-blob `
  --zone-name privatelink.blob.core.windows.net --virtual-network $vnet --registration-enabled false
az network private-endpoint dns-zone-group create -g $rg --endpoint-name pe-blob -n default `
  --private-dns-zone privatelink.blob.core.windows.net --zone-name blob
```

## 5. Container Registry and images

```powershell
az acr create -g $rg -n $acr --sku Basic --admin-enabled false
$acrId = az acr show -g $rg -n $acr --query id -o tsv
az role assignment create --assignee-object-id $idPrincipal --assignee-principal-type ServicePrincipal `
  --role AcrPull --scope $acrId

# --no-logs avoids a Windows console encoding error; the build still runs server-side
az acr build -r $acr -t upload-api:v1      --platform linux/amd64 --no-logs ./api
az acr build -r $acr -t clamav-scanner:v1  --platform linux/amd64 --no-logs ./scanner
az acr repository list -n $acr -o table     # confirm both images exist
```

## 6. Container Apps environment (VNet-injected) and Log Analytics

```powershell
az monitor log-analytics workspace create -g $rg -n $law -l $location --quota 0.5 --retention-time 30
$lawId  = az monitor log-analytics workspace show -g $rg -n $law --query customerId -o tsv
$lawKey = az monitor log-analytics workspace get-shared-keys -g $rg -n $law --query primarySharedKey -o tsv
$subnetId = az network vnet subnet show -g $rg --vnet-name $vnet -n snet-aca --query id -o tsv

az containerapp env create -g $rg -n $env -l $location `
  --infrastructure-subnet-resource-id $subnetId `
  --logs-workspace-id $lawId --logs-workspace-key $lawKey
```

(The Log Analytics key is used only by this command and is not stored in the repo.)

## 7. Static Web App (to learn its hostname for CORS)

```powershell
az staticwebapp create -g $rg -n $swaName -l $location --sku Free
$swaHost = az staticwebapp show -g $rg -n $swaName --query defaultHostname -o tsv
```

## 8. ClamAV scan job (one isolated container per file)

```powershell
az containerapp job create -g $rg -n job-clamav-scan --environment $env `
  --trigger-type Manual --replica-timeout 3600 --replica-retry-limit 0 `
  --image "$acr.azurecr.io/clamav-scanner:v1" --cpu 2 --memory 4Gi `
  --mi-user-assigned $idId --registry-server "$acr.azurecr.io" --registry-identity $idId `
  --env-vars STORAGE_ACCOUNT_NAME=$storage AZURE_CLIENT_ID=$idClientId

$jobId = az containerapp job show -g $rg -n job-clamav-scan --query id -o tsv

# Let the broker start (only) this job
az role assignment create --assignee-object-id $idPrincipal --assignee-principal-type ServicePrincipal `
  --role "Container Apps Jobs Operator" --scope $jobId
```

## 9. Upload broker (Container App, scale-to-zero)

```powershell
az containerapp create -g $rg -n ca-upload-api --environment $env `
  --image "$acr.azurecr.io/upload-api:v1" `
  --user-assigned $idId --registry-server "$acr.azurecr.io" --registry-identity $idId `
  --ingress external --target-port 8080 --min-replicas 0 --max-replicas 3 `
  --cpu 0.5 --memory 1Gi `
  --env-vars STORAGE_ACCOUNT_NAME=$storage AZURE_CLIENT_ID=$idClientId `
             ALLOWED_ORIGIN="https://$swaHost" SCAN_JOB_ID=$jobId `
             SCANNER_IMAGE="$acr.azurecr.io/clamav-scanner:v1"

$apiFqdn = az containerapp show -g $rg -n ca-upload-api --query properties.configuration.ingress.fqdn -o tsv
```

## 10. Deploy the frontend

```powershell
# Point the UI at your broker (this edits your local copy; don't commit it)
"window.APP_CONFIG = { apiBase: `"https://$apiFqdn`" };" | Set-Content frontend\config.js

# Deployment token is generated by Azure for your SWA; keep it out of source control
$token = az staticwebapp secrets list -n $swaName -g $rg --query properties.apiKey -o tsv
swa deploy ./frontend --deployment-token $token --env production

"Open: https://$swaHost"
```

## 11. Verify

```powershell
Invoke-RestMethod "https://$apiFqdn/api/health"        # {"ok":true,...}

# Clean file -> should end in state 'clean' and land in the department container
.\test-upload.ps1 -Api "https://$apiFqdn" -Path .\README.md -Department sheriff

# EICAR test string -> should end in 'infected' and NOT reach the department
Set-Content eicar.txt 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
.\test-upload.ps1 -Api "https://$apiFqdn" -Path .\eicar.txt -Department corrections
Remove-Item eicar.txt
```

Because the storage account is private, inspect results from inside the VNet,
via the Azure portal's Storage browser (if you have network access), or by
temporarily adding your IP to the storage firewall if your policy permits.
The upload status record also reports the final state.

## Updating

```powershell
az acr build -r $acr -t upload-api:v2 --platform linux/amd64 --no-logs ./api
az containerapp update -g $rg -n ca-upload-api --image "$acr.azurecr.io/upload-api:v2"

# Rebuild the scanner regularly (e.g. weekly) to pick up new ClamAV signatures
az acr build -r $acr -t clamav-scanner:v2 --platform linux/amd64 --no-logs ./scanner
az containerapp job update -g $rg -n job-clamav-scan --image "$acr.azurecr.io/clamav-scanner:v2"
az containerapp update -g $rg -n ca-upload-api --set-env-vars SCANNER_IMAGE="$acr.azurecr.io/clamav-scanner:v2"
```

## Cleanup

```powershell
az group delete -n $rg --yes --no-wait
```

## Hardening before real use

- Add **Microsoft Entra ID authentication** to the Static Web App and validate
  the token in the broker; the demo is anonymous.
- Restrict `ALLOWED_ORIGIN` (already set to your SWA host) and consider
  fronting with a WAF if required by your organisation.
- Add Log Analytics alert rules for scan job failures and quarantine growth.
- Files over 2 GiB cannot be scanned by ClamAV and are held in `quarantine`
  for manual review.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `MissingSubscriptionRegistration` | Run the `az provider register` commands in step 1 |
| Broker returns 500 on `/api/upload/init` | Identity lacks *Storage Blob Data Contributor*, or the private DNS zone isn't linked to the VNet (`nslookup <storage>.blob.core.windows.net` from inside the VNet must return a private IP) |
| Upload stuck at `queued` | Identity lacks *Container Apps Jobs Operator* on the job, or `SCAN_JOB_ID` is wrong |
| Browser CORS error | `ALLOWED_ORIGIN` doesn't exactly match `https://<swa-hostname>` |
| `az acr build` UnicodeEncodeError on Windows | Use `--no-logs` (already in the commands above) |
| Role assignments seem ignored | Wait a few minutes for Azure RBAC propagation |
