import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'ui', 'mapping.js'), 'utf8')
const M = new Function(`${source}; return OctopusMapping`)()

const backup = {
  channel_groups: [{ id: 3, name: 'Paid' }],
  channels: [
    { id: 8, name: 'Alpha', group_id: 3, type: 1, enabled: true, base_urls: [{ url: 'https://a.example/v1' }], model: 'm1,m2' },
    { id: 9, name: 'Beta', group_id: 3, type: 0, enabled: false, base_urls: [{ url: 'https://b.example/v1' }, { url: 'https://b2.example/v1' }], model: 'm2,m3' },
    { id: 10, name: 'NoKeys', group_id: 3, type: 0, enabled: true, base_urls: [{ url: 'https://c.example/v1' }], model: 'm4' },
  ],
  channel_keys: [
    { id: 1, channel_id: 8, enabled: true, channel_key: 'sk-a', priority: 0 },
    { id: 2, channel_id: 9, enabled: true, channel_key: 'sk-b', priority: 1 },
    { id: 3, channel_id: 9, enabled: false, channel_key: 'sk-disabled', priority: 0 },
  ],
  groups: [
    { id: 100, name: 'Chat Group', mode: 4, endpoint_type: 'chat' },
    { id: 101, name: 'Empty Group', mode: 3, endpoint_type: 'chat' },
  ],
  group_items: [
    { id: 1, group_id: 100, channel_id: 8, model_name: 'm1', priority: 2, weight: 5 },
    { id: 2, group_id: 100, channel_id: 9, model_name: 'm2', priority: 1, weight: 9 },
    { id: 3, group_id: 101, channel_id: 10, model_name: 'm4', priority: 1, weight: 1 },
  ],
  llm_infos: [
    { name: 'm1', input: 0.14, output: 0.28 },
    { name: 'm2', input: 0, output: 0 },
  ],
  api_keys: [
    { id: 6, name: 'Phone', api_key: 'sk-x', enabled: true, supported_models: 'm1,m2', max_cost: 5, rate_limit_rpm: 10 },
    { id: 7, name: 'All', api_key: 'sk-y', enabled: false },
  ],
}

// channel id → provider id used to resolve route/price phases.
const providerIds = new Map([[8, 1], [9, 2]])

// One channel with a custom header, the codex header profile and a prompt rule.
const rewriteBackup = {
  channels: [{
    id: 1,
    name: 'Codex',
    type: 1,
    base_urls: [{ url: 'https://c/v1' }],
    model: 'gpt-5',
    custom_header: [
      { header_key: 'X-Trace-Id', header_value: 'abc' },
      { header_key: 'Authorization', header_value: 'Bearer leak' },
      { header_key: 'x-trace-id', header_value: 'last-wins' },
    ],
    param_override: JSON.stringify({ max_tokens: 512, top_p: 0.2 }),
    request_rewrite: {
      enabled: true,
      profile: 'codex',
      header_profile: 'codex',
      prompt_rules: [{ pattern: '^You are Claude', replacement: 'You are GPT' }],
    },
  }],
  channel_keys: [{ channel_id: 1, channel_key: 'sk-c', enabled: true }],
}

test('slugify, uniqueSlug and uniqueName', () => {
  assert.equal(M.slugify('Chat Group'), 'chat-group')
  assert.equal(M.slugify('额度/渠道监控'), 'imported')
  const used = new Set(['chat-group'])
  assert.equal(M.uniqueSlug('Chat Group', used), 'chat-group-2')
  const names = new Set(['Alpha', 'Alpha (2)'])
  assert.equal(M.uniqueName('Alpha', names), 'Alpha (3)')
})

test('protocolFor maps anthropic/gemini and rejects unsupported types', () => {
  assert.equal(M.protocolFor(0), 'openai')
  assert.equal(M.protocolFor(1), 'openai-responses')
  assert.equal(M.protocolFor(2), 'anthropic')
  assert.equal(M.protocolFor(3), 'gemini')
  assert.equal(M.protocolFor(5), 'openai')
  assert.equal(M.protocolFor(4), null) // Volcengine
  assert.equal(M.protocolFor(9), null) // Codex
  assert.equal(M.strategyFor(4), 'weighted')
  assert.equal(M.strategyFor(1), 'round-robin')
  assert.equal(M.strategyFor(5), 'priority')
})

test('priceMicros converts $/M to integer micros', () => {
  assert.equal(M.priceMicros(0.14), 140000)
  assert.equal(M.priceMicros(0), 0)
  assert.equal(M.priceMicros(-1), 0)
  assert.equal(M.priceMicros(0.0000001), 1)
})

test('regexToGlobs converts simple alternations and rejects real regex', () => {
  assert.deepEqual(M.regexToGlobs('^gpt-4.*$'), ['gpt-4*'])
  assert.deepEqual(M.regexToGlobs('claude-a|claude-b'), ['claude-a', 'claude-b'])
  assert.equal(M.regexToGlobs('gpt-4(?!turbo)'), null)
  assert.equal(M.regexToGlobs(''), null)
})

test('mapProviders skips keyless/unsupported channels and gives every address all keys', () => {
  const { requests, providerMap, skipped } = M.mapProviders(backup, [], [])
  const providers = requests.filter((request) => request.kind === 'provider')
  assert.equal(providers.length, 2) // NoKeys skipped
  assert.equal(providerMap.has(10), false)
  assert.ok(skipped.some((item) => item.name === 'NoKeys'))
  const alpha = providers.find((request) => request.name === 'Alpha')
  assert.equal(alpha.body.protocol, 'openai-responses')
  assert.equal(alpha.body.mode, 'single')
  assert.equal(alpha.body.secret, 'sk-a')
  const beta = providers.find((request) => request.name === 'Beta')
  assert.equal(beta.body.mode, 'unified')
  assert.equal(beta.body.enabled, false)
  assert.equal(beta.body.endpoints.length, 2)
  // M3: both addresses carry the full enabled key set.
  assert.deepEqual(beta.body.endpoints[0].secrets, ['sk-b'])
  assert.deepEqual(beta.body.endpoints[1].secrets, ['sk-b'])
  // Backend requires top-level secret/secrets mirroring the first address.
  assert.equal(beta.body.secret, 'sk-b')
  assert.deepEqual(beta.body.secrets, ['sk-b'])
})

test('mapProviders skips unsupported channel types with a reason', () => {
  const anthropic = {
    channels: [{ id: 1, name: 'Claude', type: 2, base_urls: [{ url: 'https://x/v1' }], model: 'claude' }],
    channel_keys: [{ channel_id: 1, channel_key: 'sk', enabled: true }],
  }
  const ok = M.mapProviders(anthropic, [], [])
  assert.equal(ok.requests[0].body.protocol, 'anthropic')
  const volc = { channels: [{ id: 2, name: 'Volc', type: 4, base_urls: [{ url: 'https://x/v1' }], model: 'm' }], channel_keys: [{ channel_id: 2, channel_key: 'sk', enabled: true }] }
  const bad = M.mapProviders(volc, [], [])
  assert.equal(bad.requests.length, 0)
  assert.match(bad.skipped[0].reason, /unsupported channel type 4/)
})

test('mapProviders reuses existing providers by name+endpoint (idempotent)', () => {
  const { requests, providerMap } = M.mapProviders(backup, [{ name: 'Alpha', id: 77, endpoint: 'https://a.example/v1' }], [])
  const alpha = requests.find((request) => request.kind === 'provider' && request.name === 'Alpha')
  assert.equal(alpha, undefined) // reused, not recreated
  assert.equal(providerMap.get(8), 'Alpha')
})

test('mapProviders reuses a renamed collision by endpoint (idempotent)', () => {
  // channel 9 "Beta" was created as "Beta (2)" on first import; re-import must
  // reuse it by endpoint rather than creating "Beta (3)".
  const { requests, providerMap } = M.mapProviders(backup, [{ name: 'Beta (2)', id: 55, endpoint: 'https://b.example/v1' }], [])
  const beta = requests.find((request) => request.kind === 'provider' && /Beta/.test(request.name))
  assert.equal(beta, undefined)
  assert.equal(providerMap.get(9), 'Beta (2)')
})

test('mapProviders uniquifies colliding names beyond a single suffix', () => {
  const dup = {
    channels: [
      { id: 1, name: 'Same', type: 0, base_urls: [{ url: 'https://a/v1' }], model: 'm' },
      { id: 2, name: 'Same', type: 0, base_urls: [{ url: 'https://b/v1' }], model: 'm' },
    ],
    channel_keys: [{ channel_id: 1, channel_key: 'k1', enabled: true }, { channel_id: 2, channel_key: 'k2', enabled: true }],
  }
  const { requests } = M.mapProviders(dup, [{ name: 'Same', id: 1 }, { name: 'Same (2)', id: 2 }], [])
  const names = requests.filter((r) => r.kind === 'provider').map((r) => r.name)
  assert.deepEqual(names, ['Same (3)', 'Same (4)'])
})

test('mapRoutes emits id tuples ordered by priority with weighted strategy', () => {
  const { requests, skipped } = M.mapRoutes(backup, providerIds, [])
  assert.equal(requests.length, 1) // Empty Group has no resolvable candidates
  assert.ok(skipped.some((item) => item.name === 'Empty Group'))
  const route = requests[0]
  assert.equal(route.slug, 'chat-group')
  assert.equal(route.body.strategy, 'weighted')
  assert.deepEqual(route.body.candidates, [[2, 'm2'], [1, 'm1']]) // priority 1 first
  assert.deepEqual(route.body.weights, [9, 5])
})

test('mapRoutes reuses existing slugs and skips non-chat endpoint types', () => {
  const reused = M.mapRoutes(backup, providerIds, [{ slug: 'chat-group' }])
  assert.equal(reused.requests.length, 0)
  const embed = { groups: [{ id: 1, name: 'Embed', mode: 3, endpoint_type: 'embeddings' }], group_items: [{ group_id: 1, channel_id: 8, model_name: 'm1', priority: 1 }] }
  const skipped = M.mapRoutes(embed, providerIds, [])
  assert.equal(skipped.requests.length, 0)
  assert.match(skipped.skipped[0].reason, /embeddings/)
})

test('mapRoutes imports simple match_regex as extra glob patterns', () => {
  const regexed = { groups: [{ id: 1, name: 'G', mode: 3, endpoint_type: 'chat', match_regex: '^gpt-4.*$' }], group_items: [{ group_id: 1, channel_id: 8, model_name: 'm1', priority: 1 }] }
  const { requests } = M.mapRoutes(regexed, providerIds, [])
  assert.deepEqual(requests[0].body.patterns, ['g', 'gpt-4*'])
  const complex = { groups: [{ id: 1, name: 'G', mode: 3, endpoint_type: 'chat', match_regex: 'gpt-4(?!turbo)' }], group_items: [{ group_id: 1, channel_id: 8, model_name: 'm1', priority: 1 }] }
  const lost = M.mapRoutes(complex, providerIds, [])
  assert.deepEqual(lost.requests[0].body.patterns, ['g'])
  assert.ok(lost.skipped.some((item) => /match_regex/.test(item.reason)))
})

test('mapPrices emits id-based pricing only for priced models', () => {
  const prices = M.mapPrices(backup, providerIds)
  assert.equal(prices.length, 1) // m2 unpriced, m4 provider skipped
  assert.equal(prices[0].providerId, 1)
  assert.equal(prices[0].body.provider_id, 1)
  assert.equal(prices[0].body.model, 'm1')
  assert.equal(prices[0].body.input_price_micros, 140000)
  assert.equal(prices[0].body.output_price_micros, 280000)
})

test('mapKeys preserves scope, secret, enabled flag and future expiry', () => {
  const future = Math.floor(Date.now() / 1000) + 86400
  const withExpiry = { api_keys: [{ id: 1, name: 'K', api_key: 'sk', enabled: true, supported_models: 'm1', expire_at: future }] }
  const { requests } = M.mapKeys(withExpiry, providerIds)
  assert.deepEqual(requests[0].body.models, ['m1'])
  assert.equal(requests[0].body.secret, 'sk')
  assert.equal(typeof requests[0].body.expires_at, 'string')
  assert.ok(Date.parse(requests[0].body.expires_at) > Date.now())
  const { requests: base } = M.mapKeys(backup, providerIds)
  assert.deepEqual(base[0].body.models, ['m1', 'm2'])
  assert.equal(base[0].body.max_amount_micros, 5_000_000)
  assert.equal(base[0].body.rpm, 10)
  assert.deepEqual(base[1].body.models, ['*'])
  assert.equal(base[1].enabled, false)
})

test('mapKeys skips expired keys and builds policies from source fields', () => {
  const past = Math.floor(Date.now() / 1000) - 86400
  const rich = {
    api_keys: [
      { id: 1, name: 'Expired', api_key: 'sk', enabled: true, expire_at: past },
      { id: 2, name: 'Restricted', api_key: 'sk2', enabled: true, allowed_ips: '10.0.0.0/8,192.168.1.1', per_model_quota_json: '{"m1":{"rpm":5,"tpm":1000}}', excluded_channels: '8' },
    ],
  }
  const { requests, skipped, policies } = M.mapKeys(rich, providerIds)
  assert.equal(requests.length, 1)
  assert.ok(skipped.some((item) => item.name === 'Expired' && /expired/.test(item.reason)))
  const entry = policies.get('Restricted')
  assert.deepEqual(entry.policy.ip_whitelist, ['10.0.0.0/8', '192.168.1.1'])
  assert.deepEqual(entry.policy.model_quotas, { m1: { rpm: 5, tpm: 1000 } })
  assert.deepEqual(entry.excludedChannels, [8]) // raw Octopus channel ids
  // resolvePhases resolves excluded channels to real provider ids
  const plan = { providerMap: new Map(), policies, skipped: [], phases: [] }
  const resolved = M.resolvePhases(plan, { groups: [], group_items: [], llm_infos: [], channels: [] }, providerIds, [])
  assert.deepEqual(resolved.policies.get('Restricted').excluded_providers, [1])
})

test('mapKeys narrows category-restricted keys to matching route models', () => {
  const categorized = {
    groups: [
      { id: 1, name: 'Free Tier', category: 'free', mode: 3, endpoint_type: 'chat' },
      { id: 2, name: 'Paid Tier', category: 'paid', mode: 3, endpoint_type: 'chat' },
    ],
    group_items: [
      { group_id: 1, channel_id: 8, model_name: 'free-model', priority: 1 },
      { group_id: 2, channel_id: 9, model_name: 'paid-model', priority: 1 },
    ],
    api_keys: [{ id: 1, name: 'FreeKey', api_key: 'sk', enabled: true, allowed_group_categories: 'free' }],
  }
  const { requests } = M.mapKeys(categorized, providerIds)
  const models = requests[0].body.models
  assert.ok(models.includes('free-tier'))
  assert.ok(models.includes('free-model'))
  assert.ok(!models.includes('paid-model'))
  assert.ok(!models.includes('*'))
})

test('buildPlan orders phases and resolvePhases fills id-based routes/prices', () => {
  const plan = M.buildPlan(backup, { providers: [], routes: [], groups: [] })
  assert.deepEqual(plan.phases.map((phase) => phase.id), ['providers', 'routes', 'prices', 'keys'])
  assert.equal(plan.phases[0].requests.length, 3) // 1 group + 2 providers
  assert.equal(plan.phases[3].requests.length, 2) // keys
  const resolved = M.resolvePhases(plan, backup, providerIds, [])
  assert.equal(resolved.routes.requests.length, 1)
  assert.deepEqual(resolved.routes.requests[0].body.candidates, [[2, 'm2'], [1, 'm1']])
  assert.equal(resolved.prices.length, 1)
})

test('mapKeys skips keys whose name already exists (idempotent re-import)', () => {
  const { requests, skipped } = M.mapKeys(backup, providerIds, [{ name: 'Phone', id: 99 }])
  assert.equal(requests.length, 1) // only "All" remains
  assert.equal(requests[0].name, 'All')
  assert.ok(skipped.some((item) => item.name === 'Phone' && /already exists/.test(item.reason)))
})
test('mapProviders migrates custom_header and the codex header profile', () => {
  const { requests, skipped } = M.mapProviders(rewriteBackup, [], [])
  const body = requests.find((request) => request.kind === 'provider').body
  assert.deepEqual(body.headers, [
    { name: 'User-Agent', value: 'Codex Desktop/0.131.0 (Windows 10.0.19045; x86_64) unknown (Codex Desktop; 26.519.21041)' },
    { name: 'Origin', value: 'https://chat.openai.com' },
    { name: 'Referer', value: 'https://chat.openai.com/' },
    { name: 'Accept', value: 'application/json' },
    { name: 'x-trace-id', value: 'last-wins' },
  ])
  assert.deepEqual(body.param_replace, [])
  assert.ok(skipped.some((item) => item.kind === 'rewrite' && /Authorization/.test(item.reason)))
  assert.ok(skipped.some((item) => /profile codex/.test(item.reason)))
})

test('mapProviders maps param_override to only-if-absent defaults and skips the rest', () => {
  const withParams = {
    channels: [{
      id: 1, name: 'P', type: 0, base_urls: [{ url: 'https://p/v1' }], model: 'm',
      param_override: JSON.stringify({ max_tokens: 512, temperature: 0.2, top_p: 'high', frequency_penalty: 0.5, max_completion_tokens: 64 }),
    }],
    channel_keys: [{ channel_id: 1, channel_key: 'k', enabled: true }],
  }
  const { requests, skipped } = M.mapProviders(withParams, [], [])
  const body = requests.find((request) => request.kind === 'provider').body
  assert.deepEqual(body.param_defaults, [
    { field: 'max_tokens', value: 512 },
    { field: 'max_completion_tokens', value: 64 },
    { field: 'temperature', value: 0.2 },
  ])
  assert.ok(skipped.some((item) => /top_p must be a number/.test(item.reason)))
  assert.ok(skipped.some((item) => /frequency_penalty has no Sepia equivalent/.test(item.reason)))
  const broken = M.mapProviders({
    channels: [{ id: 2, name: 'B', type: 0, base_urls: [{ url: 'https://b/v1' }], model: 'm', param_override: '{oops' }],
    channel_keys: [{ channel_id: 2, channel_key: 'k', enabled: true }],
  }, [], [])
  assert.ok(broken.skipped.some((item) => /not valid JSON/.test(item.reason)))
  assert.deepEqual(broken.requests.find((request) => request.kind === 'provider').body.param_defaults, [])
})

test('mapProviders maps prompt rules to system-only replacements and skips Rust-incompatible patterns', () => {
  const withPrompts = {
    channels: [{
      id: 1, name: 'Pr', type: 0, base_urls: [{ url: 'https://pr/v1' }], model: 'm',
      request_rewrite: {
        enabled: true,
        profile: 'preserve',
        prompt_rules: [
          { pattern: '^You are Claude', replacement: 'You are GPT' },
          { pattern: '(?<=role:)assistant', replacement: 'model' },
          { pattern: '(\\w+)-\\1', replacement: 'dup' },
          { pattern: '(?P<name>Codex)', replacement: 'Agent $<name>' },
        ],
      },
    }],
    channel_keys: [{ channel_id: 1, channel_key: 'k', enabled: true }],
  }
  const { requests, skipped } = M.mapProviders(withPrompts, [], [])
  const body = requests.find((request) => request.kind === 'provider').body
  assert.deepEqual(body.prompt_replace, [
    { pattern: '^You are Claude', replacement: 'You are GPT' },
    { pattern: '(?P<name>Codex)', replacement: 'Agent ${name}' },
  ])
  assert.equal(skipped.filter((item) => /prompt rule/.test(item.reason)).length, 2)
  assert.equal(M.rustRegexCompatible('a(?=b)'), false)
  assert.equal(M.rustRegexCompatible('(\\w)\\1'), false)
  assert.equal(M.rustRegexCompatible('^\\s*(You|I) are'), true)
})

test('mapProviders updates a reused provider with rewrite rules without clearing keys', () => {
  const stored = {
    id: 77, name: 'Codex', protocol: 'openai-responses', endpoint: 'https://c/v1',
    models: ['gpt-5'], group_id: 'octopus-3', enabled: true, mode: 'single',
    headers: [], param_replace: [], prompt_replace: [], param_defaults: [],
  }
  const first = M.mapProviders(rewriteBackup, [stored], [])
  assert.equal(first.requests.filter((request) => request.kind === 'provider').length, 0)
  const update = first.requests.find((request) => request.kind === 'provider-update')
  assert.equal(update.method, 'PUT')
  assert.equal(update.path, '/api/v1/providers/77')
  assert.equal(update.body.name, 'Codex')
  assert.equal(update.body.mode, 'single')
  assert.equal(update.body.secret, '')
  assert.deepEqual(update.body.secrets, [])
  assert.deepEqual(update.body.models, ['gpt-5'])
  assert.ok(update.body.headers.some((header) => header.name === 'User-Agent'))
  assert.equal(first.rewrite.updates, 1)
  // Idempotent: the stored provider already carries these rules, so no request.
  const upToDate = {
    ...stored,
    headers: update.body.headers,
    param_replace: update.body.param_replace,
    prompt_replace: update.body.prompt_replace,
    param_defaults: update.body.param_defaults,
  }
  const second = M.mapProviders(rewriteBackup, [upToDate], [])
  assert.equal(second.requests.filter((request) => request.kind === 'provider-update').length, 0)
  assert.equal(second.rewrite.updates, 0)
})

test('mapProviders discloses a reused provider that cannot be updated', () => {
  const bare = { id: 77, name: 'Codex', endpoint: 'https://c/v1' }
  const { requests, skipped } = M.mapProviders(rewriteBackup, [bare], [])
  assert.equal(requests.filter((request) => request.kind === 'provider-update').length, 0)
  assert.ok(skipped.some((item) => /missing protocol\/models/.test(item.reason)))
})

test('mapProviders discloses unsupported rewrite capabilities', () => {
  const channel = {
    id: 4, name: 'Cfg', type: 0, base_urls: [{ url: 'https://cfg/v1' }], model: 'm',
    request_rewrite: {
      enabled: true,
      profile: 'openai_chat_compat',
      header_profile: 'codex',
      tool_role_strategy: 'stringify_to_user',
      system_message_strategy: 'merge',
    },
  }
  const { requests, skipped } = M.mapProviders({
    channels: [channel],
    channel_keys: [{ channel_id: 4, channel_key: 'k', enabled: true }],
  }, [], [])
  const reasons = skipped.map((item) => item.reason).join(' | ')
  assert.match(reasons, /openai_chat_compat/)
  assert.match(reasons, /tool_role_strategy stringify_to_user/)
  assert.match(reasons, /system_message_strategy merge/)
  // Headers still migrate; nothing else is claimed.
  const body = requests.find((request) => request.kind === 'provider').body
  assert.equal(body.headers.length, 4)
  assert.deepEqual(body.prompt_replace, [])
})

test('buildPlan exposes rewrite counts for the analyze preview', () => {
  const plan = M.buildPlan(rewriteBackup, { providers: [], routes: [], groups: [], keys: [] })
  // 4 codex headers + 1 custom header + 1 prompt rule + 2 param defaults
  assert.equal(plan.rewrite.rules, 8)
  assert.equal(plan.rewrite.updates, 0)
  assert.equal(plan.rewrite.skipped, 2) // Authorization + codex profile disclosure
  const plain = M.buildPlan(backup, { providers: [], routes: [], groups: [], keys: [] })
  assert.deepEqual(plain.rewrite, { rules: 0, updates: 0, skipped: 0 })
})
