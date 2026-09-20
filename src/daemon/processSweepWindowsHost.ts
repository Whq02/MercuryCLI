export const processSweepWindowsHost = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProcessProbe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server, int id, int info, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static int ConsoleState(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return Marshal.GetLastWin32Error() == 6 ? 0 : -1;
    FreeConsole();
    return 1;
  }
  public static int SessionState(int id) {
    if (id == 0) return 0;
    IntPtr buffer; int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, id, 8, out buffer, out bytes)) return -1;
    try {
      if (bytes < 4) return -1;
      int state = Marshal.ReadInt32(buffer);
      if (state == 0 || state == 1 || state == 3) return 1;
      return state == 4 || state == 6 || state == 7 || state == 8 ? 0 : -1;
    } finally { WTSFreeMemory(buffer); }
  }
  public static string[] Arguments(string command) {
    if (String.IsNullOrEmpty(command)) return null;
    int count; IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) return null;
    try {
      string[] result = new string[count];
      for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
}
'@
function Emit($value) {
  [Console]::WriteLine((ConvertTo-Json -InputObject $value -Depth 12 -Compress))
  [Console]::Out.Flush()
}
function Tri($value) {
  if ($value -eq 1) { return $true }
  if ($value -eq 0) { return $false }
  return $null
}
function Row($process, $full = $true) {
  $sid = $null
  if ($full) {
    try {
      $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
      if ($owner.ReturnValue -eq 0) { $sid = $owner.Sid }
    } catch {}
  }
  $started = $null
  $token = $null
  if ($null -ne $process.CreationDate) {
    $started = ([DateTimeOffset]$process.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
    $token = "$($process.CreationDate)"
  }
  $session = $null
  $connected = $null
  if ($null -ne $process.SessionId) {
    $session = [int]$process.SessionId
    $connected = Tri ([ProcessProbe]::SessionState($session))
  }
  return @{
    pid = [int]$process.ProcessId
    ppid = [int]$process.ParentProcessId
    exe = $process.ExecutablePath
    args = [ProcessProbe]::Arguments($process.CommandLine)
    startedAtMs = $started
    startToken = $token
    user = $sid
    sessionId = $session
    consoleAttached = $(if ($full) { Tri ([ProcessProbe]::ConsoleState($process.ProcessId)) } else { $null })
    sessionConnected = $connected
  }
}
function Wanted($process, $pids) {
  if ($pids.ContainsKey([int]$process.ProcessId)) { return $true }
  $name = [string]$process.Name
  if ($name -notmatch '^(node|bun|mercury)(\.exe)?$') { return $false }
  return ([string]$process.CommandLine) -match '(^|[\\/])mercury(\.mjs|\.cmd|\.exe)?($|[\s"])'
}
function Request() {
  $line = [Console]::ReadLine()
  if ($null -eq $line) { throw 'No request received' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
}
$handle = [IntPtr]::Zero
$stopper = $null
try {
  $request = Request
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ([string]::IsNullOrEmpty($user)) { throw 'The current user identity could not be read' }
  if ($request.op -eq 'table') {
    $pids = @{}
    foreach ($wanted in @($request.pids)) { if ($null -ne $wanted) { $pids[[int]$wanted] = $true } }
    $rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 } | ForEach-Object { Row $_ (Wanted $_ $pids) })
    Emit @{ rows = $rows }
  } elseif ($request.op -eq 'signal') {
    $targetPid = [uint32]$request.pid
    if ($targetPid -eq 0 -or $targetPid -eq $PID) { throw 'Invalid target pid' }
    $owner = [string]$env:MERCURY_DAEMON_OWNER_PID
    if ($owner -ne '' -and [string]$targetPid -eq $owner) { throw 'The target is the owner of the process asking for the stop' }
    $ancestor = [uint32]$PID
    for ($hop = 0; $hop -lt 64 -and $ancestor -ne 0; $hop++) {
      $link = Get-CimInstance Win32_Process -Filter "ProcessId=$ancestor"
      if ($null -eq $link) { break }
      $ancestor = [uint32]$link.ParentProcessId
      if ($ancestor -eq $targetPid) { throw 'The target is an ancestor of the process asking for the stop' }
    }
    $handle = [ProcessProbe]::OpenProcess(0x101000, $false, $targetPid)
    if ($handle -eq [IntPtr]::Zero) { throw ('Cannot open the target process: Win32 error ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    $state = [ProcessProbe]::WaitForSingleObject($handle, 0)
    if ($state -eq 0) { Emit @{ row = $null }; exit 0 }
    if ($state -ne 258) { throw 'Cannot read the target process state' }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid"
    if ($null -eq $process) { throw 'The target process is live but CIM cannot read it' }
    $row = Row $process
    Emit @{ row = $row; user = $user }
    $decision = Request
    if ($decision.go -ne $true) { exit 0 }
    if ([ProcessProbe]::WaitForSingleObject($handle, 0) -eq 0) { Emit @{ sent = $false; reason = 'The process left before the stop' }; exit 0 }
    $again = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid"
    if ($null -eq $again) { Emit @{ sent = $false; reason = 'The process could not be re-read before the stop' }; exit 0 }
    $check = Row $again
    if ($null -eq $check.user -or $check.user -ne $user) { Emit @{ sent = $false; reason = 'The process is not owned by the current user' }; exit 0 }
    if ($check.startToken -ne $row.startToken -or $check.exe -ne $row.exe) { Emit @{ sent = $false; reason = 'The process identity changed before the stop' }; exit 0 }
    if ($check.consoleAttached -ne $false) { Emit @{ sent = $false; reason = 'The console became live or unreadable before the stop' }; exit 0 }
    $info = [System.Diagnostics.ProcessStartInfo]::new("$env:SystemRoot\System32\taskkill.exe")
    $info.Arguments = '/PID ' + [string]$targetPid
    if ($request.force -eq $true) { $info.Arguments += ' /F' }
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $stopper = [System.Diagnostics.Process]::Start($info)
    $out = $stopper.StandardOutput.ReadToEndAsync()
    $err = $stopper.StandardError.ReadToEndAsync()
    if (-not $stopper.WaitForExit(10000)) {
      $stopper.Kill()
      Emit @{ sent = $false; reason = 'The stop command did not finish within its budget and was ended; re-read the process before deciding' }
      exit 0
    }
    Emit @{ sent = ($stopper.ExitCode -eq 0); reason = ($out.Result + $err.Result).Trim() }
  } else { throw 'Unknown process request' }
} catch {
  Emit @{ error = $_.Exception.Message }
  exit 1
} finally {
  if ($null -ne $stopper -and -not $stopper.HasExited) { try { $stopper.Kill() } catch {} }
  if ($handle -ne [IntPtr]::Zero) { [void][ProcessProbe]::CloseHandle($handle) }
}
`
