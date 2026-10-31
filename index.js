/**
 * dsh-pollinations-free — mount the free models of enter.pollinations.ai
 * (official + community) into the DeepSeek Harness model picker.
 *
 * Design (mirrors the dsh-our-free-model plugin's structural adapter contract,
 * kept deliberately small):
 *
 *  - Catalog: `https://gen.pollinations.ai/models?reliability=all` is the very
 *    feed the enter.pollinations.ai dashboard loads (verified in its
 *    `assets/model-catalog-*.js`). The free predicate is copied from that file:
 *    no token price on any prompt/completion side, no paid adjustments or
 *    variants, not an agent, not `paid_only`.
 *  - Two provider routes, because the harness picker groups strictly by route:
 *      `pollinations-free`         — official free lane, works anonymously on
 *                                    `text.pollinations.ai` (OpenAI Chat
 *                                    compatible, streaming + tools verified).
 *      `pollinations-free-community` — community models, served by
 *                                    `gen.pollinations.ai`; they need a free
 *                                    API key from enter.pollinations.ai/keys,
 *                                    configured below. An empty route is
 *                                    hidden by the client until configured.
 *  - Adapter contract is validated structurally by registerAdapter (duck-typed,
 *    same trick our-free-model uses), so this mounts on more than one kernel
 *    line without importing a version-pinned base class.
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'

export const ROUTE_FREE = 'pollinations-free'
export const ROUTE_COMMUNITY = 'pollinations-free-community'
const ROUTE_LABELS = {
  [ROUTE_FREE]: 'Pollinations Free',
  [ROUTE_COMMUNITY]: 'Pollinations Community',
}

const GEN_CATALOG = 'https://gen.pollinations.ai/models?reliability=all'
const CLASSIC_MODELS = 'https://text.pollinations.ai/models'
const CLASSIC_BASE = 'https://text.pollinations.ai'
const GEN_BASE = 'https://gen.pollinations.ai'

const PROMPT_PRICE_KEYS = [
  'promptTextTokens', 'promptCachedTokens', 'promptCacheWriteTokens',
  'promptAudioTokens', 'promptAudioSeconds', 'promptImageTokens',
  'promptVideoTokens', 'promptVideoSeconds',
]
const OUTPUT_PRICE_KEYS = [
  'completionTextTokens', 'completionReasoningTokens', 'completionAudioTokens',
  'completionAudioSeconds', 'completionImageTokens', 'completionVideoSeconds', 'completionVideoTokens',
]

const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
// Catalog prices arrive as decimal STRINGS ("0.00000015"), so coercion is
// required here — and the dashboard predicate treats any positive value as a
// price, whatever type it wore.
const price = (pricing, key) => {
  const raw = pricing?.[key]
  const v = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN
  return Number.isFinite(v) && v > 0 ? v : undefined
}
const pricedKeys = (pricing, keys) => keys.some(key => price(pricing, key) !== undefined)

/** The dashboard's own `free` predicate (model-catalog asset, function R). */
function isFreeCatalogEntry(entry) {
  if (entry.agent === true) return false
  if (entry.paid_only === true) return false
  if (entry.pricing === undefined) return false
  if (pricedKeys(entry.pricing, PROMPT_PRICE_KEYS) || pricedKeys(entry.pricing, OUTPUT_PRICE_KEYS)) return false
  if ((entry.pricing_adjustments ?? []).some(a => Number(a?.price) > 0)) return false
  if ((entry.pricing_variants ?? []).some(v => pricedKeys(v.pricing, [...PROMPT_PRICE_KEYS, ...OUTPUT_PRICE_KEYS]))) return false
  return true
}

function categoryOf(entry) {
  if (typeof entry.category === 'string') return entry.category
  const out = entry.output_modalities ?? []
  if (out.includes('video')) return 'video'
  if (out.includes('image')) return 'image'
  if (out.includes('audio')) return 'audio'
  return 'text'
}

/** Build the advertised catalog: chat-capable free models only (text output).
 *
 * Lanes are decided by what was verified live on 2026-10-31:
 *  - a name present on `text.pollinations.ai/models` answers anonymously on the
 *    classic lane (streaming + tools verified for `openai-fast`);
 *  - every other free model (gen official-free and all community models) is
 *    served only by `gen.pollinations.ai`, which refuses anonymous requests
 *    with 401 — it needs the free API key from enter.pollinations.ai/keys.
 */
export function buildCatalog(genRows, classicRows) {
  const classicNames = new Set((classicRows ?? []).map(row => String(row.name ?? '')).filter(id => id !== ''))
  const entries = []
  const seen = new Set()
  for (const row of genRows ?? []) {
    const id = String(row.name ?? row.id ?? '')
    if (id === '' || seen.has(id) || !isFreeCatalogEntry(row)) continue
    if (categoryOf(row) !== 'text' && !(row.supported_endpoints ?? []).includes('/v1/chat/completions')) continue
    if (!(row.output_modalities ?? ['text']).includes('text')) continue
    seen.add(id)
    const onClassic = classicNames.has(id)
    entries.push({
      id,
      name: String(row.title ?? row.description?.split(' - ')[0] ?? id),
      description: typeof row.description === 'string' ? row.description : '',
      community: row.community === true,
      publisher: typeof row.publisher === 'string' ? row.publisher : '',
      contextWindow: number(row.context_length) ?? 128000,
      maxOutput: number(row.max_completion_tokens) ?? 8192,
      vision: (row.input_modalities ?? []).includes('image'),
      tools: row.tools === true || (row.capabilities ?? []).includes('tool_calling'),
      lane: onClassic ? 'classic' : 'gen',
      requiresKey: !onClassic,
    })
  }
  for (const row of classicRows ?? []) {
    const id = String(row.name ?? '')
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    entries.push({
      id,
      name: id,
      description: typeof row.description === 'string' ? row.description : '',
      community: row.community === true,
      publisher: '',
      contextWindow: 128000,
      maxOutput: 8192,
      vision: (row.input_modalities ?? []).includes('image') || row.vision === true,
      tools: row.tools === true,
      lane: 'classic',
      requiresKey: false,
    })
  }
  return entries
}

// ── message projection: harness vocabulary -> OpenAI Chat wire ───────────────
const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? { type: 'text', text: part }
        : part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text'
          ? { type: 'text', text: String(part.text ?? '') } : part))
      .filter(block => block !== null && typeof block === 'object')
  }
  return []
}

function textOf(blocks) {
  return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
}

function imageDataUrl(block, resolveImage) {
  if (block?.offloaded === true) return undefined
  return resolveImage?.(block.attachment) ?? (typeof block.attachment?.url === 'string' ? block.attachment.url : undefined)
}

function callIdOf(message) {
  const id = String(message?.toolCallId ?? message?.source?.callId ?? '')
  return id === '' ? null : id
}

function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = callIdOf(message)
    return id === null ? [] : [{ callId: id, content: blocksOf(message.content), isError: message.isError === true }]
  }
  const out = []
  for (const block of blocksOf(message.content)) {
    if (block?.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? '')
    if (id === '') continue
    out.push({ callId: id, content: blocksOf(block.content), isError: block.isError === true })
  }
  return out
}

/**
 * Harness messages -> Chat messages, with the light pairing repair that keeps
 * an interrupted tool call from poisoning every later turn (a dangling call or
 * an orphan result makes some servers answer 400 forever for that history).
 */
export function toChatMessages(messages, resolveImage, warnings) {
  const rows = []
  const callIds = new Set()
  const resultIds = new Set()
  for (const message of messages ?? []) {
    for (const block of blocksOf(message.content)) if (block?.type === 'tool-call') callIds.add(String(block.id ?? ''))
    for (const result of toolResultsOf(message)) resultIds.add(result.callId)
  }
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    for (const result of results) {
      const text = textOf(result.content)
      rows.push({
        role: 'tool', tool_call_id: result.callId,
        content: (result.isError ? 'Error: ' : '') + (text !== '' ? text : '(no output)'),
      })
    }
    const blocks = blocksOf(message.content).filter(b => b?.type !== 'tool-result')
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text) rows.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        if (results.length > 0 && blocks.length === 0) break
        const parts = []
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') {
            const url = imageDataUrl(block, resolveImage)
            if (url !== undefined && IMAGE_MEDIA.has(String(block.attachment?.mediaType ?? 'image/png').split(';')[0])) parts.push({ type: 'image_url', image_url: { url } })
            else if (warnings) warnings.push('image-dropped')
          }
        }
        if (parts.length === 0) {
          const fallback = textOf(blocks)
          if (fallback) rows.push({ role: 'user', content: fallback })
          else if (results.length === 0) rows.push({ role: 'user', content: '(no text)' })
          break
        }
        rows.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts })
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls = []
        for (const block of blocks) {
          if (block?.type !== 'tool-call') continue
          const id = String(block.id ?? '')
          if (!resultIds.has(id)) continue // unanswered call: drop, do not poison the history
          calls.push({
            id, type: 'function',
            function: { name: String(block.name ?? ''), arguments: typeof block.arguments === 'string' ? block.arguments : '{}' },
          })
        }
        const reasoning = textOf(blocks.filter(b => b?.type === 'reasoning'))
        if (calls.length === 0) {
          if (text !== '') rows.push({ role: 'assistant', content: text })
          break
        }
        rows.push({ role: 'assistant', content: text !== '' ? text : (reasoning !== '' ? '' : null), tool_calls: calls })
        break
      }
      case 'tool': break // already consumed above via toolResultsOf
      default: {
        const text = textOf(blocks)
        if (text) rows.push({ role: 'user', content: text })
      }
    }
  }
  // Drop tool results whose call never made it into the emitted history.
  const emittedCalls = new Set()
  for (const row of rows) for (const call of row.tool_calls ?? []) emittedCalls.add(call.id)
  return rows.filter(row => row.role !== 'tool' || emittedCalls.has(row.tool_call_id))
}

export function toToolDefs(tools) {
  const list = []
  for (const tool of tools ?? []) {
    const source = tool && typeof tool.function === 'object' && tool.function !== null ? tool.function : tool
    const name = String(source?.name ?? '').trim()
    if (name === '') continue
    const parameters = source.parameters && typeof source.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters : { type: 'object', properties: {} }
    list.push({
      type: 'function',
      function: { name: name.slice(0, 128), description: typeof source.description === 'string' ? source.description : '', parameters },
    })
  }
  return list
}

// ── SSE reader + harness StreamChunk projection ──────────────────────────────
async function * ssePayloads(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      yield line.slice(5).trim()
    }
  }
}

class BlockSink {
  constructor(emit) { this.emit = emit; this.next = 0; this.open = new Map(); this.dsmlHold = '' }
  slot(key, kind) {
    const existing = this.open.get(key)
    if (existing !== undefined) return existing
    const blockType = kind === 'reasoning' ? 'reasoning' : kind === 'tool-call' ? 'tool-call' : 'text'
    const block = { index: this.next++, kind, text: '', args: '', id: kind === 'tool-call' ? `call_${crypto.randomBytes(12).toString('hex')}` : '', name: '' }
    this.open.set(key, block)
    this.emit({ type: 'block-start', index: block.index, blockType })
    return block
  }
  text(key, delta) {
    if (!delta) return
    this.sawText = true
    const block = this.slot(key, 'text')
    block.text += delta
    this.emit({ type: 'text-delta', index: block.index, text: delta })
  }
  reasoning(key, delta) {
    if (!delta) return
    this.sawReasoning = true
    const block = this.slot(key, 'reasoning')
    block.text += delta
    this.emit({ type: 'reasoning-delta', index: block.index, text: delta })
  }
  toolStart(key, id, name) {
    const block = this.slot(key, 'tool-call')
    if (id) block.id = id
    if (name) block.name = name
  }
  toolArgs(key, delta) {
    if (!delta) return
    this.sawToolCall = true
    const block = this.slot(key, 'tool-call')
    block.args += delta
    const name = block.name !== '' ? { name: block.name } : {}
    this.emit({ type: 'tool-call-delta', index: block.index, id: block.id ?? '', ...name, argumentsDelta: delta })
  }
  closeAll() {
    let brokenToolCall = false
    for (const block of this.open.values()) {
      if (block.kind === 'text' && block.text !== '') this.emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      else if (block.kind === 'reasoning' && block.text !== '') this.emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
      else if (block.kind === 'tool-call') {
        try { JSON.parse(block.args === '' ? '{}' : block.args) } catch { brokenToolCall = true }
        if (block.name === '') brokenToolCall = true
        this.emit({ type: 'block-end', index: block.index, block: { type: 'tool-call', id: block.id ?? '', name: block.name ?? '', arguments: block.args === '' ? '{}' : block.args } })
      }
    }
    this.open.clear()
    return brokenToolCall
  }
}

function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens)
  const completion = number(usage.completion_tokens ?? usage.output_tokens)
  const cached = number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) ?? 0
  const reasoning = number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const out = { inputTokens: Math.max(0, (prompt ?? 0) - cached), outputTokens: completion ?? 0 }
  if (cached > 0) out.cacheReadTokens = cached
  if (reasoning > 0) out.reasoningTokens = reasoning
  out.totalTokens = (prompt ?? 0) + (completion ?? 0)
  return out
}

function finishReasonKind(token) {
  if (token === 'tool_calls' || token === 'function_call') return 'tool-calls'
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') return 'max-tokens'
  return 'stop'
}

class PollinationsError extends Error {
  constructor(message, code) { super(message); this.name = 'PollinationsError'; this.code = code }
}

function classifyStatus(status, body) {
  const message = typeof body?.error?.message === 'string' ? body.error.message
    : typeof body?.error === 'string' ? body.error
      : typeof body?.message === 'string' ? body.message : `HTTP ${status}`
  if (status === 401 || status === 403) return new PollinationsError(message, 'INVALID_CREDENTIAL')
  if (status === 402) return new PollinationsError(message, 'QUOTA_EXHAUSTED')
  if (status === 404) return new PollinationsError(message, 'SERVER')
  if (status === 429) return new PollinationsError(message, 'RATE_LIMIT')
  // The gen gateway answers 400 for several distinct refusals. Two need real
  // failure codes so the host does not blindly retry them:
  //  - a prompt past the model's context window (OpenAI-style
  //    "maximum context length ... requested N tokens");
  //  - an oversized request body the gateway refuses to even buffer
  //    ("Failed to buffer the request body: length limit exceeded").
  // Both are permanent for the turn; retrying would only hit the same wall.
  if (status === 400) {
    const text = String(message)
    if (/maximum context length|context length is/i.test(text)) return new PollinationsError(text, 'CONTEXT_WINDOW_EXCEEDED')
    if (/length limit exceeded|too large|request body/i.test(text)) return new PollinationsError(text, 'CLIENT_ERROR')
    return new PollinationsError(text, 'CLIENT_ERROR')
  }
  if (status >= 500) return new PollinationsError(message, 'SERVER')
  return new PollinationsError(message, 'CLIENT_ERROR')
}

// ── the adapter ──────────────────────────────────────────────────────────────
const FALLBACK_IMAGE_PRICING = Object.freeze({
  priceImages(images) {
    return images.map(image => image.offloaded === true
      ? { visualTokens: 0, text: '[image omitted]' }
      : { visualTokens: 1024, text: '[image]' })
  },
})

export class PollinationsAdapter {
  /**
   * @param {object} deps
   * @param {() => {catalog: object[], membership: Record<string, string[]>, settings: object}} deps.state
   * @param {(ref: object) => string | undefined} [deps.resolveImage]
   * @param {(message: string) => void} [deps.warn]
   */
  constructor(deps) { this.deps = deps }

  providerInfo(provider) { return { id: provider, name: ROUTE_LABELS[provider] ?? provider } }

  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT']),
      initialDelayMs: 1000,
      maxDelayMs: 10000,
      jitterRatio: 0.25,
    })
  }

  imageRequestPricing() { return FALLBACK_IMAGE_PRICING }

  async listModels(provider) {
    const state = this.deps.state()
    const ids = new Set(state.membership[provider] ?? [])
    return state.catalog
      .filter(entry => ids.has(entry.id))
      .map(entry => ({
        provider,
        id: entry.id,
        name: `${entry.name}${entry.vision ? ' 👁' : ''}`,
        description: entryDescription(entry, state),
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
  }

  async resolveModel(provider, model) {
    const state = this.deps.state()
    const entry = state.catalog.find(candidate => candidate.id === model)
    if (entry === undefined) {
      return { provider, id: model, name: model, context: { contextWindow: 128000 }, defaultMaxTokens: 8192 }
    }
    const ceiling = Math.min(entry.maxOutput, state.settings.defaultMaxTokens ?? 32768)
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: ceiling,
    }
  }

  async prepareCall(provider, model) {
    const snapshot = this.deps.state()
    const entry = snapshot.catalog.find(candidate => candidate.id === model) ?? null
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options, entry, snapshot),
    }
  }

  stream(options, pinned, snapshot = this.deps.state()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = this.run(options, pinned ?? snapshot.catalog.find(c => c.id === options.model) ?? null, snapshot, controller.signal)
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done) cleanup()
        return row
      } catch (error) { cleanup(); throw error }
    }
    return {
      [Symbol.asyncIterator]() { return this },
      next: value => step('next', value),
      return: value => { controller.abort(); cleanup(); return step('return', value) },
      throw: error => { controller.abort(error); cleanup(); return step('throw', error) },
    }
  }

  async * run(options, entry, snapshot, signal) {
    const settings = snapshot.settings ?? {}
    const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    if (settings.enabled === false) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'pollinations-free is switched off in its config', code: 'CONFIG_DISABLED' } } }
      return
    }
    if (entry === null) {
      // A picker entry can outlive its catalog row: the upstream renamed or
      // re-priced the model between refreshes, or the page cached a model list
      // from before a hot reload. Refusing here turns a selectable model into
      // a dead end ("does not serve"), so instead synthesize a best-effort row
      // and let the upstream deliver its real verdict — a 401 with the keys
      // URL, a 404 for a truly vanished id, all of which map cleanly already.
      const id = String(options.model ?? '')
      const looksCommunity = id.startsWith('community/')
      const hasKey = String(settings.apiKey ?? process.env.POLLINATIONS_API_KEY ?? '').trim() !== ''
      entry = {
        id, name: id, description: '', community: looksCommunity, publisher: '',
        contextWindow: 131072, maxOutput: 8192, vision: false, tools: true,
        lane: looksCommunity || hasKey ? 'gen' : 'classic',
        requiresKey: false,
      }
    }
    const apiKey = String(settings.apiKey ?? process.env.POLLINATIONS_API_KEY ?? '').trim()
    if (entry.requiresKey && apiKey === '') {
      yield {
        type: 'finish', reason: { kind: 'error', failure: {
          message: `"${entry.id}" is served on gen.pollinations.ai, which needs a free API key (get one at https://enter.pollinations.ai/keys) in this plugin's config (apiKey)`,
          code: 'INVALID_CREDENTIAL',
        } },
      }
      return
    }
    const useGen = entry.lane === 'gen' || settings.preferGenApi === true
    const base = useGen ? GEN_BASE : CLASSIC_BASE
    const maxTokens = Math.min(options.maxTokens ?? settings.defaultMaxTokens ?? 16384, entry.maxOutput)
    const payload = {
      model: entry.id,
      messages: toChatMessages(options.messages ?? [], this.deps.resolveImage, []),
      max_tokens: maxTokens,
      stream: true,
      // The classic lane (text.pollinations.ai) documents `referrer` as an
      // optional attribution field; the gen gateway validates strictly and
      // rejects the very same key with 400 "Unsupported parameter(s): referrer"
      // (verified live 2026-10-31). Send it only where it is known to pass.
      ...(useGen ? {} : { referrer: settings.referrer || 'dsh-pollinations-free' }),
    }
    if (useGen) payload.stream_options = { include_usage: true }
    const tools = toToolDefs(options.tools)
    if (tools.length > 0 && entry.tools) payload.tools = tools
    if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) payload.temperature = options.temperature

    const headers = { 'content-type': 'application/json', accept: 'text/event-stream' }
    if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`

    let response
    try {
      response = await directFetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(payload), signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `pollinations unreachable: ${error?.message ?? error}`, code: 'TRANSPORT' } } }
      return
    }
    if (!response.ok) {
      const body = await response.text().then(text => { try { return JSON.parse(text) } catch { return null } }).catch(() => null)
      const mapped = classifyStatus(response.status, body)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: mapped.message, code: mapped.code } } }
      return
    }

    const outbox = []
    const sink = new BlockSink(chunk => outbox.push(chunk))
    let usage
    let finishToken
    let sawError
    try {
      for await (const data of ssePayloads(response.body)) {
        if (data === '[DONE]') break
        if (data === '') continue
        let payloadRow
        try { payloadRow = JSON.parse(data) } catch { continue }
        if (payloadRow.error) {
          const failure = payloadRow.error
          sawError = typeof failure?.message === 'string' ? failure.message : 'upstream error'
          break
        }
        if (payloadRow.usage) usage = mapUsage(payloadRow.usage)
        for (const choice of payloadRow.choices ?? []) {
          const delta = choice.delta ?? {}
          const reasoning = [delta.reasoning, delta.reasoning_content, delta.reasoning_text, delta.thinking]
            .find(value => typeof value === 'string' && value !== '')
          if (reasoning !== undefined) sink.reasoning('r', reasoning)
          if (typeof delta.content === 'string') sink.text('t', delta.content)
          for (const call of delta.tool_calls ?? []) {
            const key = call.index !== undefined && call.index !== null ? `c${call.index}` : (call.id ? `cid:${call.id}` : 'c0')
            if (typeof call.function?.name === 'string' && call.function.name !== '') sink.toolStart(key, call.id ?? '', call.function.name)
            else if (call.id) sink.toolStart(key, call.id, '')
            if (call.function?.arguments) sink.toolArgs(key, call.function.arguments)
          }
          if (choice.finish_reason) finishToken = choice.finish_reason
        }
        while (outbox.length > 0) yield outbox.shift()
      }
    } catch (error) {
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
        return
      }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `stream failed: ${error?.message ?? error}`, code: 'TRANSPORT' } } }
      return
    }
    const brokenToolCall = sink.closeAll()
    while (outbox.length > 0) yield outbox.shift()

    if (sawError !== undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: sawError, code: 'SERVER' } } }
      return
    }
    if (usage !== undefined) {
      Object.assign(totalUsage, usage)
      yield { type: 'usage', usage: totalUsage }
    }
    if (sink.sawText === false && sink.sawToolCall === false && sink.sawReasoning === false && finishToken === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'empty response', code: 'EMPTY_RESPONSE' } } }
      return
    }
    yield { type: 'finish', reason: { kind: brokenToolCall ? 'max-tokens' : finishReasonKind(finishToken) } }
  }
}

function entryDescription(entry, state) {
  const bits = []
  if (entry.publisher) bits.push(entry.publisher)
  bits.push(entry.community ? 'community' : 'official')
  bits.push(`${Math.round(entry.contextWindow / 1000)}K ctx`)
  if (entry.vision) bits.push('vision')
  if (entry.tools) bits.push('tools')
  const hasKey = String(state.settings.apiKey ?? process.env.POLLINATIONS_API_KEY ?? '').trim() !== ''
  if (entry.requiresKey && !hasKey) bits.push('需 API key')
  return bits.join(' · ')
}

// ── direct transport ─────────────────────────────────────────────────────────
/**
 * A `node:https`-based fetch over the same surface this plugin consumes
 * (`{ ok, status, headers.get, body, text() }`). The global fetch is NOT used:
 * a composition may mount a proxy plugin that replaces `globalThis.fetch` and
 * re-serializes requests (billion-context does exactly this), which breaks
 * upstream gates and streaming on other lanes (the same trap dsh-our-free-model
 * documents as its issue #50). `node:https` cannot be swapped by another
 * plugin, so the bytes leave this process as we wrote them.
 */
function directFetch(url, { method = 'GET', headers = {}, body = undefined, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) { reject(new Error('request aborted')); return }
    const target = new URL(url)
    const transport = target.protocol === 'http:' ? http : https
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method,
      headers: body !== undefined
        ? { ...headers, 'content-length': Buffer.byteLength(body, 'utf8') }
        : headers,
    }, response => {
      const stream = Readable.toWeb(response)
      resolve({
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        headers: { get: name => response.headers[String(name).toLowerCase()] ?? null },
        body: stream,
        async text() {
          const chunks = []
          for await (const chunk of response) chunks.push(Buffer.from(chunk))
          return Buffer.concat(chunks).toString('utf8')
        },
      })
    })
    request.on('error', reject)
    const abort = () => request.destroy(new Error('request aborted'))
    signal?.addEventListener?.('abort', abort, { once: true })
    if (body !== undefined) request.write(body, 'utf8')
    request.end()
  })
}

// ── catalog state + sync ─────────────────────────────────────────────────────
async function getJson(url, signal) {
  const timeout = AbortSignal.timeout(20000)
  const linked = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await directFetch(url, { headers: { accept: 'application/json' }, signal: linked })
  if (!response.ok) throw new PollinationsError(`catalog HTTP ${response.status}`, 'SERVER')
  return JSON.parse(await response.text())
}

// ── loader entry ─────────────────────────────────────────────────────────────
const SETTINGS_VERSION = 1

/**
 * The plugin's own persisted settings, `~/.dsh/pollinations-free/settings.json`.
 *
 * Row config (the loader entry's `config`) stays the seed and the fallback, but
 * it is not where a settings page can write: the patch file lives next to the
 * app's other patches and rewriting it from a running plugin is exactly the
 * kind of self-edit the composition forbids. This file is the writable layer:
 * the settings page POSTs here, every apply() re-reads it over the row config,
 * and moving or reinstalling the plugin package never touches it.
 */
export function loadStoredSettings(dataDir, rowConfig) {
  const base = normalizeSettings(rowConfig)
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'))
    if (raw?.version !== SETTINGS_VERSION || typeof raw !== 'object') return base
    return normalizeSettings({ ...base, ...raw })
  } catch {
    return base
  }
}

export function saveStoredSettings(dataDir, settings) {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = path.join(dataDir, 'settings.json')
  const next = JSON.stringify({ version: SETTINGS_VERSION, ...normalizeSettings(settings), savedAt: Date.now() }, null, 2)
  fs.writeFileSync(file, next)
  return next
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  // Writable settings live under DSH_HOME (the profile-independent data home),
  // so an install that moves packages between directories keeps its values.
  const dataDir = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'pollinations-free')
  const settings = loadStoredSettings(dataDir, config)

  // Breadcrumb trail: a composition that never mounts the plugin, or mounts it
  // but whose `llm` injection never fires, is otherwise invisible without host
  // logs. This file is the plugin's own "I got here" record.
  const statusDir = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'pollinations-free')
  const statusFile = path.join(statusDir, 'status.json')
  const marks = { applyAt: Date.now(), injectAt: 0, registeredAt: 0, lastSyncAt: 0, lastError: '', catalogSize: 0, official: 0, community: 0 }
  let statusTimer = null
  const writeStatus = () => {
    try {
      fs.mkdirSync(statusDir, { recursive: true })
      fs.writeFileSync(statusFile, JSON.stringify({ ...marks, pid: process.pid }, null, 2))
    } catch { /* breadcrumbs never break the plugin */ }
  }
  // Debounced: refresh() marks every parse, and a 60-min timer keeps the file
  // fresh without a write per chunk.
  const touchStatus = () => {
    if (statusTimer !== null) return
    statusTimer = setTimeout(() => { statusTimer = null; writeStatus() }, 400)
    statusTimer.unref?.()
  }
  writeStatus()

  let catalog = []
  let membership = {}
  let disposed = false
  let timer = null
  // The adapter handle lives wherever the `llm` injection last ran; a service
  // replacement re-runs the callback and the scoped effect disposes the old
  // registration before the new one lands.
  let registration = null

  const state = () => ({ catalog, membership, settings })
  const adapter = new PollinationsAdapter({
    state,
    warn: message => logger.warn?.(message),
    resolveImage: imageResolver(ctx, logger),
  })

  function emitMembership() {
    const hasKey = settings.apiKey !== ''
    // By default every free model is advertised (that is what the user asked
    // to "load in"), and the ones that need a key carry a "需 API key" marker
    // in the picker description plus a clean error if selected. An install
    // that only wants what works right now can hide them.
    const reachable = entry => entry.lane === 'classic' || hasKey || settings.hideModelsWithoutKey !== true
    membership = {
      [ROUTE_FREE]: catalog.filter(entry => !entry.community && reachable(entry)).map(entry => entry.id),
      [ROUTE_COMMUNITY]: settings.hideCommunity === true ? []
        : catalog.filter(entry => entry.community && reachable(entry)).map(entry => entry.id),
    }
    if (!hasKey) {
      const genCount = catalog.filter(entry => entry.lane === 'gen').length
      if (genCount > 0) {
        logger.info?.(`pollinations-free: ${genCount} free models (gen official + community) answer only with an API key from https://enter.pollinations.ai/keys — put it in this plugin's config (apiKey); anonymous use covers the classic lane only (${catalog.length - genCount} models)`)
      }
    }
  }

  async function refresh({ label = 'sync' } = {}) {
    if (disposed) return
    try {
      const [genRows, classicRows] = await Promise.all([
        getJson(GEN_CATALOG).catch(error => { logger.warn?.(`pollinations-free: gen catalog failed (${error?.message})`); return [] }),
        getJson(CLASSIC_MODELS).catch(() => []),
      ])
      const rows = Array.isArray(genRows) ? genRows : Array.isArray(genRows?.models) ? genRows.models : []
      const classic = Array.isArray(classicRows) ? classicRows : []
      if (rows.length === 0 && classic.length === 0) {
        logger.warn?.('pollinations-free: both catalog sources failed; keeping the previous catalog')
        return
      }
      catalog = buildCatalog(rows, classic)
      emitMembership()
      marks.lastSyncAt = Date.now()
      marks.catalogSize = catalog.length
      marks.official = catalog.filter(e => !e.community).length
      marks.community = catalog.filter(e => e.community).length
      touchStatus()
      logger.info?.(`pollinations-free: catalog ${label} — ${catalog.filter(e => !e.community).length} official free + ${catalog.filter(e => e.community).length} community free`)
      registration?.replace(Object.keys(membership))
    } catch (error) {
      logger.warn?.(`pollinations-free: catalog refresh failed (${error?.message ?? error})`)
      marks.lastError = String(error?.message ?? error)
      touchStatus()
    }
  }

  // `ctx.inject(deps, callback)` is cordis' "run this once these services exist".
  // The `llm` service is published by a row that may not have mounted yet when a
  // plugin loads, and a direct `ctx.llm.registerAdapter` at apply time then fails
  // with `cannot get property "llm" without inject` (observed on the first
  // install of this bundle). Pending is the fix, exactly as dsh-our-free-model
  // does it for `credentials`/`commands`/`llm`.
  ctx.inject(['llm'], scoped => {
    const llm = scoped.llm
    marks.injectAt = Date.now()
    registration = llm.registerAdapter([ROUTE_FREE, ROUTE_COMMUNITY], adapter)
    marks.registeredAt = Date.now()
    writeStatus()
    scoped.effect(() => () => { registration?.(); registration = null }, 'pollinations-free: adapter routes')

    llm.registerConfigurableProviders?.([
      {
        provider: ROUTE_FREE,
        displayName: ROUTE_LABELS[ROUTE_FREE],
        settingsNs: scoped.fiber?.entry?.options?.id ?? ctx.fiber?.entry?.options?.id ?? 'pollinations-free',
        settingsPath: [],
      },
      {
        provider: ROUTE_COMMUNITY,
        displayName: ROUTE_LABELS[ROUTE_COMMUNITY],
        settingsNs: scoped.fiber?.entry?.options?.id ?? ctx.fiber?.entry?.options?.id ?? 'pollinations-free',
        settingsPath: [],
      },
    ])
    llm.registerModelDiscovery?.(
      scoped.fiber?.entry?.options?.id ?? ctx.fiber?.entry?.options?.id ?? 'pollinations-free',
      async () => {
        await refresh({ label: 'discovery' })
        const advertised = new Set(Object.values(membership).flat())
        return catalog
          .filter(entry => advertised.has(entry.id))
          .map(entry => ({
            id: entry.id,
            name: entry.name,
            contextWindow: entry.contextWindow,
            maxTokens: entry.maxOutput,
            inputModalities: entry.vision ? ['text', 'image'] : ['text'],
          }))
      },
    )

    void refresh({ label: 'boot' })
  })

  // ── settings HTTP surface (the settings page's read/write door) ────────────
  // Same-origin `/api/pollinations-free/*` routes over the host webServer, the
  // exact pattern dsh-our-free-model uses. GET serves the live values plus a
  // redacted catalog count; POST merges the patch, persists it to the settings
  // file, and re-applies it live (membership + next refresh cadence) without a
  // restart. The key never leaves the host: GET reports only whether one is
  // set, and POST accepts it without echoing it back.
  const publicSettings = () => ({
    ...settings,
    apiKeySet: settings.apiKey !== '',
    apiKey: '',
  })
  const applySettingsPatch = patch => {
    const next = normalizeSettings({ ...settings, ...patch })
    // The page never sends a key back it did not receive, so an empty
    // `apiKey` in a patch means "keep the stored one" — clearing the key is
    // the explicit `clearApiKey: true` flag instead.
    if (typeof patch?.apiKey === 'string' && patch.apiKey.trim() === '' && patch.clearApiKey !== true) next.apiKey = settings.apiKey
    Object.assign(settings, next)
    saveStoredSettings(dataDir, settings)
    emitMembership()
    registration?.replace(Object.keys(membership))
    // Re-arm the catalog timer when the cadence changed.
    if (timer !== null) { clearInterval(timer) }
    timer = setInterval(() => void refresh({ label: 'periodic' }), Math.max(5, settings.refreshMinutes ?? 60) * 60_000)
    timer.unref?.()
    void refresh({ label: 'settings-saved' })
    return publicSettings()
  }

  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    const api = async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const routePath = url.pathname.replace(/\/+$/, '') || '/'
      const send = (status, body) => {
        if (res.writableEnded) return
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method === 'GET' && routePath === '/api/pollinations-free/settings') {
          return send(200, { ok: true, settings: publicSettings(), catalogSize: catalog.length, official: catalog.filter(e => !e.community).length, community: catalog.filter(e => e.community).length, lastSyncAt: marks.lastSyncAt, lastError: marks.lastError })
        }
        if (req.method === 'POST' && routePath === '/api/pollinations-free/settings') {
          let raw = ''
          for await (const chunk of req) { raw += chunk; if (raw.length > 65536) break }
          let patch
          try { patch = JSON.parse(raw || '{}') } catch { return send(400, { error: 'invalid JSON body' }) }
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return send(400, { error: 'body must be a JSON object' })
          const settingsOut = applySettingsPatch(patch)
          return send(200, { ok: true, settings: settingsOut })
        }
        if (req.method === 'POST' && routePath === '/api/pollinations-free/refresh') {
          await refresh({ label: 'manual' })
          return send(200, { ok: true, catalogSize: catalog.length, official: catalog.filter(e => !e.community).length, community: catalog.filter(e => e.community).length, lastSyncAt: marks.lastSyncAt, lastError: marks.lastError })
        }
        return send(404, { error: 'not found' })
      } catch (error) {
        logger.warn?.(`pollinations-free: api ${req.method} ${routePath} failed (${error?.message ?? error})`)
        return send(500, { error: 'internal error' })
      }
    }
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/pollinations-free', handler: api }), 'pollinations-free: settings api')
  })

  timer = setInterval(() => void refresh({ label: 'periodic' }), Math.max(5, settings.refreshMinutes ?? 60) * 60_000)
  timer.unref?.()
  // cordis `effect(setup)` runs setup NOW and keeps its RETURN value as the
  // disposer. Passing the teardown itself would run it at boot (and mark the
  // plugin disposed before its first refresh ever fired).
  if (typeof ctx.effect === 'function') ctx.effect(() => () => { disposed = true; clearInterval(timer) }, 'pollinations-free: catalog timer')
  else ctx.on?.('dispose', () => { disposed = true; clearInterval(timer) })
}

function normalizeSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: source.enabled !== false,
    apiKey: typeof source.apiKey === 'string' ? source.apiKey.trim() : '',
    hideCommunity: source.hideCommunity === true,
    hideModelsWithoutKey: source.hideModelsWithoutKey === true,
    preferGenApi: source.preferGenApi === true,
    referrer: typeof source.referrer === 'string' ? source.referrer : 'dsh-pollinations-free',
    defaultMaxTokens: number(source.defaultMaxTokens) ?? 32768,
    refreshMinutes: number(source.refreshMinutes) ?? 60,
  }
}

/** Read an attachment image as a data URL through the host attachments service. */
function imageResolver(ctx, logger) {
  if (typeof ctx.get !== 'function') return undefined
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  return ref => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      if (fs.statSync(hostPath).size > MAX_IMAGE_BYTES) return undefined
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`pollinations-free: could not read image ${id} (${error?.message ?? error})`)
      return undefined
    }
  }
}

/**
 * Row Config schema so Settings can show this plugin's fields.
 *
 * The projected shape (same as dsh-unlag) is a `uid` + numeric `refs` table of
 * field nodes, plus a root object node whose `dict` maps field names to ref
 * numbers; the plain field nodes ride again under `Config.dict` for value
 * projection. A flat dict of plain nodes WITHOUT `uid`/`refs` is not projected
 * into a form — which is why the first version of this plugin showed no
 * settings section in the UI. Validation never throws: a rejected row config
 * would fail the entry at boot, so anything unreadable falls back to defaults.
 */
const FIELDS = {
  enabled: { type: 'boolean', meta: { default: true, description: '总开关：关闭后模型从选择器消失' } },
  apiKey: { type: 'string', meta: { default: '', description: 'enter.pollinations.ai/keys 免费领取的 API Key：填入后官方 gen 通道与社区模型全部解锁；留空则只有经典匿名通道稳定可用' } },
  hideCommunity: { type: 'boolean', meta: { default: false, description: '隐藏社区模型分组' } },
  hideModelsWithoutKey: { type: 'boolean', meta: { default: false, description: '没有填 key 时隐藏需要 key 的模型（默认全部显示，选中时给出提示）' } },
  preferGenApi: { type: 'boolean', meta: { default: false, description: '匿名可用模型也改走 gen.pollinations.ai（更全的 usage 上报）' } },
  referrer: { type: 'string', meta: { default: 'dsh-pollinations-free', description: '上报给 pollinations 的 referrer 标识' } },
  defaultMaxTokens: { type: 'number', meta: { default: 32768, description: '默认输出上限（不会超过模型自身上限）' } },
  refreshMinutes: { type: 'number', meta: { default: 60, description: '模型目录自动刷新间隔（分钟）' } },
}

const NAMES = Object.keys(FIELDS)
const ROOT_REF = NAMES.length + 2
const SCHEMA = {
  uid: ROOT_REF, // ui-copy-ignore
  refs: {
    // ui-copy-ignore
    ...Object.fromEntries(NAMES.map((name, i) => [i + 2, FIELDS[name]])),
    // ui-copy-ignore
    [ROOT_REF]: {
      type: 'object',
      meta: { default: {} },
      dict: Object.fromEntries(NAMES.map((name, i) => [name, i + 2])),
    },
  },
}

export const Config = {
  ...SCHEMA,
  type: 'object', // ui-copy-ignore
  dict: FIELDS, // ui-copy-ignore
  meta: { default: {} }, // ui-copy-ignore
  toJSON() {
    return SCHEMA
  },
  '~standard': {
    version: 1, // ui-copy-ignore
    vendor: 'dsh-pollinations-free', // ui-copy-ignore
    validate(value) {
      return { value: normalizeSettings(value) }
    },
  },
}
