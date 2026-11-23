# Octopus Receive

A Sepia plugin that imports an [Octopus](https://github.com/bestruirui/octopus) backup JSON into this gateway through the management API. The sandboxed UI parses the backup and maps each entity into small management-API requests; the WASM guest forwards them through the `admin.request` host capability using the invoking administrator's session. Requires the `admin` permission and an administrator login.

## What is imported

| Octopus | Sepia | Notes |
| --- | --- | --- |
| `channel_groups` | provider groups (`octopus-<id>`) | reused if present |
| `channels` + `channel_keys` | providers + keys | type 0/5/6 → `openai`, 1 → `openai-responses`, 2 → `anthropic`, 3 → `gemini`; other types are skipped with a reason. Multiple `base_urls` become a unified channel; every address gets the full key set. |
| `groups` + `group_items` | routes + candidates | candidates ordered by `priority`; mode 1→round-robin, 2→random, 4→weighted, 3/5→priority. Non-`chat` endpoint types are skipped. |
| `llm_infos` | model pricing | $/M tokens → integer micros/token (minimum 1 when priced). |
| `api_keys` | client keys + policies | preserves the plaintext secret, scope, limits and future expiry; IP whitelist, per-model quotas and excluded channels are applied via `/keys/{id}/policy`. |

## Semantic differences (disclosed)

- **Routing mode 5 (auto)** has no Sepia equivalent (Sepia has no success-rate strategy); it maps to `priority` (saved order). Mode 3 (failover) also maps to `priority`.
- **`match_regex`** is converted to Sepia glob patterns only for simple literal alternations / a trailing `.*`. Real regex metacharacters cannot be represented; the route keeps its slug pattern and the loss is logged.
- **`allowed_group_categories`** restricts which Octopus *groups* (routes) a key can see. Sepia's `allowed_groups` filters *provider groups* instead, so the two are not equivalent. Rather than grant everything, the importer narrows the key's model scope to the slugs and member models of the matching routes.
- **Expired keys** (`expire_at` in the past) are skipped — Sepia rejects past expirations.
- **Idempotency**: providers are reused when an existing provider has the same name *and* endpoint; routes are reused by slug; groups by id. Re-importing the same backup does not create duplicates. A same-name channel pointing at a *different* endpoint is treated as a distinct provider and gets a unique ` (n)` suffix.

## Build & package

```sh
cargo build --target wasm32-unknown-unknown --release
node package.mjs   # writes octopus-receive.zip (manifest + plugin.wasm + ui/)
```

Install the zip from Plugins → Install plugin, enable it, then Open UI. Choose a backup JSON, Analyze, review the counts and skipped items, then Import.

## Tests

```sh
node --test mapping.test.mjs
```

Pure mapping logic is covered by `mapping.test.mjs` (protocol mapping, name uniqueness, id-based candidates, multi-address keys, idempotent reuse, regex conversion, key policies/expiry/categories).