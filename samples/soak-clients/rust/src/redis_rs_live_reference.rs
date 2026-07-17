// Consumer-only reference. Keep this module out of main.rs unless the consumer
// supplies redis-rs outside the retained corpus.
use redis::{Client, ConnectionAddr, ConnectionInfo, RedisConnectionInfo};
use std::time::Duration;

pub fn client(host: String) -> redis::RedisResult<Client> {
    let info = ConnectionInfo {
        addr: Box::new(ConnectionAddr::TcpTls {
            host,
            port: 10000,
            insecure: false,
            tls_params: None,
        }),
        redis: RedisConnectionInfo::default(),
    };
    Client::open(info)
}

pub fn deadline() -> Duration {
    Duration::from_millis(750)
}
