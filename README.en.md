[English](README.en.md) | [简体中文](README.md)

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
| `custom_header` / `param_override` / `request_rewrite` | provider request rewriting (`headers` / `param_defaults` / `prompt_replace`) | `custom_header` → static outbound `headers`; `param_override` migrates only the four defaults `max_tokens`, `max_completion_tokens`, `temperature`, `top_p` (applied only when the request omits them); `request_rewrite.header_profile = codex` expands to the 4 fixed headers; `prompt_rules` → `prompt_replace`, which only touches system/developer prompts. |

## Semantic differences (disclosed)

- **Routing mode 5 (auto)** has no Sepia equivalent (Sepia has no success-rate strategy); it maps to `priority` (saved order). Mode 3 (failover) also maps to `priority`.
- **`match_regex`** is converted to Sepia glob patterns only for simple literal alternations / a trailing `.*`. Real regex metacharacters cannot be represented; the route keeps its slug pattern and the loss is logged.
- **`allowed_group_categories`** restricts which Octopus *groups* (routes) a key can see. Sepia's `allowed_groups` filters *provider groups* instead, so the two are not equivalent. Rather than grant everything, the importer narrows the key's model scope to the slugs and member models of the matching routes.
- **Expired keys** (`expire_at` in the past) are skipped — Sepia rejects past expirations.
- **Unsupported rewriting is skipped item by item and disclosed**: the `profile` message shaping (all of `openai_chat_compat`, everything except the fixed headers for `codex`), `tool_role_strategy = stringify_to_user`, `system_message_strategy = merge`, `prompt_rules` the Rust regex engine cannot compile (lookaround, backreferences, atomic groups, conditionals), reserved/sensitive headers (authorization, cookie, host, content-length, …) and `param_override` keys outside the four supported fields. Skipped rewriting is never reported as migrated.
- **`prompt_rules` replacements**: ECMAScript named-group references `$<name>` become Rust `${name}`. Sepia uses the Rust regex engine, which has no lookaround or backreferences, so such rules are skipped during Analyze.
- **Idempotency**: providers are reused when an existing provider has the same name *and* first endpoint, or when only the first endpoint matches (so a renamed collision such as `Dup (2)` still matches by endpoint); a reused provider with rewriting is updated in place with `PUT /providers/{id}`, writing the four rewriting arrays without sending secrets or clearing existing keys, and no request is sent when the stored rules already match. Routes are reused by slug and groups by id. Re-importing the same backup does not create duplicates. A unique ` (n)` suffix is only appended when the name collides with an existing provider *and* the endpoint differs.

## Build & package

```sh
cargo build --target wasm32-unknown-unknown --release
node package.mjs   # writes octopus-receive.zip (manifest + plugin.wasm + ui/)
```

`Cargo.toml` pulls `sepia-plugin-sdk` from the Sepia repository over git, pinned to rev `e912ca66f0` (which includes the bump allocator `ensure_capacity` fix), so a standalone clone builds without a sibling Sepia checkout. When developing inside a Sepia checkout, create a gitignored `.cargo/config.toml` pointing at the local path, so the build picks up the SDK from your working tree (`paths` overrides do not rewrite `Cargo.lock`, so `--locked` keeps working):

```toml
paths = ["../backend/plugin-sdk"]
```

Install the zip from Plugins → Install plugin, enable it, then Open UI. Choose a backup JSON, Analyze, review the counts and skipped items, then Import.

## Tests

```sh
node --test mapping.test.mjs
```

Pure mapping logic is covered by `mapping.test.mjs` (protocol mapping, name uniqueness, id-based candidates, multi-address keys, idempotent reuse, regex conversion, key policies/expiry/categories, request rewriting and its skip disclosure).