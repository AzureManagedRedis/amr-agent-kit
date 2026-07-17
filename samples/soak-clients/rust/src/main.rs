use std::collections::HashSet;
use std::env;

fn positive(name: &str, fallback: u32) -> bool {
    env::var(name)
        .unwrap_or_else(|_| fallback.to_string())
        .parse::<u32>()
        .is_ok_and(|value| value > 0)
}

fn valid_live_endpoint(endpoint: &str) -> bool {
    let authority = endpoint.strip_prefix("rediss://").unwrap_or("").split('/').next().unwrap_or("");
    let host_and_port = authority.rsplit('@').next().unwrap_or("");
    let Some((host, port)) = host_and_port.rsplit_once(':') else {
        return false;
    };
    !host.is_empty() && port == "10000"
}

fn json_string(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            '\r' => "\\r".chars().collect::<Vec<_>>(),
            '\t' => "\\t".chars().collect::<Vec<_>>(),
            character if character.is_control() => format!("\\u{:04x}", character as u32).chars().collect(),
            character => vec![character],
        })
        .collect()
}

fn main() {
    let mode = env::var("SOAK_MODE").unwrap_or_else(|_| "dry-run".to_owned());
    let scenario = env::var("SOAK_SCENARIO").unwrap_or_else(|_| "cache".to_owned());
    let namespace = env::var("SOAK_KEY_NAMESPACE").unwrap_or_else(|_| "soak:offline".to_owned());
    let scenarios: HashSet<&str> = ["cache", "stream", "pubsub", "ingestion", "semantic-cache", "checkpoint"].into();
    let mut namespace_characters = namespace.chars();
    let namespace_valid = matches!(namespace_characters.next(), Some(character) if character.is_ascii_alphanumeric())
        && namespace_characters.all(|character| character.is_ascii_alphanumeric() || matches!(character, ':' | '_' | '-'));
    let mut invalid = !matches!(mode.as_str(), "dry-run" | "live")
        || !scenarios.contains(scenario.as_str())
        || namespace.is_empty()
        || !namespace_valid
        || !positive("SOAK_TIMEOUT_MS", 750)
        || !positive("SOAK_MAX_RETRIES", 3)
        || !positive("SOAK_TTL_SECONDS", 60);
    if mode == "live" && !valid_live_endpoint(&env::var("REDIS_ENDPOINT").unwrap_or_default()) {
        invalid = true;
    }

    let status = if invalid {
        "invalid-config"
    } else if mode == "live" {
        "live-adapter-required"
    } else {
        "ok"
    };
    let succeeded = usize::from(status == "ok");
    println!(
        "{{\"library\":\"redis-rs\",\"mode\":\"{}\",\"scenario\":\"{}\",\"status\":\"{}\",\"keyNamespace\":\"{}\",\"probeKey\":\"{}:{}:probe\",\"metrics\":{{\"attempted\":1,\"succeeded\":{},\"failed\":{},\"latencyMs\":0}}}}",
        json_string(&mode),
        json_string(&scenario),
        status,
        json_string(&namespace),
        json_string(&namespace),
        json_string(&scenario),
        succeeded,
        1 - succeeded
    );
    if invalid {
        std::process::exit(2);
    }
}
