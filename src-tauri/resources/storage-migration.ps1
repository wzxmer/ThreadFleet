param(
  [Parameter(Mandatory)][string]$ControlDir,
  [ValidateSet('Migrate', 'Cleanup', 'Maintenance')][string]$Mode = 'Migrate',
  [string]$TestRoot
)
$ErrorActionPreference = 'Stop'
$planPath = Join-Path $ControlDir 'plan.json'
$cancelPath = Join-Path $ControlDir 'cancel'
$mutexSuffix = if ($TestRoot) { '.Test-' + [IO.Path]::GetFileName($TestRoot.TrimEnd('\')) } else { '' }
$mutex = New-Object System.Threading.Mutex($false, ('Local\ThreadFleetStorageMigration' + $mutexSuffix))
$ownsMutex = $false
$plan = $null
$planValidated = $false
$workerLock = $null

function Save-Plan {
  $temporary = Join-Path $ControlDir ([Guid]::NewGuid().ToString('N') + '.tmp')
  $json = $script:plan | ConvertTo-Json -Depth 12
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($planPath)) {
    [IO.File]::Replace($temporary, $planPath, [NullString]::Value)
  } else { [IO.File]::Move($temporary, $planPath) }
}

function Full-Path([string]$Path) { [IO.Path]::GetFullPath($Path).TrimEnd('\') }
function Is-Within([string]$Child, [string]$Parent) {
  return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or $Child.StartsWith($Parent + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Exists([string]$Path) { return $null -ne (Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue) }
function Is-Link([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return $item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Assert-Junction([string]$Alias, [string]$Target) {
  $item = Get-Item -LiteralPath $Alias -Force
  if ($item.LinkType -ne 'Junction' -or (Full-Path ([string]@($item.Target)[0])) -ine (Full-Path $Target)) {
    throw "Storage alias does not point to the verified destination: $Alias"
  }
}
function Remove-Link([string]$Path) {
  if (-not (Is-Link $Path)) { throw "Refusing to remove a non-link as a junction: $Path" }
  [IO.Directory]::Delete($Path)
}
function Test-Junction([string]$Parent, [string]$Target) {
  # Read through a disposable link before renaming a single live directory.
  # Some Windows policies reject newly created mount points (WinError 448).
  $token = '.tf-link-probe-' + [guid]::NewGuid().ToString('N')
  $alias = Join-Path $Parent $token
  $probe = Join-Path $Target ($token + '.txt')
  $targetExisted = [IO.Directory]::Exists($Target)
  New-Item -ItemType Directory -Path $Parent, $Target -Force | Out-Null
  try {
    [IO.File]::WriteAllText($probe, $token)
    New-Item -ItemType Junction -Path $alias -Target $Target | Out-Null
    if ([IO.File]::ReadAllText((Join-Path $alias ($token + '.txt'))) -cne $token) { throw 'Storage junction read verification failed' }
    [IO.File]::WriteAllText((Join-Path $alias ($token + '.txt')), 'verified')
    if ([IO.File]::ReadAllText($probe) -cne 'verified') { throw 'Storage junction write verification failed' }
  } catch { throw "Windows cannot use the required storage junction. Original data has not been moved. $($_.Exception.Message)" }
  finally {
    if (Is-Link $alias) { Remove-Link $alias }
    if ([IO.File]::Exists($probe)) { [IO.File]::Delete($probe) }
    if (-not $targetExisted -and [IO.Directory]::Exists($Target) -and -not @(Get-ChildItem -LiteralPath $Target -Force).Count) { [IO.Directory]::Delete($Target) }
  }
}
function Assert-Plan {
  if ($script:plan.version -ne 1 -or $script:plan.id -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid migration plan' }
  if (-not $script:plan.locations.Count) { throw 'Migration plan has no locations' }
  $root = Full-Path $script:plan.root
  $ancestor = $root
  while ($ancestor) {
    if (Is-Link $ancestor) { throw 'Destination ancestors must not be directory links' }
    $ancestor = Split-Path $ancestor -Parent
  }
  if (-not [IO.Path]::IsPathRooted($script:plan.root) -or (Is-Within (Full-Path $ControlDir) $root)) { throw 'Invalid data root' }
  if ($TestRoot) {
    $test = Full-Path $TestRoot
    if (-not (Is-Within $root $test) -or -not (Is-Within (Full-Path $ControlDir) $test)) { throw 'Test paths must remain inside the isolated fixture' }
  }
  $seen = @()
  foreach ($entry in $script:plan.locations) {
    foreach ($field in @('alias', 'source', 'destination', 'backup')) {
      if (-not [IO.Path]::IsPathRooted($entry.$field)) { throw 'Storage paths must be absolute' }
      $entry.$field = Full-Path $entry.$field
      if ($TestRoot -and -not (Is-Within $entry.$field $test)) { throw 'Test source escapes the isolated fixture' }
    }
    if ((Is-Within (Full-Path $ControlDir) $entry.alias) -or (Is-Within (Full-Path $ControlDir) $entry.source)) { throw 'Storage source must not contain migration controls' }
    if ($entry.kind -notmatch '^[a-z-]+$' -or $entry.destination -ine (Join-Path $root $entry.kind) -or
        $entry.backup -ine ($entry.alias + '.tf-backup-' + $script:plan.id)) { throw 'Invalid migration location' }
    if ((Is-Within $root $entry.alias) -or (Is-Within $entry.alias $root) -or
        (Is-Within $root $entry.source) -or (Is-Within $entry.source $root)) { throw 'Source and destination overlap' }
    foreach ($other in $seen) {
      if ($other.kind -eq $entry.kind) { throw 'Duplicate destination kind' }
      if ((Is-Within $entry.alias $other.alias) -or (Is-Within $other.alias $entry.alias) -or
          (Is-Within $entry.source $other.source) -or (Is-Within $other.source $entry.source)) { throw 'Storage sources overlap' }
    }
    $seen += $entry
  }
}
function Uses-MigratingSource($Process) {
  if ($Mode -ne 'Migrate' -or -not $script:planValidated) { return $false }
  foreach ($entry in $script:plan.locations) {
    foreach ($root in @($entry.source, $entry.alias)) {
      if ($Process.ExecutablePath -and (Is-Within (Full-Path $Process.ExecutablePath) $root)) { return $true }
      # Native messaging wrappers and interpreted MCP servers may live outside
      # the source while their command or script keeps a source directory open.
      if ($Process.Name -match '^(cmd|node|bun|deno|dotnet|python|pythonw|uv|powershell|pwsh)(\.exe)?$' -and
          $Process.CommandLine -and $Process.CommandLine.IndexOf($root + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
  }
  return $false
}
function Busy-Processes {
  if ($TestRoot) { return @() }
  # Fail closed when process enumeration fails. Never terminate another session.
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ProcessId -ne $PID -and -not (Waiting-Startup $_.ProcessId) -and (
      $_.Name -match '^(threadfleet|codex|codex-code-mode-host|codexmonitor|codex_monitor|codex_monitor_daemon|codex-monitor-daemon|gemini)(\.exe)?$' -or
      ($_.Name -match '^(node|bun|deno)(\.exe)?$' -and $_.CommandLine -match '(gemini|codex|codexmonitor)') -or
      ($_.Name -match '^msedgewebview2\.exe$' -and $_.CommandLine -match 'com\.dimillian\.codexmonitor') -or
      (Uses-MigratingSource $_)
    )
  })
}
function Waiting-Startup([int]$ProcessId) {
  $marker = Join-Path $ControlDir ('starting-' + $ProcessId)
  if (-not [IO.File]::Exists($marker)) { return $false }
  try {
    $file = [IO.File]::Open($marker, 'Open', 'ReadWrite', 'None')
    $file.Dispose()
    return $false # A stale marker never excludes a running client.
  } catch [IO.IOException] { return $true }
}
function Check-Cancel {
  if (Exists $cancelPath) { throw 'Migration cancelled before switching data paths' }
}
function Snapshot-Value($Item, [switch]$PathsOnly) {
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return 'link:' + $Item.LinkType + ':' + (@($Item.Target) -join '|') }
  if ($Item.PSIsContainer) { return 'directory' }
  if ($PathsOnly) { return 'file' }
  return 'file:' + $Item.Length + ':' + (Get-FileHash -LiteralPath $Item.FullName -Algorithm SHA256).Hash
}
function Snapshot([string]$Root, [switch]$PathsOnly) {
  $result = @{}
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($Root)
  while ($pending.Count) {
    $directory = $pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
      $relative = $item.FullName.Substring($Root.Length).TrimStart('\')
      $result[$relative] = Snapshot-Value $item -PathsOnly:$PathsOnly
      if ($item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { $pending.Push($item.FullName) }
    }
  }
  return ,$result
}
function Assert-Same($Left, $Right, [string]$Context = 'backup', [string]$Kind = 'storage') {
  $missing = @($Left.Keys | Where-Object { -not $Right.ContainsKey($_) } | Sort-Object)
  $extra = @($Right.Keys | Where-Object { -not $Left.ContainsKey($_) } | Sort-Object)
  $changed = @($Left.Keys | Where-Object { $Right.ContainsKey($_) -and $Left[$_] -cne $Right[$_] } | Sort-Object)
  if (-not ($missing.Count + $extra.Count + $changed.Count)) { return }
  # Keep diagnostics outside every migrating source. Persist only bounded path
  # differences, never file contents or credentials from the snapshots.
  $reportPath = Join-Path $ControlDir ($script:plan.id + '-' + $Kind + '-' + $Context + '.difference.json')
  $report = @{ context = $Context; kind = $Kind; expectedCount = $Left.Count; actualCount = $Right.Count;
    missingCount = $missing.Count; extraCount = $extra.Count; changedCount = $changed.Count;
    missing = @($missing | Select-Object -First 20); extra = @($extra | Select-Object -First 20); changed = @($changed | Select-Object -First 20) }
  [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  throw "Storage verification failed ($Context, $Kind): expected $($Left.Count), actual $($Right.Count); missing $($missing.Count), extra $($extra.Count), changed $($changed.Count). Details: $reportPath"
}
function Verification-Path($Entry) { Join-Path $ControlDir ($script:plan.id + '-' + $Entry.kind + '.verification.json') }
function Prepare-RetryDestination($Entry, $SourceSnapshot) {
  $paths = Snapshot $Entry.destination -PathsOnly
  $extras = @($paths.Keys | Where-Object { -not $SourceSnapshot.ContainsKey($_) })
  if (-not $extras.Count) { return }
  $verified = @{}
  $verification = Verification-Path $Entry
  if (Exists $verification) {
    $stored = Get-Content -LiteralPath $verification -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($property in $stored.PSObject.Properties) { $verified[$property.Name] = $property.Value }
  }
  # Preserve unknown, changed and durable retry leftovers outside the active
  # destination. Only unchanged verified transient copies may be discarded.
  # Move complete extra subtrees atomically, never traverse a directory link.
  $roots = @($extras | Where-Object {
    $parent = Split-Path $_ -Parent
    -not $parent -or $SourceSnapshot.ContainsKey($parent)
  })
  $preserved = $null
  foreach ($relative in $roots) {
    $members = @($extras | Where-Object { $_ -eq $relative -or $_.StartsWith($relative + '\', [StringComparison]::OrdinalIgnoreCase) })
    $discard = $true
    foreach ($member in $members) {
      $item = Get-Item -LiteralPath (Join-Path $Entry.destination $member) -Force
      $transient = $Entry.kind -eq 'app-cache' -or ($Entry.kind -eq 'codex' -and $member -match '^(tmp|\.tmp)(\\|$)')
      if (-not $transient -or -not $verified.ContainsKey($member) -or (Is-Link $item.FullName) -or
          $verified[$member] -cne (Snapshot-Value $item)) { $discard = $false }
    }
    $path = Join-Path $Entry.destination $relative
    if ($discard) {
      foreach ($member in @($members | Sort-Object { $_.Length } -Descending)) {
        $item = Get-Item -LiteralPath (Join-Path $Entry.destination $member) -Force
        if ((Is-Link $item.FullName) -or $verified[$member] -cne (Snapshot-Value $item)) { throw 'Retry copy changed before cleanup; data preserved' }
        if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName) }
        else {
          if ($item.IsReadOnly) { $item.IsReadOnly = $false }
          [IO.File]::Delete($item.FullName)
        }
      }
      continue
    }
    if (-not $preserved) {
      $preserved = Join-Path $script:plan.root ('.tf-retry-preserved-' + $script:plan.id + '-' + $Entry.kind + '-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $preserved | Out-Null
      # Match the destination's protected access boundary for retained data.
      Set-Acl -LiteralPath $preserved -AclObject (Get-Acl -LiteralPath $Entry.destination)
    }
    $target = Join-Path $preserved $relative
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer) { [IO.Directory]::Move($path, $target) }
    else { [IO.File]::Move($path, $target) }
  }
}
function Remove-Tree([string]$Path) {
  # Never traverse nested junctions into another client's or project's data.
  if (Is-Link $Path) { Remove-Link $Path; return }
  foreach ($item in Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop) {
    if ($item.PSIsContainer) { Remove-Tree $item.FullName }
    else {
      if (($item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { $item.IsReadOnly = $false }
      [IO.File]::Delete($item.FullName)
    }
  }
  [IO.Directory]::Delete($Path)
}

function Save-Maintenance($Result) {
  $path = Join-Path $ControlDir 'maintenance-result.json'
  $temporary = $path + '.' + $PID + '.tmp'
  [IO.File]::WriteAllText($temporary, ($Result | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
  else { [IO.File]::Move($temporary, $path) }
}
function Physical-Directory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return $item -and $item.PSIsContainer -and -not (Is-Link $Path)
}
function Cache-Files([string]$Root) {
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  if (Physical-Directory $Root) { $pending.Push($Root) }
  while ($pending.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) } else { $item }
    }
  }
}
function Run-Maintenance {
  $maintenanceMutex = New-Object System.Threading.Mutex($false, ('Local\ThreadFleetCacheMaintenance' + $mutexSuffix))
  $maintenanceOwner = $false
  $storageOwner = $false
  $result = @{ status = 'idle'; lastRun = $null; removedFiles = 0; removedBytes = 0; error = $null }
  try {
    try { $maintenanceOwner = $maintenanceMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $maintenanceOwner = $true }
    if (-not $maintenanceOwner) { return }
    $resultPath = Join-Path $ControlDir 'maintenance-result.json'
    if (Exists $resultPath) {
      $storedResult = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $result.lastRun = $storedResult.lastRun
      $result.removedFiles = $storedResult.removedFiles
      $result.removedBytes = $storedResult.removedBytes
    }
    $policyPath = Join-Path $ControlDir 'maintenance.json'
    while ($true) {
      $policy = Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $policy.enabled) { Save-Maintenance $result; return }
      if ($policy.retentionDays -lt 7 -or $policy.retentionDays -gt 365) { throw 'Retention must be between 7 and 365 days' }
      if (Exists (Join-Path $ControlDir 'maintenance-result.json')) {
        $previous = Get-Content -LiteralPath (Join-Path $ControlDir 'maintenance-result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($previous.lastRun -and $previous.status -eq 'idle' -and [datetime]::Parse($previous.lastRun).ToUniversalTime() -gt [datetime]::UtcNow.AddDays(-1)) { return }
      }
      if (-not (Busy-Processes).Count) { break }
      Start-Sleep -Seconds 2
    }
    # A waiting maintenance worker never holds the migration mutex.
    while (-not $storageOwner) {
      $latestPolicy = Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $latestPolicy.enabled) { Save-Maintenance $result; return }
      $policy = $latestPolicy
      if (-not (Busy-Processes).Count) {
        try { $storageOwner = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $storageOwner = $true }
      }
      if (-not $storageOwner) { Start-Sleep -Seconds 2 }
    }
    if (Exists $planPath) {
      $migration = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($migration.status -notin @('ready', 'failed', 'cancelled')) { return }
    }
    $result.status = 'cleaning'
    $result.removedFiles = 0; $result.removedBytes = 0
    Save-Maintenance $result
    if ((Busy-Processes).Count) { $result.status = 'idle'; Save-Maintenance $result; return }
    $cutoff = [datetime]::UtcNow.AddDays(-[int]$policy.retentionDays)
    foreach ($root in $policy.cacheRoots) {
      # Only fixed WebView cache locations supplied by the host; never profile data.
      if ((Full-Path $root) -notmatch '\\EBWebView\\Default\\(Cache|Code Cache|GPUCache)$') { throw 'Invalid browser cache path' }
      if ($TestRoot -and -not (Is-Within (Full-Path $root) (Full-Path $TestRoot))) { throw 'Cache escaped fixture' }
      # The application root itself may be a migrated junction, but no directory
      # beneath that root may redirect cache traversal elsewhere.
      $profile = Split-Path $root
      $webview = Split-Path $profile
      if (-not (Physical-Directory $webview) -or -not (Physical-Directory $profile)) { continue }
      foreach ($file in @(Cache-Files $root)) {
        if ($file.LastWriteTimeUtc -lt $cutoff -and $file.LastAccessTimeUtc -lt $cutoff) {
          [IO.File]::Delete($file.FullName)
          $result.removedFiles++; $result.removedBytes += $file.Length
        }
      }
    }
    foreach ($root in $policy.artifactRoots) {
      if ($TestRoot -and -not (Is-Within (Full-Path $root) (Full-Path $TestRoot))) { throw 'Artifacts escaped fixture' }
      # Fixed project/session depth. Do not follow any nested links.
      if (-not (Physical-Directory $root)) { continue }
      foreach ($project in Get-ChildItem -LiteralPath $root -Directory -Force) {
        if (Is-Link $project.FullName) { continue }
        foreach ($session in Get-ChildItem -LiteralPath $project.FullName -Directory -Force) {
          if (Is-Link $session.FullName) { continue }
          $temporary = Join-Path $session.FullName '.threadfleet-tmp'
          $marker = Join-Path $temporary '.threadfleet-disposable'
          if (-not (Physical-Directory $temporary) -or -not [IO.File]::Exists($marker) -or (Is-Link $marker)) { continue }
          if ([IO.File]::ReadAllText($marker) -cne 'ThreadFleet disposable cache v1') { continue }
          foreach ($file in @(Cache-Files $temporary)) {
            if ($file.FullName -ine $marker -and $file.LastWriteTimeUtc -lt $cutoff -and $file.LastAccessTimeUtc -lt $cutoff) {
              [IO.File]::Delete($file.FullName)
              $result.removedFiles++; $result.removedBytes += $file.Length
            }
          }
        }
      }
    }
    $result.lastRun = [datetime]::UtcNow.ToString('o')
    $result.status = 'idle'
    Save-Maintenance $result
  } catch {
    $result.status = 'idle'; $result.error = $_.Exception.Message
    Save-Maintenance $result
  } finally {
    if ($storageOwner) { $mutex.ReleaseMutex() }
    if ($maintenanceOwner) { $maintenanceMutex.ReleaseMutex() }
    $maintenanceMutex.Dispose()
  }
}
function Rollback {
  foreach ($entry in @($script:plan.locations)[($script:plan.locations.Count - 1)..0]) {
    if (Exists $entry.backup) {
      if (Exists $entry.alias) {
        Assert-Junction $entry.alias $entry.destination
        Remove-Link $entry.alias
      }
      [IO.Directory]::Move($entry.backup, $entry.alias)
    }
    $entry.switched = $false
  }
}

try {
  if ($Mode -eq 'Maintenance') { Run-Maintenance; exit 0 }
  try { $ownsMutex = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) { exit 0 }
  $workerLock = [IO.File]::Open((Join-Path $ControlDir 'migration-worker.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
  $plan = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-Plan
  $planValidated = $true
  if ($Mode -eq 'Cleanup') {
    if ($plan.status -notin @('ready', 'cleanup-queued', 'cleaning') -or $plan.backupsCleaned) { throw 'No verified backup cleanup is available' }
    $plan.status = 'cleanup-queued'
    Save-Plan
    while ((Busy-Processes).Count) {
      if (Exists $cancelPath) { $plan.status = 'ready'; Save-Plan; exit 0 }
      Start-Sleep -Seconds 2
    }
    $plan.status = 'cleaning'
    Save-Plan
    foreach ($entry in $plan.locations) {
      Assert-Junction $entry.alias $entry.destination
      $progressPath = Join-Path $ControlDir ($plan.id + '-' + $entry.kind + '.cleanup-authorized')
      if (Exists $progressPath) { continue }
      if (-not (Exists $entry.backup)) { continue }
      $verified = @{}
      $stored = Get-Content -LiteralPath (Verification-Path $entry) -Raw -Encoding UTF8 | ConvertFrom-Json
      foreach ($property in $stored.PSObject.Properties) { $verified[$property.Name] = $property.Value }
      if ($entry.wasLink) {
        Assert-Junction $entry.backup $entry.source
        Assert-Same $verified (Snapshot $entry.source)
      } else { Assert-Same $verified (Snapshot $entry.backup) }
      [IO.File]::WriteAllText($progressPath, 'Verified unchanged backup; deletion may resume')
    }
    # Old backups can be removed only while no client can reopen the old paths.
    if ((Busy-Processes).Count) { throw 'Close ThreadFleet and Agent clients before removing old copies' }
    foreach ($entry in $plan.locations) {
      Assert-Junction $entry.alias $entry.destination
      $progressPath = Join-Path $ControlDir ($plan.id + '-' + $entry.kind + '.cleanup-authorized')
      if (((Exists $entry.backup) -or ($entry.wasLink -and (Exists $entry.source))) -and -not (Exists $progressPath)) { throw 'Missing verified backup cleanup authorization' }
      if (Exists $entry.backup) {
        if ($entry.wasLink) { Remove-Link $entry.backup } else { Remove-Tree $entry.backup }
      }
      if ($entry.wasLink -and (Exists $entry.source)) { Remove-Tree $entry.source }
    }
    $plan.backupsCleaned = $true
    $plan.error = $null
    $plan.status = 'ready'
    Save-Plan
    exit 0
  }
  if ($plan.status -eq 'ready' -or $plan.status -eq 'cancelled') { exit 0 }
  $interrupted = $plan.status -in @('copying', 'switching', 'recovering')
  $plan.status = if ($interrupted) { 'recovering' } else { 'queued' }
  $plan.error = $null
  Save-Plan
  while ((Busy-Processes).Count) {
    if (Exists $cancelPath) { $plan.status = 'cancelled'; Save-Plan; exit 0 }
    Start-Sleep -Seconds 2
  }
  if (Exists $cancelPath) { $plan.status = 'cancelled'; Save-Plan; exit 0 }
  Check-Cancel
  # Recover any interrupted switch before copying or touching another location.
  Rollback
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($plan.root))
  if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') { throw 'Choose a local NTFS disk for the unified data directory' }
  if (Is-Link $plan.root) { throw 'Data root must be a physical directory' }
  $required = [long]0
  foreach ($entry in $plan.locations) {
    if (Exists $entry.source) { foreach ($file in Cache-Files $entry.source) { $required += $file.Length } }
  }
  if ($drive.AvailableFreeSpace -lt ($required + 256MB)) { throw 'Not enough free disk space for a verified copy and reserve' }
  foreach ($entry in $plan.locations) {
    Test-Junction (Split-Path $entry.alias -Parent) $entry.destination
  }
  $plan.status = 'copying'
  Save-Plan
  foreach ($entry in $plan.locations) {
    Check-Cancel
    if ((Busy-Processes).Count) { throw 'A client started during copying; close ThreadFleet and Agent clients before retrying. Original paths remain active' }
    if (-not (Exists $entry.alias)) { New-Item -ItemType Directory -Path $entry.alias -Force | Out-Null }
    if ($entry.wasLink) { Assert-Junction $entry.alias $entry.source }
    elseif (Is-Link $entry.alias) { throw "Source changed into a link: $($entry.alias)" }
    if (Is-Link $entry.destination) { throw 'Destination must be a physical directory' }
    New-Item -ItemType Directory -Path $entry.destination -Force | Out-Null
    $permissions = Get-Acl -LiteralPath $entry.source
    $permissions.SetAccessRuleProtection($true, $true)
    Set-Acl -LiteralPath $entry.destination -AclObject $permissions
    $before = Snapshot $entry.source
    Prepare-RetryDestination $entry $before
    # Mapped browser indexes can change without a new size or write time.
    # Recopy matching metadata too: retries must use the current source bytes.
    & "$env:SystemRoot\System32\robocopy.exe" $entry.source $entry.destination /E /IS /IM /COPY:DATS /SECFIX /DCOPY:DAT /SL /SJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP *> $null
    if ($LASTEXITCODE -ge 8) { throw "Storage copy failed for $($entry.kind); code $LASTEXITCODE" }
    # Preserve the source's access boundary even when the new parent has wider
    # inheritable permissions. Robocopy can reset the root inheritance flag.
    Set-Acl -LiteralPath $entry.destination -AclObject $permissions
    Assert-Same $before (Snapshot $entry.source) 'source-stability' $entry.kind
    Assert-Same $before (Snapshot $entry.destination) 'destination-copy' $entry.kind
    [IO.File]::WriteAllText((Verification-Path $entry), ($before | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  }
  Check-Cancel
  if ((Busy-Processes).Count) { throw 'An Agent client started during migration; original paths remain active' }
  $plan.status = 'switching'
  Save-Plan
  foreach ($entry in $plan.locations) {
    if ((Busy-Processes).Count) { throw 'A client started while switching; restoring the original paths' }
    [IO.Directory]::Move($entry.alias, $entry.backup)
    New-Item -ItemType Junction -Path $entry.alias -Target $entry.destination | Out-Null
    Assert-Junction $entry.alias $entry.destination
    $entry.switched = $true
    Save-Plan
  }
  $plan.status = 'ready'
  $plan.error = $null
  Save-Plan
} catch {
  $failure = $_.Exception.Message
  if ($plan -and $planValidated) {
    if ($Mode -eq 'Migrate') {
      try { Rollback; $plan.status = 'failed' }
      catch { $plan.status = 'recovery-required'; $failure += '; rollback: ' + $_.Exception.Message }
    } else { $plan.status = 'ready' }
    $plan.error = $failure
    try { Save-Plan } catch { Write-Error $failure }
  }
  exit 1
} finally {
  if ($workerLock) { $workerLock.Dispose() }
  if ($ownsMutex) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
