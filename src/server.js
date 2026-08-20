// 十交易所整合服务器
// 路由规则：
//   /api/de/*  → Decibel 交易所
//   /api/ex/*  → Extended 交易所
//   /api/rs/*  → RISEx 交易所
//   /api/ar/*  → Arcus 交易所
//   /api/lr/*  → Robinhood Chain Lighter 交易所
//   /api/n1/*, /api/ph/*, /api/ph2/*, /api/na/*, /api/pd/* → 新增交易所
//   /api/overview → 十交易所总览（余额+盈亏）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from './config.js';
import { createExchange as createDeExchange } from './exchange/de/index.js';
import { createExchange as createExExchange } from './exchange/ex/index.js';
import { createExchange as createRsExchange } from './exchange/rs/index.js';
import { createExchange as createArExchange } from './exchange/ar/index.js';
import { createExchange as createLrExchange } from './exchange/lr/index.js';
import { createExchange as createN1Exchange } from './exchange/n1/index.js';
import { createExchange as createPhExchange } from './exchange/ph/index.js';
import { createExchange as createPh2Exchange } from './exchange/ph2/index.js';
import { createExchange as createNaExchange } from './exchange/na/index.js';
import { createExchange as createPdExchange } from './exchange/pd/index.js';
import { GridBot } from './bot.js';
import { analyzeTrend } from './trend.js';
import { setupProxies, checkProxy } from './proxy.js';
import { loadSnapshot, saveSnapshot } from './persist.js';
import { createAiService } from './ai/service.js';
import { dashboardExchangeState } from './overview.js';

// ── 启动配置 ─────────────────────────────────────────────────────────────────
const cfg = getConfig();

// ── 代理设置 ─────────────────────────────────────────────────────────────────
const proxyResult = await setupProxies(cfg);
if (proxyResult.used) {
  console.log('[代理] 已启用: ' + proxyResult.used);
  console.log('[代理检测] 正在验证代理可用性...');
  const chk = await checkProxy();
  if (chk.ok) {
    console.log('[代理检测] ✓ 代理正常，当前出口 IP: ' + chk.ip);
  } else {
    console.error('[代理检测] ✗ 代理无法联网：' + chk.error);
    const hasLive = [cfg.de, cfg.ex, cfg.rs, cfg.ar, cfg.lr, cfg.n1, cfg.ph, cfg.ph2, cfg.na, cfg.pd]
      .some((venue) => venue.mode === 'live');
    if (hasLive) {
      console.error('  实盘模式已中止启动，以免在断网状态下运行造成挂单失控。');
      process.exit(1);
    } else {
      console.error('  模拟模式将继续运行，但可能拿不到真实行情。');
    }
  }
} else {
  console.log('[代理] 未配置（直连模式）');
}

// ── 创建十个交易所和机器人 ───────────────────────────────────────────────────
const deExchange = createDeExchange(cfg.de);
const exExchange = createExExchange(cfg.ex);
const rsExchange = createRsExchange(cfg.rs);
const arExchange = createArExchange(cfg.ar);
const lrExchange = createLrExchange(cfg.lr);
const n1Exchange = createN1Exchange(cfg.n1);
const phExchange = createPhExchange(cfg.ph);
const ph2Exchange = createPh2Exchange(cfg.ph2);
const naExchange = createNaExchange(cfg.na);
const pdExchange = createPdExchange(cfg.pd);

const deBot = new GridBot(deExchange, { onChange: (s) => saveSnapshot('de', s) });
const exBot = new GridBot(exExchange, { onChange: (s) => saveSnapshot('ex', s) });
const rsBot = new GridBot(rsExchange, { onChange: (s) => saveSnapshot('rs', s) });
const arBot = new GridBot(arExchange, { onChange: (s) => saveSnapshot('ar', s) });
const lrBot = new GridBot(lrExchange, { onChange: (s) => saveSnapshot('lr', s) });
const n1Bot = new GridBot(n1Exchange, { onChange: (s) => saveSnapshot('n1', s) });
const phBot = new GridBot(phExchange, { onChange: (s) => saveSnapshot('ph', s) });
const ph2Bot = new GridBot(ph2Exchange, { onChange: (s) => saveSnapshot('ph2', s) });
const naBot = new GridBot(naExchange, { onChange: (s) => saveSnapshot('na', s) });
const pdBot = new GridBot(pdExchange, { onChange: (s) => saveSnapshot('pd', s) });

// Restore cumulative stats / config from the previous run (display continuity).
// Trading does NOT auto-resume; stray-order cleanup happens after each exchange
// finishes init (see below).
deBot.restore(loadSnapshot('de'));
exBot.restore(loadSnapshot('ex'));
rsBot.restore(loadSnapshot('rs'));
arBot.restore(loadSnapshot('ar'));
lrBot.restore(loadSnapshot('lr'));
n1Bot.restore(loadSnapshot('n1'));
phBot.restore(loadSnapshot('ph'));
ph2Bot.restore(loadSnapshot('ph2'));
naBot.restore(loadSnapshot('na'));
pdBot.restore(loadSnapshot('pd'));

// Belt-and-suspenders: ensure every exchange always has an 'error' listener so a
// stray emit can never crash the process (the GridBot also attaches one).
for (const ex of [deExchange, exExchange, rsExchange, arExchange, lrExchange, n1Exchange, phExchange, ph2Exchange, naExchange, pdExchange]) {
  if (ex.listenerCount('error') === 0) {
    ex.on('error', (e) => { try { console.error('[交易所错误] ' + (e?.message || e)); } catch {} });
  }
}

// ── AI 服务（哨兵/日报/分析/对话/出区间建议）────────────────────────────────
const aiService = createAiService({
  bots: { de: deBot, ex: exBot, rs: rsBot, ar: arBot, lr: lrBot, n1: n1Bot, ph: phBot, ph2: ph2Bot, na: naBot, pd: pdBot },
  exchanges: { de: deExchange, ex: exExchange, rs: rsExchange, ar: arExchange, lr: lrExchange, n1: n1Exchange, ph: phExchange, ph2: ph2Exchange, na: naExchange, pd: pdExchange },
});
aiService.start();

// SSE 客户端集合（按交易所分组）
const deClients = new Set();
const exClients = new Set();
const rsClients = new Set();
const arClients = new Set();
const lrClients = new Set();
const n1Clients = new Set();
const phClients = new Set();
const ph2Clients = new Set();
const naClients = new Set();
const pdClients = new Set();

// ── 工具函数 ──────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};
const PUBLIC_ROOT = path.join(ROOT, 'public');

function send(res, code, obj) {
  const body = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve) => {
    let b = '', n = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      n += c.length;
      if (n > maxBytes) { done = true; try { req.destroy(); } catch { /* ignore */ } resolve({}); return; }
      b += c;
    });
    req.on('end', () => { if (done) return; done = true; try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// ── 交易所路由处理器工厂 ───────────────────────────────────────────────────────
function makeExchangeHandler(prefix, bot, exchange, exCfg, clients, name) {
  return async (req, res, subPath, url) => {
    if (subPath === '/markets') {
      return send(res, 200, {
        exchange: name,
        mode: exCfg.mode,
        dataSource: exchange.dataSource || (exCfg.mode === 'live' ? 'real' : 'synthetic'),
        network: exchange.network || exCfg.network,
        apiUrl: exchange.apiUrl || exCfg.apiUrl,
        markets: await exchange.getMarkets(),
      });
    }

    if (subPath === '/trend') {
      const marketId = Number(url.searchParams.get('marketId') || 1);
      const intervalSec = Number(url.searchParams.get('intervalSec') || 3600);
      let candles = [];
      try { candles = await exchange.getCandles(marketId, intervalSec, 200); } catch { /* tolerate */ }
      let price = null;
      try { price = await exchange.getPrice(marketId); } catch {}
      const analysis = (candles && candles.length >= 20)
        ? analyzeTrend(candles)
        : {
            trend: 'range', recommended: 'neutral', strength: 0, atrPct: null, price,
            detail: '暂时拿不到足够K线数据，已默认中性网格。可手动设置上下边界后启动；不影响下单。',
          };
      return send(res, 200, { analysis, candles: (candles || []).slice(-120) });
    }

    if (subPath === '/state') return send(res, 200, bot.getState());

    if (subPath === '/start' && req.method === 'POST') {
      try { return send(res, 200, await bot.start(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stop' && req.method === 'POST') {
      try { return send(res, 200, await bot.stop(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/adjust' && req.method === 'POST') {
      try { return send(res, 200, await bot.adjustRange(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/reset' && req.method === 'POST') {
      try { return send(res, 200, await bot.resetStats()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/cancel-orders' && req.method === 'POST') {
      try { return send(res, 200, await bot.cancelAllOrders()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/refill' && req.method === 'POST') {
      try { return send(res, 200, await bot.refillGrid()); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/start-recovery' && req.method === 'POST') {
      try { return send(res, 200, await bot.startRecovery(await readBody(req))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    // 重新与交易所建立连接：重建客户端/解卡轮询/重启轮询循环。
    // 不撤单、不平仓、不动网格状态 —— 挂单照常被跟踪；重连成功后立刻对账一次。
    // 若该所启动时未连上导致续跑被跳过（快照仍为运行状态），重连成功后自动续跑接管挂单。
    if (subPath === '/reconnect' && req.method === 'POST') {
      try {
        if (typeof exchange.reconnect === 'function') await exchange.reconnect();
        else if (typeof exchange.init === 'function') await exchange.init();
        let resumed = false, resumeError = null;
        if (!bot.running) {
          const key = prefix.split('/').pop(); // '/api/ex' -> 'ex'
          const snap = loadSnapshot(key);
          if (snap?.running && snap?.config) {
            try {
              // marketId 是按连接会话编号的，可能已漂移：按市场名称重新解析
              const markets = await exchange.getMarkets();
              const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
              const m = markets.find((x) => norm(x.displayName) === norm(snap.config.displayName) || norm(x.name) === norm(snap.config.displayName));
              if (m) snap.config.marketId = m.marketId;
              await bot.resume(snap);
              resumed = true;
              console.log(`[恢复] ${key.toUpperCase()} 重连成功后已自动续跑，接管挂单并完成对账。`);
            } catch (e) {
              resumeError = e?.message || String(e); // 续跑失败不撤单：挂单保留，可重启程序再试
              console.error(`[恢复] ${key.toUpperCase()} 重连后续跑失败（${resumeError}），挂单保留未动。`);
            }
          }
        }
        if (bot.running) await bot.reconcileOpenOrders().catch(() => {});
        return send(res, 200, { ok: true, resumed, resumeError, state: bot.getState() });
      } catch (e) {
        return send(res, 500, { error: e?.message || String(e) });
      }
    }

    if (subPath === '/close-position' && req.method === 'POST') {
      try { const b = await readBody(req); return send(res, 200, await bot.closePositionNow(b && b.marketId)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (subPath === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(bot.getState())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    send(res, 404, { error: 'not found: ' + subPath });
  };
}

const deHandler = makeExchangeHandler('/api/de', deBot, deExchange, cfg.de, deClients, 'Decibel');
const exHandler = makeExchangeHandler('/api/ex', exBot, exExchange, cfg.ex, exClients, 'Extended');
const rsHandler = makeExchangeHandler('/api/rs', rsBot, rsExchange, cfg.rs, rsClients, 'RISEx');
const arHandler = makeExchangeHandler('/api/ar', arBot, arExchange, cfg.ar, arClients, 'Arcus');
const lrHandler = makeExchangeHandler('/api/lr', lrBot, lrExchange, cfg.lr, lrClients, 'RHC Lighter');
const n1Handler = makeExchangeHandler('/api/n1', n1Bot, n1Exchange, cfg.n1, n1Clients, 'N1');
const phHandler = makeExchangeHandler('/api/ph', phBot, phExchange, cfg.ph, phClients, 'Phoenix');
const ph2Handler = makeExchangeHandler('/api/ph2', ph2Bot, ph2Exchange, cfg.ph2, ph2Clients, 'Phoenix2');
const naHandler = makeExchangeHandler('/api/na', naBot, naExchange, cfg.na, naClients, 'Nado');
const pdHandler = makeExchangeHandler('/api/pd', pdBot, pdExchange, cfg.pd, pdClients, 'PopDEX');

// ── HTTP 服务器 ───────────────────────────────────────────────────────────────
const server = http.createServer(async (request, res) => {
  const url = new URL(request.url, 'http://localhost');
  const p = url.pathname;

  try {
    // ── 总览 API ──────────────────────────────────────────────────────────
    if (p === '/api/overview') {
      return send(res, 200, {
        de: pick(deBot.getState(), cfg.de.mode),
        ex: pick(exBot.getState(), cfg.ex.mode),
        rs: pick(rsBot.getState(), cfg.rs.mode),
        ar: pick(arBot.getState(), cfg.ar.mode),
        lr: pick(lrBot.getState(), cfg.lr.mode),
        n1: pick(n1Bot.getState(), cfg.n1.mode),
        ph: pick(phBot.getState(), cfg.ph.mode),
        ph2: pick(ph2Bot.getState(), cfg.ph2.mode),
        na: pick(naBot.getState(), cfg.na.mode),
        pd: pick(pdBot.getState(), cfg.pd.mode),
      });
    }

    // ── 总览 SSE 流 ───────────────────────────────────────────────────────
    if (p === '/api/overview/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // send the current snapshot immediately (don't leave the client blank
      // until the next 1s broadcast tick)
      // One browser connection carries both the overview and the complete
      // per-exchange states. The old UI opened several permanent HTTP/1.1 SSE
      // connections, leaving Chrome no free socket for trade actions.
      const initial = dashboardState();
      res.write(`data: ${JSON.stringify(initial, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`);
      const overviewClients = server._overviewClients;
      overviewClients.add(res);
      request.on('close', () => overviewClients.delete(res));
      return;
    }

    // ── AI 助手 API ───────────────────────────────────────────────────────
    if (p === '/api/ai/status') {
      return send(res, 200, aiService.status());
    }
    if (p === '/api/ai/test' && request.method === 'POST') {
      try { return send(res, 200, await aiService.test()); }
      catch (e) { return send(res, 200, { ok: false, error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/sentinel-run' && request.method === 'POST') {
      try {
        const r = await aiService.runSentinel();
        return send(res, 200, r || { error: aiService.sentinelError || '巡检失败' });
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/market-run' && request.method === 'POST') {
      try { return send(res, 200, await aiService.runMarketAnalysis()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/report' && request.method === 'POST') {
      try { return send(res, 200, await aiService.makeReport()); }
      catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/analyze' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        return send(res, 200, await aiService.analyze(String(b.ex || 'de')));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }
    if (p === '/api/ai/chat' && request.method === 'POST') {
      try {
        const b = await readBody(request);
        if (!b.message) return send(res, 400, { error: '消息为空' });
        return send(res, 200, await aiService.chatControl(b.message, Array.isArray(b.history) ? b.history : []));
      } catch (e) { return send(res, 500, { error: e?.message || String(e) }); }
    }

    // ── 代理配置 API ──────────────────────────────────────────────────────
    if (p === '/api/proxy-check') {
      const result = await checkProxy();
      return send(res, 200, result);
    }

    if (p === '/api/proxy-config') {
      return send(res, 200, {
        global: process.env.GLOBAL_PROXY || '',
        de: process.env.DECIBEL_PROXY || '',
        ex: process.env.EXTENDED_PROXY || '',
        rs: process.env.RISEX_PROXY || '',
        ar: process.env.ARCUS_PROXY || '',
        lr: process.env.LIGHTER_PROXY || '',
        n1: process.env.N1_PROXY || '',
        ph: process.env.PHOENIX_PROXY || '',
        ph2: process.env.PHOENIX2_PROXY || '',
        na: process.env.NADO_PROXY || '',
        pd: process.env.POPDEX_PROXY || '',
        // Boolean only: a Windows proxy can contain credentials or an internal
        // hostname and must never be sent to the browser.
        windowsSystem: proxyResult.source === 'windows-system',
      });
    }

    if (p === '/api/env' && request.method === 'POST') {
      try {
        const { key, value } = await readBody(request);
        const PROXY_KEYS = ['GLOBAL_PROXY','DECIBEL_PROXY','EXTENDED_PROXY','RISEX_PROXY','ARCUS_PROXY','LIGHTER_PROXY','N1_PROXY','PHOENIX_PROXY','PHOENIX2_PROXY','NADO_PROXY','POPDEX_PROXY'];
        const AI_KEYS = ['AI_PROVIDER','AI_API_KEY','AI_BASE_URL','AI_MODEL','AI_MODEL_SMALL','AI_SENTINEL_MINUTES','AI_MARKET_MINUTES','AI_REPORT_HOUR','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','NOTIFY_WEBHOOK'];
        if (!PROXY_KEYS.includes(key) && !AI_KEYS.includes(key)) return send(res, 400, { error: '不允许修改该字段: ' + key });
        // SECURITY: the value is written verbatim into .env. Reject anything that
        // could break out of a single KEY=VALUE line (newlines / control chars)
        // — otherwise a crafted value could inject arbitrary env lines (e.g. flip
        // DE_MODE=live, set private keys). Per-key format validation below.
        const val = value == null ? '' : String(value).trim();
        if (val) {
          if (/\s/.test(val) || [...val].some((c) => c.charCodeAt(0) < 32) || val.length > 500) {
            return send(res, 400, { error: '值包含非法字符（空白/换行/控制字符）或过长。' });
          }
          if (PROXY_KEYS.includes(key)) {
            // host:port | host:port:user:pass | scheme://[user:pass@]host:port
            const ok = /^[\w.-]+:\d{1,5}(:[^:\s@]+:[^:\s@]+)?$/.test(val)
              || /^(https?|socks[45]?):\/\/([^:@/\s]+(:[^@/\s]+)?@)?[\w.-]+:\d{1,5}\/?$/i.test(val);
            if (!ok) return send(res, 400, { error: '代理地址格式无效。示例：http://127.0.0.1:7890 或 socks5://user:pass@host:1080' });
          } else if (key === 'AI_PROVIDER') {
            if (!/^(openai|anthropic|gemini)$/i.test(val)) return send(res, 400, { error: 'AI_PROVIDER 只能是 openai / anthropic / gemini（OpenAI 兼容协议的服务商选 openai）。' });
          } else if (key === 'AI_SENTINEL_MINUTES' || key === 'AI_MARKET_MINUTES') {
            if (!/^\d{1,4}$/.test(val)) return send(res, 400, { error: '间隔必须是数字（分钟，0=关闭）。' });
          } else if (key === 'AI_REPORT_HOUR') {
            if (!/^\d{1,2}$/.test(val) || Number(val) > 23) return send(res, 400, { error: '日报时间必须是 0-23 的整点小时。' });
          } else if (key === 'AI_BASE_URL' || key === 'NOTIFY_WEBHOOK') {
            if (!/^https?:\/\/\S+$/i.test(val)) return send(res, 400, { error: '必须是 http(s):// 开头的 URL。' });
          }
        }
        // 更新内存中的环境变量
        if (val) process.env[key] = val; else delete process.env[key];
        // 写入 .env 文件
        const envFile = path.join(ROOT, '.env');
        let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
        const regex = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
        const line = val ? `${key}=${val}` : `# ${key}=`;
        if (regex.test(content)) {
          content = content.replace(regex, line);
        } else {
          content = content.trimEnd() + '\n' + line + '\n';
        }
        fs.writeFileSync(envFile, content, 'utf8');
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    // ── 交易所子路由 ──────────────────────────────────────────────────────
    if (p.startsWith('/api/de/')) {
      return await deHandler(request, res, p.slice('/api/de'.length), url);
    }
    if (p.startsWith('/api/ex/')) {
      return await exHandler(request, res, p.slice('/api/ex'.length), url);
    }
    if (p.startsWith('/api/rs/')) {
      return await rsHandler(request, res, p.slice('/api/rs'.length), url);
    }
    if (p.startsWith('/api/ar/')) {
      return await arHandler(request, res, p.slice('/api/ar'.length), url);
    }
    if (p.startsWith('/api/lr/')) {
      return await lrHandler(request, res, p.slice('/api/lr'.length), url);
    }
    if (p.startsWith('/api/n1/')) {
      return await n1Handler(request, res, p.slice('/api/n1'.length), url);
    }
    if (p.startsWith('/api/ph2/')) {
      return await ph2Handler(request, res, p.slice('/api/ph2'.length), url);
    }
    if (p.startsWith('/api/ph/')) {
      return await phHandler(request, res, p.slice('/api/ph'.length), url);
    }
    if (p.startsWith('/api/na/')) {
      return await naHandler(request, res, p.slice('/api/na'.length), url);
    }
    if (p.startsWith('/api/pd/')) {
      return await pdHandler(request, res, p.slice('/api/pd'.length), url);
    }

    // ── 静态文件 ──────────────────────────────────────────────────────────
    const relativeFile = p === '/' ? 'index.html' : p.replace(/^[/\\]+/, '');
    const full = path.resolve(PUBLIC_ROOT, relativeFile);
    const insidePublic = full === PUBLIC_ROOT || full.startsWith(PUBLIC_ROOT + path.sep);
    if (insidePublic && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      return fs.createReadStream(full).pipe(res);
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server._overviewClients = new Set();

// ── SSE 推送定时器 ────────────────────────────────────────────────────────────
setInterval(() => {
  const stringify = (obj) =>
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

  if (deClients.size > 0) {
    const data = `data: ${stringify(deBot.getState())}\n\n`;
    for (const r of deClients) { try { r.write(data); } catch { deClients.delete(r); } }
  }
  if (exClients.size > 0) {
    const data = `data: ${stringify(exBot.getState())}\n\n`;
    for (const r of exClients) { try { r.write(data); } catch { exClients.delete(r); } }
  }
  if (rsClients.size > 0) {
    const data = `data: ${stringify(rsBot.getState())}\n\n`;
    for (const r of rsClients) { try { r.write(data); } catch { rsClients.delete(r); } }
  }
  if (arClients.size > 0) {
    const data = `data: ${stringify(arBot.getState())}\n\n`;
    for (const r of arClients) { try { r.write(data); } catch { arClients.delete(r); } }
  }
  if (lrClients.size > 0) {
    const data = `data: ${stringify(lrBot.getState())}\n\n`;
    for (const r of lrClients) { try { r.write(data); } catch { lrClients.delete(r); } }
  }
  if (n1Clients.size > 0) {
    const data = `data: ${stringify(n1Bot.getState())}\n\n`;
    for (const r of n1Clients) { try { r.write(data); } catch { n1Clients.delete(r); } }
  }
  if (phClients.size > 0) {
    const data = `data: ${stringify(phBot.getState())}\n\n`;
    for (const r of phClients) { try { r.write(data); } catch { phClients.delete(r); } }
  }
  if (ph2Clients.size > 0) {
    const data = `data: ${stringify(ph2Bot.getState())}\n\n`;
    for (const r of ph2Clients) { try { r.write(data); } catch { ph2Clients.delete(r); } }
  }
  if (naClients.size > 0) {
    const data = `data: ${stringify(naBot.getState())}\n\n`;
    for (const r of naClients) { try { r.write(data); } catch { naClients.delete(r); } }
  }
  if (pdClients.size > 0) {
    const data = `data: ${stringify(pdBot.getState())}\n\n`;
    for (const r of pdClients) { try { r.write(data); } catch { pdClients.delete(r); } }
  }
  if (server._overviewClients.size > 0) {
    const data = `data: ${stringify(dashboardState())}\n\n`;
    for (const r of server._overviewClients) { try { r.write(data); } catch { server._overviewClients.delete(r); } }
  }
}, 1000);

function dashboardState() {
  return {
    de: dashboardExchangeState(deBot.getState(), cfg.de.mode),
    ex: dashboardExchangeState(exBot.getState(), cfg.ex.mode),
    rs: dashboardExchangeState(rsBot.getState(), cfg.rs.mode),
    ar: dashboardExchangeState(arBot.getState(), cfg.ar.mode),
    lr: dashboardExchangeState(lrBot.getState(), cfg.lr.mode),
    n1: dashboardExchangeState(n1Bot.getState(), cfg.n1.mode),
    ph: dashboardExchangeState(phBot.getState(), cfg.ph.mode),
    ph2: dashboardExchangeState(ph2Bot.getState(), cfg.ph2.mode),
    na: dashboardExchangeState(naBot.getState(), cfg.na.mode),
    pd: dashboardExchangeState(pdBot.getState(), cfg.pd.mode),
  };
}

function pick(s, mode) {
  return {
    running: s.running,
    mode,
    balance: s.balance,
    equity: s.equity,
    totalPnl: s.totalPnl,
    realizedPnl: s.realizedPnl,
    unrealizedPnl: s.unrealizedPnl,
    returnPct: s.returnPct,
    volume: s.volume,
    completedRungs: s.stats?.completedRungs ?? 0,
    openOrders: s.openOrders ?? 0,
    exchangeOpenOrders: s.exchangeOpenOrders ?? null,
    outOfRange: s.outOfRange ?? false,
    riskGuard: s.riskGuard ?? null,
    health: s.health ?? null,
    lastPrice: s.lastPrice,
    config: s.config,
    position: s.position ?? null,
    operationalIssue: s.operationalIssue ?? null,
    apiWalletAddress: s.apiWalletAddress ?? null,
  };
}

// ── 错误处理 ──────────────────────────────────────────────────────────────────
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${cfg.port} 已被占用。`);
    console.error('请先关闭占用该端口的程序，或在 .env 里改 PORT=8284 用别的端口。\n');
  } else {
    console.error('[服务器错误] ' + (e?.message || e));
  }
  process.exit(1);
});

// ── 初始化各交易所 ────────────────────────────────────────────────────────────
async function initExchange(exchange, name, exCfg) {
  try {
    await exchange.init();
    console.log(`[${name}] ✓ 连接成功 [${exCfg.mode.toUpperCase()} 模式]`);
  } catch (e) {
    exchange.stop?.();
    exchange.dataSource = null;
    exchange.lastOkAt = 0;
    exchange.lastError = e?.message || String(e);
    console.error(`\n[${name}] ✗ 初始化失败：${e?.message || e}`);
    console.error(`  目标接口: ${exCfg.apiUrl}   网络: ${exCfg.network}`);
    const cause = e?.cause || {};
    const code = cause.code || '';
    if (code === 'ENOTFOUND') {
      console.error('  ➤ 域名解析失败：检查网络，或配置代理。');
    } else if (code === 'ECONNREFUSED' && String(cause.address || '').includes('127.0.0.1')) {
      console.error('  ➤ 本机代理端口连不上，检查代理软件是否开启。');
    } else if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(cause.message || '')) {
      console.error('  ➤ 连接超时，接口被网络拦截，或代理未正确转发。');
    }
    console.error(`  该交易所将以离线模式运行（行情可能使用合成数据）。\n`);
    // 不退出，让其他交易所继续工作
  }
}

await Promise.all([
  initExchange(deExchange, 'Decibel', cfg.de),
  initExchange(exExchange, 'Extended', cfg.ex),
  initExchange(rsExchange, 'RISEx', cfg.rs),
  initExchange(arExchange, 'Arcus', cfg.ar),
  initExchange(lrExchange, 'RHC Lighter', cfg.lr),
  initExchange(n1Exchange, 'N1', cfg.n1),
  initExchange(phExchange, 'Phoenix', cfg.ph),
  initExchange(ph2Exchange, 'Phoenix2', cfg.ph2),
  initExchange(naExchange, 'Nado', cfg.na),
  initExchange(pdExchange, 'PopDEX', cfg.pd),
]);

// LIVE Arcus must expose a verified account snapshot before the dashboard can
// offer trading controls. During concurrent exchange startup an early
// partial snapshot can occasionally be superseded; retry once through the
// adapter's read-only reconnect path and fail Arcus closed if it is still bad.
if (cfg.ar.mode === 'live' && arExchange.dataSource === 'real') {
  const arcusReady = () => Number.isFinite(arExchange.balance)
    && Number.isFinite(arExchange.equity)
    && Number(arExchange.lastOkAt) > 0;
  if (!arcusReady()) {
    console.warn('[Arcus] 启动账户快照不完整，正在执行一次只读重连校验…');
    try { await arExchange.reconnect(); }
    catch (e) { console.error('[Arcus] 启动重连校验失败：' + (e?.message || e)); }
  }
  if (!arcusReady()) {
    arExchange.stop();
    arExchange.dataSource = null;
    arExchange.lastError = 'Arcus 实盘账户权益未通过启动校验，已保持离线以阻止交易。';
    console.error('[Arcus] ✗ 实盘账户权益未通过启动校验，Arcus 已保持离线。');
  }
}

// RHC live is fail-closed as well: trading controls remain offline unless the
// signer profile, authenticated order read and account/equity snapshot all
// completed successfully during init/reconnect.
if (cfg.lr.mode === 'live' && lrExchange.dataSource === 'real') {
  const lighterReady = () => Number.isFinite(lrExchange.balance)
    && Number.isFinite(lrExchange.equity)
    && Number(lrExchange.lastOkAt) > 0;
  if (!lighterReady()) {
    console.warn('[RHC Lighter] 启动账户快照不完整，正在执行一次只读重连校验…');
    try { await lrExchange.reconnect(); }
    catch (e) { console.error('[RHC Lighter] 启动重连校验失败：' + (e?.message || e)); }
  }
  if (!lighterReady()) {
    lrExchange.dataSource = null;
    lrExchange.lastError = 'RHC 实盘账户权益或 API 签名鉴权未通过，已保持离线以阻止交易。';
    console.error('[RHC Lighter] ✗ 实盘启动校验未通过，RHC 已保持离线。');
  }
}

// ── 崩溃恢复 / 续跑 ────────────────────────────────────────────────────────────
// If a bot was "running" when the process died, RESUME it: re-attach to the
// orders still resting on the exchange and keep managing the grid. If resume
// fails (e.g. exchange offline), fall back to cancelling stray orders so we
// never operate a half-known grid.
async function resumeIfWasRunning(bot, exchange, key) {
  const snap = loadSnapshot(key);
  if (!(snap?.running && snap?.config)) return;
  if (exchange.dataSource == null) {
    console.log(`[恢复] ${key.toUpperCase()} 交易所未连接，跳过续跑；保留挂单待下次连接。`);
    return;
  }
  try {
    console.log(`[恢复] 检测到 ${key.toUpperCase()} 上次为运行状态，正在接管续跑...`);
    await bot.resume(snap);
    console.log(`[恢复] ${key.toUpperCase()} 已续跑，接管挂单并完成对账。`);
  } catch (e) {
    console.error(`[恢复] ${key.toUpperCase()} 续跑失败（${e?.message || e}），改为撤销遗留挂单。`);
    try {
      await bot.recoverStrayOrders();
    } catch (cancelError) {
      console.error(`[恢复] ${key.toUpperCase()} 遗留挂单撤单/确认失败：${cancelError?.message || cancelError}。本地状态未清除，请立即到交易所核对。`);
    }
  }
}
await Promise.all([
  resumeIfWasRunning(deBot, deExchange, 'de'),
  resumeIfWasRunning(exBot, exExchange, 'ex'),
  resumeIfWasRunning(rsBot, rsExchange, 'rs'),
  resumeIfWasRunning(arBot, arExchange, 'ar'),
  resumeIfWasRunning(lrBot, lrExchange, 'lr'),
  resumeIfWasRunning(n1Bot, n1Exchange, 'n1'),
  resumeIfWasRunning(phBot, phExchange, 'ph'),
  resumeIfWasRunning(ph2Bot, ph2Exchange, 'ph2'),
  resumeIfWasRunning(naBot, naExchange, 'na'),
  resumeIfWasRunning(pdBot, pdExchange, 'pd'),
]);

// After init, surface any LEFTOVER position so the dashboard can prompt the user
// (recovery ladder / re-grid / market close). Decibel & Extended RE-NUMBER their
// marketIds every run, so the persisted numeric id may point at the wrong market
// — re-resolve it by the market NAME, then start watching it so the position is
// polled into getState.
const _norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function detectOrphanPosition(bot, ex) {
  if (!bot.config?.displayName || ex.dataSource == null || typeof ex.getMarkets !== 'function') return;
  try {
    const markets = await ex.getMarkets();
    const want = _norm(bot.config.displayName);
    const m = markets.find((x) => _norm(x.displayName) === want || _norm(x.name) === want || _norm(x.symbol) === want);
    if (m) {
      bot.config.marketId = m.marketId;            // fix stale/ephemeral id -> current
      await ex.getPrice(m.marketId).catch(() => {}); // seed watch -> position gets polled
    }
  } catch { /* ignore */ }
}
await Promise.all([
  detectOrphanPosition(deBot, deExchange),
  detectOrphanPosition(exBot, exExchange),
  detectOrphanPosition(rsBot, rsExchange),
  detectOrphanPosition(arBot, arExchange),
  detectOrphanPosition(lrBot, lrExchange),
  detectOrphanPosition(n1Bot, n1Exchange),
  detectOrphanPosition(phBot, phExchange),
  detectOrphanPosition(ph2Bot, ph2Exchange),
  detectOrphanPosition(naBot, naExchange),
  detectOrphanPosition(pdBot, pdExchange),
]);

server.listen(cfg.port, cfg.host, () => {
  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  十交易所整合网格机器人 已启动`);
  console.log(`  仪表盘: http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
  if (cfg.host === '0.0.0.0') console.log('  ⚠ 当前监听所有网卡(0.0.0.0)，局域网内可访问，请确保有防护。');
  console.log(`${'═'.repeat(52)}`);
  console.log(`  Decibel  [${cfg.de.mode.toUpperCase()}]  ${cfg.de.network}`);
  console.log(`  Extended [${cfg.ex.mode.toUpperCase()}]  ${cfg.ex.network}`);
  console.log(`  RISEx    [${cfg.rs.mode.toUpperCase()}]  ${cfg.rs.network}`);
  console.log(`  Arcus    [${cfg.ar.mode.toUpperCase()}]  ${cfg.ar.network}  accountIndex=${cfg.ar.accountIndex}`);
  console.log(`  RHC      [${cfg.lr.mode.toUpperCase()}]  mainnet  accountIndex=${Number.isFinite(cfg.lr.accountIndex) ? cfg.lr.accountIndex : '未配置'}  apiKeyIndex=${Number.isFinite(cfg.lr.apiKeyIndex) ? cfg.lr.apiKeyIndex : '未配置'}`);
  console.log(`  N1       [${cfg.n1.mode.toUpperCase()}]  ${cfg.n1.network}`);
  console.log(`  Phoenix  [${cfg.ph.mode.toUpperCase()}]  ${cfg.ph.network}`);
  console.log(`  Phoenix2 [${cfg.ph2.mode.toUpperCase()}]  ${cfg.ph2.network}`);
  console.log(`  Nado     [${cfg.na.mode.toUpperCase()}]  ${cfg.na.network}`);
  console.log(`  PopDEX   [${cfg.pd.mode.toUpperCase()}]  ${cfg.pd.network}`);
  console.log(`${'─'.repeat(52)}`);
  if ([cfg.de, cfg.ex, cfg.rs, cfg.ar, cfg.lr, cfg.n1, cfg.ph, cfg.ph2, cfg.na, cfg.pd]
    .some((venue) => venue.mode === 'paper')) {
    console.log('  ⚠ 部分交易所为模拟模式，不涉及真实资金。');
    console.log('    在 .env 中设置对应交易所的 *_MODE=live 切换实盘。');
  }
  console.log('');
});
