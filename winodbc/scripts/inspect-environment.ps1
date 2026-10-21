# Windows 개발 도구를 읽기 전용으로 조회한다. 출력은 프로젝트 내부로 제한한다.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputDir = Join-Path $projectDir 'build\wo0'
[void][IO.Directory]::CreateDirectory($outputDir)

function Get-FileEvidence([string] $LiteralPath) {
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        return [pscustomobject]@{ path = $LiteralPath; exists = $false }
    }
    $item = Get-Item -LiteralPath $LiteralPath
    $machine = $null
    if ($item.Extension -in '.exe', '.dll') {
        $stream = [IO.File]::OpenRead($LiteralPath)
        $reader = New-Object IO.BinaryReader($stream)
        try {
            if ($reader.ReadUInt16() -eq 0x5a4d) {
                $stream.Position = 0x3c
                $peOffset = $reader.ReadUInt32()
                $stream.Position = $peOffset
                if ($reader.ReadUInt32() -eq 0x4550) {
                    $machine = '0x{0:X4}' -f $reader.ReadUInt16()
                }
            }
        } finally { $reader.Dispose(); $stream.Dispose() }
    }
    [pscustomobject]@{ path = $item.FullName; exists = $true; version = $item.VersionInfo.FileVersion; machine = $machine }
}

function Get-CommandEvidence([string] $Name, [string[]] $Arguments) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return [pscustomobject]@{ name = $Name; exists = $false } }
    $lines = @(& $command.Source @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    [pscustomobject]@{ name = $Name; path = $command.Source; exists = $true; exitCode = $code; output = $lines }
}

$vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$instances = @()
if (Test-Path -LiteralPath $vswherePath) {
    $instances = @((& $vswherePath -all -products '*' -format json -utf8 | Out-String) | ConvertFrom-Json)
}
$visualStudio = @()
foreach ($instance in $instances) {
    $toolchains = @()
    $msvcDir = Join-Path $instance.installationPath 'VC\Tools\MSVC'
    if (Test-Path -LiteralPath $msvcDir) {
        foreach ($toolset in Get-ChildItem -LiteralPath $msvcDir -Directory) {
            $architectures = @()
            foreach ($arch in 'x86', 'x64') {
                $binDir = Join-Path $toolset.FullName "bin\Hostx64\$arch"
                $architectures += [pscustomobject]@{
                    target = $arch
                    compiler = Get-FileEvidence (Join-Path $binDir 'cl.exe')
                    linker = Get-FileEvidence (Join-Path $binDir 'link.exe')
                    dumpbin = Get-FileEvidence (Join-Path $binDir 'dumpbin.exe')
                    crt = Get-FileEvidence (Join-Path $toolset.FullName "lib\$arch\libcmt.lib")
                }
            }
            $toolchains += [pscustomobject]@{ version = $toolset.Name; architectures = $architectures }
        }
    }
    $msbuildPath = Join-Path $instance.installationPath 'MSBuild\Current\Bin\MSBuild.exe'
    $msbuildVersion = @()
    if (Test-Path -LiteralPath $msbuildPath) { $msbuildVersion = @(& $msbuildPath -version -nologo) }
    $visualStudio += [pscustomobject]@{
        name = $instance.displayName; version = $instance.installationVersion
        path = $instance.installationPath; toolchains = $toolchains
        msbuild = Get-FileEvidence $msbuildPath; msbuildVersion = $msbuildVersion
    }
}

$kits = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots' -ErrorAction SilentlyContinue
$sdks = @()
if ($kits -and $kits.KitsRoot10) {
    $includeDir = Join-Path $kits.KitsRoot10 'Include'
    if (Test-Path -LiteralPath $includeDir) {
        foreach ($sdk in Get-ChildItem -LiteralPath $includeDir -Directory) {
            $headers = @('sql.h', 'sqlext.h', 'sqltypes.h', 'sqlucode.h') | ForEach-Object {
                Get-FileEvidence (Join-Path $sdk.FullName "um\$_")
            }
            $libraries = @()
            foreach ($arch in 'x86', 'x64') {
                foreach ($library in 'odbc32', 'odbccp32', 'ws2_32', 'bcrypt', 'secur32', 'crypt32', 'normaliz') {
                    $libraries += Get-FileEvidence (Join-Path $kits.KitsRoot10 "Lib\$($sdk.Name)\um\$arch\$library.lib")
                }
                $libraries += Get-FileEvidence (Join-Path $kits.KitsRoot10 "Lib\$($sdk.Name)\ucrt\$arch\libucrt.lib")
            }
            $sdks += [pscustomobject]@{ version = $sdk.Name; headers = @($headers); libraries = $libraries }
        }
    }
}

# Office용 드라이버의 존재를 Excel/Access 앱의 설치와 혼동하지 않는다.
$appEvidence = @()
foreach ($view in [Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32) {
    foreach ($hive in [Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryHive]::CurrentUser) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        try {
            foreach ($app in 'EXCEL.EXE', 'MSACCESS.EXE', 'dbeaver.exe') {
                $key = $root.OpenSubKey("SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$app")
                if ($key) {
                    try {
                        $appPath = [string]$key.GetValue('')
                        if ($appPath) { $appEvidence += Get-FileEvidence ($appPath.Trim('"')) }
                    } finally { $key.Dispose() }
                }
            }
        } finally { $root.Dispose() }
    }
}
foreach ($programRoot in $env:ProgramFiles, ${env:ProgramFiles(x86)}) {
    foreach ($relative in 'Microsoft Office\root\Office16\EXCEL.EXE', 'Microsoft Office\root\Office16\MSACCESS.EXE', 'Microsoft Office\Office16\EXCEL.EXE', 'Microsoft Office\Office16\MSACCESS.EXE', 'DBeaver\dbeaver.exe') {
        $appPath = Join-Path $programRoot $relative
        if (Test-Path -LiteralPath $appPath) { $appEvidence += Get-FileEvidence $appPath }
    }
}
$apps = @(Get-ChildItem -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    Get-ItemProperty | Where-Object DisplayName -match 'Office|Excel|Access|DBeaver|ODBC|DataGrip' |
    Select-Object DisplayName, DisplayVersion, InstallLocation)
$os = Get-CimInstance Win32_OperatingSystem
$report = [ordered]@{
    schemaVersion = 1
    capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
    computer = $env:COMPUTERNAME
    os = [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture }
    powershell = $PSVersionTable.PSVersion.ToString()
    tools = @((Get-CommandEvidence 'cmake' @('--version')), (Get-CommandEvidence 'ctest' @('--version')), (Get-CommandEvidence 'node' @('--version')))
    visualStudio = $visualStudio
    sdks = $sdks
    managers = @('System32', 'SysWOW64') | ForEach-Object {
        Get-FileEvidence (Join-Path $env:windir "$_\odbc32.dll")
        Get-FileEvidence (Join-Path $env:windir "$_\odbcad32.exe")
    }
    applicationExecutables = @($appEvidence | Sort-Object path -Unique)
    applicationRegistrations = $apps
    odbcDrivers = @(Get-OdbcDriver | Select-Object Name, Platform)
}
$reportPath = Join-Path $outputDir 'environment.json'
[IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
Write-Output "환경 조회 완료: $reportPath"
