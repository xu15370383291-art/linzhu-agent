using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Security.Cryptography;

class FileBroker {
    [StructLayout(LayoutKind.Sequential)]
    struct Info {
        public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Modified;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    const uint Read=0x80000000, ReadShare=1, WriteShare=2, Open=3, DirectoryFlag=0x02000000, NoFollow=0x00200000;
    static long total;
    static int count;
    static string mode="full";
    static List<SafeFileHandle> pins = new List<SafeFileHandle>();
    static Dictionary<string, object> metadata = new Dictionary<string, object>();
    static bool Private(string name) {
        string lower=name.ToLowerInvariant();
        return lower==".agent-data" || lower==".git" || lower=="node_modules" || lower==".env" || lower.StartsWith(".env.") || lower.StartsWith(".agent-stage-");
    }
    static string Validate(string value) {
        if (value.Length<3 || !char.IsLetter(value[0]) || value[1]!=':' || value[2]!='\\') throw new Exception("Local absolute drive path required");
        if (value.Substring(2).Contains(":")) throw new Exception("Alternate streams are denied");
        foreach (string part in value.Substring(3).Split('\\')) {
            if (part=="." || part==".." || part.EndsWith(".") || part.EndsWith(" ") || Private(part)) throw new Exception("Unsafe or private path");
        }
        return Path.GetFullPath(value);
    }
    static SafeFileHandle OpenChecked(string value, bool directory, bool pin) {
        SafeFileHandle handle=CreateFile(value, directory ? 0x80 : Read, ReadShare | (directory ? WriteShare : 0), IntPtr.Zero, Open, NoFollow | DirectoryFlag, IntPtr.Zero);
        if (handle.IsInvalid) throw new IOException("Cannot lock file path (Windows error " + Marshal.GetLastWin32Error() + ")");
        Info info;
        if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400)!=0 || ((info.Attributes & 0x10)!=0)!=directory || !directory && info.Links!=1) {
            handle.Dispose(); throw new Exception("Reparse points, hard links and unexpected file types are denied");
        }
        if (pin) pins.Add(handle);
        return handle;
    }
    static void PinParents(string source, bool create=false) {
        string root=Path.GetPathRoot(source);
        OpenChecked(root, true, true);
        string parent=Path.GetDirectoryName(source);
        if (String.IsNullOrEmpty(parent)) return;
        string current=root;
        foreach (string part in parent.Substring(root.Length).Split('\\')) {
            if (part.Length==0) continue;
            current=Path.Combine(current, part);
            if (create && !Directory.Exists(current)) Directory.CreateDirectory(current);
            OpenChecked(current, true, true);
        }
    }
    static void Copy(string source, string destination, string relative, int depth) {
        if (++count>5000 || depth>32) throw new Exception("Snapshot entry/depth quota exceeded");
        bool directory=(File.GetAttributes(source) & FileAttributes.Directory)!=0;
        using (SafeFileHandle handle=OpenChecked(source, directory, false)) {
            Info info;
            if (!GetFileInformationByHandle(handle, out info)) throw new IOException("Cannot inspect locked handle");
            long length=((long)info.SizeHigh<<32) | info.SizeLow;
            long ticks=((long)info.Modified.dwHighDateTime<<32) | (uint)info.Modified.dwLowDateTime;
            metadata[relative]=new { sizeBytes=length, modifiedAt=DateTime.FromFileTimeUtc(ticks).ToString("o"), type=directory ? "directory" : "file" };
            if (directory) {
                Directory.CreateDirectory(destination);
                if (mode=="file_info") return;
                string[] entries=Directory.GetFileSystemEntries(source);
                if (entries.Length>5000) throw new Exception("Directory entry quota exceeded");
                Array.Sort(entries, StringComparer.Ordinal);
                foreach (string entry in entries) {
                    string name=Path.GetFileName(entry);
                    if (Private(name)) continue;
                    Validate(entry);
                    if (mode=="list_files" && (File.GetAttributes(entry) & FileAttributes.Directory)!=0) {
                        using (SafeFileHandle child=OpenChecked(entry,true,false)) Directory.CreateDirectory(Path.Combine(destination,name));
                        if (++count>5000) throw new Exception("Snapshot entry quota exceeded");
                    } else Copy(entry, Path.Combine(destination,name), relative=="." ? name : relative+"/"+name, depth+1);
                }
            } else {
                if (mode=="list_files" || mode=="find_files" || mode=="file_info" && length>2000000 || mode=="search_text" && length>100000) {
                    using (FileStream placeholder=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
                        if (mode=="search_text") placeholder.SetLength(100001);
                    }
                    return;
                }
                if (length>2000000 || (total+=length)>32000000) throw new Exception("Snapshot byte quota exceeded (2 MB/file, 32 MB/operation); narrow the target path");
                // The handle denies write/delete sharing until all approved bytes are copied.
                using (FileStream input=new FileStream(handle, FileAccess.Read))
                using (FileStream output=new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                    input.CopyTo(output); output.Flush(true);
                }
                File.SetLastWriteTimeUtc(destination, DateTime.FromFileTimeUtc(ticks));
            }
        }
    }
    static void Commit(Dictionary<string,string> request) {
        string target=Validate(request["source"]);
        PinParents(target,true);
        string content=request["content"], expected=request["expected"];
        byte[] bytes=Encoding.UTF8.GetBytes(content);
        if (bytes.Length>100000 || content.Length>40000) throw new Exception("Write quota exceeded");
        string staged=Path.Combine(Path.GetDirectoryName(target), ".agent-stage-"+Guid.NewGuid().ToString("N"));
        try {
            using (FileStream output=new FileStream(staged, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                output.Write(bytes,0,bytes.Length); output.Flush(true);
            }
            if (expected!="missing") {
                using (SafeFileHandle handle=OpenChecked(target,false,false))
                using (FileStream input=new FileStream(handle,FileAccess.Read)) {
                    if (input.Length>100000) throw new Exception("File changed since preview");
                    using (SHA256 sha=SHA256.Create()) {
                        string actual=BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
                        if (actual!=expected) throw new Exception("File changed since preview");
                    }
                }
                // Ancestors remain pinned. Replace never follows a target symlink.
                // Concurrent replacement of the leaf after this check is not CAS.
                File.Replace(staged,target,null);
            } else File.Move(staged,target);
        } finally { if (File.Exists(staged)) File.Delete(staged); }
    }
    static int Main() {
        JavaScriptSerializer json=new JavaScriptSerializer(); json.MaxJsonLength=1000000;
        try {
            var request=json.Deserialize<Dictionary<string,string>>(Console.In.ReadToEnd());
            if (request.ContainsKey("operation") && request["operation"]=="commit") {
                Commit(request); Console.WriteLine(json.Serialize(new { ok=true })); return 0;
            }
            string source=Validate(request["source"]), destination=Validate(request["destination"]);
            if (request.ContainsKey("mode")) mode=request["mode"];
            if (mode!="full" && mode!="read_file" && mode!="file_info" && mode!="list_files" && mode!="find_files" && mode!="search_text") throw new Exception("Unknown snapshot mode");
            if (Directory.Exists(destination) || File.Exists(destination)) throw new Exception("Snapshot output must not exist");
            PinParents(source);
            Copy(source, destination, ".", 0);
            Console.WriteLine(json.Serialize(new { ok=true, metadata=metadata, entries=count, bytes=total }));
            return 0;
        } catch (Exception error) {
            Console.WriteLine(json.Serialize(new { ok=false, message=error.Message })); return 1;
        } finally { foreach (SafeFileHandle pin in pins) pin.Dispose(); }
    }
}
