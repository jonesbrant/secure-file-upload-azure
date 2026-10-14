param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Department = 'sheriff',
  [Parameter(Mandatory = $true)][string]$Api   # e.g. https://<broker-fqdn>, no trailing slash
)

$ErrorActionPreference = 'Stop'
$file = Get-Item $Path
$blockSize = 8MB

$init = Invoke-RestMethod "$Api/api/upload/init" -Method Post -ContentType 'application/json' `
  -Body (@{ department = $Department; fileName = $file.Name; size = $file.Length } | ConvertTo-Json)
Write-Host "uploadId = $($init.uploadId)"

$stream = [System.IO.File]::OpenRead($file.FullName)
try {
  $index = 0
  $buffer = New-Object byte[] $blockSize
  while (($read = $stream.Read($buffer, 0, $blockSize)) -gt 0) {
    $chunk = New-Object byte[] $read
    [Array]::Copy($buffer, $chunk, $read)
    Invoke-WebRequest "$Api/api/upload/block?id=$($init.uploadId)&index=$index" -Method Put `
      -ContentType 'application/octet-stream' -Body $chunk | Out-Null
    Write-Host "  block $index ($read bytes) staged"
    $index++
  }
} finally { $stream.Dispose() }

Invoke-RestMethod "$Api/api/upload/complete" -Method Post -ContentType 'application/json' `
  -Body (@{ uploadId = $init.uploadId; blockCount = $index; contentType = 'application/octet-stream' } | ConvertTo-Json) | Out-Null
Write-Host 'upload committed, scan job started'

for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Seconds 5
  $status = Invoke-RestMethod "$Api/api/status?id=$($init.uploadId)"
  Write-Host "  [$($status.state)] $($status.message)"
  if ($status.state -in @('clean', 'infected', 'error')) { break }
}
