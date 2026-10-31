/**
 * Pollinations Free — browser half.
 *
 * Contributes one thing to the web shell: a settings section
 * (`settings.section` id `pollinations-free`) holding this plugin's switches —
 * the API key gate, the two visibility toggles, the referrer, the output
 * ceiling and the catalog cadence — plus a manual catalog refresh.
 *
 * Data rides the plugin's own same-origin `/api/pollinations-free/*` routes
 * served by the host process (the pattern dsh-our-free-model established).
 * The API key is stored host-side only: GET never returns it, and POST
 * accepts it without echoing it back.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. Colour comes from theme variables.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pollinations-free',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const zh = () => /^zh(-|$)/i.test(document?.documentElement?.lang || navigator.language || '')
    const T = {
      nav: () => (zh() ? 'Pollinations 免费模型' : 'Pollinations Free'),
      title: () => (zh() ? 'Pollinations 免费模型' : 'Pollinations Free'),
      desc: () => (zh()
        ? '把 enter.pollinations.ai 上的免费模型（官方 + 社区）装载进模型选择器。目录自动同步，改动立即生效。'
        : 'Loads the free models from enter.pollinations.ai (official + community) into the model picker. The catalog syncs itself; changes apply immediately.'),
      apiKeyLabel: () => (zh() ? 'API Key' : 'API key'),
      apiKeyHint: () => (zh()
        ? '留空 = 只用匿名经典通道（openai-fast）。去 enter.pollinations.ai/keys 免费领取一个，填进来即解锁官方 gen 通道与全部社区模型。保存后不会回显，只显示「已设置」。'
        : 'Empty = anonymous classic lane only (openai-fast). Get a free one at enter.pollinations.ai/keys to unlock the gen lane and every community model. Saved keys are never shown back; only "set" is displayed.'),
      apiKeySet: () => (zh() ? '已设置' : 'set'),
      apiKeyUnset: () => (zh() ? '未设置' : 'not set'),
      keyPlaceholder: () => (zh() ? '粘贴新的 API Key（留空保持不变）' : 'paste a new key (leave empty to keep the current one)'),
      clearKey: () => (zh() ? '清除已存的 Key' : 'clear the stored key'),
      save: () => (zh() ? '保存' : 'Save'),
      saved: () => (zh() ? '已保存，改动已生效' : 'Saved and applied'),
      saving: () => (zh() ? '保存中…' : 'Saving…'),
      refresh: () => (zh() ? '刷新模型目录' : 'Refresh catalog'),
      refreshing: () => (zh() ? '刷新中…' : 'Refreshing…'),
      catalog: n => (zh() ? `目录共 ${n} 个免费模型` : `${n} free models in the catalog`),
      enabled: () => (zh() ? '启用插件（关闭后模型从选择器消失）' : 'Enable the plugin (off hides its models)'),
      hideCommunity: () => (zh() ? '隐藏社区模型分组' : 'Hide the community group'),
      hideWithoutKey: () => (zh() ? '没有 key 时隐藏需要 key 的模型' : 'Hide models that need a key while no key is set'),
      preferGen: () => (zh() ? '匿名可用模型也走 gen 网关' : 'Route anonymous models via the gen gateway too'),
      referrerLabel: () => (zh() ? 'referrer 标识' : 'referrer'),
      referrerHint: () => (zh() ? '仅匿名经典通道发送，用于上游归因' : 'sent on the anonymous classic lane only, for upstream attribution'),
      maxTokensLabel: () => (zh() ? '默认输出上限' : 'Default output ceiling'),
      refreshLabel: () => (zh() ? '目录刷新间隔（分钟）' : 'Catalog refresh interval (minutes)'),
      error: e => (zh() ? `出错了：${e}` : `Something failed: ${e}`),
      needRestartNote: () => (zh() ? '改动即时生效，无需重启。' : 'Changes apply immediately; no restart needed.'),
    }

    const api = async (path, options) => {
      const response = await fetch(new URL(`api/pollinations-free${path}`, document.baseURI), {
        cache: 'no-store',
        credentials: 'same-origin',
        ...options,
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data?.ok === false) throw new Error(data?.error ?? `HTTP ${response.status}`)
      return data
    }

    const Row = ({ label, hint, children }) => h('div', { style: ROW_STYLE },
      h('div', { style: LABEL_COL },
        h('div', { style: LABEL_STYLE }, label),
        hint ? h('div', { style: HINT_STYLE }, hint) : null),
      h('div', { style: CONTROL_COL }, children))

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '6px 10px',
      borderRadius: 8, border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
      background: 'var(--dsh-color-surface, transparent)',
      color: 'inherit', fontSize: 13, outline: 'none',
    }
    const buttonStyle = {
      padding: '6px 14px', borderRadius: 8, border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.35))',
      background: 'var(--dsh-color-surface, transparent)', color: 'inherit',
      fontSize: 13, cursor: 'pointer',
    }

    function SettingsPage() {
      const [state, setState] = useState(undefined)
      const [keyDraft, setKeyDraft] = useState('')
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')

      const load = useCallback(() => {
        api('/settings').then(data => setState(data)).catch(e => setError(String(e?.message ?? e)))
      }, [])
      useEffect(() => { load() }, [load])

      const save = async patch => {
        setBusy(true); setError(''); setNote('')
        try {
          const data = await api('/settings', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          setState(current => ({ ...current, settings: data.settings }))
          setNote(T.saved())
          setKeyDraft('')
        } catch (e) { setError(T.error(e?.message ?? e)) } finally { setBusy(false) }
      }
      const refreshCatalog = async () => {
        setBusy(true); setError(''); setNote('')
        try {
          const data = await api('/refresh', { method: 'POST' })
          setState(current => ({ ...current, ...data }))
          setNote(T.catalog(data.catalogSize))
        } catch (e) { setError(T.error(e?.message ?? e)) } finally { setBusy(false) }
      }

      if (state === undefined) return h('div', { style: PAGE_STYLE }, zh() ? '加载中…' : 'Loading…')
      const s = state.settings

      return h('div', { style: PAGE_STYLE },
        h('h3', { style: TITLE_STYLE }, T.title()),
        h('p', { style: DESC_STYLE }, T.desc()),
        h('div', { style: CARD_STYLE },
          h(Row, { label: T.apiKeyLabel(), hint: T.apiKeyHint() },
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch', maxWidth: 420 } },
              h('div', { style: { fontSize: 12, opacity: 0.75 } },
                s.apiKeySet ? `● ${T.apiKeySet()}` : `○ ${T.apiKeyUnset()}`),
              h('input', {
                style: inputStyle, type: 'password', autoComplete: 'off',
                placeholder: T.keyPlaceholder(), value: keyDraft,
                onChange: event => setKeyDraft(event.target.value),
              }),
              h('div', { style: { display: 'flex', gap: 8 } },
                h('button', {
                  style: buttonStyle, disabled: busy,
                  onClick: () => save({ apiKey: keyDraft.trim() }),
                }, busy ? T.saving() : T.save()),
                s.apiKeySet ? h('button', {
                  style: buttonStyle, disabled: busy,
                  onClick: () => save({ apiKey: '', clearApiKey: true }),
                }, T.clearKey()) : null))),
          h(Row, { label: T.enabled() },
            h('input', { type: 'checkbox', checked: s.enabled !== false, disabled: busy, onChange: e => save({ enabled: e.target.checked }) })),
          h(Row, { label: T.hideCommunity() },
            h('input', { type: 'checkbox', checked: s.hideCommunity === true, disabled: busy, onChange: e => save({ hideCommunity: e.target.checked }) })),
          h(Row, { label: T.hideWithoutKey() },
            h('input', { type: 'checkbox', checked: s.hideModelsWithoutKey === true, disabled: busy, onChange: e => save({ hideModelsWithoutKey: e.target.checked }) })),
          h(Row, { label: T.preferGen() },
            h('input', { type: 'checkbox', checked: s.preferGenApi === true, disabled: busy, onChange: e => save({ preferGenApi: e.target.checked }) })),
          h(Row, { label: T.referrerLabel(), hint: T.referrerHint() },
            h('input', { style: { ...inputStyle, maxWidth: 280 }, value: s.referrer ?? '', disabled: busy, onChange: e => { s.referrer = e.target.value; setState(current => ({ ...current, settings: { ...s } })) }, onBlur: () => save({ referrer: s.referrer }) })),
          h(Row, { label: T.maxTokensLabel() },
            h('input', { style: { ...inputStyle, maxWidth: 140 }, type: 'number', min: 1024, max: 200000, value: s.defaultMaxTokens ?? 32768, disabled: busy, onChange: e => { s.defaultMaxTokens = Number(e.target.value); setState(current => ({ ...current, settings: { ...s } })) }, onBlur: () => save({ defaultMaxTokens: s.defaultMaxTokens }) })),
          h(Row, { label: T.refreshLabel() },
            h('input', { style: { ...inputStyle, maxWidth: 140 }, type: 'number', min: 5, max: 1440, value: s.refreshMinutes ?? 60, disabled: busy, onChange: e => { s.refreshMinutes = Number(e.target.value); setState(current => ({ ...current, settings: { ...s } })) }, onBlur: () => save({ refreshMinutes: s.refreshMinutes }) })),
          h('div', { style: { ...ROW_STYLE, alignItems: 'center' } },
            h('button', { style: buttonStyle, disabled: busy, onClick: refreshCatalog }, busy ? T.refreshing() : T.refresh()),
            h('span', { style: { fontSize: 12, opacity: 0.7 } },
              state.catalogSize !== undefined ? T.catalog(state.catalogSize) : ''))),
        note ? h('p', { style: NOTE_STYLE }, note) : null,
        error ? h('p', { style: ERROR_STYLE }, error) : null,
        h('p', { style: HINT_STYLE }, T.needRestartNote()))
    }

    const PAGE_STYLE = { maxWidth: 720, padding: '8px 4px 40px', color: 'var(--dsh-color-text, inherit)' }
    const TITLE_STYLE = { margin: '4px 0 6px', fontSize: 18 }
    const DESC_STYLE = { margin: '0 0 18px', fontSize: 13, opacity: 0.75, lineHeight: 1.6 }
    const CARD_STYLE = { display: 'flex', flexDirection: 'column', gap: 18, padding: '18px 20px', borderRadius: 12, border: '1px solid var(--dsh-color-border, rgba(127,127,127,0.25))', background: 'var(--dsh-color-surface, transparent)' }
    const ROW_STYLE = { display: 'flex', gap: 16 }
    const LABEL_COL = { width: 260, flexShrink: 0 }
    const CONTROL_COL = { flex: 1, minWidth: 0 }
    const LABEL_STYLE = { fontSize: 13, fontWeight: 600 }
    const HINT_STYLE = { fontSize: 12, opacity: 0.6, lineHeight: 1.55, marginTop: 4 }
    const NOTE_STYLE = { margin: '14px 0 0', fontSize: 13, color: 'var(--dsh-color-success, #2c8a4b)' }
    const ERROR_STYLE = { margin: '14px 0 0', fontSize: 13, color: 'var(--dsh-color-danger, #c0392b)' }

    const inject = ['slots']
    return {
      inject,
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'pollinations-free',
          order: 36,
          label: T.nav,
        }, () => h(SettingsPage)))
      },
    }
  },
})
