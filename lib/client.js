// ============================================================================
// dsh-downloader —— DSH 下载代理插件（浏览器/客户端半部）
//
// 职责：在「设置 → 下载代理」里挂一个管理面板
//   1. 编辑插件 Config（经 ctx.get('configForms').get('dsh-downloader')）
//   2. 轮询 /dsh-downloader/status 与 /proxies 显示实时状态
//   3. 更新订阅 / 重启内核 / 逐节点测速与选择
//
// 以预打包 bundle 形式随插件安装，格式与官方 client 插件一致
// （window.__ModuleLoader__）。注意：0.1.7 起 ctx.settingsScope 已删除，
// 必须惰性走 ctx.configForms；且 scope.subscribe / getSnapshot 是类原型方法，
// 直接传给 useSyncExternalStore 会因 this 丢失而崩，必须包一层闭包。
// ============================================================================
window.__ModuleLoader__.load({
  id: '@having5548/dsh-downloader',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')

    // ------------------------------------------------------------------
    // 常量
    // ------------------------------------------------------------------
    var ENTRY_ID = 'dsh-downloader'
    var LOCALE_NS = 'dsh-downloader'
    var API_BASE = '/dsh-downloader/'

    var DEFAULTS = {
      enabled: true,
      proxyUrl: '',
      subscriptionUrl: '',
      fetchProxyUrl: '',
      autoUpdateHours: 24,
      groupType: 'url-test',
      preferredNode: '',
      latencyTestUrl: 'http://www.gstatic.com/generate_204',
      latencyTimeoutMs: 3000,
      domesticDirect: true,
      protectAiPlatforms: true,
      extraDirectDomains: [],
      extraRules: [],
      excludeRules: [],
      downloadDir: '',
      maxDownloadMb: 512,
      downloadTimeoutS: 600,
      stallTimeoutS: 30,
      insecureTls: false,
      allowOutsideWorkspace: false,
      maxRedirects: 10
    }

    var LOCALE_ZH = {
      nav: '下载代理',
      title: '下载代理',
      intro: '让模型下载境外文件时自动走代理、境内直连。代理出口由插件自带的订阅内核提供，不依赖本机 Clash。',
      upstream: '上游',
      nodes: '节点',
      rules: '分流规则',
      download: '下载',
      refresh: '刷新',
      restart: '重启内核',
      updateSubscription: '更新订阅',
      testAll: '全部测速',
      select: '选择',
      test: '测速',
      clearLatency: '清空延迟',
      sessionGuard: '会话保护',
      guardIntro: '把国内 AI 平台域名写进 $DSH_HOME/.env 的 NO_PROXY，让模型连接绕开全局代理 —— 代理程序关掉或节点抖动都不会断链。写入前会自动备份。',
      guardApply: '写入 NO_PROXY',
      guardRestore: '还原备份',
      guardCovered: '已覆盖',
      guardMissing: '缺少',
      guardNoProxyVars: '该文件没有配置 HTTP_PROXY / HTTPS_PROXY，此项暂时无效',
      guardRestart: '改完需要重启 DSH 才生效',
      notRunning: '未运行',
      stRunning: '运行中',
      stDisabled: '已关闭',
      stNoSubscription: '无可用订阅',
      stFailed: '失败',
      stIdle: '未启动',
      mdExplicit: '上游：配置的 proxyUrl',
      mdEnvironment: '上游：启动环境代理',
      mdSubscription: '上游：自包含订阅',
      mdNone: '上游：未配置',
      nodesBadge: '节点',
      unavailable: '当前环境无法持久化设置，本次修改仅当前页面生效。'
    }
    var LOCALE_EN = {
      nav: 'Download proxy',
      title: 'Download proxy',
      intro: 'Routes foreign downloads through a proxy and keeps domestic targets direct. The proxy exit comes from the plugin\'s own subscription core — no local Clash needed.',
      upstream: 'Upstream',
      nodes: 'Nodes',
      rules: 'Rules',
      download: 'Download',
      refresh: 'Refresh',
      restart: 'Restart core',
      updateSubscription: 'Update subscription',
      testAll: 'Test all',
      select: 'Select',
      test: 'Test',
      clearLatency: 'Clear latencies',
      sessionGuard: 'Session guard',
      guardIntro: 'Writes the Chinese AI platform domains into NO_PROXY in $DSH_HOME/.env so model connections bypass the global proxy — closing the proxy app or losing a node cannot break the session. The file is backed up before any write.',
      guardApply: 'Write NO_PROXY',
      guardRestore: 'Restore backup',
      guardCovered: 'covered',
      guardMissing: 'missing',
      guardNoProxyVars: 'That file sets no HTTP_PROXY / HTTPS_PROXY, so this entry is inert for now',
      guardRestart: 'Restart DSH for the change to take effect',
      notRunning: 'not running',
      stRunning: 'running',
      stDisabled: 'disabled',
      stNoSubscription: 'no usable subscription',
      stFailed: 'failed',
      stIdle: 'idle',
      mdExplicit: 'upstream: configured proxyUrl',
      mdEnvironment: 'upstream: launch environment',
      mdSubscription: 'upstream: self-contained subscription',
      mdNone: 'upstream: not configured',
      nodesBadge: 'nodes',
      unavailable: 'Settings cannot be persisted in this environment; changes apply to this page only.'
    }

    // ------------------------------------------------------------------
    // 工具函数
    // ------------------------------------------------------------------
    function formatBytes(value) {
      var n = Number(value) || 0
      var units = ['B', 'KB', 'MB', 'GB', 'TB']
      var i = 0
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
      return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + ' ' + units[i]
    }

    function formatTime(ts) {
      if (ts === null || ts === undefined) return '—'
      try { return new Date(ts).toLocaleString() } catch (e) { return String(ts) }
    }

    function linesToArray(text) {
      return String(text || '')
        .split(/\r?\n/)
        .map(function (line) { return line.trim() })
        .filter(function (line) { return line.length > 0 })
    }

    function arrayToLines(list) {
      return Array.isArray(list) ? list.join('\n') : ''
    }

    // 状态 / 上游模式的展示名（原始值仍是英文标识符，只翻译给人看的那一份）
    var STATE_KEYS = { running: 'stRunning', disabled: 'stDisabled', 'no-subscription': 'stNoSubscription', failed: 'stFailed', idle: 'stIdle' }
    var MODE_KEYS = { explicit: 'mdExplicit', environment: 'mdEnvironment', subscription: 'mdSubscription', none: 'mdNone' }

    function labelOf(map, value, translate) {
      var key = map[value]
      return key ? translate(key) : (value || '?')
    }

    // ------------------------------------------------------------------
    // 样式（沿用 DSH 语义化 CSS 变量，自动适配明暗主题）
    // ------------------------------------------------------------------
    var CSS = [
      '.dshdl{display:flex;flex-direction:column;gap:16px}',
      '.dshdl-title{font-size:15px;font-weight:600;margin:0}',
      '.dshdl-desc{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary,#5b616b);margin:0}',
      '.dshdl-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-2,transparent)}',
      '.dshdl-cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.dshdl-cardTitle{font-size:13px;font-weight:600}',
      '.dshdl-badges{display:flex;gap:6px;flex-wrap:wrap}',
      '.dshdl-badge{font-size:11.5px;line-height:16px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));color:var(--dsw-alias-label-secondary,#5b616b)}',
      '.dshdl-badge.dshdl-ok{border-color:var(--dsw-alias-state-success-primary,#2fa95e);color:var(--dsw-alias-state-success-primary,#2fa95e)}',
      '.dshdl-badge.dshdl-warn{border-color:var(--dsw-alias-state-warn-primary,#d9822b);color:var(--dsw-alias-state-warn-primary,#d9822b)}',
      '.dshdl-badge.dshdl-err{border-color:var(--dsw-alias-state-error-primary,#d64545);color:var(--dsw-alias-state-error-primary,#d64545)}',
      '.dshdl-row{display:grid;grid-template-columns:minmax(140px,220px) 1fr;gap:10px;align-items:center}',
      '.dshdl-label{font-size:12.5px;color:var(--dsw-alias-label-secondary,#5b616b)}',
      '.dshdl-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8f98);grid-column:2}',
      '.dshdl-input,.dshdl-select,.dshdl-area{width:100%;box-sizing:border-box;font:inherit;font-size:12.5px;padding:5px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}',
      '.dshdl-area{min-height:62px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.dshdl-check{width:15px;height:15px}',
      '.dshdl-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.dshdl-btn{font:inherit;font-size:12.5px;padding:5px 11px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.16));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);cursor:pointer}',
      '.dshdl-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dshdl-btn:disabled{opacity:.5;cursor:default}',
      '.dshdl-btn.dshdl-small{font-size:11.5px;padding:3px 8px}',
      '.dshdl-nodes{max-height:280px;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px}',
      '.dshdl-node{display:flex;align-items:center;gap:8px;padding:5px 9px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))}',
      '.dshdl-node:last-child{border-bottom:none}',
      '.dshdl-node.dshdl-active{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dshdl-nodeName{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshdl-nodeMeta{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11.5px;white-space:nowrap}',
      '.dshdl-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#d64545);white-space:pre-wrap;word-break:break-word}',
      '.dshdl-warn{font-size:12px;color:var(--dsw-alias-state-warn-primary,#d9822b)}',
      '.dshdl-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98);padding:8px 2px}'
    ].join('')

    function ensureCss() {
      try {
        if (document.getElementById('dsh-downloader-style')) return
        var el = document.createElement('style')
        el.id = 'dsh-downloader-style'
        el.textContent = CSS
        document.head.appendChild(el)
      } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // 面板
    // ------------------------------------------------------------------
    function Field(props) {
      var label = props.label
      var hint = props.hint
      var value = props.value
      var onChange = props.onChange
      var onCommit = props.onCommit
      var type = props.type || 'text'
      var disabled = !!props.disabled

      var control
      if (type === 'bool') {
        control = React.createElement('input', {
          className: 'dshdl-check',
          type: 'checkbox',
          checked: !!value,
          disabled: disabled,
          onChange: function (e) { onChange(e.target.checked) }
        })
      } else if (type === 'select') {
        control = React.createElement('select', {
          className: 'dshdl-select',
          value: value,
          disabled: disabled,
          onChange: function (e) { onChange(e.target.value); if (onCommit) onCommit(e.target.value) }
        }, (props.options || []).map(function (option) {
          return React.createElement('option', { key: option.value, value: option.value }, option.label)
        }))
      } else if (type === 'textarea') {
        control = React.createElement('textarea', {
          className: 'dshdl-area',
          value: value,
          disabled: disabled,
          spellCheck: false,
          onChange: function (e) { onChange(e.target.value) },
          onBlur: function () { if (onCommit) onCommit(value) }
        })
      } else {
        control = React.createElement('input', {
          className: 'dshdl-input',
          type: type === 'number' ? 'number' : 'text',
          value: value,
          disabled: disabled,
          spellCheck: false,
          onChange: function (e) { onChange(e.target.value) },
          onBlur: function () { if (onCommit) onCommit(value) },
          onKeyDown: function (e) { if (e.key === 'Enter' && onCommit) onCommit(value) }
        })
      }
      return React.createElement('div', { className: 'dshdl-row' },
        React.createElement('span', { className: 'dshdl-label' }, label),
        control,
        hint ? React.createElement('span', { className: 'dshdl-hint' }, hint) : null)
    }

    function DownloaderSection(props) {
      var scope = props.scope
      var t = props.t || function (key) { return key }

      // scope.subscribe / getSnapshot 是类原型方法：必须包一层闭包保住 this。
      var snap = scope
        ? React.useSyncExternalStore(
            function (listener) { return scope.subscribe(listener) },
            function () { return scope.getSnapshot() })
        : { status: 'unavailable', value: undefined }

      var stored = Object.assign({}, DEFAULTS, (snap && snap.value) || {})
      var [draft, setDraft] = React.useState({})
      var [status, setStatus] = React.useState(null)
      var [nodes, setNodes] = React.useState([])
      var [groups, setGroups] = React.useState([])
      var [guard, setGuard] = React.useState(null)
      var [busy, setBusy] = React.useState(null)
      var [error, setError] = React.useState(null)

      var value = Object.assign({}, stored, draft)

      function set(field, next) {
        setDraft(function (prev) { var copy = Object.assign({}, prev); copy[field] = next; return copy })
      }

      function commit(field, next) {
        if (!scope) return
        setDraft(function (prev) { var copy = Object.assign({}, prev); delete copy[field]; return copy })
        try {
          var promise = scope.set(field, next)
          if (promise && typeof promise.catch === 'function') {
            promise.catch(function (e) { setError(String((e && e.message) || e)) })
          }
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }

      function commitBool(field, next) {
        set(field, next)
        commit(field, next)
      }

      function commitNumber(field, raw) {
        var parsed = Number(raw)
        if (!isFinite(parsed)) { commit(field, stored[field]); return }
        commit(field, parsed)
      }

      var api = React.useCallback(function (path, body) {
        return fetch(API_BASE + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body)
        }).then(function (response) {
          return response.text().then(function (text) {
            var payload = text.length > 0 ? JSON.parse(text) : {}
            if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status))
            return payload
          })
        })
      }, [])

      var loadStatus = React.useCallback(function (refresh) {
        return api('status' + (refresh ? '?refresh=1' : ''))
          .then(function (payload) { setStatus(payload); setError(null) })
          .catch(function (e) { setError(String((e && e.message) || e)) })
      }, [api])

      var loadNodes = React.useCallback(function () {
        return api('proxies')
          .then(function (payload) { setNodes(payload.nodes || []); setGroups(payload.groups || []) })
          .catch(function () { /* status carries the error */ })
      }, [api])

      var loadGuard = React.useCallback(function () {
        return api('guard')
          .then(function (payload) { setGuard(payload) })
          .catch(function () { /* non-fatal */ })
      }, [api])

      React.useEffect(function () {
        ensureCss()
        loadStatus(false)
        loadNodes()
        loadGuard()
        var statusTimer = setInterval(function () { loadStatus(false); loadGuard() }, 5000)
        var nodeTimer = setInterval(function () { loadNodes() }, 15000)
        return function () { clearInterval(statusTimer); clearInterval(nodeTimer) }
      }, [loadStatus, loadNodes, loadGuard])

      function run(label, task) {
        setBusy(label)
        setError(null)
        Promise.resolve()
          .then(task)
          .catch(function (e) { setError(String((e && e.message) || e)) })
          .then(function () { setBusy(null) })
      }

      var stateBadgeClass = 'dshdl-badge'
      if (status) {
        if (status.state === 'running') stateBadgeClass += ' dshdl-ok'
        else if (status.state === 'failed') stateBadgeClass += ' dshdl-err'
        else stateBadgeClass += ' dshdl-warn'
      }

      var upstreamRows = [
        React.createElement(Field, { key: 'proxyUrl', label: 'proxyUrl', value: value.proxyUrl, type: 'text',
          hint: '显式上游，支持 http:// 与 socks5://。填了就不再用订阅。',
          onChange: function (v) { set('proxyUrl', v) }, onCommit: function (v) { commit('proxyUrl', v) } }),
        React.createElement(Field, { key: 'subscriptionUrl', label: 'subscriptionUrl', value: value.subscriptionUrl, type: 'text',
          hint: 'Clash 订阅地址。自包含内核从这里取节点，不需要本机装 Clash。',
          onChange: function (v) { set('subscriptionUrl', v) }, onCommit: function (v) { commit('subscriptionUrl', v) } }),
        React.createElement(Field, { key: 'fetchProxyUrl', label: 'fetchProxyUrl', value: value.fetchProxyUrl, type: 'text',
          hint: '仅用于抓订阅本身（订阅被墙时填），必须是 http(s):// 代理。',
          onChange: function (v) { set('fetchProxyUrl', v) }, onCommit: function (v) { commit('fetchProxyUrl', v) } }),
        React.createElement(Field, { key: 'groupType', label: 'groupType', value: value.groupType, type: 'select',
          options: [
            { value: 'url-test', label: 'url-test（自动最快）' },
            { value: 'select', label: 'select（手动）' },
            { value: 'fallback', label: 'fallback（失败切换）' }
          ],
          onChange: function (v) { set('groupType', v) }, onCommit: function (v) { commit('groupType', v) } }),
        React.createElement(Field, { key: 'preferredNode', label: 'preferredNode', value: value.preferredNode, type: 'text',
          hint: '按名字固定一个节点，优先级最高。',
          onChange: function (v) { set('preferredNode', v) }, onCommit: function (v) { commit('preferredNode', v) } }),
        React.createElement(Field, { key: 'autoUpdateHours', label: 'autoUpdateHours', value: value.autoUpdateHours, type: 'number',
          hint: '订阅自动更新间隔（小时，0 关闭）。',
          onChange: function (v) { set('autoUpdateHours', v) }, onCommit: function (v) { commitNumber('autoUpdateHours', v) } }),
        React.createElement(Field, { key: 'latencyTestUrl', label: 'latencyTestUrl', value: value.latencyTestUrl, type: 'text',
          onChange: function (v) { set('latencyTestUrl', v) }, onCommit: function (v) { commit('latencyTestUrl', v) } }),
        React.createElement(Field, { key: 'latencyTimeoutMs', label: 'latencyTimeoutMs', value: value.latencyTimeoutMs, type: 'number',
          onChange: function (v) { set('latencyTimeoutMs', v) }, onCommit: function (v) { commitNumber('latencyTimeoutMs', v) } })
      ]

      var rulesRows = [
        React.createElement(Field, { key: 'protectAiPlatforms', label: 'protectAiPlatforms', value: value.protectAiPlatforms, type: 'bool',
          hint: '国内 AI 平台域名（DeepSeek / 智谱 / Kimi / 通义 / 豆包 / 文心 / 混元 / 星火 / MiniMax …）强制直连，优先级高于一切规则，连"全部走代理"模式也不例外。',
          onChange: function (v) { commitBool('protectAiPlatforms', v) } }),
        React.createElement(Field, { key: 'domesticDirect', label: 'domesticDirect', value: value.domesticDirect, type: 'bool',
          hint: '开：境内直连、境外走代理。关：所有下载都走代理（AI 平台仍直连）。',
          onChange: function (v) { commitBool('domesticDirect', v) } }),
        React.createElement(Field, { key: 'extraDirectDomains', label: 'extraDirectDomains', value: arrayToLines(value.extraDirectDomains), type: 'textarea',
          hint: '每行一个域名或完整 URL，加进强制直连名单。',
          onChange: function (v) { set('extraDirectDomains', v) }, onCommit: function (v) { commit('extraDirectDomains', linesToArray(v)) } }),
        React.createElement(Field, { key: 'extraRules', label: 'extraRules', value: arrayToLines(value.extraRules), type: 'textarea',
          hint: '每行一条，如 DOMAIN-SUFFIX,example.com,DIRECT。',
          onChange: function (v) { set('extraRules', v) }, onCommit: function (v) { commit('extraRules', linesToArray(v)) } }),
        React.createElement(Field, { key: 'excludeRules', label: 'excludeRules', value: arrayToLines(value.excludeRules), type: 'textarea',
          hint: '每行一条，从订阅规则里剔除（子串匹配）。',
          onChange: function (v) { set('excludeRules', v) }, onCommit: function (v) { commit('excludeRules', linesToArray(v)) } })
      ]

      var downloadRows = [
        React.createElement(Field, { key: 'downloadDir', label: 'downloadDir', value: value.downloadDir, type: 'text',
          hint: '空 = $DSH_HOME/downloads。',
          onChange: function (v) { set('downloadDir', v) }, onCommit: function (v) { commit('downloadDir', v) } }),
        React.createElement(Field, { key: 'maxDownloadMb', label: 'maxDownloadMb', value: value.maxDownloadMb, type: 'number',
          onChange: function (v) { set('maxDownloadMb', v) }, onCommit: function (v) { commitNumber('maxDownloadMb', v) } }),
        React.createElement(Field, { key: 'downloadTimeoutS', label: 'downloadTimeoutS', value: value.downloadTimeoutS, type: 'number',
          onChange: function (v) { set('downloadTimeoutS', v) }, onCommit: function (v) { commitNumber('downloadTimeoutS', v) } }),
        React.createElement(Field, { key: 'stallTimeoutS', label: 'stallTimeoutS', value: value.stallTimeoutS, type: 'number',
          onChange: function (v) { set('stallTimeoutS', v) }, onCommit: function (v) { commitNumber('stallTimeoutS', v) } }),
        React.createElement(Field, { key: 'maxRedirects', label: 'maxRedirects', value: value.maxRedirects, type: 'number',
          onChange: function (v) { set('maxRedirects', v) }, onCommit: function (v) { commitNumber('maxRedirects', v) } }),
        React.createElement(Field, { key: 'insecureTls', label: 'insecureTls', value: value.insecureTls, type: 'bool',
          hint: '跳过 TLS 校验，仅用于企业 TLS 解密环境。',
          onChange: function (v) { commitBool('insecureTls', v) } }),
        React.createElement(Field, { key: 'allowOutsideWorkspace', label: 'allowOutsideWorkspace', value: value.allowOutsideWorkspace, type: 'bool',
          hint: '允许 save_path 写到工作区与下载目录之外。',
          onChange: function (v) { commitBool('allowOutsideWorkspace', v) } })
      ]

      var nodeRows = nodes.length === 0
        ? React.createElement('div', { className: 'dshdl-empty' }, '暂无节点。填好 subscriptionUrl 后点「更新订阅」。')
        : nodes.map(function (node) {
            var active = status && status.selected === node.name
            return React.createElement('div', { key: node.name, className: 'dshdl-node' + (active ? ' dshdl-active' : '') },
              React.createElement('span', { className: 'dshdl-nodeName', title: node.name }, node.name),
              React.createElement('span', { className: 'dshdl-nodeMeta' },
                (node.type || '?') + (node.needsNative ? ' · 需原生连接器' : '') + (node.delay === null ? '' : ' · ' + node.delay + 'ms')),
              React.createElement('button', {
                type: 'button', className: 'dshdl-btn dshdl-small', disabled: !!busy,
                onClick: function () {
                  run('delay:' + node.name, function () { return api('delay', { name: node.name }).then(loadNodes) })
                }
              }, t('test')),
              React.createElement('button', {
                type: 'button', className: 'dshdl-btn dshdl-small', disabled: !!busy || active,
                onClick: function () {
                  run('select:' + node.name, function () { return api('select', { name: node.name }).then(loadStatus).then(loadNodes) })
                }
              }, t('select')))
          })

      return React.createElement('section', { className: 'dshdl' },
        React.createElement('h2', { className: 'dshdl-title' }, t('title')),
        React.createElement('p', { className: 'dshdl-desc' }, t('intro')),

        React.createElement('div', { className: 'dshdl-card' },
          React.createElement('div', { className: 'dshdl-cardHead' },
            React.createElement('span', { className: 'dshdl-cardTitle' }, t('upstream')),
            React.createElement('div', { className: 'dshdl-badges' },
              React.createElement('span', { className: stateBadgeClass }, status ? labelOf(STATE_KEYS, status.state, t) : '…'),
              React.createElement('span', { className: 'dshdl-badge' }, status ? labelOf(MODE_KEYS, status.mode, t) : t('mdNone')),
              React.createElement('span', { className: 'dshdl-badge' }, status && status.port > 0 ? ('127.0.0.1:' + status.port) : t('notRunning')),
              React.createElement('span', { className: 'dshdl-badge' }, (t('nodesBadge') || '节点') + ' ' + (status ? status.nodeCount : 0)))),
          status ? React.createElement('p', { className: 'dshdl-desc' }, status.reason) : null,
          React.createElement('div', { className: 'dshdl-actions' },
            React.createElement('button', { type: 'button', className: 'dshdl-btn', disabled: !!busy,
              onClick: function () { run('refresh', function () { return loadStatus(true).then(loadNodes) }) } }, t('refresh')),
            React.createElement('button', { type: 'button', className: 'dshdl-btn', disabled: !!busy,
              onClick: function () { run('restart', function () { return api('restart', {}).then(loadStatus).then(loadNodes) }) } }, t('restart')),
            React.createElement('button', { type: 'button', className: 'dshdl-btn', disabled: !!busy,
              onClick: function () { run('update-subscription', function () { return api('update-subscription', {}).then(loadStatus).then(loadNodes) }) } }, t('updateSubscription'))),
          React.createElement(Field, { key: 'enabled', label: 'enabled', value: value.enabled, type: 'bool',
            hint: '关闭后下载工具直接失败，不再解析上游。',
            onChange: function (v) { commitBool('enabled', v) } }),
          upstreamRows,
          status && status.lastSubscriptionUpdate
            ? React.createElement('p', { className: 'dshdl-desc' }, '订阅更新时间：' + formatTime(status.lastSubscriptionUpdate))
            : null,
          status && status.nativeNodes > 0 && !status.nativeConnector
            ? React.createElement('p', { className: 'dshdl-warn' }, '有 ' + status.nativeNodes + ' 个节点需要可选的 Go 原生连接器（hysteria2 / reality），当前构建未打包，这些节点会被跳过。')
            : null),

        React.createElement('div', { className: 'dshdl-card' },
          React.createElement('div', { className: 'dshdl-cardHead' },
            React.createElement('span', { className: 'dshdl-cardTitle' }, t('sessionGuard')),
            React.createElement('div', { className: 'dshdl-badges' },
              React.createElement('span', {
                className: guard && guard.covered ? 'dshdl-badge dshdl-ok' : 'dshdl-badge dshdl-warn'
              }, guard
                ? (guard.covered ? t('guardCovered') : t('guardMissing') + ' ' + ((guard.missing && guard.missing.length) || 0))
                : '…'))),
          React.createElement('p', { className: 'dshdl-desc' }, t('guardIntro')),
          guard ? React.createElement('p', { className: 'dshdl-desc' }, guard.env_path) : null,
          guard && Array.isArray(guard.proxy_vars) && guard.proxy_vars.length === 0
            ? React.createElement('p', { className: 'dshdl-warn' }, t('guardNoProxyVars'))
            : null,
          React.createElement('div', { className: 'dshdl-actions' },
            React.createElement('button', {
              type: 'button', className: 'dshdl-btn', disabled: !!busy || !!(guard && guard.covered),
              onClick: function () {
                run('guard-apply', function () {
                  return api('guard-apply', {}).then(function (payload) { setGuard(payload.state); return loadStatus(false) })
                })
              }
            }, t('guardApply')),
            React.createElement('button', {
              type: 'button', className: 'dshdl-btn', disabled: !!busy,
              onClick: function () {
                run('guard-restore', function () {
                  return api('guard-restore', {}).then(function (payload) { setGuard(payload.state) })
                })
              }
            }, t('guardRestore'))),
          React.createElement('p', { className: 'dshdl-desc' }, t('guardRestart'))),

        React.createElement('div', { className: 'dshdl-card' },
          React.createElement('div', { className: 'dshdl-cardHead' },
            React.createElement('span', { className: 'dshdl-cardTitle' }, t('nodes') + ' (' + nodes.length + ')'),
            React.createElement('div', { className: 'dshdl-actions' },
              React.createElement('button', { type: 'button', className: 'dshdl-btn dshdl-small', disabled: !!busy,
                onClick: function () { run('delay-all', function () { return api('delay-all', {}).then(loadNodes) }) } }, t('testAll')),
              React.createElement('button', { type: 'button', className: 'dshdl-btn dshdl-small', disabled: !!busy,
                onClick: function () { run('clear-latencies', function () { return api('clear-latencies', {}).then(loadNodes) }) } }, t('clearLatency')))),
          React.createElement('div', { className: 'dshdl-nodes' }, nodeRows),
          status && status.traffic
            ? React.createElement('p', { className: 'dshdl-desc' },
                '流量 ↑' + formatBytes(status.traffic.up) + ' ↓' + formatBytes(status.traffic.down))
            : null),

        React.createElement('div', { className: 'dshdl-card' },
          React.createElement('span', { className: 'dshdl-cardTitle' }, t('rules')),
          rulesRows),

        React.createElement('div', { className: 'dshdl-card' },
          React.createElement('span', { className: 'dshdl-cardTitle' }, t('download')),
          downloadRows),

        error ? React.createElement('p', { className: 'dshdl-error' }, error) : null,
        snap && snap.status === 'unavailable' ? React.createElement('p', { className: 'dshdl-warn' }, t('unavailable')) : null,

        React.createElement('p', { className: 'dshdl-desc' },
          '注意：本插件只管它自己的下载。web_fetch 与 shell 里的 curl / git / npm 由 DSH 启动期的代理策略决定 —— 需要它们也走代理，请在 $DSH_HOME/.env 里设置 HTTP_PROXY / HTTPS_PROXY。'))
    }

    // ------------------------------------------------------------------
    // 插件主体
    // ------------------------------------------------------------------
    // 只把骨架服务放进 inject；configForms / locale 一律惰性解析，
    // 否则任一服务缺失会让整个客户端插件停在 pending 且不报错。
    var inject = ['slots']

    function apply(ctx) {
      ensureCss()

      var translate = null
      try {
        ctx.locale.register(LOCALE_NS, { zh: LOCALE_ZH, en: LOCALE_EN })
        translate = ctx.locale.bind(LOCALE_NS)
      } catch (e) { /* 字典注册失败不影响面板 */ }

      var cached = null
      function getConfigForm() {
        if (cached) return cached
        try {
          var service = ctx.get('configForms')
          if (service && typeof service.get === 'function') cached = service.get(ENTRY_ID)
        } catch (e) { /* ignore */ }
        return cached
      }

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: ENTRY_ID,
          order: 91,
          label: function () { return translate ? translate('nav') : '下载代理' },
          locale: LOCALE_NS,
          inject: function () {
            return {
              scope: getConfigForm(),
              t: function (key) { return translate ? translate(key) : key }
            }
          }
        }, DownloaderSection)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
