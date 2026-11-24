[English](README.en.md) | 简体中文

# Octopus Receive

一个 Sepia 插件：通过管理 API 把 [Octopus](https://github.com/bestruirui/octopus) 备份 JSON 导入本网关。沙箱化的 UI 负责解析备份，并把每个实体映射为若干管理 API 请求；WASM guest 则使用调用方管理员的会话，通过 `admin.request` 宿主能力转发这些请求。需要 `admin` 权限，且需以管理员身份登录。

## 导入内容

| Octopus | Sepia | 说明 |
| --- | --- | --- |
| `channel_groups` | 渠道商分组（`octopus-<id>`） | 已存在则复用 |
| `channels` + `channel_keys` | 渠道商 + Key | type 0/5/6 → `openai`，1 → `openai-responses`，2 → `anthropic`，3 → `gemini`；其他类型会被跳过并给出原因。多个 `base_urls` 会合并为一个统一渠道商；每个地址都获得完整的 Key 集合。 |
| `groups` + `group_items` | 路由 + 候选 | 候选按 `priority` 排序；模式 1→round-robin，2→random，4→weighted，3/5→priority。非 `chat` 端点类型会被跳过。 |
| `llm_infos` | 模型价格 | $/M tokens → 整数 micros/token（有价格时最小为 1）。 |
| `api_keys` | 客户端密钥 + 策略 | 保留明文 secret、scope、限额与未来的过期时间；IP 白名单、按模型配额与排除渠道通过 `/keys/{id}/policy` 应用。 |
| `custom_header` / `param_override` / `request_rewrite` | 渠道商请求改写（`headers` / `param_defaults` / `prompt_replace`） | `custom_header` → 静态出站 `headers`；`param_override` 仅迁移 `max_tokens`、`max_completion_tokens`、`temperature`、`top_p` 四个缺省值（仅当请求未提供时生效）；`request_rewrite.header_profile = codex` 展开 4 条固定请求头；`prompt_rules` → 只作用于 system/developer 提示词的 `prompt_replace`。 |

## 语义差异（已披露）

- **路由模式 5（auto）** 在 Sepia 中没有对应实现（Sepia 没有成功率策略），因此映射为 `priority`（保存顺序）。模式 3（failover）同样映射为 `priority`。
- **`match_regex`** 仅在简单的字面量并列（alternation）或末尾 `.*` 的情况下才转换为 Sepia 的 glob 模式；真正的正则元字符无法表示，此时路由保留其 slug 模式，并记录这一损失。
- **`allowed_group_categories`** 限制某个 Key 能看到哪些 Octopus *分组*（即路由）。Sepia 的 `allowed_groups` 过滤的是*渠道商分组*，两者并不等价。为避免放开全部权限，导入器会把该 Key 的模型范围收窄到匹配路由的 slug 及其成员模型。
- **已过期的 Key**（`expire_at` 早于当前时间）会被跳过——Sepia 拒绝过去的过期时间。
- **请求改写的未实现能力逐条跳过并披露**：`profile` 的消息整形（`openai_chat_compat` 全部、`codex` 除固定头以外的部分）、`tool_role_strategy = stringify_to_user`、`system_message_strategy = merge`、Rust regex 无法编译的 `prompt_rules`（lookaround、反向引用、原子组、条件组）、敏感或保留请求头（authorization、cookie、host、content-length 等），以及 `param_override` 中四个受支持字段以外的键。被跳过的改写绝不会显示为迁移成功。
- **`prompt_rules` 的替换串**：ECMAScript 命名组引用 `$<name>` 会转换为 Rust 的 `${name}`；Sepia 只用 Rust regex，因此不支持 lookaround / 反向引用，此类规则在 Analyze 阶段即被跳过。
- **幂等性**：已存在的渠道商若「名称 + 首端点」相同，或仅首端点相同，即被复用（因此改名碰撞如 `Dup (2)` 只要端点相同仍会按端点匹配复用）；带改写规则的复用渠道商会以 `PUT /providers/{id}` 幂等回写四个改写数组（不发送密钥、不清空已有 Key），若已存规则与备份一致则不发请求。路由按 slug 复用，分组按 id 复用。重复导入同一备份不会产生重复项。仅当名称与现有渠道商冲突且端点不同时，才附加唯一的 ` (n)` 后缀新建。

## 构建与打包

```sh
cargo build --target wasm32-unknown-unknown --release
node package.mjs   # writes octopus-receive.zip (manifest + plugin.wasm + ui/)
```

`Cargo.toml` 通过 git 依赖固定 Sepia 仓库中的 `sepia-plugin-sdk`（rev `e912ca66f0`，含 bump allocator 的 `ensure_capacity` 修复），因此独立克隆可直接构建，无需同级 Sepia 检出。若你正在 Sepia 检出内开发，可创建不入库的 `.cargo/config.toml` 指向本地路径，构建会使用工作区里的 SDK（`paths` 覆盖不会改写 `Cargo.lock`，`--locked` 依然可用）：

```toml
paths = ["../backend/plugin-sdk"]
```

从 Plugins → Install plugin 安装 zip，启用后点击 Open UI。选择备份 JSON，点击 Analyze，核对计数与被跳过项，然后执行 Import。

## 测试

```sh
node --test mapping.test.mjs
```

纯映射逻辑由 `mapping.test.mjs` 覆盖（协议映射、名称唯一性、基于 id 的候选、多地址 Key、幂等复用、正则转换、Key 策略/过期/分组类别、请求改写与跳过披露）。