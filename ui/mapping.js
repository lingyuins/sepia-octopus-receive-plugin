// Octopus backup → Sepia management-API request mapping (pure, testable).
// All functions run in the sandboxed plugin UI; the guest only forwards the
// resulting {path, method, body} requests through the admin.request capability.
//
// References are resolved to provider ids at execution time: mapProviders
// returns a channel→name map, the UI swaps it for channel→id once providers
// exist, and mapRoutes/mapPrices then emit id-based requests directly.

var OctopusMapping = (function () {
function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'imported'
}

function uniqueSlug(name, used) {
  const base = slugify(name)
  let slug = base
  let n = 2
  while (used.has(slug)) slug = `${base}-${n++}`
  used.add(slug)
  return slug
}

// Append " (n)" until the name is unique (providers.name is UNIQUE).
function uniqueName(name, used) {
  let candidate = name
  let n = 2
  while (used.has(candidate)) candidate = `${name} (${n++})`
  used.add(candidate)
  return candidate
}

// Octopus outbound type → Sepia provider protocol.
// 0 chat / 5 embedding / 6 mimo → openai; 1 response → openai-responses;
// 2 anthropic; 3 gemini. Types without a Sepia equivalent return null (skip).
function protocolFor(type) {
  switch (type) {
    case 0: case 5: case 6: return 'openai'
    case 1: return 'openai-responses'
    case 2: return 'anthropic'
    case 3: return 'gemini'
    default: return null
  }
}

function splitModels(value) {
  return String(value || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
}

// $/M tokens → integer micros/token (round to nearest, minimum 1 when priced).
function priceMicros(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return Math.max(1, Math.round(amount * 1_000_000))
}

// Octopus group mode → Sepia routing strategy id.
// 3 failover → priority (saved order); 5 auto → priority (Sepia has no
// success-rate strategy; documented approximation).
function strategyFor(mode) {
  switch (mode) {
    case 1: return 'round-robin'
    case 2: return 'random'
    case 4: return 'weighted'
    default: return 'priority'
  }
}

function baseUrls(channel) {
  const urls = Array.isArray(channel.base_urls) ? channel.base_urls : []
  return urls.map((entry) => (entry && entry.url ? String(entry.url) : '')).filter(Boolean)
}

function channelKeys(backup, channelId) {
  return (backup.channel_keys || [])
    .filter((key) => key.channel_id === channelId && key.enabled !== false && key.channel_key)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
}

// Convert a simple Octopus match_regex into Sepia glob patterns. Only literal
// alternations and a trailing ".*" are representable; real regex metacharacters
// return null so the caller keeps the slug pattern and discloses the loss.
function regexToGlobs(regex) {
  let source = String(regex || '').trim()
  if (!source) return null
  source = source.replace(/^\^/, '').replace(/\$$/, '')
  if (/[+?()[\]{}\\]/.test(source) || /\.(?!\*$)/.test(source.replace(/\.\*$/, ''))) return null
  const branches = source.split('|')
  const globs = []
  for (const branch of branches) {
    const trimmed = branch.trim()
    if (!trimmed) return null
    if (/[.*]/.test(trimmed.replace(/\.\*$/, ''))) return null
    globs.push(trimmed.endsWith('.*') ? trimmed.slice(0, -2) + '*' : trimmed)
  }
  return globs
}

// channels + channel_keys + channel_groups → group/provider create requests.
// Existing providers (by name) and groups (by id) are reused, making re-imports
// idempotent. providerMap maps Octopus channel id → the Sepia provider name.
function mapProviders(backup, existingProviders, existingGroups) {
  const requests = []
  const skipped = []
  const providerMap = new Map()
  const existingByKey = new Map((existingProviders || []).map((provider) => [`${provider.name}\u0000${provider.endpoint}`, provider]))
  // A renamed collision (e.g. "Dup (2)") no longer matches the raw channel name,
  // so also index by endpoint: one endpoint maps to exactly one provider.
  const existingByEndpoint = new Map((existingProviders || []).map((provider) => [provider.endpoint, provider]))
  const usedNames = new Set((existingProviders || []).map((provider) => provider.name))
  const knownGroups = new Set((existingGroups || []).map((group) => group.id))

  for (const group of backup.channel_groups || []) {
    const id = `octopus-${group.id}`
    if (!knownGroups.has(id)) {
      requests.push({ path: '/api/v1/groups', method: 'POST', body: { id, name: group.name, description: '' }, kind: 'group' })
      knownGroups.add(id)
    }
  }

  for (const channel of backup.channels || []) {
    const rawName = String(channel.name || `channel-${channel.id}`).trim() || `channel-${channel.id}`
    const urls = baseUrls(channel)
    const keys = channelKeys(backup, channel.id)
    const models = splitModels(channel.model)
    const protocol = protocolFor(channel.type)
    if (protocol === null) { skipped.push({ kind: 'provider', name: rawName, reason: `unsupported channel type ${channel.type}` }); continue }
    if (urls.length === 0 || keys.length === 0 || models.length === 0) { skipped.push({ kind: 'provider', name: rawName, reason: 'missing endpoint, key or model' }); continue }
    const reuse = existingByKey.get(`${rawName}\u0000${urls[0]}`) || existingByEndpoint.get(urls[0])
    if (reuse) { providerMap.set(channel.id, reuse.name); continue }
    const name = uniqueName(rawName, usedNames)
    providerMap.set(channel.id, name)
    const groupId = channel.group_id != null ? `octopus-${channel.group_id}` : 'official'
    const enabled = channel.enabled !== false
    const secrets = keys.map((key) => key.channel_key)
    if (urls.length === 1) {
      requests.push({
        path: '/api/v1/providers', method: 'POST', kind: 'provider', name,
        body: { name, protocol, endpoint: urls[0], models, secret: secrets[0], secrets, group_id: groupId, enabled, mode: 'single' },
      })
    } else {
      requests.push({
        path: '/api/v1/providers', method: 'POST', kind: 'provider', name,
        body: {
          name, protocol, endpoint: urls[0], models, secret: secrets[0], secrets, group_id: groupId, enabled, mode: 'unified',
          // Every address gets the full key set (Octopus keys are channel-level).
          // Top-level secret/secrets mirror the first address (backend requires them).
          endpoints: urls.map((url) => ({ endpoint: url, secrets })),
        },
      })
    }
  }
  return { requests, providerMap, skipped }
}

// groups + group_items → route create requests. providerMap holds provider ids
// at execution time, so candidates are emitted as [provider_id, model] tuples.
// Existing routes (by slug) are reused. Non-chat endpoint types are skipped.
function mapRoutes(backup, providerMap, existingRoutes) {
  const requests = []
  const skipped = []
  const existingSlugs = new Set((existingRoutes || []).map((route) => route.slug))
  const usedSlugs = new Set(existingSlugs)
  const itemsByGroup = new Map()
  for (const item of backup.group_items || []) {
    const list = itemsByGroup.get(item.group_id) || []
    list.push(item)
    itemsByGroup.set(item.group_id, list)
  }
  for (const group of backup.groups || []) {
    const endpointType = String(group.endpoint_type || 'chat')
    if (endpointType !== 'chat') { skipped.push({ kind: 'route', name: String(group.name || ''), reason: `endpoint type ${endpointType} not supported` }); continue }
    const items = (itemsByGroup.get(group.id) || []).slice().sort((a, b) => (a.priority || 0) - (b.priority || 0))
    const candidates = []
    const weights = []
    for (const item of items) {
      const providerId = providerMap.get(item.channel_id)
      if (providerId == null || !item.model_name) continue
      candidates.push([providerId, String(item.model_name)])
      weights.push(Math.min(100, Math.max(1, Number(item.weight) || 1)))
    }
    if (candidates.length === 0) { skipped.push({ kind: 'route', name: String(group.name || ''), reason: 'no resolvable candidates' }); continue }
    const baseSlug = slugify(group.name)
    if (existingSlugs.has(baseSlug)) continue
    const slug = uniqueSlug(group.name, usedSlugs)
    const strategy = strategyFor(group.mode)
    let patterns = [slug]
    const globs = regexToGlobs(group.match_regex)
    if (globs && globs.length) patterns = [slug, ...globs]
    else if (String(group.match_regex || '').trim()) skipped.push({ kind: 'route', name: String(group.name || slug), reason: 'match_regex too complex for glob; only slug pattern imported' })
    requests.push({
      path: '/api/v1/routes', method: 'POST', kind: 'route', slug,
      body: {
        slug, name: String(group.name || slug), description: '',
        patterns, candidates, strategy,
        weights: strategy === 'weighted' ? weights : undefined,
        list_members: true, enabled: true,
      },
    })
  }
  return { requests, skipped }
}

// llm_infos → pricing requests keyed by provider id + model.
function mapPrices(backup, providerMap) {
  const prices = new Map()
  for (const info of backup.llm_infos || []) {
    const input = priceMicros(info.input)
    const output = priceMicros(info.output)
    if (input > 0 && output > 0) prices.set(String(info.name), { input, output })
  }
  const requests = []
  for (const channel of backup.channels || []) {
    const providerId = providerMap.get(channel.id)
    if (providerId == null) continue
    for (const model of splitModels(channel.model)) {
      const price = prices.get(model)
      if (!price) continue
      requests.push({
        path: '/api/v1/models/pricing', method: 'POST', kind: 'price', providerId,
        body: { provider_id: providerId, model, input_price_micros: price.input, output_price_micros: price.output },
      })
    }
  }
  return requests
}

// Categories restrict which Octopus groups (routes) a key can see. Sepia has no
// route-category concept, so we narrow the key's model scope to the slugs and
// member models of the matching routes instead of granting everything.
function categoryModels(backup, categories) {
  const wanted = new Set(categories.map((category) => category.toLowerCase()))
  const models = new Set()
  const groupIds = new Set()
  for (const group of backup.groups || []) {
    if (group.category && wanted.has(String(group.category).toLowerCase())) {
      models.add(slugify(group.name))
      groupIds.add(group.id)
    }
  }
  for (const item of backup.group_items || []) {
    if (groupIds.has(item.group_id) && item.model_name) models.add(String(item.model_name))
  }
  return Array.from(models)
}

// api_keys → client key create requests + per-key policies. Empty supported
// models with no category restriction means all models. Expired source keys
// are skipped (Sepia rejects past expirations). Policies are applied by the UI
// after creation via POST /keys/{id}/policy.
function mapKeys(backup, providerMap, existingKeys) {
  const requests = []
  const skipped = []
  const policies = new Map()
  const now = Date.now()
  const existingNames = new Set((existingKeys || []).map((key) => key.name))
  for (const key of backup.api_keys || []) {
    const name = String(key.name || `key-${key.id}`)
    // Idempotent re-import: a key with the same name already exists (its token
    // hash is unique), so skip recreation rather than failing on UNIQUE.
    if (existingNames.has(name)) { skipped.push({ kind: 'key', name, reason: 'already exists' }); continue }
    const expireAt = Number(key.expire_at) || 0
    if (expireAt > 0 && expireAt * 1000 <= now) { skipped.push({ kind: 'key', name, reason: 'already expired' }); continue }
    const supported = splitModels(key.supported_models)
    const categories = splitModels(key.allowed_group_categories)
    let models
    if (supported.length) models = supported
    else if (categories.length) { models = categoryModels(backup, categories); if (!models.length) models = ['*'] }
    else models = ['*']
    const policy = { ip_whitelist: [], model_quotas: {}, allowed_groups: [], excluded_providers: [], model_groups: [] }
    const ips = splitModels(key.allowed_ips)
    if (ips.length) policy.ip_whitelist = ips
    if (key.per_model_quota_json) {
      try {
        const parsed = JSON.parse(key.per_model_quota_json)
        if (parsed && typeof parsed === 'object') {
          for (const model of Object.keys(parsed)) {
            const quota = parsed[model] || {}
            policy.model_quotas[model] = { rpm: Number(quota.rpm) || 0, tpm: Number(quota.tpm) || 0 }
          }
        }
      } catch (error) { skipped.push({ kind: 'key', name, reason: 'invalid per_model_quota_json' }) }
    }
    // Excluded channels reference Octopus channel ids; resolve them to Sepia
    // provider ids at execution time (providerMap holds ids then). Store the
    // raw channel ids here so buildPlan stays name-based.
    const excludedChannels = splitModels(key.excluded_channels).map((id) => Number(id)).filter((id) => Number.isFinite(id))
    const hasPolicy = policy.ip_whitelist.length || Object.keys(policy.model_quotas).length || excludedChannels.length
    if (hasPolicy) policies.set(name, { policy, excludedChannels })
    requests.push({
      path: '/api/v1/keys', method: 'POST', kind: 'key', name,
      body: {
        name, models,
        token_limit: Number(key.max_tokens) || 0,
        max_amount_micros: Math.round((Number(key.max_cost) || 0) * 1_000_000),
        rpm: Number(key.rate_limit_rpm) || 0,
        tpm: Number(key.rate_limit_tpm) || 0,
        expires_at: expireAt > 0 ? new Date(expireAt * 1000).toISOString() : null,
        secret: key.api_key ? String(key.api_key) : null,
      },
      enabled: key.enabled !== false,
    })
  }
  return { requests, skipped, policies }
}

// Full plan: ordered phases. Providers must exist before routes/prices; the UI
// resolves providerMap names to ids after the provider phase, then runs the
// route/price phases with id-based requests. Key policies follow key creation.
function buildPlan(backup, existing) {
  const providers = mapProviders(backup, existing.providers, existing.groups)
  const keys = mapKeys(backup, providers.providerMap, existing.keys)
  return {
    providerMap: providers.providerMap,
    policies: keys.policies,
    skipped: [...providers.skipped, ...keys.skipped],
    phases: [
      { id: 'providers', requests: providers.requests },
      { id: 'routes', requests: [], source: 'routes' },
      { id: 'prices', requests: [], source: 'prices' },
      { id: 'keys', requests: keys.requests },
    ],
  }
}

// Build the id-based route/price phases and resolve key policies once provider
// ids are known. excluded_providers needs real Sepia provider ids (i64).
function resolvePhases(plan, backup, providerIds, existingRoutes) {
  const routes = mapRoutes(backup, providerIds, existingRoutes)
  const prices = mapPrices(backup, providerIds)
  const policies = new Map()
  plan.policies.forEach((entry, name) => {
    const policy = { ...entry.policy, excluded_providers: entry.excludedChannels.map((id) => providerIds.get(id)).filter((id) => id != null) }
    policies.set(name, policy)
  })
  return { routes, prices, policies }
}

  return { slugify, uniqueSlug, uniqueName, protocolFor, splitModels, priceMicros, strategyFor, regexToGlobs, mapProviders, mapRoutes, mapPrices, mapKeys, categoryModels, buildPlan, resolvePhases }
})()
if (typeof window !== 'undefined') window.OctopusMapping = OctopusMapping