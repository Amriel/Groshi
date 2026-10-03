# Кладе приватний ключ підпису в секрет GitHub, жодного разу його не показуючи.
#
# Потрібен один раз. Після цього збірку, підпис і публікацію робить CI за
# теґом, і людині не лишається ручних кроків. Доти кожен випуск вимагав
# підпису на тому самому компʼютері, де колись створили ключ, — а коли той
# ключ зник, випуски спинились зовсім (реальний випадок: 1.32.3 зібрана,
# протестована, але не опублікована).
#
# Значення ключа йде в gh через stdin: ні в командний рядок, ні в журнал
# PowerShell, ні на екран воно не потрапляє.
param([string]$Repo = 'Amriel/Groshi')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$keyFile = Join-Path $env:LOCALAPPDATA 'Groshi\signing-key.dpapi'
if (-not (Test-Path -LiteralPath $keyFile)) {
    throw "Ключа підпису немає ($keyFile). Спершу: scripts\manage-signing-key.ps1 -Action Init"
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'Потрібен GitHub CLI (gh) з виконаним gh auth login.'
}

$encrypted = [IO.File]::ReadAllBytes($keyFile)
$plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
try {
    [Text.Encoding]::UTF8.GetString($plain) | & gh secret set GROSHI_SIGNING_KEY --repo $Repo
    if ($LASTEXITCODE -ne 0) { throw 'gh secret set не завершився успішно.' }
    Write-Output "Секрет GROSHI_SIGNING_KEY оновлено в $Repo. Тепер релізи підписує CI."
} finally {
    [Array]::Clear($plain, 0, $plain.Length)
}
