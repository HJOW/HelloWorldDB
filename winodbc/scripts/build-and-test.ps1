# 두 아키텍처의 Debug/Release를 빌드하고 ABI 증거를 프로젝트 안에 남긴다.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceDir = Join-Path $projectDir 'build\native'
[void][IO.Directory]::CreateDirectory($evidenceDir)
$summaryPath = Join-Path $evidenceDir 'summary.json'
[IO.File]::WriteAllText($summaryPath,
    (@{ status = 'running'; capturedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json),
    (New-Object Text.UTF8Encoding($false)))

function Invoke-Checked([string] $Executable, [string[]] $Arguments, [string] $LogName, [switch] $Quiet) {
    # Windows PowerShell 5.1의 stderr ErrorRecord가 종료 코드/로그 수집을 중단하지 않게 한다.
    $nativePreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& $Executable @Arguments 2>&1 | ForEach-Object { "$_" })
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $nativePreference }
    [IO.File]::WriteAllLines((Join-Path $evidenceDir $LogName), $lines, (New-Object Text.UTF8Encoding($false)))
    if (-not $Quiet) { $lines | Write-Output }
    if ($code -ne 0) { throw "$Executable failed: exit $code ($LogName)" }
}

Push-Location -LiteralPath $projectDir
try {
    & (Join-Path $PSScriptRoot 'inspect-environment.ps1')
    Invoke-Checked 'node' @('--test', '--test-reporter=tap', 'tests/wo0.test.mjs') 'wo0.log'
    $environment = Get-Content -LiteralPath (Join-Path $projectDir 'build\wo0\environment.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    $dumpbin = @($environment.visualStudio | ForEach-Object { $_.toolchains } |
        ForEach-Object { $_.architectures } | Where-Object { $_.target -eq 'x64' -and $_.dumpbin.exists })[0].dumpbin.path
    if (-not $dumpbin) { throw 'dumpbin was not found in the current host evidence.' }

    $ctestPassed = 0
    foreach ($arch in 'x64', 'x86') {
        Invoke-Checked 'cmake' @('--preset', $arch) "$arch-configure.log"
        foreach ($config in 'Debug', 'Release') {
            $preset = "$arch-$($config.ToLowerInvariant())"
            Invoke-Checked 'cmake' @('--build', '--preset', $preset) "$preset-build.log"
            Invoke-Checked 'ctest' @('--preset', $preset, '--verbose', '--output-junit', (Join-Path $evidenceDir "$preset-ctest.xml")) "$preset-ctest.log"
            [xml] $testResults = Get-Content -LiteralPath (Join-Path $evidenceDir "$preset-ctest.xml") -Encoding UTF8 -Raw
            if ([int]$testResults.testsuite.failures -ne 0 -or [int]$testResults.testsuite.skipped -ne 0) {
                throw "Unexpected CTest failures/skips: $preset"
            }
            $ctestPassed += [int]$testResults.testsuite.tests
            $binaryDir = Join-Path $projectDir "build\$arch\bin\$config"
            foreach ($binary in 'hwdbodbc.dll', 'hwdb_abi_probe.exe', 'hwdb_dm_probe.exe', 'hwdb_boundary_test.exe') {
                Invoke-Checked $dumpbin @('/headers', '/exports', '/dependents', (Join-Path $binaryDir $binary)) "$preset-$binary-pe.log" -Quiet
            }
        }
    }
    # 같은 구성의 반대 비트 수 DLL을 양방향으로 검사한다. 등록과 DSN 변경은 없다.
    $mismatchPassed = 0
    foreach ($arch in 'x64', 'x86') {
        $other = if ($arch -eq 'x64') { 'x86' } else { 'x64' }
        foreach ($config in 'Debug', 'Release') {
            $probe = Join-Path $projectDir "build\$arch\bin\$config\hwdb_abi_probe.exe"
            $dll = Join-Path $projectDir "build\$other\bin\$config\hwdbodbc.dll"
            Invoke-Checked $probe @('reject', $dll) "$arch-$config-mismatch.log"
            $mismatchPassed++
        }
    }
    Invoke-Checked 'node' @('--test', '--test-reporter=tap', 'tests/wo1.test.mjs') 'pe-audit.log'
    $report = [ordered]@{
        status = 'passed'
        computer = $environment.computer
        os = $environment.os
        capturedAt = [DateTimeOffset]::UtcNow.ToString('o')
        configurations = @('x64-debug', 'x64-release', 'x86-debug', 'x86-release')
        ctestPassed = $ctestPassed
        mismatchPassed = $mismatchPassed
        peAuditPassed = [int]((Get-Content -LiteralPath (Join-Path $evidenceDir 'pe-audit.log') -Encoding UTF8 | Select-String '^# pass (\d+)$').Matches.Groups[1].Value)
        wo0Passed = [int]((Get-Content -LiteralPath (Join-Path $evidenceDir 'wo0.log') -Encoding UTF8 | Select-String '^# pass (\d+)$').Matches.Groups[1].Value)
        failed = 0
        skipped = 0
        serverRuntime = @($environment.tools | Where-Object name -eq 'node')[0].output
        driverRegistered = $false
        driverManagerRegistry = 'process-private HKLM mapping under HKCU; removed after test'
    }
    [IO.File]::WriteAllText($summaryPath,
        ($report | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
} catch {
    [IO.File]::WriteAllText($summaryPath,
        (@{ status = 'failed'; capturedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json),
        (New-Object Text.UTF8Encoding($false)))
    throw
} finally { Pop-Location }
