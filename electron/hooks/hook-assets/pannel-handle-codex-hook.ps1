$hookUrl = $env:PANNEL_HANDLE_HOOK_URL
if ([string]::IsNullOrWhiteSpace($hookUrl)) {
  exit 0
}

$codexHookUrl = $hookUrl -replace "/claude-hook$", "/codex-hook"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
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

$transcriptItems = [System.Collections.Generic.List[object]]::new()
$transcriptBytes = 0
$transcriptPath = if ($payload.Contains("transcript_path")) { [string]$payload["transcript_path"] } elseif ($payload.Contains("transcriptPath")) { [string]$payload["transcriptPath"] } else { "" }
if ($transcriptPath.EndsWith(".jsonl", [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $transcriptPath -PathType Leaf)) {
  try {
    foreach ($line in (Get-Content -LiteralPath $transcriptPath -Tail 500 -Encoding UTF8)) {
      try { $row = $line | ConvertFrom-Json } catch { continue }
      $item = $row.payload
      if ($row.type -ne "response_item" -or $item.type -ne "message" -or $item.role -ne "assistant") { continue }
      $parts = @($item.content | ForEach-Object { if ($_ -is [string]) { $_ } elseif ($_.text -is [string]) { $_.text } })
      $text = ($parts -join "`n").Trim()
      if ([string]::IsNullOrWhiteSpace($text) -or [string]::IsNullOrWhiteSpace([string]$item.id)) { continue }
      $size = [System.Text.Encoding]::UTF8.GetByteCount($text)
      if ($size -gt 131072 -or ($transcriptBytes + $size) -gt 524288) { continue }
      $transcriptBytes += $size
      $entry = [ordered]@{ id = [string]$item.id; phase = $(if ($item.phase -eq "final") { "final" } else { "commentary" }); content = $text }
      if ($row.timestamp -is [string]) { $entry["timestamp"] = $row.timestamp }
      $transcriptItems.Add($entry)
    }
  } catch {}
}
if ($transcriptItems.Count -gt 0) { $payload["pannel_handle_transcript_items"] = $transcriptItems }

$payload["cwd"] = (Get-Location).Path
$payload["pannel_handle_session_id"] = $env:PANNEL_HANDLE_SESSION_ID

try {
  $body = $payload | ConvertTo-Json -Depth 20 -Compress
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  Invoke-RestMethod -Uri $codexHookUrl -Method Post -Body $bodyBytes -ContentType "application/json; charset=utf-8" -TimeoutSec 2 | Out-Null
} catch {
  Write-Error ($_.Exception.Message)
}
