$hookUrl = $env:PANNEL_HANDLE_HOOK_URL
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$stdin = [Console]::In.ReadToEnd()
$payload = [ordered]@{}

if (-not [string]::IsNullOrWhiteSpace($stdin)) {
  try {
    $parsed = $stdin | ConvertFrom-Json
    foreach ($property in $parsed.PSObject.Properties) { $payload[$property.Name] = $property.Value }
  } catch {
    $payload["parse_error"] = $_.Exception.Message
    $payload["raw_input"] = $stdin
  }
}

$sessionId = if ($payload["sessionId"]) { [string]$payload["sessionId"] } else { [string]$env:GROK_SESSION_ID }
$grokHome = if ($env:GROK_HOME) { $env:GROK_HOME } else { Join-Path $env:USERPROFILE ".grok" }
$transcriptPath = $null
if ($sessionId -match '^[0-9a-fA-F-]{36}$') {
  $sessionsRoot = Join-Path $grokHome "sessions"
  if (Test-Path -LiteralPath $sessionsRoot -PathType Container) {
    foreach ($workspace in Get-ChildItem -LiteralPath $sessionsRoot -Directory -ErrorAction SilentlyContinue) {
      $candidate = Join-Path $workspace.FullName "$sessionId\updates.jsonl"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $transcriptPath = $candidate; break }
    }
  }
}

$payload["cwd"] = if ($payload["workspaceRoot"]) { $payload["workspaceRoot"] } else { (Get-Location).Path }
$payload["pannel_handle_session_id"] = $env:PANNEL_HANDLE_SESSION_ID
if ($transcriptPath) { $payload["transcript_path"] = $transcriptPath }

if (-not [string]::IsNullOrWhiteSpace($hookUrl)) {
  try {
    $grokHookUrl = $hookUrl -replace "/claude-hook$", "/grok-hook"
    $body = $payload | ConvertTo-Json -Depth 30 -Compress
    Invoke-RestMethod -Uri $grokHookUrl -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json; charset=utf-8" -TimeoutSec 2 | Out-Null
  } catch { [Console]::Error.WriteLine($_.Exception.Message) }
}
[Console]::Out.WriteLine("{}")
