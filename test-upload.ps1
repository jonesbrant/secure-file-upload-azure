param(
  [Parameter(Mandatory)][string]$Path,
  [Parameter(Mandatory)][string]$Api,
  [Parameter(Mandatory)][string]$Email,
  [Parameter(Mandatory)][string]$ProgramId,
  [ValidateSet("sheriff", "public-health", "corrections")][string]$Department = "sheriff",
  [string]$Reference = "Deployment smoke test",
  [string]$Details = "Non-sensitive validation file"
)
$ErrorActionPreference = "Stop"
$file = Get-Item -LiteralPath $Path
if ($file.Length -lt 1 -or $file.Length -ge 2GB) { throw "Choose a non-empty file smaller than 2 GiB." }
$Api = $Api.TrimEnd("/")
Invoke-RestMethod "$Api/api/auth/request" -Method Post -ContentType "application/json" `
  -Body (@{ email = $Email } | ConvertTo-Json) | Out-Null
$code = Read-Host "Enter the eight-digit code delivered to your email"
$session = Invoke-RestMethod "$Api/api/auth/verify" -Method Post -ContentType "application/json" `
  -Body (@{ email = $Email; code = $code } | ConvertTo-Json)
$headers = @{ Authorization = "Bearer $($session.token)" }
try {
  $init = Invoke-RestMethod "$Api/api/upload/init" -Method Post -Headers $headers `
    -ContentType "application/json" -Body (@{ department = $Department; programId = $ProgramId;
      fileName = $file.Name; size = $file.Length; reference = $Reference; details = $Details } | ConvertTo-Json)
  Write-Host "Submission: $($init.uploadId)"
  $stream = [IO.File]::OpenRead($file.FullName)
  try {
    $index = 0
    $buffer = [byte[]]::new(8MB)
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $chunk = [byte[]]::new($read)
      [Array]::Copy($buffer, $chunk, $read)
      Invoke-WebRequest "$Api/api/upload/block?id=$($init.uploadId)&index=$index" `
        -Method Put -Headers $headers -ContentType "application/octet-stream" -Body $chunk | Out-Null
      Write-Host "Staged block $index ($read bytes)"
      $index++
    }
  } finally { $stream.Dispose() }
  Invoke-RestMethod "$Api/api/upload/complete" -Method Post -Headers $headers -ContentType "application/json" `
    -Body (@{ uploadId = $init.uploadId; blockCount = $index } | ConvertTo-Json) | Out-Null
  $terminal = @("clean", "infected", "error", "oversize", "defender_error", "expired")
  for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep 5
    $status = Invoke-RestMethod "$Api/api/status?id=$($init.uploadId)" -Headers $headers
    Write-Host "[$($status.state)] $($status.message)"
    if ($status.state -in $terminal) { break }
  }
  if ($status.state -notin $terminal) { throw "Still pending after 15 minutes. Check scanner and Event Grid delivery." }
  if ($status.state -ne "clean") { throw "File was not released: $($status.state)" }
} finally {
  try { Invoke-RestMethod "$Api/api/auth/logout" -Method Post -Headers $headers | Out-Null } catch {}
  $headers = $null
  $session = $null
  $code = $null
}
