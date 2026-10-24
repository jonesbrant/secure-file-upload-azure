param(
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$Api,
  [Parameter(Mandatory)][string]$AdminEmail,
  [string]$Job = "job-intake-maintenance"
)
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$jobInfo = az containerapp job show -g $ResourceGroup -n $Job -o json | ConvertFrom-Json
$template = $jobInfo.properties.template
$container = $template.containers[0]
$container | Add-Member -NotePropertyName command -NotePropertyValue @("node") -Force
$source = Get-Content -Raw (Join-Path (Split-Path $PSScriptRoot -Parent) "api\live-smoke.js")
$container | Add-Member -NotePropertyName args -NotePropertyValue @("-e", $source) -Force
$container.env = @($container.env | Where-Object name -notin "SMOKE_API","SMOKE_EMAIL") + @(
  @{ name = "SMOKE_API"; value = $Api.TrimEnd("/") },
  @{ name = "SMOKE_EMAIL"; value = $AdminEmail }
)
$path = Join-Path ([IO.Path]::GetTempPath()) ("fileupload-smoke-" + [guid]::NewGuid() + ".json")
try {
  $template | ConvertTo-Json -Depth 30 | Set-Content $path
  $execution = az containerapp job start -g $ResourceGroup -n $Job --yaml $path -o json | ConvertFrom-Json
} finally {
  Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue
}
Write-Output "Integration execution: $($execution.name)"
for ($attempt = 0; $attempt -lt 240; $attempt++) {
  Start-Sleep 5
  $status = az containerapp job execution list -g $ResourceGroup -n $Job `
    --query "[?name=='$($execution.name)'].properties.status | [0]" -o tsv
  if ($status -in "Succeeded","Failed","Stopped") { break }
}
az containerapp job logs show -g $ResourceGroup -n $Job --container $container.name `
  --execution $execution.name --tail 100 --format text
if ($status -ne "Succeeded") { throw "Live integration execution ended with status: $status" }
Write-Output "Live integration succeeded. OTP inbox delivery must be verified separately."
