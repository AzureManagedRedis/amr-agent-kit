package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
)

var namespacePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_-]*$`)
var scenarios = map[string]bool{"cache": true, "stream": true, "pubsub": true, "ingestion": true, "semantic-cache": true, "checkpoint": true}

type metrics struct {
	Attempted int `json:"attempted"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	LatencyMs int `json:"latencyMs"`
}

type result struct {
	Library      string  `json:"library"`
	Mode         string  `json:"mode"`
	Scenario     string  `json:"scenario"`
	Status       string  `json:"status"`
	KeyNamespace string  `json:"keyNamespace"`
	ProbeKey     string  `json:"probeKey"`
	Metrics      metrics `json:"metrics"`
}

func positive(name string, fallback int) bool {
	value, err := strconv.Atoi(env(name, strconv.Itoa(fallback)))
	return err == nil && value > 0
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func validLiveEndpoint(endpoint string) bool {
	parsed, err := url.Parse(endpoint)
	return err == nil && parsed.Scheme == "rediss" && parsed.Port() == "10000" && parsed.Hostname() != ""
}

func main() {
	mode, scenario, namespace := env("SOAK_MODE", "dry-run"), env("SOAK_SCENARIO", "cache"), env("SOAK_KEY_NAMESPACE", "soak:offline")
	invalid := (mode != "dry-run" && mode != "live") || !scenarios[scenario] || !namespacePattern.MatchString(namespace) ||
		!positive("SOAK_TIMEOUT_MS", 750) || !positive("SOAK_MAX_RETRIES", 3) || !positive("SOAK_TTL_SECONDS", 60)
	if mode == "live" && !validLiveEndpoint(os.Getenv("REDIS_ENDPOINT")) {
		invalid = true
	}
	status := "ok"
	if invalid {
		status = "invalid-config"
	} else if mode == "live" {
		status = "live-adapter-required"
	}
	succeeded := 0
	if status == "ok" {
		succeeded = 1
	}
	encoded, _ := json.Marshal(result{"go-redis", mode, scenario, status, namespace, fmt.Sprintf("%s:%s:probe", namespace, scenario), metrics{1, succeeded, 1 - succeeded, 0}})
	fmt.Println(string(encoded))
	if invalid {
		os.Exit(2)
	}
}
