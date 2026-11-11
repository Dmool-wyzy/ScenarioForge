$ErrorActionPreference = 'Stop'
# This fixed helper treats the approved command as JSON data. No command text is
# evaluated by PowerShell. Joining a kill-on-close job before starting the target
# makes even children left behind by an exited parent part of that job.
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ScenarioForgeCommandJob {
  [StructLayout(LayoutKind.Sequential)] public struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
}
'@
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SCENARIOFORGE_LOCAL_COMMAND)) | ConvertFrom-Json
  $job = [ScenarioForgeCommandJob]::CreateJobObject([IntPtr]::Zero, $null)
  if ($job -eq [IntPtr]::Zero) { throw 'Cannot create command job.' }
  $limits = New-Object ScenarioForgeCommandJob+ExtendedLimits
  $limits.Basic.LimitFlags = 0x2000 # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (-not [ScenarioForgeCommandJob]::SetInformationJobObject($job, 9, [ref]$limits, [Runtime.InteropServices.Marshal]::SizeOf($limits))) { throw 'Cannot configure command job.' }
  if (-not [ScenarioForgeCommandJob]::AssignProcessToJobObject($job, [Diagnostics.Process]::GetCurrentProcess().Handle)) { throw 'Cannot join command job.' }
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = [string]$payload.executable
  $info.Arguments = [string]$payload.arguments
  $info.WorkingDirectory = [string]$payload.directory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables.Remove('SCENARIOFORGE_LOCAL_COMMAND')
  $target = New-Object Diagnostics.Process
  $target.StartInfo = $info
  if (-not $target.Start()) { throw 'Cannot start approved command.' }
  $stdout = $target.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $stderr = $target.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $target.WaitForExit()
  # A surviving child may keep the pipe open. Never wait indefinitely for that
  # pipe: process exit closes our last job handle and terminates all job members.
  [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), 250) | Out-Null
  [Environment]::Exit($target.ExitCode)
} catch {
  # Do not echo argument JSON or exception bodies that may contain local paths.
  [Console]::Error.WriteLine('ScenarioForge could not establish or start the Windows command job; no uncontained fallback was used.')
  [Environment]::Exit(125)
}
