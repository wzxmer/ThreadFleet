param([Parameter(Mandatory)][string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Use a new fixture directory' }
New-Item -ItemType Directory -Path $FixtureRoot | Out-Null
$ControlDir = $FixtureRoot
$plan = @{ id = [guid]::NewGuid().ToString() }
$worker = Join-Path $PSScriptRoot '../src-tauri/resources/storage-migration.ps1'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw $errors[0] }
# Load the real verification seam without starting a migration or touching live data.
foreach ($name in @('Snapshot', 'Assert-Same')) {
  $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  . ([scriptblock]::Create($node.Extent.Text))
}
$source = Join-Path $FixtureRoot 'source'
$destination = Join-Path $FixtureRoot 'destination'
New-Item -ItemType Directory -Path $source, $destination | Out-Null
[IO.File]::WriteAllText((Join-Path $source 'history.jsonl'), 'session history')
$before = Snapshot $source
[IO.File]::Copy((Join-Path $source 'history.jsonl'), (Join-Path $destination 'history.jsonl'))
[IO.File]::WriteAllText((Join-Path $source 'status-helper.log'), 'created during copying')
function Expect-Failure($Left, $Right, [string]$Context, [string]$Expected) {
  $failure = $null
  try { Assert-Same $Left $Right $Context 'app-data' } catch { $failure = $_.Exception.Message }
  if (-not $failure -or $failure -notlike $Expected) { throw "Unexpected verification result: $failure" }
}
Expect-Failure $before (Snapshot $source) 'source-stability' '*source-stability*app-data*'
Expect-Failure (Snapshot $source) (Snapshot $destination) 'destination-copy' '*destination-copy*app-data*'
# Equal counts must still reject a replaced path and changed content.
Expect-Failure @{ 'one' = 'file:old' } @{ 'two' = 'file:old' } 'destination-copy' '*destination-copy*'
Expect-Failure @{ 'one' = 'file:old' } @{ 'one' = 'file:new' } 'source-stability' '*source-stability*'
Assert-Same $before $before 'source-stability' 'app-data'
$report = Get-Content -LiteralPath (Join-Path $ControlDir ($plan.id + '-app-data-source-stability.difference.json')) -Raw | ConvertFrom-Json
if ($report.changedCount -ne 1 -or $report.changed[0] -ne 'one') { throw 'Missing bounded difference diagnostics' }
if ([IO.File]::ReadAllText((Join-Path $source 'history.jsonl')) -ne 'session history') { throw 'Verification modified source data' }
Write-Output 'PASS: source changes, incomplete copies, equal-count path/content changes, and unchanged data'
