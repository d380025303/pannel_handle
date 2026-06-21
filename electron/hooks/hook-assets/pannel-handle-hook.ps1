$hookUrl = $env:PANNEL_HANDLE_HOOK_URL
if ([string]::IsNullOrWhiteSpace($hookUrl)) {
  exit 0
}

$stdin = [Console]::In.ReadToEnd()
$payload = [ordered]@{}

if (-not [string]::IsNullOrWhiteSpace($stdin)) {
  try {
    $parsed = $stdin | ConvertFrom-Json
    if ($parsed -and $parsed.PSObject) {
      foreach ($property in $parsed.PSObject.Properties) {
        $payload[$property.Name] = $property.Value
      }
    }
  } catch {
    $payload["parse_error"] = $_.Exception.Message
    $payload["raw_input"] = $stdin
  }
}

$payload["cwd"] = (Get-Location).Path
$payload["pannel_handle_session_id"] = $env:PANNEL_HANDLE_SESSION_ID

try {
  $body = $payload | ConvertTo-Json -Depth 20 -Compress
  Invoke-RestMethod -Uri $hookUrl -Method Post -Body $body -ContentType "application/json" -TimeoutSec 2 | Out-Null
} catch {
  Write-Error ($_.Exception.Message)
}
