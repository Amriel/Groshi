param(
    [ValidateSet('Init', 'Sign')][string]$Action = 'Init',
    [string]$Installer
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$repoRoot = Split-Path -Parent $PSScriptRoot
$keyDirectory = Join-Path $env:LOCALAPPDATA 'Groshi'
$keyFile = Join-Path $keyDirectory 'signing-key.dpapi'
$publicFile = Join-Path $repoRoot 'desktop/src-tauri/update-key.pub'
$previousKey = $env:GROSHI_SIGNING_KEY
try {
    if (Test-Path -LiteralPath $keyFile) {
        $encrypted = [IO.File]::ReadAllBytes($keyFile)
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $env:GROSHI_SIGNING_KEY = [Text.Encoding]::UTF8.GetString($plain)
        [Array]::Clear($plain, 0, $plain.Length)
    } elseif ($Action -eq 'Init') {
        # Приватний ключ передається між локальними процесами й одразу
        # шифрується для поточного користувача Windows; у Git і логи не йде.
        $generated = 'const c=require("node:crypto");const p=c.generateKeyPairSync("ed25519");process.stdout.write(p.privateKey.export({format:"der",type:"pkcs8"}).toString("base64"));' | & node
        if ($LASTEXITCODE -ne 0) { throw 'Не вдалося створити ключ підпису.' }
        $env:GROSHI_SIGNING_KEY = $generated
        $plain = [Text.Encoding]::UTF8.GetBytes($generated)
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null
        [IO.File]::WriteAllBytes($keyFile, $encrypted)
        [Array]::Clear($plain, 0, $plain.Length)
        $generated = $null
    } else { throw 'Ключ підпису не створено. Спочатку запустіть цей скрипт із -Action Init.' }

    $publicKey = 'const c=require("node:crypto");const k=c.createPrivateKey({key:Buffer.from(process.env.GROSHI_SIGNING_KEY,"base64"),format:"der",type:"pkcs8"});process.stdout.write(c.createPublicKey(k).export({format:"der",type:"spki"}).subarray(-32).toString("hex"));' | & node
    if ($LASTEXITCODE -ne 0 -or $publicKey -notmatch '^[0-9a-f]{64}$') { throw 'Не вдалося перевірити публічний ключ.' }
    if (Test-Path -LiteralPath $publicFile) {
        if ([IO.File]::ReadAllText($publicFile).Trim() -ne $publicKey) {
            throw 'Публічний ключ репозиторію належить іншому ключу підпису. Автоматична заміна заборонена.'
        }
    } else { [IO.File]::WriteAllText($publicFile, $publicKey + [Environment]::NewLine) }
    if ($Action -eq 'Sign') {
        if (-not $Installer) { throw 'Потрібен шлях -Installer до готового інсталятора.' }
        & node (Join-Path $repoRoot 'scripts/sign-update.cjs') $Installer --public-key $publicFile
        if ($LASTEXITCODE -ne 0) { throw 'Підписування не завершилося.' }
    } else { Write-Output 'Ключ підпису захищений Windows; у репозиторії збережено лише публічний ключ.' }
} finally { $env:GROSHI_SIGNING_KEY = $previousKey }
