param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Url,

  [ValidateSet("Edge", "Chrome")]
  [string]$Browser = "Edge",

  [string]$UserDataDirectory = (Join-Path $env:LOCALAPPDATA "SmartPOS\KioskProfile")
)

$parsedUrl = $null
$isValidUrl = [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsedUrl)
if (-not $isValidUrl -or
  $parsedUrl.Scheme -notin @("http", "https") -or
  $Url.Contains('"')) {
  throw "Url must be an absolute HTTP or HTTPS address without quotation marks."
}

$browserCandidates = if ($Browser -eq "Edge") {
  @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
} else {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
}

$browserPath = $browserCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browserPath) {
  throw "$Browser was not found. Install it or select another browser."
}

if (-not (Test-Path $UserDataDirectory)) {
  New-Item -ItemType Directory -Path $UserDataDirectory -Force | Out-Null
}

$browserArguments = @(
  "--user-data-dir=`"$UserDataDirectory`""
  "--kiosk-printing"
  "--kiosk"
  "`"$Url`""
)
if ($Browser -eq "Edge") {
  $browserArguments += "--edge-kiosk-type=fullscreen"
}

Start-Process -FilePath $browserPath -ArgumentList $browserArguments
