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
        await database.StringSetAsync(
            $"{config.KeyNamespace}:{config.Scenario}:probe",
            "1",
            TimeSpan.FromSeconds(config.TtlSeconds));
    }
}
#endif
