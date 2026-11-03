# Builds the Arc Guard Android app (build\ArcGuard.apk) with the Android SDK command-line tools only
# (no Gradle, no internet). Optional: -Install puts it on the USB-connected phone and sets up
# `adb reverse` so the app can reach the laptop's backend at http://localhost:8000.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1 [-Install]
param([switch]$Install)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr" }
$env:Path = "$env:JAVA_HOME\bin;$env:Path"
$Bt = Get-ChildItem "$Sdk\build-tools" | Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } | Select-Object -Last 1
$Platform = Get-ChildItem "$Sdk\platforms" -Directory | Sort-Object Name | Select-Object -Last 1
$AndroidJar = "$($Platform.FullName)\android.jar"
$Adb = "$Sdk\platform-tools\adb.exe"
Write-Host "build-tools $($Bt.Name), $($Platform.Name), JDK $env:JAVA_HOME"

function Run($exe, [string[]]$argv) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$exe failed ($LASTEXITCODE)" }
}

Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force build\gen, build\classes, build\dex | Out-Null

# 1. resources
Run "$($Bt.FullName)\aapt2.exe" @("compile", "--dir", "res", "-o", "build\res.zip")
Run "$($Bt.FullName)\aapt2.exe" @("link", "-I", $AndroidJar, "--manifest", "AndroidManifest.xml",
  "--java", "build\gen", "--min-sdk-version", "24", "--target-sdk-version", "34",
  "--version-code", "1", "--version-name", "1.0", "-o", "build\unsigned.apk", "build\res.zip")

# 2. Java -> classes -> dex
$sources = Get-ChildItem -Recurse src, build\gen -Filter *.java | ForEach-Object FullName
Run javac (@("--release", "11", "-nowarn", "-Xlint:-options", "-encoding", "UTF-8", "-classpath", $AndroidJar, "-d", "build\classes") + $sources)
$classes = Get-ChildItem -Recurse build\classes -Filter *.class | ForEach-Object FullName
Run "$($Bt.FullName)\d8.bat" (@("--release", "--min-api", "24", "--lib", $AndroidJar, "--output", "build\dex") + $classes)

# 3. add classes.dex, align, sign (debug key)
Push-Location build\dex
Run jar @("uf", "..\unsigned.apk", "classes.dex")
Pop-Location
Run "$($Bt.FullName)\zipalign.exe" @("-f", "-p", "4", "build\unsigned.apk", "build\aligned.apk")
$Ks = "$env:USERPROFILE\.android\debug.keystore"
if (-not (Test-Path $Ks)) {
  New-Item -ItemType Directory -Force (Split-Path $Ks) | Out-Null
  Run keytool @("-genkeypair", "-keystore", $Ks, "-storepass", "android", "-keypass", "android", "-alias", "androiddebugkey",
    "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000", "-dname", "CN=Android Debug,O=Android,C=US")
}
Run "$($Bt.FullName)\apksigner.bat" @("sign", "--ks", $Ks, "--ks-pass", "pass:android", "--key-pass", "pass:android",
  "--out", "build\ArcGuard.apk", "build\aligned.apk")
Write-Host "Built $PSScriptRoot\build\ArcGuard.apk"

if ($Install) {
  Run $Adb @("install", "-r", "build\ArcGuard.apk")
  Run $Adb @("reverse", "tcp:8000", "tcp:8000")
  Run $Adb @("shell", "am", "start", "-n", "com.arcguard.app/.MainActivity")
  Write-Host "Installed and started. In the app use http://localhost:8000 (USB) or http://<laptop-ip>:8000 (Wi-Fi)."
}
