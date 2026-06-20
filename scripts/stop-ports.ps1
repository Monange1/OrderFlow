$ports = @(3000, 4000)
$connections = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue

if (-not $connections) {
  Write-Host "Ports 3000 and 4000 are already free."
  exit 0
}

$processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique

foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host "Stopping process $processId ($($process.ProcessName)) using dev port."
    Stop-Process -Id $processId -Force
  }
}

Write-Host "Dev ports cleared."
