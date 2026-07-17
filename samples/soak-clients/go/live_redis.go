//go:build redis_live

package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"regexp"
	"time"

	"github.com/redis/go-redis/v9"
)

var scopePartPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_-]*$`)

func newGoRedisClient(endpoint string, timeout time.Duration) (*redis.Client, error) {
	options, err := redis.ParseURL(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parse Redis endpoint: %w", err)
	}
	if options.TLSConfig == nil {
		return nil, fmt.Errorf("Redis endpoint must use rediss")
	}

	options.TLSConfig.MinVersion = tls.VersionTLS12
	options.TLSConfig.InsecureSkipVerify = false
	options.DialTimeout = timeout
	options.ReadTimeout = timeout
	options.WriteTimeout = timeout
	options.MaxRetries = 3
	return redis.NewClient(options), nil
}

func scopedKey(namespace string, runID string, scenario string, purpose string) (string, error) {
	if !scopePartPattern.MatchString(namespace) || !scopePartPattern.MatchString(runID) || !scopePartPattern.MatchString(scenario) {
		return "", fmt.Errorf("invalid scoped key component")
	}
	return fmt.Sprintf("%s:%s:%s:%s", namespace, runID, scenario, purpose), nil
}

func writeProbe(ctx context.Context, client *redis.Client, namespace string, runID string, scenario string, ttl time.Duration) error {
	probeKey, err := scopedKey(namespace, runID, scenario, "probe")
	if err != nil {
		return err
	}
	teardownKey, err := scopedKey(namespace, runID, scenario, "teardown")
	if err != nil {
		return err
	}
	defer client.Del(ctx, probeKey, teardownKey)
	return client.Set(ctx, probeKey, "1", ttl).Err()
}
