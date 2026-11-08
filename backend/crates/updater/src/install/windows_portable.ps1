# Windows portable update: only replace the executable, never the data directory.
param([switch]$StageOnly)
$ErrorActionPreference = 'Stop'
__APP_EXE__
__APP_PID__
__RESTART_ARGS__
__ARCHIVE__
__LOG_FILE__
__FAILURE_FILE__
$appExe = [IO.Path]::GetFullPath($appExe)
$appDir = [IO.Path]::GetDirectoryName($appExe)
$staged = $appExe + '.update-new'
$backup = $appExe + '.update-old'
$hashFile = $logFile + '.portable-sha256'

function Write-Log([string]$message) {
    try { Add-Content -LiteralPath $logFile -Value $message -Encoding UTF8 } catch { }
}

function Write-Failure([string]$reason) {
    Write-Log $reason
    try { Set-Content -LiteralPath $markerFile -Value $reason -Encoding UTF8 } catch { }
}

function Get-Sha256([string]$path) {
    $stream = [IO.File]::OpenRead($path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Start-Client {
    # Start-Process resolves wildcard characters in paths; pass literal paths to Windows instead.
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $appExe
    $info.WorkingDirectory = $appDir
    $info.Arguments = $restartArgs
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $client = [Diagnostics.Process]::Start($info)
    $client.Dispose()
}

if ($StageOnly) {
    try {
        if (-not [IO.File]::Exists($appExe)) { throw 'Portable executable does not exist.' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
            $entries = @($zip.Entries | Where-Object { $_.FullName -ceq 'OpenShell.exe' })
            if ($entries.Count -ne 1 -or $entries[0].Length -lt 2) {
                throw 'Portable archive must contain exactly one OpenShell.exe at its root.'
            }
            # Extract one known file. ZIP paths can never write into connections or other user files.
            $source = $entries[0].Open()
            try {
                $destination = [IO.File]::Open($staged, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
                try { $source.CopyTo($destination) } finally { $destination.Dispose() }
            } finally { $source.Dispose() }
        } finally { $zip.Dispose() }
        $binary = [IO.File]::OpenRead($staged)
        try {
            if ($binary.ReadByte() -ne 77 -or $binary.ReadByte() -ne 90) {
                throw 'Portable archive does not contain a Windows executable.'
            }
        } finally { $binary.Dispose() }
        $hash = Get-Sha256 $staged
        Set-Content -LiteralPath $hashFile -Value $hash -Encoding ASCII
        Write-Log 'Portable update staged; waiting for client handoff.'
        exit 0
    } catch {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
        Write-Failure ('便携版更新准备失败，当前程序未改动：' + $_.Exception.Message)
        exit 1
    }
}

$oldMoved = $false
$newMoved = $false
$clientExited = $false
try {
    $oldProcess = Get-Process -Id $appPid -ErrorAction SilentlyContinue
    if ($oldProcess -and -not $oldProcess.WaitForExit(120000)) {
        throw 'OpenShell did not exit within 120 seconds; update cancelled.'
    }
    $clientExited = $true
    $expectedHash = (Get-Content -LiteralPath $hashFile -Raw).Trim()
    if ((Get-Sha256 $staged) -ne $expectedHash) {
        throw 'Staged executable checksum changed; update cancelled.'
    }
    # Paths are absolute and only these fixed sibling files are moved or removed.
    if ([IO.File]::Exists($backup)) { Remove-Item -LiteralPath $backup -Force }
    Move-Item -LiteralPath $appExe -Destination $backup
    $oldMoved = $true
    Move-Item -LiteralPath $staged -Destination $appExe
    $newMoved = $true
    Start-Client
    Remove-Item -LiteralPath $markerFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $hashFile -Force -ErrorAction SilentlyContinue
    Write-Log 'Portable update complete; new client started.'
    # Keep the previous executable for recovery until the next successful update.
    exit 0
} catch {
    $reason = $_.Exception.Message
    Write-Log $_.ScriptStackTrace
    if ($oldMoved) {
        try {
            if ($newMoved) { Remove-Item -LiteralPath $appExe -Force }
            Move-Item -LiteralPath $backup -Destination $appExe
        } catch { $reason += '; rollback: ' + $_.Exception.Message }
    }
    Write-Failure ('便携版自动更新失败，已尝试恢复旧程序：' + $reason)
    if ($clientExited -and [IO.File]::Exists($appExe)) {
        try {
            Start-Client
        } catch { Write-Log ('Failed to restart previous client: ' + $_.Exception.Message) }
    }
    exit 1
}
