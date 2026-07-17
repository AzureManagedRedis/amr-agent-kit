#if STACKEXCHANGE_REDIS
using StackExchange.Redis;

internal static class StackExchangeRedisLiveReference
{
    internal static async Task RunAsync(SoakConfig config, string endpoint)
    {
        var options = ConfigurationOptions.Parse(endpoint);
        options.Ssl = true;
        options.AbortOnConnectFail = false;
        options.ConnectTimeout = config.TimeoutMs;
        options.SyncTimeout = config.TimeoutMs;
        options.ReconnectRetryPolicy = new ExponentialRetry(config.TimeoutMs);
        using var connection = await ConnectionMultiplexer.ConnectAsync(options);
        var database = connection.GetDatabase();
        var probeKey = $"{config.KeyNamespace}:{config.RunId}:{config.Scenario}:probe";
        var teardownKey = $"{config.KeyNamespace}:{config.RunId}:{config.Scenario}:teardown";
        try
        {
            await database.StringSetAsync(probeKey, "1", TimeSpan.FromSeconds(config.TtlSeconds));
        }
        finally
        {
            await database.KeyDeleteAsync(probeKey);
            await database.KeyDeleteAsync(teardownKey);
        }
    }
}
#endif
