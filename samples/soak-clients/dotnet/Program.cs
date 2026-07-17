using System.Text.Json;
using System.Text.RegularExpressions;

var config = SoakConfig.Read();
var probeKey = $"{config.KeyNamespace}:{config.Scenario}:probe";
var result = new SoakResult(
    "StackExchange.Redis",
    config.Mode,
    config.Scenario,
    config.Error is null ? (config.Mode == "live" ? "live-adapter-required" : "ok") : "invalid-config",
    config.KeyNamespace,
    probeKey,
    new Metrics(1, config.Error is null && config.Mode == "dry-run" ? 1 : 0, config.Error is null && config.Mode == "dry-run" ? 0 : 1, 0));

Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase
}));
return config.Error is null ? 0 : 2;

internal sealed record SoakResult(string Library, string Mode, string Scenario, string Status, string KeyNamespace, string ProbeKey, Metrics Metrics);
internal sealed record Metrics(int Attempted, int Succeeded, int Failed, int LatencyMs);

internal sealed record SoakConfig(string Mode, string Scenario, string KeyNamespace, int TimeoutMs, int MaxRetries, int TtlSeconds, string? Error)
{
    private static readonly HashSet<string> Scenarios = ["cache", "stream", "pubsub", "ingestion", "semantic-cache", "checkpoint"];
    private static readonly Regex NamespacePattern = new("^[A-Za-z0-9][A-Za-z0-9:_-]*$", RegexOptions.CultureInvariant);

    public static SoakConfig Read()
    {
        var mode = Environment.GetEnvironmentVariable("SOAK_MODE") ?? "dry-run";
        var scenario = Environment.GetEnvironmentVariable("SOAK_SCENARIO") ?? "cache";
        var keyNamespace = Environment.GetEnvironmentVariable("SOAK_KEY_NAMESPACE") ?? "soak:offline";
        var timeoutMs = ParsePositive("SOAK_TIMEOUT_MS", 750);
        var maxRetries = ParsePositive("SOAK_MAX_RETRIES", 3);
        var ttlSeconds = ParsePositive("SOAK_TTL_SECONDS", 60);

        var error = mode is not ("dry-run" or "live") ? "invalid-mode"
            : !Scenarios.Contains(scenario) ? "invalid-scenario"
            : !NamespacePattern.IsMatch(keyNamespace) ? "invalid-key-namespace"
            : timeoutMs is null || maxRetries is null || ttlSeconds is null ? "invalid-bounds"
            : mode == "live" ? ValidateLiveEndpoint(Environment.GetEnvironmentVariable("REDIS_ENDPOINT"))
            : null;

        return new(mode, scenario, keyNamespace, timeoutMs ?? 0, maxRetries ?? 0, ttlSeconds ?? 0, error);
    }

    private static int? ParsePositive(string name, int fallback) =>
        int.TryParse(Environment.GetEnvironmentVariable(name) ?? fallback.ToString(), out var value) && value > 0 ? value : null;

    private static string? ValidateLiveEndpoint(string? endpoint)
    {
        if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "rediss" || uri.Port != 10000)
        {
            return "invalid-live-endpoint";
        }

        return null;
    }
}
