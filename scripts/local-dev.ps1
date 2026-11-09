param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
    [string]$KeyPath = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $repo '.tmp'
$statePath = Join-Path $runtime 'local-processes.json'
if (!$KeyPath) { $KeyPath = [IO.Path]::GetFullPath((Join-Path $repo '..\..\java.pem')) }
New-Item -ItemType Directory -Force $runtime | Out-Null
$state = @{}
if (Test-Path $statePath) {
    $saved = Get-Content -Raw $statePath | ConvertFrom-Json
    foreach ($item in $saved.PSObject.Properties) { $state[$item.Name] = $item.Value }
}
function Save-State { $state | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $statePath }
function Get-OwnedProcess([string]$Name) {
    if (!$state.ContainsKey($Name)) { return $null }
    $entry = $state[$Name]
    $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if ($process -and $process.StartTime.ToUniversalTime() -eq ([datetime]$entry.started).ToUniversalTime()) { return $process }
    return $null
}
function Port-Open([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try { return $client.ConnectAsync('127.0.0.1', $Port).Wait(400) -and $client.Connected }
    catch { return $false }
    finally { $client.Dispose() }
}
function Start-ServiceProcess([string]$Name, [string]$Exe, [string]$Arguments, [string]$Directory, [int]$Port) {
    $process = Get-OwnedProcess $Name
    if ($process -and (Port-Open $Port)) { Write-Output "$Name already running (PID $($process.Id))."; return }
    if ($process) { throw "$Name process exists but port $Port is unavailable. Check .tmp/$Name.err.log or run Stop first." }
    if (Port-Open $Port) { throw "Port $Port is occupied by another process; it has not been stopped." }
    $process = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime "$Name.out.log") -RedirectStandardError (Join-Path $runtime "$Name.err.log") -PassThru
    $state[$Name] = @{ pid = $process.Id; started = $process.StartTime.ToUniversalTime().ToString('o') }
    Save-State
    for ($i = 0; $i -lt 45; $i++) {
        if ($process.HasExited) { throw "$Name exited. Check .tmp/$Name.err.log." }
        if (Port-Open $Port) { Write-Output "$Name ready on 127.0.0.1:$Port (PID $($process.Id))."; return }
        Start-Sleep -Seconds 1
    }
    throw "$Name did not become ready. Check .tmp/$Name.err.log. Use Stop to stop local processes."
}
if ($Action -eq 'Stop') {
    foreach ($name in @('web', 'mcp', 'repository', 'tunnel')) {
        $process = Get-OwnedProcess $name
        if ($process) {
            & taskkill.exe /PID $process.Id /T /F | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Could not stop $name." }
            Write-Output "Stopped $name."
        }
        $state.Remove($name)
    }
    Save-State
    exit
}
if ($Action -eq 'Status') {
    foreach ($name in @('tunnel', 'repository', 'mcp', 'web')) {
        $process = Get-OwnedProcess $name
        $label = if ($process) { "running (PID $($process.Id))" } else { 'stopped' }
        Write-Output "${name}: $label"
    }
    exit
}
$envFile = Join-Path $repo '.env.local'
if (!(Test-Path $envFile)) { throw 'Missing .env.local; follow docs/LOCAL_DEVELOPMENT.md.' }
$localConfig = Get-Content -Raw $envFile
if ($localConfig -notmatch 'mysql://[^\r\n]+@127\.0\.0\.1:13307/(scenarioforge_dev_admin|projectdb)\?') {
    throw 'This launcher requires a configured database through the local SSH tunnel.'
}
$databaseName = $Matches[1]
if ($databaseName -eq 'projectdb') {
    $env:SCENARIOFORGE_TASK_SCHEDULER = 'off'
    Write-Output 'Connected to LIVE projectdb. Local changes are live; queued tasks run on the server.'
} else {
    Remove-Item Env:SCENARIOFORGE_TASK_SCHEDULER -ErrorAction SilentlyContinue
}
if (!(Test-Path $KeyPath)) { throw "SSH key missing: $KeyPath" }
$node = (Get-Command node.exe).Source
$ssh = (Get-Command ssh.exe).Source
$python = Join-Path $repo 'mcp-server\.venv\Scripts\python.exe'
if (!(Test-Path $python)) { throw 'Install Python dependencies with uv sync --locked inside mcp-server.' }
$env:NODE_ENV = 'development'
$env:NEXT_TELEMETRY_DISABLED = '1'
$sshArgs = '-N -T -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i "{0}" -L 127.0.0.1:13307:127.0.0.1:3307 ubuntu@175.27.143.14' -f $KeyPath
Start-ServiceProcess 'tunnel' $ssh $sshArgs $repo 13307
if ($databaseName -eq 'projectdb') {
    $env:SCENARIOFORGE_REPOSITORY_BACKEND_URL = 'http://127.0.0.1:13000'
    $env:SCENARIOFORGE_REPOSITORY_BACKEND_ORIGIN = 'https://175.27.143.14'
    $repositoryArgs = '-N -T -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -i "{0}" -L 127.0.0.1:13000:127.0.0.1:3000 ubuntu@175.27.143.14' -f $KeyPath
    Start-ServiceProcess 'repository' $ssh $repositoryArgs $repo 13000
} else {
    Remove-Item Env:SCENARIOFORGE_REPOSITORY_BACKEND_URL -ErrorAction SilentlyContinue
    Remove-Item Env:SCENARIOFORGE_REPOSITORY_BACKEND_ORIGIN -ErrorAction SilentlyContinue
}
Start-ServiceProcess 'mcp' $python ('"{0}"' -f (Join-Path $repo 'mcp-server\main.py')) (Join-Path $repo 'mcp-server') 8000
$webArgs = '"{0}" dev --webpack --hostname 127.0.0.1 --port 3000' -f (Join-Path $repo 'node_modules\next\dist\bin\next')
Start-ServiceProcess 'web' $node $webArgs $repo 3000
Write-Output 'Open http://localhost:3000 . Logs: .tmp/*.log .'
