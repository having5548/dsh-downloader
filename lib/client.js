// ============================================================================
// dsh-downloader —— DSH 下载代理插件（客户端半部）
//
// 两个入口，共用同一套组件与样式（要求「两个入口的 UI 风格一致」）：
//   1. 左侧栏导航页 —— sidebar.panellist（图标行）+ main（keyed 页面）
//   2. 设置页       —— settings.section（同一套 Page 组件，variant='settings'）
//   另外保留 sidebar.footer.action 的实时流量徽标。
//
// 文案：LOCALE_ZH / LOCALE_EN 两份完整字典，经 ctx.locale 注册（DSH 会按系统语言
// 自动选中，用户也能在 设置 → 语言 里改）。页内另有 自动/中/EN 三态切换，只影响
// 本插件页面，不劫持全局语言。
//
// 必须惰性走 ctx.configForms；scope.subscribe / getSnapshot 是类原型方法，
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
    var PANEL_ID = 'dsh-downloader'
    var LS_ADVANCED = 'dsh-downloader.advanced'
    var LS_LANG = 'dsh-downloader.lang'

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
      guardShellDownloads: true,
      extraRules: [],
      excludeRules: [],
      downloadDir: '',
      maxDownloadMb: 512,
      downloadTimeoutS: 600,
      stallTimeoutS: 30,
      threads: 4,
      insecureTls: true,
      allowOutsideWorkspace: false,
      maxRedirects: 10,
      harnessProxy: false,
      harnessProxyPort: 17890
    }

    // ------------------------------------------------------------------
    // 文案
    // ------------------------------------------------------------------
    var LOCALE_ZH = {
      nav: '下载代理',
      title: '下载代理',
      subtitle: '境外文件走代理、境内直连，由插件自带的订阅内核提供出口',
      entryLabel: '下载代理',
      langAuto: '自动',
      langZh: '中文',
      langEn: 'English',

      // 状态
      stRunning: '运行中',
      stDisabled: '已关闭',
      stFailed: '失败',
      stIdle: '未启动',
      stNoSubscription: '未配置订阅',
      stUnavailable: '不可用',
      refresh: '刷新',
      restartCore: '重启内核',
      corePort: '内核端口',
      coreNone: '未运行',
      nodesCount: '节点',
      currentNode: '当前节点',
      nodeAuto: '自动选择',
      modeExplicit: '固定代理地址',
      modeSubscription: '订阅',
      modeEnvironment: '环境代理',
      modeNone: '未配置',
      upstream: '上游',
      upstreamNone: '既没有配置订阅，也没有代理地址',
      notRunningHint: '内核没有运行，下载会直接失败。先看下面的上游配置。',

      // 配置（节点配置）
      profiles: '节点配置',
      profilesHint: '一份配置 = 一条订阅地址或一个导入的配置文件',
      addProfile: '添加配置',
      importUrl: '订阅地址',
      importUrlPlaceholder: 'https://… 或 clash://install-config?url=…',
      importLabel: '名称（可留空）',
      importFile: '导入文件',
      import: '导入',
      cancel: '取消',
      emptyProfiles: '还没有配置。点右下角「添加配置」导入订阅或文件。',
      current: '当前',
      fileSource: '本地文件',
      updatedAt: '更新于',
      never: '从未更新',
      use: '选用',
      update: '更新',
      remove: '删除',
      autoUpdate: '自动更新',
      autoUpdateOn: '自动更新 · 每 %s 小时',
      trafficQuota: '流量',

      // 节点
      nodes: '代理节点',
      nodesHint: '点一个节点即选用；「自动选择」按延迟自动挑',
      testAll: '全部测速',
      testing: '测速中…',
      ms: '%s ms',
      timeout: '超时',
      untested: '未测',
      needsNative: '需连接器',
      nodeType: '类型',

      // 下载
      download: '下载',
      downloadDir: '下载目录',
      downloadDirHint: '留空 = DSH 的 downloads 目录',
      threads: '线程数',
      threadsHint: '服务端支持时按此并发下载；1 = 单连接',
      maxMb: '单文件上限（MB）',
      dirPlaceholder: '留空使用默认目录',

      // 高级
      advanced: '高级设置',
      advancedHint: '打开后显示全部可调项',
      advUpstream: '上游与订阅',
      proxyUrl: '固定代理地址',
      proxyUrlHint: '显式上游，支持 http:// 与 socks5://；填了就不再使用订阅',
      subscriptionUrl: '订阅地址（旧版）',
      subscriptionUrlHint: '只有在没有任何「节点配置」时才会用它',
      fetchProxyUrl: '拉取订阅用的代理',
      fetchProxyUrlHint: '仅当订阅本身被墙时填，必须是 http(s):// 代理',
      groupType: '分组类型',
      preferredNode: '首选节点',
      preferredNodeHint: '按名字固定一个节点，优先级最高',
      autoUpdateHours: '订阅自动更新（小时）',
      latencyTestUrl: '测速地址',
      latencyTimeoutMs: '测速超时（ms）',
      advRouting: '分流',
      domesticDirect: '境内直连',
      domesticDirectHint: '关闭后所有目标都走代理',
      protectAiPlatforms: '国内 AI 平台强制直连',
      protectAiPlatformsHint: '最高优先级 DIRECT，连代理抖动也不会断会话',
      extraDirectDomains: '额外直连域名',
      extraDirectDomainsHint: '逗号或换行分隔',
      extraRules: '追加规则',
      extraRulesHint: '每行一条，如 DOMAIN-SUFFIX,example.com,DIRECT',
      excludeRules: '剔除规则',
      excludeRulesHint: '每行一条，子串匹配订阅规则',
      advEngine: '下载引擎',
      maxRedirects: '最大重定向次数',
      stallTimeoutS: '停滞判定（秒）',
      downloadTimeoutS: '总时长预算（秒）',
      insecureTls: '跳过 TLS 证书校验',
      insecureTlsHint: '默认开启：接受任何证书（含自签与中间人）。关掉更安全，但 TLS 解密环境下下载与订阅会失败',
      allowOutsideWorkspace: '允许写工作区外',
      allowOutsideWorkspaceHint: '否则只写到工作区与下载目录',
      guardShellDownloads: '拦截未走代理的境外 shell 下载',
      guardShellDownloadsHint: '拦到就改用 dsh_run_proxied 重跑',
      advHarness: 'harness 出网',
      harnessProxy: '开放给 harness',
      harnessProxyHint: '让 web_fetch / shell 子进程 / MCP 的 HTTP 也走内核。写入 $DSH_HOME/.env 后需重启 DSH',
      harnessProxyPort: '固定端口',
      harnessProxyPortHint: '写进 .env，不能随机；被占用时自动退回随机端口',

      // 会话保护
      guard: '会话保护',
      guardHint: '把国内 AI 平台域名写进 NO_PROXY，代理关掉也不断会话',
      guardCovered: '已覆盖 %s 个域名',
      guardMissing: '缺少 %s 个',
      guardApply: '写入',
      guardRestore: '还原',
      guardNoVars: '该文件还没有配置 HTTP_PROXY，这项暂时不起作用',
      guardRestart: '改完需要重启 DSH',

      // 流量 / 页脚
      traffic: '流量',
      trafficUp: '上行',
      trafficDown: '下行',
      trafficTotal: '累计',
      trafficIdle: '内核没在跑，没有流量',

      // 其它
      unavailable: '当前环境无法持久化设置，本次修改仅当前页面生效。',
      scopeNote: '内核只绑 127.0.0.1 并要求本进程令牌，其它程序连不上也借不走。',
      about: '关于',
      dataDir: '数据目录',
      saved: '已保存',
      failed: '失败'
    }

    var LOCALE_EN = {
      nav: 'Download proxy',
      title: 'Download proxy',
      subtitle: 'Foreign files go through the proxy, domestic stay direct — the exit comes from the plugin own subscription core',
      entryLabel: 'Download proxy',
      langAuto: 'Auto',
      langZh: '中文',
      langEn: 'English',

      stRunning: 'Running',
      stDisabled: 'Disabled',
      stFailed: 'Failed',
      stIdle: 'Not started',
      stNoSubscription: 'No subscription',
      stUnavailable: 'Unavailable',
      refresh: 'Refresh',
      restartCore: 'Restart core',
      corePort: 'Core port',
      coreNone: 'not running',
      nodesCount: 'Nodes',
      currentNode: 'Current node',
      nodeAuto: 'Auto select',
      modeExplicit: 'Fixed proxy URL',
      modeSubscription: 'Subscription',
      modeEnvironment: 'Environment proxy',
      modeNone: 'Not configured',
      upstream: 'Upstream',
      upstreamNone: 'Neither a subscription nor a proxy URL is configured',
      notRunningHint: 'The core is not running, so downloads will fail. Check the upstream settings below.',

      profiles: 'Node profiles',
      profilesHint: 'One profile = a subscription URL or an imported config file',
      addProfile: 'Add profile',
      importUrl: 'Subscription URL',
      importUrlPlaceholder: 'https://… or clash://install-config?url=…',
      importLabel: 'Label (optional)',
      importFile: 'Import file',
      import: 'Import',
      cancel: 'Cancel',
      emptyProfiles: 'No profiles yet. Use "Add profile" in the corner to import one.',
      current: 'Current',
      fileSource: 'Local file',
      updatedAt: 'Updated',
      never: 'never',
      use: 'Use',
      update: 'Update',
      remove: 'Remove',
      autoUpdate: 'Auto update',
      autoUpdateOn: 'Auto update · every %s h',
      trafficQuota: 'Traffic',

      nodes: 'Nodes',
      nodesHint: 'Click a node to use it; "Auto select" picks by latency',
      testAll: 'Test all',
      testing: 'Testing…',
      ms: '%s ms',
      timeout: 'Timeout',
      untested: 'untested',
      needsNative: 'needs connector',
      nodeType: 'Type',

      download: 'Download',
      downloadDir: 'Download folder',
      downloadDirHint: 'Empty = the DSH downloads folder',
      threads: 'Threads',
      threadsHint: 'Concurrent chunks when the server supports ranges; 1 = single stream',
      maxMb: 'Max file size (MB)',
      dirPlaceholder: 'Empty uses the default folder',

      advanced: 'Advanced',
      advancedHint: 'Reveal every tunable option',
      advUpstream: 'Upstream and subscription',
      proxyUrl: 'Fixed proxy URL',
      proxyUrlHint: 'Explicit upstream, http:// or socks5://; when set, the subscription is unused',
      subscriptionUrl: 'Subscription URL (legacy)',
      subscriptionUrlHint: 'Only used when no "node profile" exists',
      fetchProxyUrl: 'Proxy for fetching the subscription',
      fetchProxyUrlHint: 'Only when the subscription itself is blocked; must be an http(s):// proxy',
      groupType: 'Group type',
      preferredNode: 'Preferred node',
      preferredNodeHint: 'Pin one node by name; highest priority',
      autoUpdateHours: 'Subscription auto update (h)',
      latencyTestUrl: 'Latency test URL',
      latencyTimeoutMs: 'Latency timeout (ms)',
      advRouting: 'Routing',
      domesticDirect: 'Domestic direct',
      domesticDirectHint: 'Turn off to proxy every target',
      protectAiPlatforms: 'Pin domestic AI platforms direct',
      protectAiPlatformsHint: 'Highest priority DIRECT, so a flapping proxy cannot break the session',
      extraDirectDomains: 'Extra direct domains',
      extraDirectDomainsHint: 'Comma or newline separated',
      extraRules: 'Extra rules',
      extraRulesHint: 'One per line, e.g. DOMAIN-SUFFIX,example.com,DIRECT',
      excludeRules: 'Excluded rules',
      excludeRulesHint: 'One per line, substring match against subscription rules',
      advEngine: 'Download engine',
      maxRedirects: 'Max redirects',
      stallTimeoutS: 'Stall timeout (s)',
      downloadTimeoutS: 'Total budget (s)',
      insecureTls: 'Skip TLS certificate verification',
      insecureTlsHint: 'On by default: accepts any certificate, including self-signed and MITM. Turning it off is safer but breaks downloads and subscriptions behind TLS inspection',
      allowOutsideWorkspace: 'Write outside the workspace',
      allowOutsideWorkspaceHint: 'Otherwise only the workspace and the download folder',
      guardShellDownloads: 'Block unproxied overseas shell downloads',
      guardShellDownloadsHint: 'When blocked, re-run through dsh_run_proxied',
      advHarness: 'Harness egress',
      harnessProxy: 'Expose the core to the harness',
      harnessProxyHint: 'Also route web_fetch / shell children / MCP HTTP. Written to $DSH_HOME/.env; restart DSH',
      harnessProxyPort: 'Fixed port',
      harnessProxyPortHint: 'Must be fixed because .env pins it; falls back to a random port when taken',

      guard: 'Session guard',
      guardHint: 'Write the AI platform domains into NO_PROXY so a dead proxy cannot drop the session',
      guardCovered: '%s domains covered',
      guardMissing: '%s missing',
      guardApply: 'Write',
      guardRestore: 'Restore',
      guardNoVars: 'That file has no HTTP_PROXY yet, so this has no effect',
      guardRestart: 'Restart DSH to apply',

      traffic: 'Traffic',
      trafficUp: 'Up',
      trafficDown: 'Down',
      trafficTotal: 'total',
      trafficIdle: 'The core is not running, so there is no traffic',

      unavailable: 'Settings cannot be persisted here; changes apply to this page only.',
      scopeNote: 'The core binds 127.0.0.1 and requires this process token, so other programs cannot borrow it.',
      about: 'About',
      dataDir: 'Data folder',
      saved: 'Saved',
      failed: 'failed'
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------
    function formatBytes(value) {
      var n = Number(value)
      if (!isFinite(n) || n <= 0) return '0 B'
      var units = ['B', 'KB', 'MB', 'GB', 'TB']
      var i = 0
      while (n >= 1024 && i < units.length - 1) { n = n / 1024; i += 1 }
      return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i]
    }

    function formatRate(value) {
      var n = Number(value)
      if (!isFinite(n) || n <= 0) return '0 B/s'
      return formatBytes(n) + '/s'
    }

    function formatRateTiny(value) {
      var n = Number(value)
      if (!isFinite(n) || n <= 0) return '0'
      if (n < 1024) return Math.round(n) + 'B'
      if (n < 1024 * 1024) return Math.round(n / 1024) + 'K'
      return (n / 1024 / 1024).toFixed(1) + 'M'
    }

    function formatTime(value) {
      if (!value) return ''
      try {
        var d = new Date(value)
        if (isNaN(d.getTime())) return ''
        var pad = function (n) { return (n < 10 ? '0' : '') + n }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      } catch (e) { return '' }
    }

    function readStore(key, fallback) {
      try {
        var raw = window.localStorage.getItem(key)
        return raw === null ? fallback : raw
      } catch (e) { return fallback }
    }

    function writeStore(key, value) {
      try { window.localStorage.setItem(key, value) } catch (e) { /* ignore */ }
    }

    function apiFetch(path, body) {
      var init = { method: body === undefined ? 'GET' : 'POST' }
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      }
      return fetch(API_BASE + path, init).then(function (response) {
        return response.text().then(function (text) {
          var payload = {}
          if (text.length > 0) {
            try { payload = JSON.parse(text) } catch (e) { payload = { error: text } }
          }
          if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status))
          return payload
        })
      })
    }

    function cls() {
      var parts = []
      for (var i = 0; i < arguments.length; i += 1) {
        if (arguments[i]) parts.push(arguments[i])
      }
      return parts.join(' ')
    }

    /**
     * 取 locale 服务。
     *
     * `ctx.locale` 只在 `inject` 里声明了硬依赖 `locale` 时才存在；本插件只 inject
     * `slots`，所以必须走可选访问 `ctx.get('locale')` —— 否则下面全部降级成英文，
     * 而界面其它地方仍是中文（实测踩过）。
     */
    function localeService(ctx) {
      if (!ctx) return null
      try {
        if (ctx.locale) return ctx.locale
      } catch (e) { /* ignore */ }
      try {
        var service = ctx.get('locale')
        if (service) return service
      } catch (e) { /* ignore */ }
      return null
    }

    // ------------------------------------------------------------------
    // 样式（全部走 DSH 主题令牌，自动适配明暗）
    // ------------------------------------------------------------------
    var CSS_ID = 'dshdl-styles'

    function ensureCss() {
      if (document.getElementById(CSS_ID)) return
      var style = document.createElement('style')
      style.id = CSS_ID
      style.textContent = [
        '.dshdl-root{display:flex;flex-direction:column;gap:22px;padding:22px 26px 40px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box;}',
        // 侧栏面板是独立的一栏，shell 不会替它滚 —— 内容超出时由自己滚。
        '.dshdl-root.dshdl-scroll{height:100%;max-height:100%;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;}',
        '.dshdl-root.dshdl-compact{padding:16px 16px 32px;gap:18px;}',
        '.dshdl-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;}',
        '.dshdl-headText{flex:1 1 auto;min-width:180px;}',
        '.dshdl-h1{margin:0;font-size:20px;font-weight:600;letter-spacing:.2px;}',
        '.dshdl-sub{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;}',
        '.dshdl-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.dshdl-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);}',
        '.dshdl-pill.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}',
        '.dshdl-pill.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
        '.dshdl-pill.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}',
        '.dshdl-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;}',
        '.dshdl-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}',
        '.dshdl-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);}',
        '.dshdl-btn:disabled{opacity:.5;cursor:default;}',
        '.dshdl-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;}',
        '.dshdl-btn.ghost{background:transparent;}',
        '.dshdl-btn.danger{color:var(--dsw-alias-state-error-primary);}',
        '.dshdl-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;}',
        '.dshdl-seg button{padding:4px 10px;font-size:12px;background:transparent;border:0;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
        '.dshdl-seg button.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
        '.dshdl-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px;}',
        '.dshdl-cardTitle{display:flex;align-items:center;gap:10px;margin:0 0 4px;font-size:14px;font-weight:600;}',
        '.dshdl-cardHint{margin:0 0 14px;color:var(--dsw-alias-label-secondary);font-size:12px;}',
        '.dshdl-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:12px;}',
        '.dshdl-kv dt{color:var(--dsw-alias-label-secondary);}',
        '.dshdl-kv dd{margin:0;word-break:break-all;}',
        '.dshdl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:10px;}',
        '.dshdl-tile{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:border-color .12s ease,transform .12s ease;}',
        '.dshdl-tile:hover{border-color:var(--dsw-alias-border-l2);}',
        '.dshdl-tile.on{border-color:var(--dsw-alias-brand-primary);}',
        '.dshdl-tile.dead{opacity:.62;}',
        '.dshdl-tileName{font-size:13px;font-weight:600;padding-right:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.dshdl-tileMeta{font-size:11px;color:var(--dsw-alias-label-secondary);}',
        '.dshdl-tileFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
        '.dshdl-lat{font-variant-numeric:tabular-nums;}',
        '.dshdl-lat.ok{color:var(--dsw-alias-state-success-primary);}',
        '.dshdl-lat.bad{color:var(--dsw-alias-state-error-primary);}',
        '.dshdl-bar{height:3px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden;}',
        '.dshdl-bar span{display:block;height:100%;background:var(--dsw-alias-brand-primary);}',
        '.dshdl-more{position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1;}',
        '.dshdl-more:hover{background:var(--dsw-alias-bg-layer-1);}',
        '.dshdl-menu{position:absolute;top:32px;right:8px;z-index:5;min-width:132px;padding:4px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px rgba(0,0,0,.28);}',
        '.dshdl-menu button{display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}',
        '.dshdl-menu button:hover{background:var(--dsw-alias-bg-layer-2);}',
        '.dshdl-menu button.danger{color:var(--dsw-alias-state-error-primary);}',
        '.dshdl-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
        '.dshdl-row:first-child{border-top:0;}',
        '.dshdl-rowText{flex:1 1 auto;min-width:0;}',
        '.dshdl-rowLabel{font-size:12.5px;}',
        '.dshdl-rowHint{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
        '.dshdl-rowCtl{flex:0 0 auto;display:flex;align-items:center;gap:8px;}',
        '.dshdl-input,.dshdl-textarea,.dshdl-select{width:100%;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit;}',
        '.dshdl-textarea{min-height:58px;resize:vertical;}',
        '.dshdl-input:focus,.dshdl-textarea:focus,.dshdl-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
        '.dshdl-row.vertical{display:block;}',
        '.dshdl-row.vertical .dshdl-rowCtl{margin-top:6px;}',
        '.dshdl-switch{position:relative;width:36px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);cursor:pointer;flex:0 0 auto;}',
        '.dshdl-switch span{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .14s ease;}',
        '.dshdl-switch.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}',
        '.dshdl-switch.on span{transform:translateX(16px);background:#fff;}',
        '.dshdl-traffic{display:flex;gap:26px;flex-wrap:wrap;}',
        '.dshdl-tItem{min-width:110px;}',
        '.dshdl-tLabel{font-size:11px;color:var(--dsw-alias-label-secondary);}',
        '.dshdl-tValue{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;}',
        '.dshdl-tSum{font-size:11px;color:var(--dsw-alias-label-secondary);}',
        '.dshdl-inlineForm{display:grid;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);}',
        '.dshdl-inlineRow{display:flex;gap:8px;flex-wrap:wrap;}',
        '.dshdl-inlineRow .dshdl-input{flex:1 1 200px;}',
        '.dshdl-note{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;}',
        '.dshdl-err{padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px;position:sticky;top:0;z-index:6;background:var(--dsw-alias-bg-layer-1);}',
        '.dshdl-note.sticky{position:sticky;top:0;z-index:6;background:var(--dsw-alias-bg-layer-1);}',
        '.dshdl-empty{padding:22px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;}',
        '.dshdl-trafFoot{display:flex;flex-direction:column;gap:1px;font-size:11px;line-height:1.25;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}',
        '.dshdl-trafFoot .row{display:flex;align-items:center;gap:5px;}',
        '.dshdl-trafRail{display:flex;flex-direction:column;align-items:center;font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}'
      ].join('\n')
      document.head.appendChild(style)
    }

    // ------------------------------------------------------------------
    // 基础组件
    // ------------------------------------------------------------------
    function h() { return React.createElement.apply(null, arguments) }

    function Pill(props) {
      var tone = props.tone === 'ok' ? ' ok' : props.tone === 'err' ? ' err' : props.tone === 'warn' ? ' warn' : ''
      return h('span', { className: 'dshdl-pill' + tone, title: props.title || '' },
        props.tone ? h('span', { className: 'dshdl-dot' }) : null,
        props.children)
    }

    function Btn(props) {
      return h('button', {
        type: 'button',
        className: cls('dshdl-btn', props.variant === 'primary' ? 'primary' : props.variant === 'ghost' ? 'ghost' : props.variant === 'danger' ? 'danger' : ''),
        disabled: props.disabled === true,
        onClick: props.onClick,
        title: props.title || ''
      }, props.children)
    }

    function Switch(props) {
      return h('button', {
        type: 'button',
        className: cls('dshdl-switch', props.value ? 'on' : ''),
        role: 'switch',
        'aria-checked': props.value ? 'true' : 'false',
        'aria-label': props.label || '',
        disabled: props.disabled === true,
        onClick: function () { if (props.onChange) props.onChange(!props.value) }
      }, h('span', null))
    }

    function Card(props) {
      return h('section', { className: 'dshdl-card' },
        h('h3', { className: 'dshdl-cardTitle' },
          props.title,
          props.titleExtra || null),
        props.hint ? h('p', { className: 'dshdl-cardHint' }, props.hint) : null,
        props.children)
    }

    /** 一行设置项：左标签+说明，右控件。 */
    function Row(props) {
      return h('div', { className: cls('dshdl-row', props.vertical ? 'vertical' : '') },
        h('div', { className: 'dshdl-rowText' },
          h('div', { className: 'dshdl-rowLabel' }, props.label),
          props.hint ? h('div', { className: 'dshdl-rowHint' }, props.hint) : null),
        h('div', { className: 'dshdl-rowCtl' }, props.children))
    }

    /** 文本输入：本地草稿，失焦/回车才提交，避免每敲一个字就写配置。 */
    function TextRow(props) {
      var state = React.useState(props.value === undefined ? '' : String(props.value))
      var draft = state[0]
      var setDraft = state[1]
      React.useEffect(function () { setDraft(props.value === undefined ? '' : String(props.value)) }, [props.value])
      function commit() {
        if (props.onCommit && String(props.value === undefined ? '' : props.value) !== draft) props.onCommit(draft)
      }
      return h(Row, { label: props.label, hint: props.hint },
        h('input', {
          className: 'dshdl-input',
          type: props.type || 'text',
          value: draft,
          placeholder: props.placeholder || '',
          onChange: function (e) { setDraft(e.target.value) },
          onBlur: commit,
          onKeyDown: function (e) { if (e.key === 'Enter') { commit(); e.currentTarget.blur() } }
        }))
    }

    /** 多行列表（规则类）用逗号/换行编辑。 */
    function ListRow(props) {
      var value = Array.isArray(props.value) ? props.value.join('\n') : ''
      var state = React.useState(value)
      var draft = state[0]
      var setDraft = state[1]
      React.useEffect(function () { setDraft(Array.isArray(props.value) ? props.value.join('\n') : '') }, [props.value])
      function commit() {
        var next = draft.split(/[\n,]+/).map(function (s) { return s.trim() }).filter(function (s) { return s.length > 0 })
        if (props.onCommit) props.onCommit(next)
      }
      return h(Row, { label: props.label, hint: props.hint, vertical: true },
        h('textarea', {
          className: 'dshdl-textarea',
          value: draft,
          placeholder: props.placeholder || '',
          onChange: function (e) { setDraft(e.target.value) },
          onBlur: commit
        }))
    }

    function SelectRow(props) {
      return h(Row, { label: props.label, hint: props.hint },
        h('select', {
          className: 'dshdl-select',
          value: props.value,
          onChange: function (e) { if (props.onCommit) props.onCommit(e.target.value) }
        }, props.options.map(function (option) {
          return h('option', { key: option.value, value: option.value }, option.label)
        })))
    }

    // ------------------------------------------------------------------
    // 语言：自动（跟随 DSH / 系统）+ 手动覆盖，只作用于本插件页面
    // ------------------------------------------------------------------
    function useLocaleSelection(ctxRef) {
      var mode = React.useState(function () { return readStore(LS_LANG, 'auto') })
      var choice = mode[0]
      var setChoice = mode[1]
      // DSH 的语言快照变化时重渲染（auto 模式据此跟随系统）
      var revision = React.useSyncExternalStore(
        function (listener) {
          var service = localeService(ctxRef.current)
          try { return service.subscribe(listener) } catch (e) { return function () {} }
        },
        function () {
          var service = localeService(ctxRef.current)
          try { return service.getSnapshot().revision } catch (e) { return 0 }
        })
      var active = 'en'
      var service = localeService(ctxRef.current)
      try {
        var snap = service.getLocale()
        active = snap && snap.active ? String(snap.active) : 'en'
      } catch (e) { active = 'en' }

      var resolved = choice === 'auto' ? (/^zh/i.test(active) ? 'zh' : 'en') : choice
      var dict = resolved === 'zh' ? LOCALE_ZH : LOCALE_EN
      var t = React.useCallback(function (key, arg) {
        var text = dict[key]
        if (text === undefined) text = LOCALE_EN[key]
        if (text === undefined) text = key
        return arg === undefined ? text : String(text).replace('%s', String(arg))
      }, [resolved, revision])

      function pick(next) {
        setChoice(next)
        writeStore(LS_LANG, next)
      }

      return { t: t, choice: choice, pick: pick, resolved: resolved }
    }

    function LocaleSwitch(props) {
      var t = props.t
      function item(value, label) {
        return h('button', {
          key: value,
          type: 'button',
          className: props.choice === value ? 'on' : '',
          onClick: function () { props.pick(value) }
        }, label)
      }
      return h('div', { className: 'dshdl-seg', title: props.title || '' },
        item('auto', t('langAuto')),
        item('zh', t('langZh')),
        item('en', t('langEn')))
    }

    // ------------------------------------------------------------------
    // 状态轮询
    // ------------------------------------------------------------------
    function useStatus(pollMs) {
      var tuple = React.useState(null)
      var status = tuple[0]
      var setStatus = tuple[1]
      var errTuple = React.useState(null)
      var error = errTuple[0]
      var setError = errTuple[1]
      var alive = React.useRef(true)

      var reload = React.useCallback(function () {
        return apiFetch('status')
          .then(function (payload) { if (alive.current) { setStatus(payload); setError(null) } return payload })
          .catch(function (e) { if (alive.current) setError(String((e && e.message) || e)) })
      }, [])

      React.useEffect(function () {
        alive.current = true
        reload()
        if (!pollMs) return function () { alive.current = false }
        var timer = setInterval(function () { if (!document.hidden) reload() }, pollMs)
        return function () { alive.current = false; clearInterval(timer) }
      }, [reload, pollMs])

      return { status: status, error: error, reload: reload }
    }

    function useTraffic(pollMs) {
      var tuple = React.useState(null)
      var traffic = tuple[0]
      var setTraffic = tuple[1]
      var alive = React.useRef(true)
      React.useEffect(function () {
        alive.current = true
        function tick() {
          apiFetch('traffic')
            .then(function (payload) { if (alive.current) setTraffic(payload) })
            .catch(function () { if (alive.current) setTraffic(null) })
        }
        tick()
        var timer = setInterval(function () { if (!document.hidden) tick() }, pollMs)
        return function () { alive.current = false; clearInterval(timer) }
      }, [pollMs])
      return traffic
    }

    // ------------------------------------------------------------------
    // 节点配置卡片（对齐 FlClash 的「配置」页）
    // ------------------------------------------------------------------
    function ProfileTile(props) {
      var profile = props.profile
      var t = props.t
      var openState = React.useState(false)
      var open = openState[0]
      var setOpen = openState[1]

      var info = profile.subscriptionInfo || null
      var used = null
      var total = null
      if (info) {
        var upSum = Number(info.upload)
        var downSum = Number(info.download)
        var totalSum = Number(info.total)
        if (isFinite(upSum) || isFinite(downSum)) used = (isFinite(upSum) ? upSum : 0) + (isFinite(downSum) ? downSum : 0)
        if (isFinite(totalSum) && totalSum > 0) total = totalSum
      }
      var percent = null
      if (used !== null && total !== null) {
        percent = Math.max(0, Math.min(100, Math.round((used / total) * 100)))
      }

      function act(name) {
        setOpen(false)
        props.onAction(name, profile)
      }

      return h('div', {
        className: cls('dshdl-tile', profile.current ? 'on' : ''),
        onClick: function () { if (!open) act('select') },
        title: profile.label
      },
        h('button', {
          className: 'dshdl-more',
          type: 'button',
          'aria-label': 'menu',
          onClick: function (e) { e.stopPropagation(); setOpen(!open) }
        }, '⋯'),
        h('div', { className: 'dshdl-tileName' }, profile.label),
        percent === null
          ? h('div', { className: 'dshdl-bar' }, h('span', { style: { width: profile.current ? '100%' : '0%' } }))
          : h('div', { className: 'dshdl-bar' }, h('span', { style: { width: percent + '%' } })),
        h('div', { className: 'dshdl-tileMeta' },
          percent === null
            ? (profile.source === 'file' ? t('fileSource') : (profile.autoUpdate ? t('autoUpdateOn', profile.autoUpdateHours || 24) : t('upstream')))
            : (formatBytes(used) + ' / ' + formatBytes(total))),
        h('div', { className: 'dshdl-tileFoot' },
          h('span', null, profile.current ? t('current') : (profile.source === 'file' ? t('fileSource') : '')),
          h('span', null, profile.lastUpdateAt ? (t('updatedAt') + ' ' + formatTime(profile.lastUpdateAt)) : t('never'))),
        open ? h('div', { className: 'dshdl-menu', onClick: function (e) { e.stopPropagation() } },
          h('button', { type: 'button', onClick: function () { act('select') } }, t('use')),
          profile.source === 'url' ? h('button', { type: 'button', onClick: function () { act('update') } }, t('update')) : null,
          h('button', { type: 'button', onClick: function () { act('auto') } }, t('autoUpdate')),
          h('button', { className: 'danger', type: 'button', onClick: function () { act('remove') } }, t('remove'))
        ) : null)
    }

    // ------------------------------------------------------------------
    // 节点卡片（对齐 FlClash 的「代理」页）
    // ------------------------------------------------------------------
    function NodeTile(props) {
      var node = props.node
      var t = props.t
      var delay = node.delay
      var latClass = 'dshdl-lat'
      var latText = t('untested')
      if (delay !== null && delay !== undefined) {
        latClass = delay > 0 ? 'dshdl-lat ok' : 'dshdl-lat bad'
        latText = delay > 0 ? t('ms', delay) : t('timeout')
      }
      return h('div', {
        className: cls('dshdl-tile', props.active ? 'on' : '', delay === 0 ? 'dead' : ''),
        onClick: props.onClick,
        title: (node.server || node.name) + (node.needsNative ? ' · ' + t('needsNative') : '')
      },
        h('div', { className: 'dshdl-tileName' }, node.name),
        h('div', { className: 'dshdl-tileMeta' }, node.type),
        h('div', { className: 'dshdl-tileFoot' }, h('span', { className: latClass }, latText)))
    }

    function AutoTile(props) {
      return h('div', {
        className: cls('dshdl-tile', props.active ? 'on' : ''),
        onClick: props.onClick
      },
        h('div', { className: 'dshdl-tileName' }, props.t('nodeAuto')),
        h('div', { className: 'dshdl-tileMeta' }, props.t('upstream')),
        h('div', { className: 'dshdl-tileFoot' }, h('span', { className: 'dshdl-lat' }, props.current || '')))
    }

    // ------------------------------------------------------------------
    // 主页面：两个入口共用
    // ------------------------------------------------------------------
    function DownloaderPage(props) {
      var ctxRef = props.ctxRef
      var variant = props.variant || 'panel'
      var compact = variant === 'settings'
      var scope = props.scope

      var locale = useLocaleSelection(ctxRef)
      var t = locale.t

      var state = useStatus(compact ? 6000 : 5000)
      var status = state.status
      var error = state.error
      var reload = state.reload
      var traffic = useTraffic(2000)

      var advancedState = React.useState(function () { return readStore(LS_ADVANCED, '0') === '1' })
      var advanced = advancedState[0]
      var setAdvanced = advancedState[1]

      var nodesState = React.useState([])
      var nodes = nodesState[0]
      var setNodes = nodesState[1]
      var groupsState = React.useState([])
      var groups = groupsState[0]
      var setGroups = groupsState[1]
      var guardState = React.useState(null)
      var guard = guardState[0]
      var setGuard = guardState[1]

      var busyState = React.useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var actionErrorState = React.useState(null)
      var actionError = actionErrorState[0]
      var setActionError = actionErrorState[1]
      var noticeState = React.useState(null)
      var notice = noticeState[0]
      var setNotice = noticeState[1]

      // 配置表单
      var snap = scope
        ? React.useSyncExternalStore(
            function (listener) { return scope.subscribe(listener) },
            function () { return scope.getSnapshot() })
        : { status: 'unavailable', value: undefined }

      var stored = Object.assign({}, DEFAULTS, (snap && snap.value) || {})
      var draftState = React.useState({})
      var draft = draftState[0]
      var setDraft = draftState[1]
      var value = Object.assign({}, stored, draft)
      var persistable = !!scope

      function setField(field, next) {
        setDraft(function (prev) { var copy = Object.assign({}, prev); copy[field] = next; return copy })
        if (!scope) return
        try {
          var promise = scope.set(field, next)
          if (promise && typeof promise.catch === 'function') {
            promise.catch(function (e) {
              setActionError(String((e && e.message) || e))
              setDraft(function (prev) { var copy = Object.assign({}, prev); delete copy[field]; return copy })
            })
          }
        } catch (e) { setActionError(String((e && e.message) || e)) }
      }

      var loadProxies = React.useCallback(function () {
        return apiFetch('proxies').then(function (payload) {
          setNodes(Array.isArray(payload.nodes) ? payload.nodes : [])
          setGroups(Array.isArray(payload.groups) ? payload.groups : [])
          return payload
        }).catch(function (e) { setActionError(String((e && e.message) || e)) })
      }, [])

      var loadGuard = React.useCallback(function () {
        return apiFetch('guard').then(function (payload) { setGuard(payload) })
          .catch(function () { setGuard(null) })
      }, [])

      React.useEffect(function () { loadProxies() }, [loadProxies])
      React.useEffect(function () { loadGuard() }, [loadGuard])

      function run(key, fn) {
        // 只挡同一个动作，不做全局锁 —— 否则一次卡住的「刷新 / 更新订阅」
        // （解析死节点可能很久）会把 busy 永久占住，之后每个按钮都静默失效。
        if (busy === key) return
        setBusy(key)
        setActionError(null)
        setNotice(null)
        Promise.resolve()
          .then(fn)
          .then(function (result) {
            setBusy(null)
            return reload().then(function () { return loadProxies() }).then(function () {
              if (result && result.hint) setNotice(result.hint)
            })
          })
          .catch(function (e) {
            setBusy(null)
            setActionError(String((e && e.message) || e))
          })
      }

      function refreshAll() {
        run('refresh', function () { return apiFetch('status?refresh=1') })
      }

      function restartCore() {
        run('restart', function () { return apiFetch('restart', {}) })
      }

      function updateSubscription() {
        run('update', function () { return apiFetch('update-subscription', {}) })
      }

      function testAll() {
        run('test', function () {
          return apiFetch('delay-all', {}).then(function (result) {
            var map = {}
            var results = (result && result.results) || {}
            Object.keys(results).forEach(function (key) { map[key] = results[key] })
            setNodes(function (prev) {
              return prev.map(function (node) {
                if (map[node.name] === undefined) return node
                var delay = map[node.name]
                return Object.assign({}, node, { delay: delay, alive: delay !== null && delay > 0 })
              })
            })
            return null
          })
        })
      }

      function selectNode(name) {
        run('select:' + name, function () { return apiFetch('select', { name: name }) })
      }

      function testNode(name) {
        run('delay:' + name, function () {
          return apiFetch('delay', { name: name }).then(function (result) {
            setNodes(function (prev) {
              return prev.map(function (node) {
                if (node.name !== name) return node
                return Object.assign({}, node, { delay: result.delay, alive: result.delay > 0 })
              })
            })
            return null
          })
        })
      }

      function profileAction(name, profile) {
        if (name === 'select') return selectProfile(profile.id)
        if (name === 'update') return run('p-update', function () { return apiFetch('profile-update', { id: profile.id }) })
        if (name === 'remove') return run('p-remove', function () { return apiFetch('profile-remove', { id: profile.id }) })
        if (name === 'auto') {
          return run('p-auto', function () {
            return apiFetch('profile-auto', { id: profile.id, enabled: !profile.autoUpdate, hours: profile.autoUpdateHours || 24 })
          })
        }
        return null
      }

      function selectProfile(id) {
        return run('p-select', function () { return apiFetch('profile-select', { id: id }) })
      }

      function addProfileFromUrl() {
        var urlState = importUrlState[0]
        var url = urlState
        if (!url.trim()) return
        run('p-add', function () {
          return apiFetch('profile-add-url', { value: url.trim(), label: importLabelState[0].trim() || undefined }).then(function (result) {
            setImportUrl('')
            setImportLabel('')
            setShowImport(false)
            return result
          })
        })
      }

      function addProfileFromFile(file) {
        if (!file) return
        var reader = new FileReader()
        reader.onload = function () {
          var content = String(reader.result || '')
          run('p-add-file', function () { return apiFetch('profile-add-file', { content: content, name: file.name }) })
        }
        reader.readAsText(file)
      }

      function applyGuard() {
        run('guard', function () {
          return apiFetch('guard-apply', {}).then(function (result) {
            loadGuard()
            return { hint: t('guardRestart') }
          })
        })
      }

      function restoreGuard() {
        run('guard-restore', function () {
          return apiFetch('guard-restore', {}).then(function () { loadGuard(); return { hint: t('guardRestart') } })
        })
      }

      // --- 派生状态 ---
      var coreState = status ? status.state : 'idle'
      var tone = 'idle'
      var stateText = t('stIdle')
      if (coreState === 'running') { tone = 'ok'; stateText = t('stRunning') }
      else if (coreState === 'disabled') { tone = 'idle'; stateText = t('stDisabled') }
      else if (coreState === 'failed') { tone = 'err'; stateText = t('stFailed') }
      else if (coreState === 'no-subscription') { tone = 'warn'; stateText = t('stNoSubscription') }
      else if (status && status.enabled === false) { tone = 'idle'; stateText = t('stDisabled') }

      var mode = status ? status.mode : 'none'
      var modeText = mode === 'subscription' ? t('modeSubscription')
        : mode === 'explicit' ? t('modeExplicit')
          : mode === 'environment' ? t('modeEnvironment')
            : t('modeNone')

      var profiles = (status && Array.isArray(status.profiles)) ? status.profiles : []
      var selectedNode = (status && status.selected) || null
      var currentNode = (status && status.currentNode) || null
      var running = status && status.state === 'running'

      // --- 导入表单状态 ---
      var importUrlPair = React.useState('')
      var importUrlState = importUrlPair
      var setImportUrl = importUrlPair[1]
      var importLabelPair = React.useState('')
      var importLabelState = importLabelPair
      var setImportLabel = importLabelPair[1]
      var showImportPair = React.useState(false)
      var showImport = showImportPair[0]
      var setShowImport = showImportPair[1]

      var header = h('header', { className: 'dshdl-head' },
        h('div', { className: 'dshdl-headText' },
          h('h2', { className: 'dshdl-h1' }, t('title')),
          h('p', { className: 'dshdl-sub' }, t('subtitle'))),
        h('div', { className: 'dshdl-actions' },
          h(Pill, { tone: tone }, stateText),
          h(LocaleSwitch, { t: t, choice: locale.choice, pick: locale.pick }),
          h(Btn, { onClick: refreshAll, disabled: busy === 'refresh' }, busy === 'refresh' ? '…' : t('refresh')),
          h(Btn, { onClick: restartCore, disabled: busy === 'restart' }, t('restartCore'))))

      var errorNode = error ? h('div', { className: 'dshdl-err' }, error) : null
      var actionErrorNode = actionError ? h('div', { className: 'dshdl-err' }, actionError) : null
      var noticeNode = notice ? h('div', { className: 'dshdl-note' }, notice) : null

      if (!persistable) {
        errorNode = h('div', { className: 'dshdl-err' }, t('unavailable'))
      }

      // --- 状态卡 ---
      var statusCard = h(Card, { title: t('upstream') },
        h('dl', { className: 'dshdl-kv' },
          h('dt', null, t('upstream')),
          h('dd', null, modeText + (status && status.reason ? ' · ' + status.reason : '')),
          h('dt', null, t('corePort')),
          h('dd', null, status && status.port ? String(status.port) : t('coreNone')),
          h('dt', null, t('nodesCount')),
          h('dd', null, status ? String(status.nodeCount) + ' · ' + (status.unsupportedNodes ? String(status.unsupportedNodes) : '0') + ' ⚠' : '—'),
          h('dt', null, t('currentNode')),
          h('dd', null, currentNode || '—')),
        !running && status ? h('div', { className: 'dshdl-note', style: { marginTop: '12px' } }, t('notRunningHint')) : null)

      // --- 节点配置卡 ---
      var profilesCard = h(Card, { title: t('profiles'), hint: t('profilesHint') },
        profiles.length === 0
          ? h('div', { className: 'dshdl-empty' }, t('emptyProfiles'))
          : h('div', { className: 'dshdl-grid' }, profiles.map(function (profile) {
            return h(ProfileTile, { key: profile.id, profile: profile, t: t, onAction: profileAction })
          })),
        showImport
          ? h('div', { className: 'dshdl-inlineForm' },
            h('div', { className: 'dshdl-inlineRow' },
              h('input', {
                className: 'dshdl-input',
                placeholder: t('importUrlPlaceholder'),
                value: importUrlState[0],
                onChange: function (e) { setImportUrl(e.target.value) }
              }),
              h('input', {
                className: 'dshdl-input',
                placeholder: t('importLabel'),
                value: importLabelState[0],
                onChange: function (e) { setImportLabel(e.target.value) }
              })),
            h('div', { className: 'dshdl-inlineRow' },
              h(Btn, { variant: 'primary', onClick: addProfileFromUrl, disabled: busy === 'p-add' }, t('import')),
              h('label', { className: 'dshdl-btn' }, t('importFile'),
                h('input', {
                  type: 'file',
                  accept: '.yaml,.yml,.txt,.conf',
                  style: { display: 'none' },
                  onChange: function (e) { addProfileFromFile(e.target.files && e.target.files[0]) }
                })),
              h(Btn, { variant: 'ghost', onClick: function () { setShowImport(false) } }, t('cancel'))))
          : h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '14px' } },
            h(Btn, { variant: 'primary', onClick: function () { setShowImport(true) } }, '+ ' + t('addProfile'))))

      // --- 节点卡 ---
      var nodesCard = h(Card, { title: t('nodes'), hint: t('nodesHint') },
        h('div', { className: 'dshdl-grid' },
          h(AutoTile, {
            t: t,
            active: selectedNode === null || selectedNode === undefined,
            current: currentNode || '',
            onClick: function () {
              // 宿主可能是还没重启的旧版本，没有 select-auto 路由 —— 退回「选中 AUTO 组的当前节点」。
              run('select-auto', function () {
                return apiFetch('select-auto', {}).catch(function () {
                  var auto = groups.filter(function (group) { return group.name === 'AUTO' })[0]
                  var target = auto && auto.now ? auto.now : (nodes[0] && nodes[0].name)
                  if (!target) return null
                  return apiFetch('select', { name: target })
                })
              })
            }
          }),
          nodes.map(function (node) {
            return h(NodeTile, {
              key: node.name,
              node: node,
              t: t,
              active: selectedNode === node.name,
              onClick: function () { selectNode(node.name) }
            })
          })),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' } },
          h(Btn, { onClick: testAll, disabled: busy === 'test' }, busy === 'test' ? t('testing') : t('testAll')),
          h(Btn, { onClick: updateSubscription, disabled: busy === 'update' }, t('update'))))

      // --- 下载卡（基础） ---
      var downloadCard = h(Card, { title: t('download') },
        h(TextRow, {
          label: t('downloadDir'),
          hint: t('downloadDirHint'),
          placeholder: t('dirPlaceholder'),
          value: value.downloadDir,
          onCommit: function (next) { setField('downloadDir', next) }
        }),
        h(Row, { label: t('threads'), hint: t('threadsHint') },
          h('input', {
            className: 'dshdl-input',
            type: 'number',
            min: 1,
            max: 32,
            value: value.threads,
            style: { width: '90px', minWidth: '90px' },
            onChange: function (e) {
              var parsed = Number(e.target.value)
              if (isFinite(parsed) && parsed >= 1) setField('threads', parsed)
            }
          })),
        h(Row, { label: t('maxMb') },
          h('input', {
            className: 'dshdl-input',
            type: 'number',
            min: 1,
            value: value.maxDownloadMb,
            style: { width: '110px', minWidth: '110px' },
            onChange: function (e) {
              var parsed = Number(e.target.value)
              if (isFinite(parsed) && parsed >= 1) setField('maxDownloadMb', parsed)
            }
          })))

      // --- 高级开关 ---
      var advancedToggle = h(Card, null,
        h(Row, { label: t('advanced'), hint: t('advancedHint') },
          h(Switch, {
            value: advanced,
            label: t('advanced'),
            onChange: function (next) {
              setAdvanced(next)
              writeStore(LS_ADVANCED, next ? '1' : '0')
            }
          })))

      var advancedCards = []
      if (advanced) {
        advancedCards.push(h(Card, { key: 'adv-upstream', title: t('advUpstream') },
          h(TextRow, {
            label: t('proxyUrl'),
            hint: t('proxyUrlHint'),
            value: value.proxyUrl,
            placeholder: 'socks5://127.0.0.1:1080',
            onCommit: function (next) { setField('proxyUrl', next) }
          }),
          h(TextRow, {
            label: t('subscriptionUrl'),
            hint: t('subscriptionUrlHint'),
            value: value.subscriptionUrl,
            placeholder: 'https://…',
            onCommit: function (next) { setField('subscriptionUrl', next) }
          }),
          h(TextRow, {
            label: t('fetchProxyUrl'),
            hint: t('fetchProxyUrlHint'),
            value: value.fetchProxyUrl,
            placeholder: 'http://127.0.0.1:7890',
            onCommit: function (next) { setField('fetchProxyUrl', next) }
          }),
          h(SelectRow, {
            label: t('groupType'),
            value: value.groupType,
            options: [
              { value: 'url-test', label: 'url-test' },
              { value: 'select', label: 'select' },
              { value: 'fallback', label: 'fallback' },
              { value: 'load-balance', label: 'load-balance' }
            ],
            onCommit: function (next) { setField('groupType', next) }
          }),
          h(TextRow, {
            label: t('preferredNode'),
            hint: t('preferredNodeHint'),
            value: value.preferredNode,
            onCommit: function (next) { setField('preferredNode', next) }
          }),
          h(Row, { label: t('autoUpdateHours') },
            h('input', {
              className: 'dshdl-input',
              type: 'number',
              min: 0,
              value: value.autoUpdateHours,
              style: { width: '90px', minWidth: '90px' },
              onChange: function (e) {
                var parsed = Number(e.target.value)
                if (isFinite(parsed) && parsed >= 0) setField('autoUpdateHours', parsed)
              }
            })),
          h(TextRow, { label: t('latencyTestUrl'), value: value.latencyTestUrl, onCommit: function (next) { setField('latencyTestUrl', next) } }),
          h(Row, { label: t('latencyTimeoutMs') },
            h('input', {
              className: 'dshdl-input',
              type: 'number',
              min: 200,
              value: value.latencyTimeoutMs,
              style: { width: '100px', minWidth: '100px' },
              onChange: function (e) {
                var parsed = Number(e.target.value)
                if (isFinite(parsed) && parsed >= 200) setField('latencyTimeoutMs', parsed)
              }
            }))))

        advancedCards.push(h(Card, { key: 'adv-routing', title: t('advRouting') },
          h(Row, { label: t('domesticDirect'), hint: t('domesticDirectHint') },
            h(Switch, { value: value.domesticDirect !== false, label: t('domesticDirect'), onChange: function (next) { setField('domesticDirect', next) } })),
          h(Row, { label: t('protectAiPlatforms'), hint: t('protectAiPlatformsHint') },
            h(Switch, { value: value.protectAiPlatforms !== false, label: t('protectAiPlatforms'), onChange: function (next) { setField('protectAiPlatforms', next) } })),
          h(ListRow, {
            label: t('extraDirectDomains'),
            hint: t('extraDirectDomainsHint'),
            value: value.extraDirectDomains,
            onCommit: function (next) { setField('extraDirectDomains', next) }
          }),
          h(ListRow, { label: t('extraRules'), hint: t('extraRulesHint'), value: value.extraRules, onCommit: function (next) { setField('extraRules', next) } }),
          h(ListRow, { label: t('excludeRules'), hint: t('excludeRulesHint'), value: value.excludeRules, onCommit: function (next) { setField('excludeRules', next) } })))

        advancedCards.push(h(Card, { key: 'adv-engine', title: t('advEngine') },
          h(Row, { label: t('maxRedirects') },
            h('input', {
              className: 'dshdl-input',
              type: 'number',
              min: 0,
              max: 30,
              value: value.maxRedirects,
              style: { width: '80px', minWidth: '80px' },
              onChange: function (e) {
                var parsed = Number(e.target.value)
                if (isFinite(parsed) && parsed >= 0) setField('maxRedirects', parsed)
              }
            })),
          h(Row, { label: t('stallTimeoutS') },
            h('input', {
              className: 'dshdl-input',
              type: 'number',
              min: 5,
              value: value.stallTimeoutS,
              style: { width: '80px', minWidth: '80px' },
              onChange: function (e) {
                var parsed = Number(e.target.value)
                if (isFinite(parsed) && parsed >= 5) setField('stallTimeoutS', parsed)
              }
            })),
          h(Row, { label: t('downloadTimeoutS') },
            h('input', {
              className: 'dshdl-input',
              type: 'number',
              min: 1,
              value: value.downloadTimeoutS,
              style: { width: '90px', minWidth: '90px' },
              onChange: function (e) {
                var parsed = Number(e.target.value)
                if (isFinite(parsed) && parsed >= 1) setField('downloadTimeoutS', parsed)
              }
            })),
          h(Row, { label: t('insecureTls'), hint: t('insecureTlsHint') },
            h(Switch, { value: value.insecureTls === true, label: t('insecureTls'), onChange: function (next) { setField('insecureTls', next) } })),
          h(Row, { label: t('allowOutsideWorkspace'), hint: t('allowOutsideWorkspaceHint') },
            h(Switch, { value: value.allowOutsideWorkspace === true, label: t('allowOutsideWorkspace'), onChange: function (next) { setField('allowOutsideWorkspace', next) } })),
          h(Row, { label: t('guardShellDownloads'), hint: t('guardShellDownloadsHint') },
            h(Switch, { value: value.guardShellDownloads !== false, label: t('guardShellDownloads'), onChange: function (next) { setField('guardShellDownloads', next) } }))))

        advancedCards.push(h(Card, { key: 'adv-harness', title: t('advHarness') },
          h(Row, { label: t('harnessProxy'), hint: t('harnessProxyHint') },
            h(Switch, { value: value.harnessProxy === true, label: t('harnessProxy'), onChange: function (next) { setField('harnessProxy', next) } })),
          h(Row, { label: t('harnessProxyPort'), hint: t('harnessProxyPortHint') },
            h('input', {
              className: 'dshdl-input',
              type: 'number',
              min: 1024,
              max: 65535,
              value: value.harnessProxyPort,
              style: { width: '100px', minWidth: '100px' },
              onChange: function (e) {
                var parsed = Number(e.target.value)
                if (isFinite(parsed) && parsed >= 1024 && parsed <= 65535) setField('harnessProxyPort', parsed)
              }
            }))))
      }

      // --- 会话保护 ---
      var protectedTotal = (status && Array.isArray(status.protectedDomains)) ? status.protectedDomains.length : 0
      var guardMissingCount = (guard && Array.isArray(guard.missing)) ? guard.missing.length : 0
      var guardCard = h(Card, { title: t('guard'), hint: t('guardHint') },
        guard
          ? h(React.Fragment, null,
            h(Row, {
              label: t('guard'),
              hint: guardMissingCount === 0
                ? t('guardCovered', protectedTotal)
                : t('guardMissing', guardMissingCount)
            },
              h('div', { style: { display: 'flex', gap: '8px' } },
                h(Btn, { variant: 'primary', onClick: applyGuard, disabled: busy === 'guard' }, t('guardApply')),
                h(Btn, { onClick: restoreGuard, disabled: busy === 'guard-restore' }, t('guardRestore')))),
            (guard.proxy_vars && guard.proxy_vars.length === 0)
              ? h('div', { className: 'dshdl-note' }, t('guardNoVars'))
              : null)
          : h('div', { className: 'dshdl-note' }, '—'))

      // --- 流量 ---
      var up = traffic ? Number(traffic.up) || 0 : 0
      var down = traffic ? Number(traffic.down) || 0 : 0
      var upRate = traffic ? Number(traffic.upRate) || 0 : 0
      var downRate = traffic ? Number(traffic.downRate) || 0 : 0
      var trafficCard = h(Card, { title: t('traffic') },
        traffic && traffic.active !== false
          ? h('div', { className: 'dshdl-traffic' },
            h('div', { className: 'dshdl-tItem' },
              h('div', { className: 'dshdl-tLabel' }, '↑ ' + t('trafficUp')),
              h('div', { className: 'dshdl-tValue' }, formatRate(upRate)),
              h('div', { className: 'dshdl-tSum' }, t('trafficTotal') + ' ' + formatBytes(up))),
            h('div', { className: 'dshdl-tItem' },
              h('div', { className: 'dshdl-tLabel' }, '↓ ' + t('trafficDown')),
              h('div', { className: 'dshdl-tValue' }, formatRate(downRate)),
              h('div', { className: 'dshdl-tSum' }, t('trafficTotal') + ' ' + formatBytes(down))))
          : h('div', { className: 'dshdl-note' }, t('trafficIdle')))

      var aboutCard = status
        ? h(Card, { title: t('about') },
          h('dl', { className: 'dshdl-kv' },
            h('dt', null, t('dataDir')),
            h('dd', null, status.dataDir || '—')),
          h('p', { className: 'dshdl-cardHint', style: { marginTop: '10px', marginBottom: 0 } }, t('scopeNote')))
        : null

      return h('div', { className: cls('dshdl-root', compact ? 'dshdl-compact' : 'dshdl-scroll') },
        header,
        errorNode,
        actionErrorNode,
        noticeNode,
        statusCard,
        profilesCard,
        nodesCard,
        downloadCard,
        advancedToggle,
        advancedCards,
        guardCard,
        trafficCard,
        aboutCard)
    }

    // ------------------------------------------------------------------
    // 侧栏导航图标（shell 只画这一格，行、标签、高亮由 shell 负责）
    // ------------------------------------------------------------------
    function PanelIcon(props) {
      var size = props.size || 16
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true'
      },
        h('path', { d: 'M8 2v7.2' }),
        h('path', { d: 'M5.2 6.4 8 9.2l2.8-2.8' }),
        h('path', { d: 'M2.6 11.4v1.4c0 .6.5 1.1 1.1 1.1h8.6c.6 0 1.1-.5 1.1-1.1v-1.4' }))
    }

    // ------------------------------------------------------------------
    // 页脚流量徽标
    // ------------------------------------------------------------------
    function TrafficBadge(props) {
      var wide = props.wide !== false
      var t = props.t || function (key) { return key }
      var traffic = useTraffic(1500)
      if (traffic === null || traffic.active === false) return null
      var upRate = Number(traffic.upRate) || 0
      var downRate = Number(traffic.downRate) || 0
      var tip = t('traffic') + '\n' +
        t('trafficUp') + ': ' + formatRate(upRate) + ' (' + t('trafficTotal') + ' ' + formatBytes(traffic.up) + ')\n' +
        t('trafficDown') + ': ' + formatRate(downRate) + ' (' + t('trafficTotal') + ' ' + formatBytes(traffic.down) + ')'
      if (!wide) {
        return h('div', { className: 'dshdl-trafRail', title: tip },
          h('span', null, '↓'),
          h('span', null, formatRateTiny(downRate)))
      }
      return h('div', { className: 'dshdl-trafFoot', title: tip },
        h('div', { className: 'row' }, h('span', null, '↑'), h('span', null, formatRateTiny(upRate))),
        h('div', { className: 'row' }, h('span', null, '↓'), h('span', null, formatRateTiny(downRate))))
    }

    // ------------------------------------------------------------------
    // 插件主体
    // ------------------------------------------------------------------
    // 只把骨架服务放进 inject；configForms / locale 一律惰性解析，
    // 否则任一服务缺失会让整个客户端插件停在 pending 且不报错。
    var inject = ['slots']

    function apply(ctx) {
      ensureCss()

      var ctxRef = { current: ctx }
      var locale = localeService(ctx)

      // 字典注册失败不影响面板（下面有自己的回退字典）。
      try {
        if (locale) locale.register(LOCALE_NS, { zh: LOCALE_ZH, en: LOCALE_EN })
      } catch (e) { /* ignore */ }

      var cached = null
      function getConfigForm() {
        if (cached) return cached
        try {
          var service = ctx.get('configForms')
          if (service && typeof service.get === 'function') cached = service.get(ENTRY_ID)
        } catch (e) { /* ignore */ }
        return cached
      }

      function label() {
        try {
          if (locale) return locale.bind(LOCALE_NS)('entryLabel')
        } catch (e) { /* ignore */ }
        return '下载代理'
      }

      // 1) 左侧栏导航行（shell 拥有按钮/标签/高亮/收起态几何）
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: label
        }, PanelIcon)
      })

      // 2) 左侧栏对应的主面板页面
      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          label: label,
          inject: function () {
            return { ctxRef: ctxRef, scope: getConfigForm(), variant: 'panel' }
          }
        }, DownloaderPage)
      })

      // 3) 设置页入口 —— 同一套 Page 组件，只是排版更紧凑
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: ENTRY_ID,
          order: 91,
          label: label,
          locale: LOCALE_NS,
          inject: function () {
            return { ctxRef: ctxRef, scope: getConfigForm(), variant: 'settings' }
          }
        }, DownloaderPage)
      })

      // 4) 侧栏页脚：实时流量。设置页/面板没打开也能看
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: ENTRY_ID + '-traffic',
          order: 20,
          inject: function () {
            var translate = function (key) { return key }
            try {
              var service = localeService(ctx)
              if (service) translate = service.bind(LOCALE_NS)
            } catch (e) { /* ignore */ }
            return { t: translate }
          }
        }, TrafficBadge)
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
