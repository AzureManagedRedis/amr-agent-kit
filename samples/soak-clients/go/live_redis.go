//go:build redis_live

package main

import (
	"context"
	"crypto/tls"
	"time"

	"github.com/redis/go-redis/v9"
)

func newGoRedisClient(endpoint string, timeout time.Duration) *redis.Client {
	return redis.NewClient(&redis.Options{
		Addr:      endpoint,
		TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		DialTimeout: timeout,
		ReadTimeout: timeout,
		WriteTimeout: timeout,
		MaxRetries: 3,
	})
}

func writeProbe(ctx context.Context, client *redis.Client, key string, ttl time.Duration) error {
	teardownKey := key[:len(key)-len(":probe")] + ":teardown"
	defer client.Del(ctx, key, teardownKey)
	return client.Set(ctx, key, "1", ttl).Err()
}
