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
$payload["cwd"] = (Get-Location).Path
$payload["pannel_handle_session_id"] = $env:PANNEL_HANDLE_SESSION_ID

if (-not [string]::IsNullOrWhiteSpace($hookUrl)) {
  try {
    $geminiHookUrl = $hookUrl -replace "/claude-hook$", "/gemini-hook"
    $body = $payload | ConvertTo-Json -Depth 20 -Compress
    Invoke-RestMethod -Uri $geminiHookUrl -Method Post -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType "application/json; charset=utf-8" -TimeoutSec 2 | Out-Null
  } catch { [Console]::Error.WriteLine($_.Exception.Message) }
}
[Console]::Out.WriteLine("{}")
