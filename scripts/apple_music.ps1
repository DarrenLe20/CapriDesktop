# Apple Music for Windows, driven from outside for Capri. Every action prints one JSON line.
#   status                          what's playing, from the Windows media session
#   control -Command play|pause|toggle|next|prev [-AppleOnly]
#   play_track -TitleB64 <base64>   plays that song from its album page, already open in the app
#   installed                       whether the app is there, and the id that launches it
# Play, pause and skip go to Apple Music first and to whatever else is playing otherwise.
param(
    [string]$Action = "status",
    [string]$Command = "toggle",
    [string]$TitleB64 = "",
    [int]$TimeoutSec = 0,
    [switch]$Single,
    [switch]$AppleOnly
)

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Write-Result($data) {
    [Console]::Out.WriteLine((New-Object PSObject -Property $data | ConvertTo-Json -Compress))
}

# Windows media session (WinRT)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$script:AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

function Await($op, [Type]$type) {
    $task = $script:AsTask.MakeGenericMethod($type).Invoke($null, @($op))
    if (-not $task.Wait(5000)) { throw "media session timeout" }
    $task.Result
}

function Get-Manager {
    Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}

function Test-AppleMusic($session) { [bool]($session -and $session.SourceAppUserModelId -like 'AppleInc.AppleMusicWin*') }
function Test-Playing($session) { [bool]($session -and [string]$session.GetPlaybackInfo().PlaybackStatus -eq 'Playing') }

# Apple Music only has a session after its first song since it opened
function Get-AppleSession($mgr) {
    foreach ($s in $mgr.GetSessions()) { if (Test-AppleMusic $s) { return $s } }
    $null
}

# Apple Music while it plays, then whatever plays, then Apple Music, then what Windows calls current
function Select-Session($mgr, [bool]$forPlay) {
    $apple = Get-AppleSession $mgr
    if (Test-Playing $apple) { return $apple }
    if (-not $forPlay) {
        foreach ($s in $mgr.GetSessions()) { if (Test-Playing $s) { return $s } }
    }
    if ($apple) { return $apple }
    $mgr.GetCurrentSession()
}

function Get-AppName([string]$source) {
    if ($source -like 'AppleInc.AppleMusicWin*') { return 'Apple Music' }
    $name = ($source -split '!')[0] -replace '_[a-z0-9]{13}$', '' -replace '\.exe$', ''
    ($name -split '\.')[-1]
}

function Read-Session($session) {
    if (-not $session) { return @{ app = ''; source = ''; status = 'None'; artist = ''; album = ''; title = '' } }
    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $source = [string]$session.SourceAppUserModelId
    $artist = [string]$props.Artist
    $album = [string]$props.AlbumTitle
    # Apple Music puts "Artist - Album" in the artist
    if (-not $album -and (Test-AppleMusic $session) -and $artist -match '^(.+?)\s[-\u2013\u2014]\s(.+)$') {
        $artist = $Matches[1]
        $album = $Matches[2]
    }
    $status = switch ([string]$session.GetPlaybackInfo().PlaybackStatus) {
        'Playing' { 'Playing' }
        'Paused' { 'Paused' }
        default { 'Stopped' }
    }
    @{ app = (Get-AppName $source); source = $source; status = $status; artist = $artist; album = $album; title = [string]$props.Title }
}

# The Apple Music window (UI Automation)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Descendants = [System.Windows.Automation.TreeScope]::Descendants
$InvokeId = [System.Windows.Automation.InvokePattern]::Pattern

function Find-AppleWindow {
    $proc = Get-Process AppleMusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($proc) { $AE::FromHandle($proc.MainWindowHandle) } else { $null }
}

function Find-ById($root, [string]$id) {
    $root.FindFirst($Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $id)))
}

function Invoke-Element($element) {
    if (-not $element) { return $false }
    try { $element.GetCurrentPattern($InvokeId).Invoke(); $true } catch { $false }
}

# Its own play button: the only way to start it before it has a media session. Right after
# opening the app, its window takes a while: waits up to TimeoutSec for it
function Invoke-TransportButton([int]$waitSec) {
    $deadline = (Get-Date).AddSeconds($waitSec)
    do {
        $root = Find-AppleWindow
        if ($root -and (Invoke-Element (Find-ById $root 'TransportControl_PlayPauseStop'))) { return $true }
        if ((Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 700 }
    } while ((Get-Date) -lt $deadline)
    $false
}

Add-Type -Namespace CapriMedia -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);'

function Send-Key([byte]$vk) {
    [CapriMedia.Keys]::keybd_event($vk, 0, 1, [UIntPtr]::Zero)
    [CapriMedia.Keys]::keybd_event($vk, 0, 3, [UIntPtr]::Zero)
}

# Lowercase words only: "Harder, Better..." and "Harder Better..." are the same song
function Get-Plain([string]$text) { ($text.ToLowerInvariant() -replace '[^\p{L}\p{Nd}]+', ' ').Trim() }

# What the media session says against the song asked for. "Song (feat. X)" is still "Song",
# but plain "Nightcall" is not "Nightcall (Remix)"
function Test-SameTitle([string]$title, [string]$wanted) {
    $plain = Get-Plain $title
    [bool]($plain -and ($plain -eq $wanted -or (" $plain ").Contains(" $wanted ")))
}

# Rows read "Track 4 Harder Better Faster Stronger 3 minutes, 45 seconds"
function Find-TrackRow($root, [string[]]$wanted) {
    $isRow = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
    $rows = @($root.FindAll($Descendants, $isRow) | Where-Object { [string]$_.Current.Name -match '^\S+\s+\d+\s+\S' })
    foreach ($w in $wanted) {
        $partial = $null
        foreach ($row in $rows) {
            $rest = [string]$row.Current.Name -replace '^\S+\s+\d+\s+', ''
            $core = Get-Plain ($rest -replace '(?:,?\s+\d+\s+\p{L}+){1,3}\s*$', '')
            if ($core -eq $w) { return $row }
            if (-not $partial -and (" $(Get-Plain $rest) ").Contains(" $w ")) { $partial = $row }
        }
        if ($partial) { return $partial }
    }
    $null
}

# Its menu is a popup outside the main window, in a window of the same process
function Find-PlayMenuItem($root) {
    $isItem = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
    $isPlay = { [string]$_.Current.Name -match '^Play\s+[\u201C\u2018"'']' }
    $item = $root.FindAll($Descendants, $isItem) | Where-Object -FilterScript $isPlay | Select-Object -First 1
    if ($item) { return $item }
    $sameApp = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $root.Current.ProcessId)
    foreach ($window in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $sameApp)) {
        $item = $window.FindAll($Descendants, $isItem) | Where-Object -FilterScript $isPlay | Select-Object -First 1
        if ($item) { return $item }
    }
    $null
}

function Invoke-PlayFromMenu($root, $row) {
    $more = $row.FindFirst($Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'More')))
    if (-not $more) {
        $more = $row.FindFirst($Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
    }
    if (-not (Invoke-Element $more)) { return $false }
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 250
        $item = Find-PlayMenuItem $root
        if ($item) { return (Invoke-Element $item) }
    }
    # No menu left open on her way out
    Send-Key 0x1B
    $false
}

function Invoke-PlayTrack {
    $title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleB64))
    # "Song (Remastered)" or "Song - Live" may show up with the extra bit cut
    $short = $title -replace '\s*[\(\[][^\)\]]*[\)\]]', '' -replace '\s+-\s+.*$', ''
    $wanted = @(@((Get-Plain $title), (Get-Plain $short)) | Where-Object { $_ } | Select-Object -Unique)
    if (-not $wanted) { return @{ ok = $false; title = $title; artist = ''; reason = 'no_title' } }

    $mgr = Get-Manager
    $now = Read-Session (Get-AppleSession $mgr)
    if ($now.status -eq 'Playing' -and (Test-SameTitle $now.title $wanted[0])) {
        return @{ ok = $true; title = $now.title; artist = $now.artist; reason = 'already_playing' }
    }

    # The page takes a few seconds to load, longer when the app had to start
    $deadline = (Get-Date).AddSeconds($(if ($TimeoutSec -gt 0) { $TimeoutSec } else { 12 }))
    $root = $null
    $row = $null
    while (-not $row -and (Get-Date) -lt $deadline) {
        $root = Find-AppleWindow
        if ($root) { $row = Find-TrackRow $root $wanted }
        if (-not $row) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $row) { return @{ ok = $false; title = $title; artist = ''; reason = 'track_not_on_page' } }

    try { $row.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch {}
    $started = Invoke-PlayFromMenu $root $row
    # A single's page has one song: its big play button plays just that
    if (-not $started -and $Single) { $started = Invoke-Element (Find-ById $root 'PlayButtonElement') }
    if (-not $started) { return @{ ok = $false; title = $title; artist = ''; reason = 'play_menu_not_found' } }

    $until = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $until) {
        Start-Sleep -Milliseconds 700
        $info = Read-Session (Get-AppleSession $mgr)
        if ($info.status -eq 'Playing' -and (Test-SameTitle $info.title $wanted[0])) {
            return @{ ok = $true; title = $info.title; artist = $info.artist; reason = '' }
        }
    }
    @{ ok = $false; title = $title; artist = ''; reason = 'not_confirmed' }
}

function Invoke-Control([string]$cmd) {
    $mgr = Get-Manager
    # AppleOnly: "open Apple Music" resumes Apple Music even when a video has the media session
    $session = if ($AppleOnly) { Get-AppleSession $mgr } else { Select-Session $mgr ($cmd -eq 'play' -or $cmd -eq 'toggle') }
    if ($session) {
        $op = switch ($cmd) {
            'play' { $session.TryPlayAsync() }
            'pause' { $session.TryPauseAsync() }
            'next' { $session.TrySkipNextAsync() }
            'prev' { $session.TrySkipPreviousAsync() }
            default { $session.TryTogglePlayPauseAsync() }
        }
        if (Await $op ([bool])) { return @{ ok = $true; app = (Get-AppName ([string]$session.SourceAppUserModelId)); method = 'session' } }
    }
    if ($cmd -eq 'play' -or $cmd -eq 'toggle') {
        if (Invoke-TransportButton $TimeoutSec) { return @{ ok = $true; app = 'Apple Music'; method = 'button' } }
    }
    # Nothing has a session: a play/pause key would start something instead of pausing it
    if ($cmd -eq 'pause' -and -not $session) { return @{ ok = $true; app = ''; method = 'none' } }
    $vk = switch ($cmd) { 'next' { 0xB0 } 'prev' { 0xB1 } default { 0xB3 } }
    Send-Key $vk
    @{ ok = $true; app = ''; method = 'keys' }
}

try {
    switch ($Action.ToLower()) {
        'status' { Write-Result (Read-Session (Select-Session (Get-Manager) $false)) }
        'control' { Write-Result (Invoke-Control $Command.ToLower()) }
        'play_track' { Write-Result (Invoke-PlayTrack) }
        'installed' {
            $pkg = Get-AppxPackage -Name 'AppleInc.AppleMusicWin' -ErrorAction SilentlyContinue | Select-Object -First 1
            Write-Result @{ installed = [bool]$pkg; appId = $(if ($pkg) { "$($pkg.PackageFamilyName)!App" } else { '' }) }
        }
        default { Write-Result @{ ok = $false; reason = "unknown action $Action" } }
    }
} catch {
    Write-Result @{ ok = $false; status = 'None'; reason = [string]$_.Exception.Message }
}
