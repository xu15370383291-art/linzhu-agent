using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// This helper is deliberately small and has no dependency on the Agent data
// model. The Node host sends one bounded JSON request and receives one bounded
// JSON result. The child command runs under a restricted, low-integrity token
// inside a kill-on-close Job Object.
class WindowsWorker {
    const uint DISABLE_MAX_PRIVILEGE = 1;
    const uint TOKEN_QUERY = 0x0008;
    const uint TOKEN_DUPLICATE = 0x0002;
    const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    const uint TOKEN_ADJUST_SESSIONID = 0x0100;
    const uint TOKEN_ALL = 0x000F01FF;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint HANDLE_FLAG_INHERIT = 1;
    const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 8;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint JobObjectExtendedLimitInformation = 9;
    const uint TokenIntegrityLevel = 25;
    const uint TokenHasRestrictionsInfo = 21;
    const uint TokenPrivileges = 3;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 0x102;

    [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int Length; public IntPtr SecurityDescriptor; public int InheritHandle; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO { public int cb; public string Reserved; public string Desktop; public string Title; public int X; public int Y; public int XSize; public int YSize; public int XCountChars; public int YCountChars; public int FillAttribute; public int Flags; public short ShowWindow; public short Reserved2; public IntPtr Reserved3; public IntPtr StdInput; public IntPtr StdOutput; public IntPtr StdError; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr Process; public IntPtr Thread; public int ProcessId; public int ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }

    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, uint type, IntPtr information, uint length, out uint returned);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CheckTokenMembership(IntPtr token, IntPtr sidToCheck, out bool isMember);
    [DllImport("advapi32.dll", SetLastError=true)] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableSidCount, IntPtr sidsToDisable, uint deletePrivilegeCount, IntPtr privilegesToDelete, uint restrictSidCount, IntPtr sidsToRestrict, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, uint type, IntPtr information, uint length);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSidToSid(string sid, out IntPtr sidPtr);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LocalFree(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, uint infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION information);

    static void Close(IntPtr value) { if (value != IntPtr.Zero && value != new IntPtr(-1)) CloseHandle(value); }
    static void Ensure(bool ok, string message) { if (!ok) throw new Exception(message + " (Windows error " + Marshal.GetLastWin32Error() + ")"); }
    static bool TokenHasRestrictions(IntPtr token, out bool lowIntegrity) {
        lowIntegrity = false;
        uint returned; IntPtr restricted = Marshal.AllocHGlobal(4); try {
                bool hasRestrictedSids = GetTokenInformation(token, TokenHasRestrictionsInfo, restricted, 4, out returned) && Marshal.ReadInt32(restricted) != 0;
                IntPtr privileges = Marshal.AllocHGlobal(4096); bool noPrivileges = false; try {
                    noPrivileges = GetTokenInformation(token, TokenPrivileges, privileges, 4096, out returned) && Marshal.ReadInt32(privileges) == 0;
                } finally { Marshal.FreeHGlobal(privileges); }
                IntPtr adminSid; bool isAdmin = false; if (ConvertStringSidToSid("S-1-5-32-544", out adminSid)) { try { CheckTokenMembership(token, adminSid, out isAdmin); } finally { LocalFree(adminSid); } }
                if (!hasRestrictedSids && (!noPrivileges || isAdmin)) return false;
            } finally { Marshal.FreeHGlobal(restricted); }
            IntPtr label = Marshal.AllocHGlobal(512); try {
                if (!GetTokenInformation(token, TokenIntegrityLevel, label, 512, out returned)) return false;
                IntPtr sid = Marshal.ReadIntPtr(label);
                IntPtr count = GetSidSubAuthorityCount(sid); if (count == IntPtr.Zero) return false;
                byte subCount = Marshal.ReadByte(count); if (subCount == 0) return false;
                IntPtr authority = GetSidSubAuthority(sid, (uint)(subCount - 1)); if (authority == IntPtr.Zero) return false;
                uint level = (uint)Marshal.ReadInt32(authority); lowIntegrity = level >= 4096 && level < 8192; return lowIntegrity;
            } finally { Marshal.FreeHGlobal(label); }
        
    }
    static bool ChildHasRestrictions(IntPtr process, out bool lowIntegrity) {
        IntPtr token; if (!OpenProcessToken(process, TOKEN_QUERY, out token)) { lowIntegrity = false; return false; }
        bool result = TokenHasRestrictions(token, out lowIntegrity); Close(token); return result;
    }
    static string CleanCommand(string command) {
        if (String.IsNullOrWhiteSpace(command) || command.Length > 256) throw new Exception("Worker command is invalid");
        if (command.IndexOfAny(new[] { '\0', '\r', '\n', '"', '&', '|', '<', '>', '`' }) >= 0) throw new Exception("Worker command contains a forbidden character");
        string lower = command.ToLowerInvariant();
        string[] forbidden = { "del ", "erase ", "copy ", "move ", "rename ", "mkdir", "rmdir", "format", "powershell", "pwsh", "start-process", "invoke-webrequest", "curl ", "wget " };
        foreach (string word in forbidden) if (lower.Contains(word)) throw new Exception("Worker command is not read-only");
        return command;
    }
    static IntPtr RestrictedToken(out bool lowIntegrity) {
        IntPtr current, restricted, sid = IntPtr.Zero, disabledSid = IntPtr.Zero, disabledBuffer = IntPtr.Zero, restrictedSid = IntPtr.Zero, restrictedBuffer = IntPtr.Zero;
        lowIntegrity = false;
        Ensure(OpenProcessToken(Process.GetCurrentProcess().Handle, TOKEN_ALL, out current), "OpenProcessToken failed");
        try {
            Ensure(ConvertStringSidToSid("S-1-5-32-544", out disabledSid), "ConvertStringSidToSid administrators failed");
            SID_AND_ATTRIBUTES disabled = new SID_AND_ATTRIBUTES { Sid = disabledSid, Attributes = 0 };
            int disabledSize = Marshal.SizeOf(disabled); disabledBuffer = Marshal.AllocHGlobal(disabledSize); Marshal.StructureToPtr(disabled, disabledBuffer, false);
            Ensure(CreateRestrictedToken(current, DISABLE_MAX_PRIVILEGE, 1, disabledBuffer, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted), "CreateRestrictedToken failed");
        } finally { Close(current); }
        try {
            Ensure(ConvertStringSidToSid("S-1-16-4096", out sid), "ConvertStringSidToSid failed");
            SID_AND_ATTRIBUTES label = new SID_AND_ATTRIBUTES { Sid = sid, Attributes = 0x20 };
            int labelSize = Marshal.SizeOf(label); IntPtr buffer = Marshal.AllocHGlobal(labelSize);
            try { Marshal.StructureToPtr(label, buffer, false); Ensure(SetTokenInformation(restricted, TokenIntegrityLevel, buffer, (uint)labelSize), "SetTokenInformation failed"); lowIntegrity = true; }
            finally { Marshal.FreeHGlobal(buffer); }
        } finally { if (sid != IntPtr.Zero) LocalFree(sid); if (disabledSid != IntPtr.Zero) LocalFree(disabledSid); if (disabledBuffer != IntPtr.Zero) Marshal.FreeHGlobal(disabledBuffer); }
        return restricted;
    }
    static Dictionary<string, object> RunCommand(string command, int timeoutMs) {
        command = CleanCommand(command);
        bool low; IntPtr token = RestrictedToken(out low), job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try {
            bool tokenLow; bool tokenRestricted = TokenHasRestrictions(token, out tokenLow); if (!tokenRestricted || !tokenLow) throw new Exception("Restricted token verification failed before process creation");
            job = CreateJobObject(IntPtr.Zero, null); Ensure(job != IntPtr.Zero, "CreateJobObject failed");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; limits.BasicLimitInformation.ActiveProcessLimit = 1;
            int size = Marshal.SizeOf(limits); IntPtr limitPtr = Marshal.AllocHGlobal(size); try { Marshal.StructureToPtr(limits, limitPtr, false); Ensure(SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitPtr, (uint)size), "SetInformationJobObject failed"); } finally { Marshal.FreeHGlobal(limitPtr); }
            SECURITY_ATTRIBUTES attributes = new SECURITY_ATTRIBUTES(); attributes.Length = Marshal.SizeOf(attributes); attributes.InheritHandle = 1;
            Ensure(CreatePipe(out outRead, out outWrite, ref attributes, 0), "CreatePipe stdout failed"); Ensure(CreatePipe(out errRead, out errWrite, ref attributes, 0), "CreatePipe stderr failed");
            Ensure(SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0), "SetHandleInformation stdout failed"); Ensure(SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0), "SetHandleInformation stderr failed");
            STARTUPINFO startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(startup); startup.Flags = (int)STARTF_USESTDHANDLES; startup.StdInput = IntPtr.Zero; startup.StdOutput = outWrite; startup.StdError = errWrite;
            string application = Environment.SystemDirectory + "\\cmd.exe"; StringBuilder commandLine = new StringBuilder("cmd.exe /d /s /c \"" + command + "\"");
            Ensure(CreateProcessAsUser(token, application, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW, IntPtr.Zero, Path.GetTempPath(), ref startup, out pi), "CreateProcessAsUser failed");
            Close(outWrite); outWrite = IntPtr.Zero; Close(errWrite); errWrite = IntPtr.Zero;
            Ensure(AssignProcessToJobObject(job, pi.Process), "AssignProcessToJobObject failed");
            StringBuilder output = new StringBuilder(), error = new StringBuilder();
            Thread outputThread = new Thread(() => ReadPipe(outRead, output)); Thread errorThread = new Thread(() => ReadPipe(errRead, error)); outputThread.Start(); errorThread.Start();
            uint wait = WaitForSingleObject(pi.Process, (uint)Math.Min(600000, Math.Max(1000, timeoutMs)));
            bool timedOut = wait == WAIT_TIMEOUT; if (timedOut) TerminateJobObject(job, 124);
            if (timedOut) WaitForSingleObject(pi.Process, 2000);
            outputThread.Join(2000); errorThread.Join(2000);
            uint exit; GetExitCodeProcess(pi.Process, out exit); bool childLow; bool childRestricted = ChildHasRestrictions(pi.Process, out childLow);
            return new Dictionary<string, object> { { "ok", !timedOut && exit == 0 && childRestricted && childLow }, { "exitCode", (int)exit }, { "stdout", Trim(output.ToString()) }, { "stderr", Trim(error.ToString()) }, { "restrictedToken", childRestricted }, { "lowIntegrity", childLow }, { "jobObject", true }, { "timedOut", timedOut } };
        } finally { Close(outRead); Close(outWrite); Close(errRead); Close(errWrite); Close(pi.Thread); Close(pi.Process); Close(token); Close(job); }
    }
    static void ReadPipe(IntPtr handle, StringBuilder target) { try { using (FileStream stream = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(handle, true), FileAccess.Read)) { byte[] buffer = new byte[8192]; int count; int total = 0; while ((count = stream.Read(buffer, 0, buffer.Length)) > 0 && total < 65536) { int take = Math.Min(count, 65536 - total); target.Append(Encoding.UTF8.GetString(buffer, 0, take)); total += take; } } } catch { } }
    static string Trim(string value) { return value.Length <= 65536 ? value : value.Substring(0, 65536); }
    static Dictionary<string, object> Handle(Dictionary<string, object> request) {
        object value; if (!request.TryGetValue("operation", out value) || !(value is string)) throw new Exception("Worker operation is required");
        string operation = (string)value;
        if (operation == "probe") return RunCommand("ver", 5000);
        if (operation != "readonly-command") throw new Exception("Worker operation is not allowed");
        object commandValue; if (!request.TryGetValue("command", out commandValue) || !(commandValue is string)) throw new Exception("Worker command is required");
        int timeout = 15000; object timeoutValue; if (request.TryGetValue("timeoutMs", out timeoutValue)) timeout = Convert.ToInt32(timeoutValue);
        return RunCommand((string)commandValue, timeout);
    }
    static int Main() {
        JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 200000;
        try { Dictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd()); Dictionary<string, object> result = Handle(request); Console.WriteLine(serializer.Serialize(result)); return 0; }
        catch (Exception error) { Console.WriteLine(serializer.Serialize(new Dictionary<string, object> { { "ok", false }, { "code", "WORKER_FAILED" }, { "message", error.Message } })); return 1; }
    }
}
