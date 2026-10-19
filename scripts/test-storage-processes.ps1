param([Parameter(Mandatory)][string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Use a new fixture directory' }
$source = Join-Path $FixtureRoot 'original'
$nested = Join-Path $source 'plugins/chrome'
New-Item -ItemType Directory -Path $nested | Out-Null
$plan = @{ locations = @(@{ source = $source; alias = $source }) }
$Mode = 'Migrate'
$planValidated = $true
$tokens = $null; $errors = $null
$worker = Join-Path $PSScriptRoot '../src-tauri/resources/storage-migration.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
foreach ($name in @('Full-Path','Is-Within','Uses-MigratingSource')) {
  $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  if (-not $node) { throw "Missing process detection: $name" }
  . ([scriptblock]::Create($node.Extent.Text))
}
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
$hostPath = Join-Path $nested 'extension-host.exe'
Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination $hostPath
$hostProcess = Start-Process -FilePath $hostPath -ArgumentList '/k' -WorkingDirectory $nested -WindowStyle Hidden -PassThru
try {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($hostProcess.Id)"
  Assert ($null -ne $process) 'Fixture host did not start'
  Assert (Uses-MigratingSource $process) 'Source-hosted Chrome plugin escaped migration wait'
  $blocked = $false
  try { [IO.Directory]::Move($source, ($source + '-renamed')) }
  catch {
    $blocked = ($_.Exception.InnerException.HResult -band 0xFFFF) -eq 5
    if (-not $blocked) { throw }
  }
  Assert $blocked 'Fixture did not reproduce the source-directory access denial'
  $wrapper = [pscustomobject]@{ Name = 'cmd.exe'; ExecutablePath = "$env:SystemRoot\System32\cmd.exe"; CommandLine = ('cmd /c "' + $hostPath + '"') }
  Assert (Uses-MigratingSource $wrapper) 'Native messaging wrapper escaped migration wait'
  $other = [pscustomobject]@{ Name = 'extension-host.exe'; ExecutablePath = ($source + '-other\extension-host.exe'); CommandLine = '' }
  Assert (-not (Uses-MigratingSource $other)) 'Unrelated executable was considered a source host'
  $Mode = 'Maintenance'
  Assert (-not (Uses-MigratingSource $process)) 'Cache maintenance unnecessarily waits for plugin hosts'
} finally {
  if (-not $hostProcess.HasExited) { Stop-Process -Id $hostProcess.Id -Force }
  $hostProcess.WaitForExit()
  $hostProcess.Dispose()
}
[IO.Directory]::Move($source, ($source + '-released'))
Write-Output 'PASS: live plugin host reproduces access denial, is detected with its wrapper, and releases the directory on exit'
