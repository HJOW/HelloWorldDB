# 기본 통과 행렬과 분리한 Windows Manager 공유 DESC 해제 회귀 재현이다.
[CmdletBinding()]
param([ValidateSet('x64-debug','x64-release','x86-debug','x86-release')][string] $Preset = 'x64-debug')
$ErrorActionPreference = 'Stop'
$projectDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$evidenceDir = Join-Path $projectDir 'build\native'
[void][IO.Directory]::CreateDirectory($evidenceDir)
$previous = $env:HWDB_DESC_FREE_REGRESSION
Push-Location -LiteralPath $projectDir
try {
    $env:HWDB_DESC_FREE_REGRESSION = '1'
    $ErrorActionPreference = 'Continue'
    $lines = @(& ctest --preset $Preset -R integration.protocol_manager --output-on-failure 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    [IO.File]::WriteAllLines((Join-Path $evidenceDir "shared-descriptor-free-$Preset.log"),$lines,(New-Object Text.UTF8Encoding($false)))
    $lines | Write-Output
} finally {
    $env:HWDB_DESC_FREE_REGRESSION = $previous
    Pop-Location
}
# 재현 실패를 성공 집계로 바꾸지 않고 CTest의 종료 코드를 보존한다.
exit $code
