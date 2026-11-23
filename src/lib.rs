//! Octopus Receive — imports an Octopus backup into Sepia.
//!
//! The sandboxed UI parses the backup JSON and maps each Octopus entity into a
//! Sepia management-API request, then sends them in small batches through
//! `http.rpc`. This guest forwards every request to the `admin.request` host
//! capability, which replays it against the gateway management API using the
//! invoking administrator's session. Requires the `admin` permission.
#![no_std]
extern crate alloc;
use sepia_plugin_sdk::{host, log};
use sepia_plugin_sdk::json::Value;

#[no_mangle]
pub extern "Rust" fn dispatch(event: &str, payload: &Value, _config: &Value) -> Value {
    match event {
        "http.rpc" => {
            let path = payload.get("path").and_then(Value::as_str).unwrap_or("");
            if path != "proxy" {
                let mut out = Value::object();
                out.insert("error", Value::str("unknown rpc path"));
                return out;
            }
            let body = payload.get("body").cloned().unwrap_or(Value::object());
            let admin_path = body.get("path").and_then(Value::as_str).unwrap_or("");
            // Defense in depth: only the management API namespace is proxied.
            // The host also validates the path, but reject anything else here.
            if !admin_path.starts_with("/api/v1/") {
                let mut out = Value::object();
                out.insert("status", Value::num(400));
                out.insert("body", Value::str("only /api/v1/ paths may be proxied"));
                return out;
            }
            let method = body.get("method").and_then(Value::as_str).unwrap_or("POST");
            let mut request = Value::object();
            request.insert("path", Value::str(admin_path));
            request.insert("method", Value::str(method));
            if let Some(inner) = body.get("body") {
                request.insert("body", inner.clone());
            }
            match host("admin.request", request) {
                Ok(result) => result,
                Err(message) => {
                    log(&alloc::format!("admin.request failed: {message}"));
                    let mut out = Value::object();
                    out.insert("status", Value::num(502));
                    out.insert("body", Value::str(&message));
                    out
                }
            }
        }
        "plugin.migrate" => Value::object(),
        _ => Value::object(),
    }
}