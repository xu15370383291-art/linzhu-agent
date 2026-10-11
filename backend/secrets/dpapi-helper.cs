using System;
using System.Security.Cryptography;

public static class AgentDpapiHelper
{
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1 || (args[0] != "protect" && args[0] != "unprotect")) return 2;
            var input = Convert.FromBase64String(Console.In.ReadToEnd().Trim());
            var output = args[0] == "protect"
                ? ProtectedData.Protect(input, null, DataProtectionScope.CurrentUser)
                : ProtectedData.Unprotect(input, null, DataProtectionScope.CurrentUser);
            Console.Out.Write(Convert.ToBase64String(output));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.Write(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
