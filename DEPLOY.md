# Deploying to your own Azure environment

This guide creates the solution in **your** subscription. Do not copy another
deployment's resource names, administrator emails, keys, or tokens. Azure calls
use managed identity. The upgrade script generates its Event Grid authentication
secret and stores it in Container Apps secrets; it obtains and clears the SWA
deployment token in memory. Neither belongs in Git.

Commands are PowerShell (`az` CLI). Run them in order in one session so the
variables carry over.

## 0. Prerequisites

| Need | Notes |
| --- | --- |
| Azure subscription | You need **Owner**, or **Contributor + User Access Administrator**, to create role assignments |
| [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) 2.60+ | `az login` |
| Container Apps extension | `az extension add --name containerapp --upgrade` |
| [Node.js 22+](https://nodejs.org), PowerShell 7.4+ | The upgrade script uses `npx` for the SWA CLI |

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
az provider register -n Microsoft.Security --wait
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

# Legacy lifecycle rules are disabled: the API/hourly job enforces program retention.
# Do not delete status blobs independently of payloads; retention can be 365 days.
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
az acr build -r $acr -t upload-api:v1      --platform linux/amd64 --no-logs .\api
az acr build -r $acr -t clamav-scanner:v1  --platform linux/amd64 --no-logs .\scanner
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

## 10. Complete the v2 portal integrations and deploy

```powershell
$bootstrapAdmin = "<your-administrator-email>"
.\scripts\upgrade.ps1 -ResourceGroup $rg -StorageAccount $storage `
  -Registry $acr -StaticWebApp $swaName -BootstrapAdmin $bootstrapAdmin `
  -Location $location -Environment $env -Identity $identity -Version v2
```

This creates private `auth`/`config` containers, ACS Email plus an Azure-managed
sender domain, a linked communication service, an Event Grid topic/subscription,
Defender for Storage on-upload scanning, and an hourly maintenance job. It builds
and updates both images, deploys the UI from a temporary configured copy, and
never edits the committed `frontend\config.js`. No WAF or Application Gateway
is provisioned. The script is repeatable for the named deployment resources.

The default Defender cap is **2,500 GB/month**; set `-DefenderScanCapGB` to your
approved budget. Scan only department copies, not quarantine/auth/config/status.
If the cap is exhausted, the API blocks retrieval until a clean result arrives.
Defender scan-volume charges can exceed the rest of this architecture's costs.

The resource-scoped ACS **Contributor** assignment is supported for managed-
identity email sending, but is broader than send-only. For a production tenant,
review a custom role with the documented communication-service read/write
permissions. The shared demo identity also has Blob Data Contributor on the
account: application roles enforce department separation; this is not separate
storage identities or subscriptions per department.

**Email lifecycle:** Microsoft currently lists ACS Email retirement on
**September 30, 2028**. The integration works today but requires migration before
that date. New customers must verify onboarding availability and sending quotas.
Replace `sendMail` in `api\services.js` to use an approved alternative delivery
provider if onboarding is restricted. See [Microsoft's lifecycle notice](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide).

**Deletion precondition:** disable Blob/container soft delete and versioning if
physical payload deletion is required. The script stops when these are enabled;
do not override an enterprise records-retention policy without resolving the
requirements conflict. No account key or public-storage firewall exception is
needed.

## 11. Verify

```powershell
Invoke-RestMethod "https://$apiFqdn/api/health"        # {"ok":true,...}

# Unit tests (scanner tests use SDK doubles, no local Azure SDK required)
Push-Location api
npm ci
npm test
Pop-Location
python -m unittest discover -s scanner -p test_scan.py

# Manual CLI smoke test: asks for the email-delivered code, never prints a session token.
.\test-upload.ps1 -Api "https://$apiFqdn" -Path .\README.md `
  -Department sheriff -Email "<your-email>" -ProgramId "<active-program-uuid>"

# Optional administrative integration test inside the private VNet.
.\scripts\test_live.ps1 -ResourceGroup $rg -Api "https://$apiFqdn" `
  -AdminEmail $bootstrapAdmin
```

The administrative integration test starts a one-off maintenance-job execution,
creates a temporary program/session, and checks real ClamAV and Defender results,
multi-block integrity, notification acceptance, retrieval deletion, EICAR rejection,
and expiry. It removes its test records afterward. It requires administrative
Azure access and does not replace testing actual OTP mailbox delivery and sign-in.

First open the SWA URL, sign in as the bootstrap administrator, and use
**Internal portal** to create programs and their recipient/retention settings.
The catalog is intentionally empty until configured. Delegate department admins
as needed. Then sign out and test the public flow with a separate email account.

Verify clean uploads reach `awaiting_defender` and then `clean`; recipients get
notifications; only authorised staff can download; and a completed download
removes the file. Use the harmless EICAR antivirus test file only in an approved
test and confirm it is blocked before department promotion. Test an interrupted
download and an expired submission. Never inject a fabricated clean Defender
result into production to make a test pass.

Storage remains private. Use the status endpoint, the staff portal, or a
VNet-connected administrator workstation for inspection. Do not open storage to
the internet to troubleshoot.

## Updating

```powershell
.\scripts\upgrade.ps1 -ResourceGroup $rg -StorageAccount $storage `
  -Registry $acr -StaticWebApp $swaName -BootstrapAdmin $bootstrapAdmin `
  -Location $location -Environment $env -Identity $identity -Version v3
```

Use a new image tag on each update. Rebuild scanner images regularly for fresh
ClamAV signatures. The Docker build runs `freshclam` and fails if updating fails.
Review image/OS advisories and monitor scanner age as an operating obligation.

## Cleanup

```powershell
az group delete -n $rg --yes --no-wait
```

## Operating boundaries

- Email OTP authenticates public and staff users; staff authorisation is separate.
  An enterprise deployment can replace staff authentication with Entra ID/MFA.
- Keep the exact SWA CORS origin; configure alerts for failed scan/cleanup jobs,
  pending Defender results, delivery failures, and scan-cap exhaustion.
- Files larger than `2 GiB - 1` bytes are rejected at initiation, rather than
  accepting files that cannot pass ClamAV. Encrypted and over-limit archives fail closed.
- API access stops exactly at expiry; physical deletion can lag up to one hour.
  A completed server-side download triggers deletion but cannot prove local saving.
- Audit stubs remain 30 days after payload deletion. Verified registration records
  and departmental configuration persist; they are not uploaded file payloads.
- Dependency audit currently reports the body-parser compressed-body advisory
  through Express. Compressed JSON is explicitly rejected (`inflate: false`) and
  covered by a regression test; do not claim the dependency audit is clean.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `MissingSubscriptionRegistration` | Run the `az provider register` commands in step 1 |
| Broker returns 500 on `/api/upload/init` | Identity lacks *Storage Blob Data Contributor*, or the private DNS zone isn't linked to the VNet (`nslookup <storage>.blob.core.windows.net` from inside the VNet must return a private IP) |
| Upload stuck at `queued` | Identity lacks *Container Apps Jobs Operator* on the job, or `SCAN_JOB_ID` is wrong |
| Browser CORS error | `ALLOWED_ORIGIN` doesn't exactly match `https://<swa-hostname>` |
| `az acr build` UnicodeEncodeError on Windows | Use `--no-logs` (already in the commands above) |
| Role assignments seem ignored | Wait a few minutes for Azure RBAC propagation |
| OTP email not received | Check junk/quarantine, ACS operation status, domain linkage, role propagation and quota |
| Stuck at `awaiting_defender` | Check Defender settings, its scan cap, Event Grid delivery and webhook authentication |
| Download says ETag changed | File was modified after its scan; do not bypass the gate |
| Physical deletion delayed | Check the hourly maintenance job; API expiry blocks access independently |
