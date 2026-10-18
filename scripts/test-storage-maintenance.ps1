param([Parameter(Mandatory)][string]$FixtureRoot, [switch]$RequireMigration)
$ErrorActionPreference = 'Stop'
$worker = (Resolve-Path (Join-Path $PSScriptRoot '../src-tauri/resources/storage-migration.ps1')).Path
$fixture = [IO.Path]::GetFullPath($FixtureRoot)
if (Test-Path -LiteralPath $fixture) { throw 'Use a new, empty fixture path' }
New-Item -ItemType Directory -Path $fixture | Out-Null
$control = Join-Path $fixture 'control'
New-Item -ItemType Directory -Path $control | Out-Null
$shell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
# Windows PowerShell needs a BOM for Unicode fixture names in the worker.
$scriptCopy = Join-Path $control 'worker.ps1'
[IO.File]::WriteAllText($scriptCopy, [IO.File]::ReadAllText($worker), [Text.UTF8Encoding]::new($true))
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Json($Value, [string]$Name = 'plan.json') {
  [IO.File]::WriteAllText((Join-Path $control $Name), ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}
function Read-Plan { Get-Content -LiteralPath (Join-Path $control 'plan.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
function Run([string]$Mode = 'Migrate') {
  & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptCopy -ControlDir $control -Mode $Mode -TestRoot $fixture
  if ($LASTEXITCODE) { throw "Worker failed: $((Read-Plan).error)" }
}
function Plan([string]$Root, $Locations) {
  $id = [guid]::NewGuid().ToString()
  $entries = @()
  foreach ($location in $Locations) {
    $entries += @{ kind = $location.kind; alias = $location.alias; source = $location.source; destination = (Join-Path $Root $location.kind); backup = ($location.alias + '.tf-backup-' + $id); wasLink = [bool]$location.wasLink; switched = $false }
  }
  @{ version = 1; id = $id; root = $Root; status = 'queued'; error = $null; backupsCleaned = $false; locations = $entries }
}
$alias = Join-Path $fixture 'original'
$protected = Join-Path $fixture 'project'
New-Item -ItemType Directory -Path $alias, $protected | Out-Null
# Real data belongs to the normal user even when the worker is elevated.
$sourcePermissions = Get-Acl -LiteralPath $alias
$sourcePermissions.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User)
Set-Acl -LiteralPath $alias -AclObject $sourcePermissions
[IO.File]::WriteAllText((Join-Path $alias 'history.jsonl'), 'session history')
[IO.File]::WriteAllText((Join-Path $alias ([char]0x4E2D + [string][char]0x6587 + '.txt')), 'unicode attachment')
[IO.File]::WriteAllText((Join-Path $protected 'source.ts'), 'must survive')
New-Item -ItemType Junction -Path (Join-Path $alias 'project-link') -Target $protected | Out-Null
$plan = Plan (Join-Path $fixture 'new') @(@{ kind = 'codex'; alias = $alias; source = $alias })
Write-Json $plan
& $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptCopy -ControlDir $control -Mode Migrate -TestRoot $fixture
$migrated = Read-Plan
$junctionsAvailable = $migrated.status -eq 'ready'
if (-not $junctionsAvailable) {
  Assert (-not $RequireMigration) "Successful migration is required: $($migrated.error)"
  Assert ($migrated.error -match 'Windows cannot use the required storage junction') "Unexpected migration failure: $($migrated.error)"
  Assert ((Get-Item -LiteralPath $alias -Force).LinkType -ne 'Junction') 'Unsupported junction check moved original storage'
  Assert ([IO.File]::ReadAllText((Join-Path $alias 'history.jsonl')) -eq 'session history') 'Preflight failure changed original history'
  Assert (-not [IO.Directory]::Exists($plan.locations[0].backup)) 'Preflight failure renamed live storage'
  Write-Output 'PASS: unsupported Windows junctions fail before live data is renamed'
  Write-Output 'SKIP: successful junction migration and backup cleanup unavailable on this Windows host'
}
if ($junctionsAvailable) {
Assert ($migrated.status -eq 'ready') 'Migration did not complete'
Assert ((Get-Item -LiteralPath $alias -Force).LinkType -eq 'Junction') 'Original path is not a junction'
Assert ([IO.File]::ReadAllText((Join-Path $alias 'history.jsonl')) -eq 'session history') 'History changed'
Assert ((Get-Acl -LiteralPath $migrated.locations[0].destination).Owner -eq $sourcePermissions.Owner) 'Source ownership was not preserved'
[IO.File]::WriteAllText((Join-Path $alias 'new-active-session.jsonl'), 'new history after migration')
Run 'Cleanup'
Assert ((Read-Plan).backupsCleaned) 'Backups not cleaned'
Assert ([IO.File]::Exists((Join-Path $alias 'new-active-session.jsonl'))) 'Live data was deleted'
Assert ([IO.File]::Exists((Join-Path $protected 'source.ts'))) 'Nested junction was followed during cleanup'

# Changing the directory again must clean the old physical root, not the new one.
$oldPhysical = $migrated.locations[0].destination
$plan = Plan (Join-Path $fixture 'new-again') @(@{ kind = 'codex'; alias = $alias; source = $oldPhysical; wasLink = $true })
Write-Json $plan
Run
Run 'Cleanup'
Assert (-not [IO.Directory]::Exists($oldPhysical)) 'Old physical root remains after repeated migration'
Assert ([IO.File]::Exists((Join-Path $alias 'new-active-session.jsonl'))) 'Repeated migration lost new history'
Assert ([IO.File]::Exists((Join-Path $protected 'source.ts'))) 'Repeated cleanup followed external junction'

# An interrupted rename before junction creation must be rolled back and resumed.
$interruptedAlias = Join-Path $fixture 'interrupted-original'
New-Item -ItemType Directory -Path $interruptedAlias | Out-Null
[IO.File]::WriteAllText((Join-Path $interruptedAlias 'saved.txt'), 'recover me')
$plan = Plan (Join-Path $fixture 'interrupted-new') @(@{ kind = 'app-data'; alias = $interruptedAlias; source = $interruptedAlias })
[IO.Directory]::Move($interruptedAlias, $plan.locations[0].backup)
$plan.status = 'switching'
Write-Json $plan
Run
Assert ([IO.File]::ReadAllText((Join-Path $interruptedAlias 'saved.txt')) -eq 'recover me') 'Interrupted switch lost data'
Write-Output 'PASS: migration, user ownership, repeated migration, interrupted recovery and backup cleanup'
}

# Maintenance must only remove old, allowlisted reproducible data.
$cache = Join-Path $fixture 'browser/EBWebView/Default/Cache'
$artifacts = Join-Path $fixture 'artifacts'
$temporary = Join-Path $artifacts 'project/session/.threadfleet-tmp'
$unmarked = Join-Path $artifacts 'project/unmarked/.threadfleet-tmp'
New-Item -ItemType Directory -Path $cache, $temporary, $unmarked | Out-Null
$oldCache = Join-Path $cache 'old.cache'
$oldTemporary = Join-Path $temporary 'old.tmp'
$report = Join-Path $artifacts 'project/session/report.pdf'
$unmarkedFile = Join-Path $unmarked 'old.tmp'
$cookies = Join-Path (Split-Path $cache) 'Cookies'
foreach ($file in @($oldCache, $oldTemporary, $report, $unmarkedFile, $cookies)) {
  [IO.File]::WriteAllText($file, 'old content')
  [IO.File]::SetLastWriteTimeUtc($file, [datetime]::UtcNow.AddDays(-60))
  [IO.File]::SetLastAccessTimeUtc($file, [datetime]::UtcNow.AddDays(-60))
}
[IO.File]::WriteAllText((Join-Path $temporary '.threadfleet-disposable'), 'ThreadFleet disposable cache v1')
[IO.File]::WriteAllText((Join-Path $cache 'recent.cache'), 'recent cache')
New-Item -ItemType Junction -Path (Join-Path $temporary 'keep-project') -Target $protected | Out-Null
$policy = @{ enabled = $true; retentionDays = 30; cacheRoots = @($cache); artifactRoots = @($artifacts) }
Write-Json $policy 'maintenance.json'
# A queued migration must delay maintenance rather than discard this exit's check.
$storageMutex = New-Object System.Threading.Mutex($false, ('Local\ThreadFleetStorageMigration.Test-' + [IO.Path]::GetFileName($fixture)))
Assert ($storageMutex.WaitOne(0)) 'Fixture storage mutex is unexpectedly busy'
$maintenance = $null
try {
  $maintenance = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $scriptCopy + '"'), '-ControlDir', ('"' + $control + '"'), '-Mode', 'Maintenance', '-TestRoot', ('"' + $fixture + '"')) -WindowStyle Hidden -PassThru
  Assert (-not $maintenance.WaitForExit(3000)) 'Maintenance abandoned its check while migration owned storage'
} finally { $storageMutex.ReleaseMutex(); $storageMutex.Dispose() }
Assert ($maintenance.WaitForExit(30000)) 'Maintenance did not resume after migration released storage'
Assert ($maintenance.ExitCode -eq 0) 'Deferred maintenance failed'
$result = Get-Content -LiteralPath (Join-Path $control 'maintenance-result.json') -Raw | ConvertFrom-Json
Assert (-not $result.error) "Maintenance error: $($result.error)"
Assert ($result.removedFiles -eq 2) "Expected two disposable files, got $($result.removedFiles)"
foreach ($file in @($report, $unmarkedFile, $cookies, (Join-Path $cache 'recent.cache'), (Join-Path $protected 'source.ts'))) { Assert ([IO.File]::Exists($file)) "Protected file removed: $file" }
Assert (-not [IO.File]::Exists($oldCache) -and -not [IO.File]::Exists($oldTemporary)) 'Expired files remain'
# Running again within 24 hours must not reset the last cleanup summary.
Run 'Maintenance'
$next = Get-Content -LiteralPath (Join-Path $control 'maintenance-result.json') -Raw | ConvertFrom-Json
Assert ($next.lastRun -eq $result.lastRun -and $next.removedFiles -eq 2) 'Daily limit was not respected'
Write-Output 'PASS: migration contention, cache retention, daily limit, unmarked artifacts and external linked data protected'
Write-Output "Fixture retained for review: $fixture"
