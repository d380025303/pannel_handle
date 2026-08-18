param(
  [string]$Task = "buildPlugin"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$gradleVersion = "8.13"
$cacheRoot = Join-Path $repoRoot "node_modules\.cache\pannel-handle-gradle"
$gradleRoot = Join-Path $cacheRoot "gradle-$gradleVersion"
$gradleExe = Join-Path $gradleRoot "bin\gradle.bat"

function Find-IdeaHome {
  if ($env:PANNEL_HANDLE_IDEA_HOME -and (Test-Path (Join-Path $env:PANNEL_HANDLE_IDEA_HOME "product-info.json"))) {
    return $env:PANNEL_HANDLE_IDEA_HOME
  }

  $runningIdea = Get-Process idea64 -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
  if ($runningIdea) {
    return Split-Path -Parent (Split-Path -Parent $runningIdea.Path)
  }

  $searchRoots = @(
    (Join-Path $env:LOCALAPPDATA "JetBrains\Toolbox\apps"),
    "C:\Program Files\JetBrains"
  )
  foreach ($root in $searchRoots) {
    if (-not (Test-Path $root)) { continue }
    $launcher = Get-ChildItem -LiteralPath $root -Recurse -Filter idea64.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($launcher) {
      return Split-Path -Parent (Split-Path -Parent $launcher.FullName)
    }
  }
  throw "IntelliJ IDEA 2025.2 was not found. Set PANNEL_HANDLE_IDEA_HOME to the IDEA installation directory."
}

$ideaHome = Find-IdeaHome
$ideaInfo = Get-Content -Raw -Encoding UTF8 (Join-Path $ideaHome "product-info.json") | ConvertFrom-Json
if (-not ([string]$ideaInfo.buildNumber).StartsWith("252.")) {
  throw "The IDEA plugin currently targets build 252.x, but $($ideaInfo.buildNumber) was found."
}

$jbrHome = Join-Path $ideaHome "jbr"
if (-not (Test-Path (Join-Path $jbrHome "bin\java.exe"))) {
  throw "The bundled JetBrains Runtime was not found at $jbrHome."
}

if (-not (Test-Path $gradleExe)) {
  New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
  $zipPath = Join-Path $cacheRoot "gradle-$gradleVersion-bin.zip"
  if (-not (Test-Path $zipPath)) {
    Invoke-WebRequest -UseBasicParsing -Uri "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" -OutFile $zipPath
  }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $cacheRoot -Force
}

$previousJavaHome = $env:JAVA_HOME
$previousIdeaHome = $env:PANNEL_HANDLE_IDEA_HOME
try {
  $env:JAVA_HOME = $jbrHome
  $env:PANNEL_HANDLE_IDEA_HOME = $ideaHome
  & $gradleExe --project-dir (Join-Path $repoRoot "idea-plugin") $Task
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  $env:JAVA_HOME = $previousJavaHome
  $env:PANNEL_HANDLE_IDEA_HOME = $previousIdeaHome
}
