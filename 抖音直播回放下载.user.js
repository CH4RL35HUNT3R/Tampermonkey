// ==UserScript==
// @name         抖音直播复盘回放一键下载 (Douyin Live Replay Downloader)
// @namespace    https://anchor.douyin.com/
// @version      8.9
// @description  抓取抖音直播回放地址，在浏览器里边下边封成 mp4。HEVC 原样搬进容器不重编码，画面正常、能拖进度。文件名按开播时刻加总时长，例如 抖音回放_26-11-18-20-30+1时45分.mp4。自己解 TS、自己拼 hvcC，用 ctts 记录 B 帧，超 4GB 用 64 位偏移。
// @author       CH4RL35HUNT3R
// @updateURL    https://raw.githubusercontent.com/CH4RL35HUNT3R/Tampermonkey/main/%E6%8A%96%E9%9F%B3%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
// @downloadURL  https://raw.githubusercontent.com/CH4RL35HUNT3R/Tampermonkey/main/%E6%8A%96%E9%9F%B3%E7%9B%B4%E6%92%AD%E5%9B%9E%E6%94%BE%E4%B8%8B%E8%BD%BD.user.js
// @supportURL   https://github.com/CH4RL35HUNT3R/Tampermonkey
// @match        https://anchor.douyin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      douyincdn.com
// @connect      douyinvod.cn
// @connect      douyinvod.com
// @connect      bytevcloudvod.com
// @connect      bytevcloudvod.cn
// @connect      bytecdntp.com
// @connect      zjcdn.com
// @connect      ixigua.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ---------- 主体 ----------

  const W = typeof unsafeWindow !== 'undefined' && unsafeWindow ? unsafeWindow : window;

  const CONCURRENCY = 16;              // 单文件分块并发
  const HLS_CONCURRENCY = 4;           // 分片并发。抖音 CDN 对单 IP 有并发限制，4 路最稳
  const HLS_WINDOW = 48;               // 预取最多领先消费指针多少段，防止整条片子堆在内存里
  const SEG_TIMEOUT_MS = 10000;        // 消费端等一段的时间上限
  const STALL_MS = 120000;             // 连续这么久一点进展都没有就收尾保存
  const CHUNK_SIZE = 4 * 1024 * 1024;  // 每块 4MB
  const MAX_ITEMS = 40;                // 列表最多留多少条，防止无限膨胀

  const RE_IMG = /\.(jpg|jpeg|png|webp|gif|heic|avif|ico|svg)(\?|#|$)/i;
  const RE_SEG = /\.(ts|m4s|m4a|aac|vtt)(\?|#|$)/i;   // 分片不是文件，抓它没意义还拖进度
  const RE_VIDEO_EXT = /\.(m3u8|mp4|flv)(\?|#|$)/i;
  const RE_CDN = /douyinvod|bytevcloudvod|\/video\/tos\//i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = new Map();
  const progress = new Map();
  const parsedMasters = new Set();
  let panelReady = false;
  let renderTimer = null;

  const log = (...a) => console.log('%c[回放]', 'color:#7ee787', ...a);

  function isVideoUrl(u) {
    if (!u || typeof u !== 'string' || u.length < 10) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    if (RE_IMG.test(u) || RE_SEG.test(u)) return false;
    return RE_VIDEO_EXT.test(u) || RE_CDN.test(u);
  }

  const kindOf = (u) => (/\.m3u8/i.test(u) ? 'HLS' : /\.flv/i.test(u) ? 'FLV' : /\.mp4/i.test(u) ? 'MP4' : '流');

  // 去重只看 域名+路径。抖音的签名参数（ts/expire/sign）每次都变，
  // 带上 query 去重等于没去重。
  function normKey(u) {
    try {
      const x = new URL(u, location.href);
      return x.host + x.pathname;
    } catch (e) {
      return String(u).split('#')[0];
    }
  }

  // ---------- 网络 ----------
  const hasGM = typeof GM_xmlhttpRequest === 'function';

  function gmGet(url, responseType, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!hasGM) return reject(new Error('GM 接口不可用'));
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        // 抖音 CDN 会看 Referer，裸请求容易被当爬虫掐掉
        headers: Object.assign({ Referer: location.origin + '/', Origin: location.origin }, headers || {}),
        responseType: responseType || 'arraybuffer',
        timeout: timeoutMs || 60000,
        onload: (r) => resolve(r),
        onerror: (r) => reject(new Error('网络请求失败' + (r && r.status ? ' ' + r.status : ''))),
        ontimeout: () => reject(new Error('请求超时')),
        onabort: () => reject(new Error('请求被中断')),
      });
    });
  }

  async function getBytesRange(url, start, end, retry = 3) {
    let lastErr;
    for (let i = 0; i < retry; i++) {
      try {
        const r = await gmGet(url, 'arraybuffer', { Range: `bytes=${start}-${end}` });
        if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
        const buf = r.response;
        if (!buf || !buf.byteLength) throw new Error('空块');
        return new Uint8Array(buf);
      } catch (e) {
        lastErr = e;
        await sleep(400 * (i + 1));
      }
    }
    throw lastErr;
  }

  async function getBytes(url) {
    const r = await gmGet(url, 'arraybuffer');
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    const buf = r.response;
    if (!buf || !buf.byteLength) throw new Error(`返回空内容（${r.status}）`);
    return new Uint8Array(buf);
  }

  async function getText(url, timeoutMs) {
    const r = await gmGet(url, 'text', {}, timeoutMs || 60000);
    if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
    return r.responseText || '';
  }

  // 取一整段 ts：有 GM 走 GM 通道，没有就用页面自己的 fetch
  async function getSegBytes(url) {
    if (hasGM) {
      const r = await gmGet(url, 'arraybuffer', {}, 30000);
      if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
      if (!r.response || !r.response.byteLength) throw new Error('空响应');
      return new Uint8Array(r.response);
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  function headerOf(r, name) {
    const h = r.responseHeaders || '';
    const m = new RegExp(name + ':\\s*([^\\r\\n]+)', 'i').exec(h);
    return m ? m[1].trim() : '';
  }

  // 探测总大小，并确认服务器是否支持分段
  async function probe(url) {
    const r = await gmGet(url, 'arraybuffer', { Range: 'bytes=0-1023' });
    const total = Number((headerOf(r, 'content-range').match(/\/(\d+)/) || [])[1] || 0);
    const len = Number(headerOf(r, 'content-length') || 0);
    const ranges = /bytes/i.test(headerOf(r, 'accept-ranges')) || r.status === 206;
    if (!total && r.status === 200) {
      return { total: len, ranges: false, status: r.status };
    }
    return { total, ranges, status: r.status };
  }

  // ---------- 抓地址 ----------
  function trimStore() {
    if (store.size <= MAX_ITEMS) return;
    const idle = [...store.values()].filter((v) => !v._busy).sort((a, b) => a.ts - b.ts);
    while (store.size > MAX_ITEMS && idle.length) store.delete(idle.shift().key);
  }

  function addUrl(u, from) {
    if (!isVideoUrl(u)) return;
    const key = normKey(u);
    const hit = store.get(key);
    if (hit) {
      hit.url = u; // 签名会过期，用最新抓到的那条
      return;
    }
    store.set(key, { key, url: u, type: kindOf(u), from: from || '', ts: Date.now(), variants: [] });
    log('+', key.slice(0, 130));
    trimStore();
    scheduleRender();
    if (/\.m3u8/i.test(u)) {
      parseMaster(key, u);
      // 趁用户看页面的时候先把编码探出来，点下载时就不用等
      const it = store.get(key);
      if (it) setTimeout(() => {
        it._probeP = detectFormat(it).catch(() => {});
      }, 200);
    }
  }

  async function parseMaster(key, url) {
    if (parsedMasters.has(key)) return;
    parsedMasters.add(key);
    try {
      const txt = await getText(url);
      if (!txt.includes('#EXT-X-STREAM-INF')) return;
      const lines = txt.split(/\r?\n/);
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
        const bw = (line.match(/BANDWIDTH=(\d+)/) || [])[1];
        const res = (line.match(/RESOLUTION=(\d+x\d+)/) || [])[1];
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
        if (j >= lines.length) break;
        const abs = new URL(lines[j].trim(), url).href;
        out.push({
          label: [res, bw ? (Number(bw) / 1e6).toFixed(1) + 'M' : ''].filter(Boolean).join(' / ') || '子流',
          url: abs,
        });
      }
      const item = store.get(key);
      if (item && out.length) {
        item.variants = out;
        out.forEach((v) => {
          const k = normKey(v.url);
          if (!store.has(k)) {
            store.set(k, { key: k, url: v.url, type: 'HLS', from: '清晰度 ' + v.label, ts: Date.now(), variants: [] });
          }
        });
        scheduleRender();
      }
    } catch (e) {
      log('主列表解析失败', e);
    }
  }

  (function hookNetwork() {
    const rawFetch = W.fetch;
    if (rawFetch) {
      W.fetch = function (...args) {
        try {
          const u = typeof args[0] === 'string' ? args[0] : args[0] && args[0].url;
          if (isVideoUrl(u)) addUrl(new URL(u, W.location.href).href, 'fetch');
        } catch (e) {}
        return rawFetch.apply(this, args);
      };
    }
    const XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const rawOpen = XHR.prototype.open;
      XHR.prototype.open = function (m, u, ...rest) {
        try {
          if (isVideoUrl(u)) addUrl(new URL(u, W.location.href).href, 'xhr');
        } catch (e) {}
        return rawOpen.call(this, m, u, ...rest);
      };
    }
    const proto = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
    if (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (desc && desc.set) {
        Object.defineProperty(proto, 'src', {
          configurable: true,
          get: desc.get,
          set(v) {
            try {
              if (isVideoUrl(v)) addUrl(new URL(v, W.location.href).href, 'video');
            } catch (e) {}
            return desc.set.call(this, v);
          },
        });
      }
    }
  })();

  // 每 2.5 秒扫一次，只在 src 变了才处理
  let lastSeen = '';
  setInterval(() => {
    const v = document.querySelector('video');
    const s = v && (v.currentSrc || v.src);
    if (!s || s === lastSeen || !/^https?:/i.test(s)) return;
    lastSeen = s;
    addUrl(s, 'video');
  }, 2500);

  // ---------- 进度与速度 ----------
  const fmt = (n) => {
    if (!n) return '0';
    const mb = n / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + 'GB' : mb.toFixed(1) + 'MB';
  };

  const speedState = new Map();
  function speedOf(key, bytes) {
    const now = Date.now();
    let s = speedState.get(key);
    if (!s) {
      s = { t: now, b: bytes, v: 0 };
      speedState.set(key, s);
      return 0;
    }
    if (now - s.t >= 700) {
      s.v = ((bytes - s.b) * 1000) / (now - s.t);
      s.t = now;
      s.b = bytes;
    }
    return s.v;
  }
  const fmtSpeed = (v) => (v > 1048576 ? (v / 1048576).toFixed(1) + 'MB/s' : (v / 1024).toFixed(0) + 'KB/s');

  // 进度条元素缓存下来，别每个字节都去 querySelector
  function setProg(key, text, pct) {
    let p = progress.get(key);
    if (!p) {
      p = { text: '', pct: 0, _bar: null, _txt: null };
      progress.set(key, p);
    }
    p.text = text;
    p.pct = pct;
    let bar = p._bar;
    if (!bar || !bar.isConnected) {
      bar = document.querySelector(`[data-p="${CSS.escape(key)}"]`);
      p._bar = bar || null;
      const row = bar && bar.closest('[data-row]');
      p._txt = row ? row.querySelector('.pg-text') : null;
    }
    if (!bar) return;
    if (p._txt) p._txt.textContent = text;
    bar.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  }

  // 面板上方飘一句提示，纯装饰。内部吞掉异常：提示画不出来也不该把下载判成失败
  let tTimer = null;
  function toast(msg) {
    try {
      let el = document.getElementById('__dl_toast');
      if (!el) {
        el = document.createElement('div');
        el.id = '__dl_toast';
        el.style.cssText =
          'position:fixed;right:24px;bottom:500px;z-index:2147483647;background:#111;color:#fff;' +
          'padding:8px 14px;border-radius:6px;font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;' +
          'opacity:0;transition:opacity .2s;pointer-events:none;max-width:320px;';
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.opacity = '1';
      clearTimeout(tTimer);
      tTimer = setTimeout(() => (el.style.opacity = '0'), 3000);
    } catch (e) {}
  }

  // ---------- 写盘 ----------
  class Sink {
    constructor(handle, fileName) {
      this.handle = handle;
      this.fileName = fileName;
      this.writer = null;
      this.chunks = [];
      this.bytes = 0;
      this.positional = !!handle;
      this.chain = Promise.resolve(); // 串行写，别让多个写入撞一起
    }
    static async create(fileName) {
      if (window.showSaveFilePicker) {
        try {
          const handle = await window.showSaveFilePicker({ suggestedName: fileName });
          return new Sink(handle, fileName);
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
        }
      }
      return new Sink(null, fileName);
    }
    async open() {
      if (this.handle && !this.writer) this.writer = await this.handle.createWritable();
    }
    // 无论同步异步，都排进同一条链，保证顺序
    writeAt(u8, pos) {
      if (!u8 || !u8.byteLength) return this.chain;
      this.bytes += u8.byteLength;
      this.chain = this.chain.then(async () => {
        try {
          if (this.writer) {
            if (typeof pos === 'number') await this.writer.write({ type: 'write', position: pos, data: u8 });
            else await this.writer.write(u8);
          } else {
            this.chunks.push(u8);
          }
        } catch (e) {
          log('写入失败', e);
        }
      });
      return this.chain;
    }
    async write(u8) {
      return this.writeAt(u8);
    }
    async close(mime) {
      await this.chain;
      if (this.writer) {
        await this.writer.close();
        return this.bytes;
      }
      const blob = new Blob(this.chunks, { type: mime || 'video/mp4' });
      this.chunks = [];
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = this.fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 30000);
      return blob.size;
    }
  }

  // ---------- 多线程分块下载 ----------
  async function parallelDownload(url, fileName, item, sink) {
    const pk = item.key || normKey(url);
    const info = await probe(url);
    log('探测', info);
    if (!info.total) throw new Error('服务器没给文件大小，无法分块');
    if (!info.ranges) throw new Error('服务器不支持分段（无 Accept-Ranges）');

    setProg(pk, `总大小 ${fmt(info.total)}，启动 ${CONCURRENCY} 线程`, 0);
    await sink.open();

    let next = 0;
    let done = 0;
    let lastTs = Date.now();
    let stalled = false;
    const total = info.total;

    async function worker() {
      for (;;) {
        if (item._stop) return;
        const start = next;
        if (start >= total) return;
        next += CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, total) - 1;
        const u8 = await getBytesRange(url, start, end);
        await sink.writeAt(u8, start);
        done += u8.byteLength;
        lastTs = Date.now();
        const sp = speedOf(pk, done);
        setProg(
          pk,
          `${fmt(done)} / ${fmt(total)}  ·  ${(done / total * 100).toFixed(1)}%${sp ? '  ·  ' + fmtSpeed(sp) : ''}`,
          (done / total) * 100
        );
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    if (!item._stop && done < total && Date.now() - lastTs > STALL_MS) stalled = true;
    const n = await sink.close('video/mp4');
    if (!n) throw new Error('写出 0 字节');
    return { bytes: n, done, total, stopped: !!item._stop, stalled };
  }

  // ---------- 单连接兜底 ----------
  function downloadViaGM(url, fileName, item) {
    const pk = item.key || normKey(url);
    return new Promise((resolve, reject) => {
      if (typeof GM_download !== 'function') return reject(new Error('GM_download 不可用'));
      GM_download({
        url,
        name: fileName,
        saveAs: true,
        onprogress: (e) => {
          if (e && e.lengthComputable) {
            const sp = speedOf(pk + '#single', e.loaded);
            setProg(pk, `${fmt(e.loaded)} / ${fmt(e.total)}${sp ? '  ·  ' + fmtSpeed(sp) : ''}`, (e.loaded / e.total) * 100);
          }
        },
        onload: () => resolve(true),
        onerror: (err) => reject(new Error('GM 下载失败 ' + ((err && (err.error || err.message)) || ''))),
        ontimeout: () => reject(new Error('GM 下载超时')),
      });
    });
  }

  // ---------- HLS ----------
  function findMux() {
    if (typeof muxjs !== 'undefined' && muxjs && muxjs.mp4) return muxjs;
    if (W.muxjs && W.muxjs.mp4) return W.muxjs;
    return null;
  }

  // mux.js 只在真碰到 TS 分片时才拉，不再 @require 阻塞每次页面加载
  let muxPromise = null;
  function ensureMux() {
    const now = findMux();
    if (now) return Promise.resolve(now);
    if (muxPromise) return muxPromise;
    // jsdelivr 在国内经常拉不动，依次换源
    const SOURCES = [
      'https://cdn.jsdelivr.net/npm/mux.js@7.0.3/dist/mux.min.js',
      'https://fastly.jsdelivr.net/npm/mux.js@7.0.3/dist/mux.min.js',
      'https://unpkg.com/mux.js@7.0.3/dist/mux.min.js',
      'https://cdn.staticfile.org/mux.js/6.3.0/mux.min.js',
    ];
    muxPromise = new Promise((resolve) => {
      let idx = 0;
      const tryNext = () => {
        if (findMux()) return resolve(findMux());
        if (idx >= SOURCES.length) return resolve(null);
        const s = document.createElement('script');
        s.src = SOURCES[idx++];
        s.onload = () => (findMux() ? resolve(findMux()) : tryNext());
        s.onerror = () => tryNext();
        (document.head || document.documentElement).appendChild(s);
      };
      tryNext();
      setTimeout(() => resolve(findMux()), 20000);
    });
    return muxPromise;
  }

  // ---------- 场次日期（用于文件名） ----------
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
  const okDate = (y, m, d) => +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31;

  // 列表里每条分片都带开播时刻，例如 #EXT-X-PROGRAM-DATE-TIME:2026-11-18T14:20:15+0800
  function dateFromPdt(txt) {
    const m = /#EXT-X-PROGRAM-DATE-TIME:\s*(\d{4})-(\d{2})-(\d{2})/.exec(txt || '');
    return m && okDate(m[1], m[2], m[3]) ? ymd(m[1], m[2], m[3]) : '';
  }

  // 文件名用的时间戳，精确到分：yy-mm-dd-hh-mm（开播时刻）
  const yy = (y) => String(y).slice(-2);
  const hhmmOk = (h, mi) => +h >= 0 && +h <= 23 && +mi >= 0 && +mi <= 59;

  function stampFromPdt(txt) {
    const m = /#EXT-X-PROGRAM-DATE-TIME:\s*(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(txt || '');
    if (!m || !okDate(m[1], m[2], m[3]) || !hhmmOk(m[4], m[5])) return '';
    return `${yy(m[1])}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`;
  }

  function stampFromUrl(u) {
    const s = String(u || '');
    // .../20261118142002/20261118142002-0.ts 这种 14 位时间戳，直接就是开播时刻
    const m = /(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?![\d])/.exec(s);
    if (m && okDate(m[1], m[2], m[3]) && hhmmOk(m[4], m[5])) return `${yy(m[1])}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`;
    // .../1794907221-1794911470.m3u8 这种 unix 秒
    const re = /(?:^|[^\d])(\d{10})(?:[^\d]|$)/g;
    let k;
    while ((k = re.exec(s))) {
      const t = Number(k[1]);
      if (t < 1577836800 || t > 2524608000) continue;
      const d = new Date(t * 1000);
      if (!okDate(d.getFullYear(), d.getMonth() + 1, d.getDate())) continue;
      return `${yy(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}-${pad2(d.getMinutes())}`;
    }
    return '';
  }

  function stampNow() {
    const n = new Date();
    return `${yy(n.getFullYear())}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}-${pad2(n.getHours())}-${pad2(n.getMinutes())}`;
  }

  // 抓到地址的钟点，面板上标来源时用
  const clockHM = (t) => {
    const d = new Date(t || Date.now());
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  // 回放总时长：+1时45分 / +45分
  function durTag(sec) {
    const s = Number(sec) || 0;
    if (s < 60) return '';
    const total = Math.round(s / 60);
    const h = Math.floor(total / 60);
    const mi = total % 60;
    return h ? `+${h}时${mi}分` : `+${mi}分`;
  }

  // 抖音回放_26-11-18-20-30+1时45分.mp4
  function replayName(item, ext) {
    const stamp = (item && item._start) || stampFromUrl(item && item.url) || stampNow();
    return `抖音回放_${stamp}${durTag(item && item._dur)}${ext || '.mp4'}`;
  }

  // 有的回放地址只有 unix 秒，没有 14 位时间戳：
  // .../hls/stream-6969149360856111386-1794907221-1794911470.m3u8
  // 1794907221 = 2026-11-17 17:20:21（本地时间），是开播时刻，后面那个是结束时刻
  function dateFromUnix(u) {
    const s = String(u || '');
    const re = /(?:^|[^\d])(\d{10})(?:[^\d]|$)/g;
    let m;
    while ((m = re.exec(s))) {
      const t = Number(m[1]);
      if (t < 1577836800 || t > 2524608000) continue; // 2020-01-01 ~ 2050
      const d = new Date(t * 1000);
      if (!okDate(d.getFullYear(), d.getMonth() + 1, d.getDate())) continue;
      return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
    }
    return '';
  }

  // 地址里也埋着同一个时刻：.../20261118142002/20261118142002-0.ts
  // 注意 stream-696920008049557944 这种长数字里也能凑出 2000-80-49，得逐个试到合法的那个
  function dateFromUrl(u) {
    const re = /(20\d{2})(\d{2})(\d{2})\d{6}/g;
    const s = String(u || '');
    let m;
    let fallback = '';
    while ((m = re.exec(s))) {
      if (!okDate(m[1], m[2], m[3])) continue;
      const d = ymd(m[1], m[2], m[3]);
      const before = s[m.index - 1] || '';
      const after = s[m.index + m[0].length] || '';
      // 前后都不是数字，才算一段独立的时间戳
      if (!/\d/.test(before) && !/\d/.test(after)) return d;
      if (!fallback) fallback = d;
    }
    return fallback || dateFromUnix(u);
  }

  async function readPlaylist(url, timeoutMs) {
    const txt = await getText(url, timeoutMs);
    if (!txt.startsWith('#EXTM3U')) throw new Error('返回的不是 m3u8');
    if (txt.includes('#EXT-X-STREAM-INF')) {
      const lines = txt.split(/\r?\n/);
      let best = null;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i].trim();
        if (!l.startsWith('#EXT-X-STREAM-INF')) continue;
        const bw = Number((l.match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
        let j = i + 1;
        while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
        if (j >= lines.length) break;
        const abs = new URL(lines[j].trim(), url).href;
        if (!best || bw > best.bw) best = { bw, url: abs };
      }
      if (best) return readPlaylist(best.url, timeoutMs);
    }
    if (/#EXT-X-KEY:METHOD=AES-128/i.test(txt)) throw new Error('分片 AES 加密，脚本解不了');
    const lines = txt.split(/\r?\n/);
    const segs = [];
    let init = null;
    let dur = 0;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('#EXT-X-MAP')) {
        const m = l.match(/URI="([^"]+)"/);
        if (m) init = new URL(m[1], url).href;
      } else if (l.startsWith('#EXTINF')) {
        const m = l.match(/#EXTINF:\s*([\d.]+)/);
        if (m) dur += Number(m[1]);
      } else if (!l.startsWith('#')) segs.push(new URL(l, url).href);
    }
    const keyMatch = txt.match(/#EXT-X-KEY:([^\r\n]+)/);
    return {
      segs,
      init,
      dur,
      key: keyMatch ? keyMatch[1].trim() : '',
      endlist: /#EXT-X-ENDLIST/.test(txt),
      // 第一条 PDT 就是开播时刻，用来给文件命名
      date: dateFromPdt(txt),
      start: stampFromPdt(txt),
    };
  }

  function sniff(u8) {
    if (!u8 || u8.byteLength < 12) return 'unknown';
    if (u8[0] === 0x47) return 'ts';
    const t = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
    return ['ftyp', 'styp', 'moof', 'moov', 'sidx'].includes(t) ? 'fmp4' : 'unknown';
  }

  // 解析 TS 里的 PMT，看视频轨到底是 H.264 还是 HEVC。
  // mux.js 只认 H.264，碰到 HEVC 会不声不响把视频轨丢掉，只剩音频。
  function tsCodec(u8) {
    if (!u8 || u8.byteLength < 376) return 'unknown';
    let base = -1;
    for (let i = 0; i < Math.min(1000, u8.byteLength - 376); i++) {
      if (u8[i] === 0x47 && u8[i + 188] === 0x47 && u8[i + 376] === 0x47) {
        base = i;
        break;
      }
    }
    if (base < 0) return 'unknown';
    const types = new Set();
    for (let off = base; off + 188 <= u8.byteLength; off += 188) {
      if (u8[off] !== 0x47) continue;
      if ((u8[off + 1] & 0x40) === 0) continue; // 只要载荷单元起始
      const afc = (u8[off + 3] >> 4) & 0x3;
      if (afc === 0 || afc === 2) continue;
      let p = off + 4;
      if (afc === 3) p += 1 + u8[p];
      if (p + 3 >= off + 188) continue;
      const s = p + 1 + u8[p]; // 跳过 pointer_field
      if (s + 12 > off + 188 || u8[s] !== 0x02) continue; // table_id 0x02 = PMT
      const secLen = ((u8[s + 1] & 0x0f) << 8) | u8[s + 2];
      const end = Math.min(s + 3 + secLen - 4, off + 188);
      const progInfoLen = ((u8[s + 10] & 0x0f) << 8) | u8[s + 11];
      let q = s + 12 + progInfoLen;
      while (q + 5 <= end) {
        types.add(u8[q]);
        q += 5 + (((u8[q + 3] & 0x0f) << 8) | u8[q + 4]);
      }
      if (types.size) break;
    }
    if (types.has(0x24)) return 'hevc';
    if (types.has(0x1b)) return 'avc';
    return 'unknown';
  }

  // 保存框弹出前就要知道扩展名，所以先探一下第一段
  // strict=true 时读不到列表就直接抛错（点击下载走这条），免得先弹保存框再失败
  async function detectFormat(item, strict) {
    if (item._fmt && item._fmtOk) return item._fmt;
    const fmt = { container: 'unknown', vcodec: 'unknown', ext: '.mp4' };
    try {
      const p = await readPlaylist(item.url, 15000);
      if (p.date && p.date !== item._sd) {
        item._sd = p.date;
        scheduleRender();
      }
      // 文件名要的「开播时刻 + 总时长」，趁这次读列表一起存下，点下载时就不用再等网络
      item._start = p.start || stampFromUrl(item.url);
      item._dur = p.dur;
      scheduleRender();
      if (p.segs.length) {
        const r = await gmGet(p.segs[0], 'arraybuffer', { Range: 'bytes=0-65535' }, 15000);
        const u8 = new Uint8Array(r.response || new ArrayBuffer(0));
        const k = sniff(u8);
        fmt.container = k;
        if (k === 'ts') {
          fmt.vcodec = tsCodec(u8);
          fmt.ext = fmt.vcodec === 'avc' ? '.mp4' : '.ts';
        }
      }
      item._fmtOk = true;
      item._probeErr = '';
    } catch (e) {
      const m = String((e && e.message) || e);
      log('格式探测失败', m);
      item._probeErr = m;
      scheduleRender();
      if (strict) throw new Error('读不到播放列表（' + m + '），地址可能已失效，刷新页面重新抓一次');
    }
    item._fmt = fmt;
    return fmt;
  }

  async function downloadHls(url, fileName, item, sink) {
    const pk = item.key || normKey(url);
    const { segs, init, dur, key, endlist } = await readPlaylist(url);
    if (!segs.length) throw new Error('播放列表里没有分片');
    if (key && !/METHOD=NONE/i.test(key)) {
      throw new Error('这条流带加密（' + key.slice(0, 50) + '），脚本解不了');
    }
    const first = await getBytes(segs[0]);
    const detected = sniff(first);
    const vcodec = detected === 'ts' ? tsCodec(first) : '';
    log('分片数', segs.length, '时长', dur.toFixed(0) + 's', '格式', detected, vcodec, endlist ? '完整列表' : '未结束');

    let mux = null;
    // 只有 H.264 才走 mux.js。HEVC 进去视频轨会被吃掉，宁可原样拼
    if (detected === 'ts' && vcodec === 'avc') {
      setProg(pk, '准备转封装…', 0);
      mux = await ensureMux();
      if (!mux) log('mux.js 没拉到，TS 原样拼接');
    } else if (detected === 'ts') {
      log('视频编码 ' + vcodec + '，跳过转封装，按 TS 原样拼接');
    }
    const useMux = !!(mux && mux.mp4);

    await sink.open();

    // 预取：多路并发拉分片，按顺序写入。窗口限制住，别让整条片子堆在内存里
    const bufs = new Array(segs.length);
    bufs[0] = first;
    let nextFetch = 1;
    let cursor = 0;
    let aborted = false;
    let abortReason = '';
    let consecFail = 0;
    let lastErrText = '';
    let failLogged = 0;

    async function fetchSeg(u, idx) {
      let lastErr;
      for (let t = 0; t < 2; t++) {
        try {
          const r = await gmGet(u, 'arraybuffer', {}, 15000);
          // 签名过期没必要重试，直接认输，省得一路慢放
          if (r.status === 401 || r.status === 403) {
            aborted = true;
            abortReason = '地址签名已过期（' + r.status + '）';
            throw new Error(abortReason);
          }
          if (r.status >= 400) throw new Error('HTTP ' + r.status);
          if (!r.response || !r.response.byteLength) throw new Error('空段');
          return new Uint8Array(r.response);
        } catch (e) {
          lastErr = e;
          lastErrText = '第' + ((idx || 0) + 1) + '段 ' + String((e && e.message) || e);
          if (failLogged < 5) {
            failLogged++;
            log('失败', lastErrText);
          }
          if (aborted) throw e;
          await sleep(300 * (t + 1));
        }
      }
      throw lastErr;
    }

    async function fetcher() {
      for (;;) {
        if (aborted || item._stop) return;
        if (nextFetch >= segs.length) return;
        // 领先消费指针太多就先歇着，等消费追上
        if (nextFetch > cursor + HLS_WINDOW) {
          await sleep(60);
          continue;
        }
        const i = nextFetch;
        nextFetch = i + 1;
        try {
          bufs[i] = await fetchSeg(segs[i], i);
          consecFail = 0;
        } catch (e) {
          bufs[i] = null;
          if (aborted) return;
          consecFail++;
          if (consecFail >= 6) {
            aborted = true;
            abortReason = abortReason || ('连续 6 段失败：' + lastErrText);
            log('连续失败 6 段，停止拉取', e);
            return;
          }
        }
      }
    }
    Array.from({ length: HLS_CONCURRENCY }, () => fetcher());

    let transmuxer = null;
    let gotInit = false;
    if (useMux) {
      transmuxer = new mux.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: true });
      transmuxer.on('data', (seg) => {
        if (!gotInit && seg.initSegment && seg.initSegment.byteLength) {
          sink.write(new Uint8Array(seg.initSegment));
          gotInit = true;
        }
        if (seg.data && seg.data.byteLength) sink.write(new Uint8Array(seg.data));
      });
    }

    let written = 0;
    let completed = 0;
    let stopped = false;
    let stalled = false;
    let lastTs = Date.now();
    if (!useMux && init) {
      await sink.write(await getBytes(init));
    }

    for (let i = 0; i < segs.length; i++) {
      cursor = i;
      if (item._stop) {
        stopped = true;
        break;
      }
      // 等这一段就绪，最多 10 秒
      let waited = 0;
      while (bufs[i] === undefined) {
        if (aborted || item._stop) break;
        if ((waited += 50) >= SEG_TIMEOUT_MS) break;
        await sleep(50);
      }
      const b = bufs[i];
      bufs[i] = undefined;
      if (!b) {
        if (aborted || item._stop) break;
        // 一段都没成，且已经很久没进展：八成是连接被掐了，收尾保存
        if (Date.now() - lastTs > STALL_MS) {
          stalled = true;
          abortReason = abortReason || ('长时间没有进展，最后一个错误：' + (lastErrText || '未捕获'));
          break;
        }
        continue;
      }
      if (transmuxer) {
        transmuxer.push(b);
        transmuxer.flush();
      } else {
        await sink.write(b);
      }
      written += b.byteLength;
      completed++;
      lastTs = Date.now();
      const sp = speedOf(pk, written);
      setProg(
        pk,
        `${completed}/${segs.length} 段 · 剩 ${segs.length - completed} 段 · ${fmt(written)}${sp ? ' · ' + fmtSpeed(sp) : ''}`,
        (completed / segs.length) * 100
      );
    }

    // 赶紧把没消费的缓冲放掉
    for (let k = 0; k < bufs.length; k++) bufs[k] = undefined;

    const n = await sink.close(/\.ts$/i.test(fileName) ? 'video/mp2t' : 'video/mp4');
    if (!n) throw new Error('写出 0 字节');
    return { bytes: n, completed, total: segs.length, stopped, stalled, aborted, abortReason, endlist, dur, detected };
  }

  // ---------- 浏览器内直封 mp4 ----------
  // 按 m3u8 拉分片，把 TS 里的 HEVC / AAC 原样搬进 mp4 容器：只换容器不重编码，
  // 画质不掉，要多久取决于带宽。全程只用浏览器自带的保存框和写盘接口。
  function remuxReady() {
    return !!(typeof window !== 'undefined' && picker());
  }

  // 油猴跑在沙箱里，showSaveFilePicker 在页面 window 上，优先用 unsafeWindow 取，
  // 取不到再退回沙箱 window，两边都要绑对 this，否则会报非法调用。
  function picker() {
    try {
      if (W && typeof W.showSaveFilePicker === 'function') return W.showSaveFilePicker.bind(W);
      if (typeof window.showSaveFilePicker === 'function') return window.showSaveFilePicker.bind(window);
    } catch (e) {}
    return null;
  }

  // 抖音这份列表带 PROGRAM-DATE-TIME，时间轴会从 1970 年起算，时长变成十几亿秒。
  // 重写一份只留分片信息的列表，duration 才正常，进度条才有意义。
  function cleanPlaylist(txt, baseUrl) {
    const body = [];
    let maxD = 0;
    let total = 0;
    let n = 0;
    for (const raw of txt.split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (/^#EXT-X-(PROGRAM-DATE-TIME|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|VERSION|ENDLIST|ALLOW-CACHE|PLAYLIST-TYPE|INDEPENDENT-SEGMENTS)/i.test(l)) continue;
      if (l.startsWith('#EXTINF')) {
        const m = l.match(/#EXTINF:\s*([\d.]+)/);
        if (m) {
          maxD = Math.max(maxD, Number(m[1]));
          total += Number(m[1]);
        }
        body.push(l);
        continue;
      }
      if (l.startsWith('#')) {
        body.push(l);
        continue;
      }
      body.push(new URL(l, baseUrl).href);
      n++;
    }
    const head = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + Math.ceil(maxD || 10), '#EXT-X-MEDIA-SEQUENCE:0'];
    return { text: head.concat(body, ['#EXT-X-ENDLIST']).join('\n'), count: n, dur: total };
  }

  const clock = (s) => {
    s = Math.max(0, Math.round(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(x).padStart(2, '0');
  };


  // ---------- 重封装器 ----------
  // 改编自 github.com/fxl1209739475-fxl/douyin-live-replay-comment-exporter（MIT）。
  // 职责：解 TS、拼 hvcC、写 hvc1、用 ctts 记录 B 帧、超 4GB 用 64 位偏移，
  // 并生成完整的 esds，让播放器认得出 AAC 配置。
  function TSRemuxerFactory() {
    let cached = null;
    return function get() {
      if (cached) return cached;
      (() => {
    /**
     * MPEG-TS → MP4 重封装（纯 JS，零依赖，Node 和浏览器都能跑）
     *
     * 为什么要这个：抖音回放是 HLS 的 .ts 分片，直接拼起来虽然能放，但 QuickTime、
     * Finder 预览、微信、很多手机播放器都不认这个容器。把它重新装进 MP4 盒子里，
     * 到处都能直接双击播放——**只是换容器，不重新编码，画质一帧不损**。
     *
     * 抖音这份回放的四个特点决定了实现：
     *   1. 视频是 HEVC → 必须构造 hvcC 配置盒，sample entry 用 'hvc1'
     *      （写成 'hev1' 的话苹果播放器只出声音不出画面）
     *   2. 音频是 AAC-LC ADTS → 要剥掉 ADTS 头，改用 esds 描述
     *   3. **有 B 帧** → PTS ≠ DTS，必须写 ctts 盒，否则播放顺序会乱
     *   4. 整场可能 4GB+ → 偏移量必须用 64 位的 co64，mdat 也要 64 位长度
     *
     * 用法（边下边写的流式场景）：
     *   const r = new Remuxer();
     *   r.begin();                       // → 先写 ftyp + mdat 头
     *   for (每个分片) r.pushSegment(u8); // → 每次返回要追加写盘的字节
     *   const tail = r.finalize();       // → moov + 需要回填的 mdat 长度
     */

    // ─────────────── 位读取（含 HEVC 的防竞争字节剔除）───────────────
    class BitReader {
      constructor(bytes) {
        // 0x00 0x00 0x03 里的 0x03 是防竞争字节，解析语法前必须去掉
        const out = [];
        for (let i = 0; i < bytes.length; i++) {
          if (i >= 2 && bytes[i] === 3 && bytes[i - 1] === 0 && bytes[i - 2] === 0) continue;
          out.push(bytes[i]);
        }
        this.b = out;
        this.pos = 0;
      }
      bit() {
        const byte = this.b[this.pos >> 3];
        if (byte === undefined) return 0;
        const v = (byte >> (7 - (this.pos & 7))) & 1;
        this.pos++;
        return v;
      }
      bits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.bit(); return v >>> 0; }
      ue() { let z = 0; while (this.bit() === 0 && z < 32) z++; return z ? ((1 << z) - 1) + this.bits(z) : 0; }
      se() { const k = this.ue(); return k & 1 ? (k + 1) >> 1 : -(k >> 1); }
      skip(n) { this.pos += n; }
    }

    // ─────────────── HEVC SPS 解析（只取构造 hvcC 必需的字段）───────────────
    function parseHevcSps(nal) {
      const r = new BitReader(nal);
      r.skip(16); // NAL 头 2 字节
      r.bits(4);  // sps_video_parameter_set_id
      const maxSubLayersMinus1 = r.bits(3);
      const temporalIdNesting = r.bit();

      // profile_tier_level
      const generalProfileSpace = r.bits(2);
      const generalTierFlag = r.bit();
      const generalProfileIdc = r.bits(5);
      const compatFlags = r.bits(32);
      // 48 位约束标志，原样留着塞进 hvcC
      const constraintHi = r.bits(24), constraintLo = r.bits(24);
      const generalLevelIdc = r.bits(8);

      const subProfile = [], subLevel = [];
      for (let i = 0; i < maxSubLayersMinus1; i++) { subProfile.push(r.bit()); subLevel.push(r.bit()); }
      if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.bits(2);
      for (let i = 0; i < maxSubLayersMinus1; i++) {
        if (subProfile[i]) { r.bits(32); r.bits(32); r.bits(24); }
        if (subLevel[i]) r.bits(8);
      }

      r.ue(); // sps_seq_parameter_set_id
      const chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) r.bit(); // separate_colour_plane_flag
      let width = r.ue();
      let height = r.ue();
      // HEVC 按 CTU 对齐编码（这个流实际编码成 1088 宽），真实显示尺寸要减掉裁剪窗口才是 1080。
      // 不减的话 MP4 头里写的尺寸和实际画面对不上，部分播放器会按 1088 拉伸变形。
      if (r.bit()) {
        const l = r.ue(), rr = r.ue(), t = r.ue(), b = r.ue();
        const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
        const subH = chromaFormatIdc === 1 ? 2 : 1;
        width -= subW * (l + rr);
        height -= subH * (t + b);
      }
      const bitDepthLumaMinus8 = r.ue();
      const bitDepthChromaMinus8 = r.ue();

      return {
        generalProfileSpace, generalTierFlag, generalProfileIdc, compatFlags,
        constraintHi, constraintLo, generalLevelIdc,
        chromaFormatIdc, bitDepthLumaMinus8, bitDepthChromaMinus8,
        temporalIdNesting, numTemporalLayers: maxSubLayersMinus1 + 1,
        width, height,
      };
    }

    // ─────────────── 字节工具 ───────────────
    const u8 = (...a) => new Uint8Array(a);
    function u16(v) { return u8((v >> 8) & 255, v & 255); }
    function u32(v) { return u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
    function u64(v) {
      const hi = Math.floor(v / 4294967296), lo = v >>> 0;
      return concat(u32(hi), u32(lo));
    }
    function concat(...parts) {
      let n = 0;
      for (const p of parts) n += p.length;
      const out = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    }
    function box(type, ...payload) {
      const body = concat(...payload);
      const t = new Uint8Array(4);
      for (let i = 0; i < 4; i++) t[i] = type.charCodeAt(i);
      return concat(u32(body.length + 8), t, body);
    }
    const fullBox = (type, ver, flags, ...p) => box(type, u8(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...p);

    // ─────────────── TS 解复用 ───────────────
    const PKT = 188;

    class TsDemuxer {
      constructor() {
        this.pmtPid = -1;
        this.videoPid = -1;
        this.audioPid = -1;
        this.buf = { }; // pid → {chunks, len}
      }

      // 33 位时间戳，5 字节里按 MPEG 规矩东一块西一块地摆
      static readTs(b, o) {
        const v = ((b[o] & 0x0e) * 536870912) + ((b[o + 1] & 0xff) << 22) + ((b[o + 2] & 0xfe) << 14) +
                  ((b[o + 3] & 0xff) << 7) + ((b[o + 4] & 0xfe) >> 1);
        return v;
      }

      parse(data, onPes) {
        // 先对齐到第一个同步字节（分片理论上都是对齐的，但别赌）
        let base = 0;
        while (base < data.length && data[base] !== 0x47) base++;
        for (let i = base; i + PKT <= data.length; i += PKT) {
          if (data[i] !== 0x47) { // 中途丢同步：往后找回同步字节再继续
            let j = i + 1;
            while (j + PKT <= data.length && data[j] !== 0x47) j++;
            if (j + PKT > data.length) break;
            i = j;
          }
          const p = data.subarray(i, i + PKT);
          const pusi = (p[1] & 0x40) !== 0;
          const pid = ((p[1] & 0x1f) << 8) | p[2];
          const afc = (p[3] >> 4) & 3;
          let off = 4;
          if (afc & 2) off += 1 + p[4];
          if (!(afc & 1) || off >= PKT) continue;
          const payload = p.subarray(off);

          if (pid === 0) { // PAT
            const ptr = payload[0];
            const s = payload.subarray(1 + ptr);
            if (s.length >= 13) this.pmtPid = ((s[10] & 0x1f) << 8) | s[11];
          } else if (pid === this.pmtPid) { // PMT：找出视频/音频 PID
            const ptr = payload[0];
            const s = payload.subarray(1 + ptr);
            const secLen = ((s[1] & 0x0f) << 8) | s[2];
            const piLen = ((s[10] & 0x0f) << 8) | s[11];
            let q = 12 + piLen;
            const end = 3 + secLen - 4;
            while (q + 5 <= end && q + 5 <= s.length) {
              const type = s[q];
              const epid = ((s[q + 1] & 0x1f) << 8) | s[q + 2];
              const esLen = ((s[q + 3] & 0x0f) << 8) | s[q + 4];
              if (type === 0x24 || type === 0x27) this.videoPid = epid;          // HEVC
              else if (type === 0x1b) this.videoPid = epid;                       // H.264（兜底）
              else if (type === 0x0f || type === 0x11) this.audioPid = epid;      // AAC ADTS / LATM
              q += 5 + esLen;
            }
          } else if (pid === this.videoPid || pid === this.audioPid) {
            if (pusi) {
              this.flush(pid, onPes);
              this.buf[pid] = { chunks: [payload], len: payload.length };
            } else if (this.buf[pid]) {
              this.buf[pid].chunks.push(payload);
              this.buf[pid].len += payload.length;
            }
          }
        }
      }

      flush(pid, onPes) {
        const b = this.buf[pid];
        if (!b) return;
        this.buf[pid] = null;
        const data = concat(...b.chunks);
        if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return;
        const flags = data[7];
        const hLen = data[8];
        let pts = null, dts = null;
        if ((flags & 0xc0) === 0xc0) { pts = TsDemuxer.readTs(data, 9); dts = TsDemuxer.readTs(data, 14); }
        else if ((flags & 0x80) === 0x80) { pts = TsDemuxer.readTs(data, 9); dts = pts; }
        onPes(pid, data.subarray(9 + hLen), pts, dts);
      }

      flushAll(onPes) {
        for (const pid of Object.keys(this.buf)) this.flush(+pid, onPes);
      }
    }

    // Annex B 按起始码切成一个个 NAL
    function splitNals(data) {
      const out = [];
      let i = 0, start = -1;
      while (i < data.length - 3) {
        if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
          const scLen = data[i + 2] === 1 ? 3 : 4;
          if (start >= 0) out.push(data.subarray(start, i));
          start = i + scLen;
          i += scLen;
        } else i++;
      }
      if (start >= 0 && start < data.length) out.push(data.subarray(start, data.length));
      return out;
    }

    // ADTS 头里读出 AAC 的采样率/声道，用来生成 AudioSpecificConfig
    const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

    // ─────────────── 主体：重封装器 ───────────────
    class Remuxer {
      constructor() {
        this.dem = new TsDemuxer();
        this.vps = null; this.sps = null; this.pps = null; this.spsInfo = null;
        this.audioCfg = null;
        this.vSamples = []; // {size, dts, cts, key}
        this.aSamples = [];
        this.vChunks = []; this.aChunks = [];
        this.offset = 0;         // 当前写到文件的哪个位置
        this.mdatStart = 0;
        this.lastVDts = null; this.lastADts = null;
        this.vRoll = 0; this.aRoll = 0;
        this.aBaseTs = null; this.aFrameIdx = 0;
      }

      // 33 位时间戳会绕回（约 26.5 小时一圈），倒退一大截就是绕回了
      unroll(v, last, which) {
        const R = 8589934592; // 2^33
        let roll = which === "v" ? this.vRoll : this.aRoll;
        if (last !== null && v + roll < last - R / 2) { roll += R; if (which === "v") this.vRoll = roll; else this.aRoll = roll; }
        return v + roll;
      }

      begin() {
        const ftyp = box("ftyp", u8(0x69,0x73,0x6f,0x6d), u32(0x200),
          u8(0x69,0x73,0x6f,0x6d), u8(0x69,0x73,0x6f,0x32), u8(0x6d,0x70,0x34,0x31), u8(0x68,0x76,0x63,0x31));
        // mdat 用 64 位长度：整场可能超 4GB。size=1 表示真实长度在后面 8 字节
        const mdatHdr = concat(u32(1), u8(0x6d,0x64,0x61,0x74), u64(0));
        this.mdatStart = ftyp.length;
        this.offset = ftyp.length + mdatHdr.length;
        this.mdatPayloadStart = this.offset;
        return concat(ftyp, mdatHdr);
      }

      /** 喂一个 .ts 分片，返回本片要追加写盘的字节 */
      pushSegment(bytes) {
        const vParts = [], aParts = [];
        let vCount = 0, aCount = 0;
        const vChunkOff = this.offset;

        const onPes = (pid, payload, pts, dts) => {
          if (pid === this.dem.videoPid) {
            if (pts === null) return;
            dts = this.unroll(dts === null ? pts : dts, this.lastVDts, "v");
            const p = this.unroll(pts, this.lastVDts, "v");
            this.lastVDts = dts;
            const nals = splitNals(payload);
            const keep = [];
            let key = false;
            for (const n of nals) {
              if (!n.length) continue;
              const t = (n[0] >> 1) & 0x3f;
              if (t === 32) { this.vps = n; continue; }
              if (t === 33) { this.sps = n; if (!this.spsInfo) { try { this.spsInfo = parseHevcSps(n); } catch (e) {} } continue; }
              if (t === 34) { this.pps = n; continue; }
              if (t === 35) continue;              // AUD，MP4 里不需要
              if (t >= 16 && t <= 21) key = true;  // IRAP = 关键帧
              keep.push(concat(u32(n.length), n)); // Annex B 起始码 → 4 字节长度前缀
            }
            if (!keep.length) return;
            const data = concat(...keep);
            vParts.push(data);
            this.vSamples.push({ size: data.length, dts, cts: p - dts, key });
            vCount++;
          } else if (pid === this.dem.audioPid) {
            if (pts === null) return;
            const pesTs = this.unroll(pts, this.lastADts, "a");
            // 一个 PES 里可能有多个 ADTS 帧，逐帧拆
            let i = 0;
            while (i + 7 <= payload.length) {
              if (payload[i] !== 0xff || (payload[i + 1] & 0xf0) !== 0xf0) { i++; continue; }
              const protAbsent = payload[i + 1] & 1;
              const len = ((payload[i + 3] & 3) << 11) | (payload[i + 4] << 3) | (payload[i + 5] >> 5);
              if (len < 7 || i + len > payload.length) break;
              if (!this.audioCfg) {
                const objType = ((payload[i + 2] >> 6) & 3) + 1;
                const freqIdx = (payload[i + 2] >> 2) & 0xf;
                const chCfg = ((payload[i + 2] & 1) << 2) | (payload[i + 3] >> 6);
                this.audioCfg = { objType, freqIdx, chCfg, rate: ADTS_RATES[freqIdx] || 48000 };
              }
              const hdr = protAbsent ? 7 : 9;
              const raw = payload.subarray(i + hdr, i + len);
              // 时间戳从「基准点 + 第几帧」直接算，不是每帧累加取整。
              // 累加的话，采样率不能整除 90000 时（如 44.1kHz 每帧差 0.2 tick），
              // 四五个小时下来会累积成肉眼可见的音画不同步。
              const rate = this.audioCfg.rate || 48000;
              const step = 1024 * 90000 / rate; // 每帧 1024 个采样对应的 90kHz ticks
              if (this.aBaseTs === null) { this.aBaseTs = pesTs; this.aFrameIdx = 0; }
              let dtsA = this.aBaseTs + Math.round(this.aFrameIdx * step);
              // 流中断/跳变时（预测值和实际 PES 时间戳差超过半秒）重新对基准，防止跑飞
              if (Math.abs(pesTs - dtsA) > 45000 && i === 0) {
                this.aBaseTs = pesTs; this.aFrameIdx = 0; dtsA = pesTs;
              }
              aParts.push(raw);
              this.aSamples.push({ size: raw.length, dts: dtsA });
              aCount++;
              this.aFrameIdx++;
              this.lastADts = dtsA;
              i += len;
            }
          }
        };

        this.dem.parse(bytes, onPes);
        this.dem.flushAll(onPes);

        const vData = concat(...vParts);
        const aChunkOff = vChunkOff + vData.length;
        const aData = concat(...aParts);
        if (vCount) this.vChunks.push({ offset: vChunkOff, count: vCount });
        if (aCount) this.aChunks.push({ offset: aChunkOff, count: aCount });
        this.offset += vData.length + aData.length;
        return concat(vData, aData);
      }

      /** 收尾：返回要追加的 moov，以及需要回填到 mdat 头里的长度 */
      finalize() {
        if (!this.vSamples.length) throw new Error("没解出任何视频帧，无法生成 MP4");
        const TS = 90000;
        const mdatSize = this.offset - this.mdatStart;

        // 每帧时长由 DTS 差值算，最后一帧沿用前一帧
        const durs = (arr) => arr.map((s, i) => (i + 1 < arr.length ? Math.max(1, arr[i + 1].dts - s.dts) : null))
          .map((d, i, a) => (d === null ? (a[i - 1] || 3000) : d));
        
        const vDur = durs(this.vSamples), aDur = durs(this.aSamples);
        const vTotal = vDur.reduce((a, b) => a + b, 0);
        const aTotal = aDur.reduce((a, b) => a + b, 0);
        const duration = Math.max(vTotal, aTotal);

        // 索引表一律「先按总长开缓冲区，再按偏移逐条写」。
        // 不能写成 concat(...arr.map(...))：5 小时的直播有 50 万+ 帧，
        // 展开的实参个数超过引擎上限，会报 Maximum call stack size exceeded，整个 MP4 报废。
        const stts = (ds) => {
          const e = [];
          for (const d of ds) { const l = e[e.length - 1]; if (l && l[1] === d) l[0]++; else e.push([1, d]); }
          const b = new Uint8Array(e.length * 8), dv = new DataView(b.buffer);
          for (let i = 0; i < e.length; i++) { dv.setUint32(i * 8, e[i][0]); dv.setUint32(i * 8 + 4, e[i][1]); }
          return fullBox("stts", 0, 0, u32(e.length), b);
        };
        const stsz = (arr) => {
          const b = new Uint8Array(arr.length * 4), dv = new DataView(b.buffer);
          for (let i = 0; i < arr.length; i++) dv.setUint32(i * 4, arr[i].size);
          return fullBox("stsz", 0, 0, u32(0), u32(arr.length), b);
        };
        const stsc = (chunks) => {
          const e = [];
          chunks.forEach((c, i) => { const l = e[e.length - 1]; if (!l || l[1] !== c.count) e.push([i + 1, c.count, 1]); });
          const b = new Uint8Array(e.length * 12), dv = new DataView(b.buffer);
          for (let i = 0; i < e.length; i++) {
            dv.setUint32(i * 12, e[i][0]); dv.setUint32(i * 12 + 4, e[i][1]); dv.setUint32(i * 12 + 8, e[i][2]);
          }
          return fullBox("stsc", 0, 0, u32(e.length), b);
        };
        // 4GB+ 的文件必须用 64 位偏移
        const co64 = (chunks) => {
          const b = new Uint8Array(chunks.length * 8), dv = new DataView(b.buffer);
          for (let i = 0; i < chunks.length; i++) {
            dv.setUint32(i * 8, Math.floor(chunks[i].offset / 4294967296));
            dv.setUint32(i * 8 + 4, chunks[i].offset >>> 0);
          }
          return fullBox("co64", 0, 0, u32(chunks.length), b);
        };
        const stss = (arr) => {
          const idx = [];
          for (let i = 0; i < arr.length; i++) if (arr[i].key) idx.push(i + 1);
          const b = new Uint8Array(idx.length * 4), dv = new DataView(b.buffer);
          for (let i = 0; i < idx.length; i++) dv.setUint32(i * 4, idx[i]);
          return fullBox("stss", 0, 0, u32(idx.length), b);
        };
        // B 帧导致 PTS≠DTS，用 version 1（有符号偏移）。
        // 必须把「最早呈现时刻」归零：B 帧重排会让整条视频轨的呈现时间抬高一个基线，
        // 不归零视频就比音频晚出画。最早的未必是第一帧，PTS = DTS + CTS，要在所有帧里取最小值。
        const vd0 = this.vSamples.length ? this.vSamples[0].dts : 0;
        const minCts = this.vSamples.reduce((m, s) => Math.min(m, s.dts - vd0 + s.cts), Infinity);
        const ctts = (arr) => {
          const e = [];
          for (const s of arr) {
            const v = s.cts - minCts;
            const l = e[e.length - 1];
            if (l && l[1] === v) l[0]++; else e.push([1, v]);
          }
          const b = new Uint8Array(e.length * 8), dv = new DataView(b.buffer);
          for (let i = 0; i < e.length; i++) { dv.setUint32(i * 8, e[i][0]); dv.setInt32(i * 8 + 4, e[i][1] | 0); }
          return fullBox("ctts", 1, 0, u32(e.length), b);
        };

        const si = this.spsInfo || {};
        const hvcC = box("hvcC", concat(
          u8(1, ((si.generalProfileSpace || 0) << 6) | ((si.generalTierFlag || 0) << 5) | (si.generalProfileIdc || 1)),
          u32(si.compatFlags || 0),
          u8((si.constraintHi >>> 16) & 255, (si.constraintHi >>> 8) & 255, si.constraintHi & 255,
             (si.constraintLo >>> 16) & 255, (si.constraintLo >>> 8) & 255, si.constraintLo & 255),
          u8(si.generalLevelIdc || 0),
          u16(0xf000), u8(0xfc), u8(0xfc | (si.chromaFormatIdc & 3)),
          u8(0xf8 | (si.bitDepthLumaMinus8 & 7)), u8(0xf8 | (si.bitDepthChromaMinus8 & 7)),
          u16(0), u8((0 << 6) | (((si.numTemporalLayers || 1) & 7) << 3) | ((si.temporalIdNesting || 0) << 2) | 3),
          u8(3), // VPS/SPS/PPS 三组
          ...[[32, this.vps], [33, this.sps], [34, this.pps]].map(([t, n]) =>
            concat(u8(0x80 | t), u16(1), u16(n.length), n))
        ));

        const w = si.width || 1080, h = si.height || 1920;
        const hvc1 = box("hvc1",
          u8(0,0,0,0,0,0), u16(1), u16(0), u16(0), u32(0), u32(0), u32(0),
          u16(w), u16(h), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
          concat(u8(0), new Uint8Array(31)), u16(0x18), u16(0xffff), hvcC);

        const cfg = this.audioCfg || { objType: 2, freqIdx: 3, chCfg: 2, rate: 48000 };
        const asc = u8((cfg.objType << 3) | (cfg.freqIdx >> 1), ((cfg.freqIdx & 1) << 7) | (cfg.chCfg << 3));
        const esds = fullBox("esds", 0, 0, concat(
          u8(3, 25, 0, 1, 0),
          u8(4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
          u8(5, 2), asc, u8(6, 1, 2)));
        const mp4a = box("mp4a", u8(0,0,0,0,0,0), u16(1), u32(0), u32(0),
          u16(cfg.chCfg || 2), u16(16), u16(0), u16(0), u32((cfg.rate || 48000) << 16), esds);

        const trak = (id, handler, sampleEntry, samples, chunks, dur, extra, tkhdExtra) => box("trak",
          fullBox("tkhd", 0, 3, u32(0), u32(0), u32(id), u32(0), u32(dur), u32(0), u32(0),
            u16(0), u16(0), u16(id === 1 ? 0 : 0x0100), u16(0),
            concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)),
            tkhdExtra),
          box("mdia",
            fullBox("mdhd", 0, 0, u32(0), u32(0), u32(TS), u32(dur), u16(0x55c4), u16(0)),
            fullBox("hdlr", 0, 0, u32(0), u8(...handler.split("").map((c) => c.charCodeAt(0))), u32(0), u32(0), u32(0), u8(0)),
            box("minf", extra,
              box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))),
              box("stbl", box("stsd", u8(0,0,0,0), u32(1), sampleEntry),
                stts(samples === this.vSamples ? vDur : aDur),
                ...(samples === this.vSamples ? [ctts(samples), stss(samples)] : []),
                stsc(chunks), stsz(samples), co64(chunks)))));

        const moov = box("moov",
          fullBox("mvhd", 0, 0, u32(0), u32(0), u32(TS), u32(duration),
            u32(0x10000), u16(0x100), u16(0), u32(0), u32(0),
            concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)),
            new Uint8Array(24), u32(3)),
          trak(1, "vide", hvc1, this.vSamples, this.vChunks, vTotal,
            box("vmhd", u8(0,0,0,1), u16(0), u16(0), u16(0), u16(0)),
            concat(u32(w << 16), u32(h << 16))),
          ...(this.aSamples.length
            ? [trak(2, "soun", mp4a, this.aSamples, this.aChunks, aTotal,
                box("smhd", u8(0,0,0,0), u16(0), u16(0)), concat(u32(0), u32(0)))]
            : []));

        return { moov, mdatSize, mdatSizeOffset: this.mdatStart + 8 };
      }
    }

      globalThis.__TSRemuxer = Remuxer;
      })();
      cached = globalThis.__TSRemuxer;
      return cached;
    };
  }
  const getRemuxer = TSRemuxerFactory();

  async function selfRemux(handle, segs, dur, pk, item) {
    const Remuxer = getRemuxer();
    const writable = await handle.createWritable();
    const mux = new Remuxer();
    let wrote = 0;
    let closed = false;
    const t0 = Date.now();
    // 拉分片用滑动窗口：始终保持 CONC 路在飞，写完一片立刻补一片，
    // 不用等整批到齐，慢片不会把其他路堵住。
    const CONC = 6;
    let bad = 0;

    // 收尾：补 moov（每帧位置/时长/关键帧），再把 mdat 的真实长度回填到文件头。
    // 中途停也算数，已经写进去的帧能正常播到断点。
    const finish = async () => {
      if (closed) return false;
      closed = true;
      if (!mux.vSamples.length) { try { await writable.abort(); } catch (_) {} return false; }
      const { moov, mdatSize, mdatSizeOffset } = mux.finalize();
      await writable.write(moov);
      wrote += moov.byteLength;
      const sz = new Uint8Array(8);
      new DataView(sz.buffer).setUint32(0, Math.floor(mdatSize / 4294967296));
      new DataView(sz.buffer).setUint32(4, mdatSize >>> 0);
      await writable.write({ type: 'write', position: mdatSizeOffset, data: sz });
      await writable.close();
      return true;
    };

    // 实时速度：留最近 4 秒的采样，算平均而不是这一片的大小，数字不会一跳一跳
    const samples = [{ t: t0, b: 0 }];
    let lastTick = 0;
    const report = (done, total, force) => {
      const now = Date.now();
      if (!force && now - lastTick < 300) return;
      lastTick = now;
      samples.push({ t: now, b: wrote });
      while (samples.length > 2 && now - samples[0].t > 4000) samples.shift();
      const dt = (now - samples[0].t) / 1000;
      const bps = dt > 0.5 ? (wrote - samples[0].b) / dt : 0;

      const pct = (done / total) * 100;
      const speed = bps > 0 ? '  ·  ' + (bps / 1048576).toFixed(1) + ' MB/s' : '';
      let eta = '';
      if (bps > 0 && done > 0 && done < total) {
        const left = ((total - done) * (wrote / done)) / bps;
        if (isFinite(left) && left > 0 && left < 86400) eta = '  ·  剩 ' + clock(left);
      }
      // 文案顺序：下到哪 → 多大了 → 多快 → 还要多久
      // 总大小按已下片段的平均值推算，首片通常偏大，过了 3% 才显示
      const est = done > 0 ? (wrote / done) * total : 0;
      const size = fmt(wrote) + (pct > 3 && est > wrote * 1.005 ? ' / 约' + fmt(est) : '');
      setProg(pk, pct.toFixed(1) + '%  ·  ' + size + speed + eta + (bad ? `  ·  ${bad} 片失败` : ''), pct);
    };

    try {
      const head = mux.begin();
      await writable.write(head);
      wrote += head.byteLength;

      const total = segs.length;
      const inflight = new Map();
      let started = 0;
      const pull = (i) => {
        if (i >= total) return;
        inflight.set(
          i,
          (async () => {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                return await getSegBytes(segs[i]);
              } catch (e) {
                if (attempt === 1) {
                  bad++;
                  log('分片失败', segs[i].slice(-32), String((e && e.message) || e));
                  return null;
                }
              }
            }
            return null;
          })()
        );
      };
      for (; started < Math.min(CONC, total); started++) pull(started);

      let done = 0;
      while (done < total) {
        if (item._stop) break;
        // 必须按顺序取：分片里的 PTS 是递增的，乱序写会把索引写歪
        const b = await inflight.get(done);
        inflight.delete(done);
        pull(started++);
        if (b && b.length) {
          const out = mux.pushSegment(b);
          if (out.length) {
            await writable.write(out);
            wrote += out.length;
          }
        }
        done++;
        report(done, total);
        if (done === 1 && !mux.vSamples.length) {
          throw new Error('第一段没解析出视频帧。这条可能不是 TS 分片（fMP4/加密流解不了）');
        }
      }

      const ok = await finish();
      if (item._stop) {
        setProg(pk, `已停止 · 保住 ${fmt(wrote)}`, 100);
        toast(ok ? `已停止，保住 ${fmt(wrote)}，能播到断点` : '已停止，还没写下画面');
        return;
      }
      if (!ok) throw new Error('一个视频帧都没写进去');
      const secs = dur ? Math.round(dur) : Math.round(mux.vSamples.length / 25);
      setProg(pk, `完成 ✓ ${mux.vSamples.length} 帧 · ${clock(secs)} · ${fmt(wrote)}`, 100);
      toast(`已保存 ${clock(secs)}，${fmt(wrote)}` + (bad ? `，${bad} 片没取到` : ''));
    } catch (e) {
      let kept = false;
      try { kept = await finish(); } catch (_) {}
      const why = String((e && e.message) || e);
      // 已经写进盘的部分要如实说，别一律报「没写进任何内容」
      const tail = kept ? `，已保住 ${fmt(wrote)}（可播到断点）` : wrote > 0 ? `，已写 ${fmt(wrote)}` : '，没写进任何内容';
      throw new Error(why + tail);
    }
  }

  // 一条路：读列表 → 弹保存框 → 边下边封。不经过任何第三方库。
  async function remuxDirect(item, fileName, pk) {
    const pick = picker();
    if (!pick) throw new Error('浏览器不支持直接写盘，请用 Chrome 或 Edge');
    // 保存框必须在点击的同一个手势里弹出，中间别插网络请求
    const handle = await pick({
      suggestedName: fileName,
      types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
    });

    setProg(pk, '读列表…', 0);
    let txt;
    try {
      txt = await getText(item.url, 20000);
    } catch (e) {
      const s = String((e && e.message) || e);
      if (/HTTP (403|404)/.test(s)) {
        throw new Error('地址取不到（' + s + '），这条回放可能已被回收，或者抓到的是过期地址，刷新页面重新抓一次');
      }
      throw e;
    }
    if (!txt.startsWith('#EXTM3U')) throw new Error('返回的不是 m3u8');
    const pd = dateFromPdt(txt);
    if (pd) item._sd = pd;
    if (/#EXT-X-STREAM-INF/i.test(txt)) throw new Error('抓到的是多清晰度的主列表，里面没有分片，在页面上重新播一下再抓');
    if (/#EXT-X-KEY/i.test(txt)) throw new Error('列表带加密标记，没法直接封');

    const clean = cleanPlaylist(txt, item.url);
    if (!clean.count) throw new Error('列表里没有分片');
    const segs = clean.text.split(/\r?\n/).filter((l) => l && l[0] !== '#');
    if (!segs.length) throw new Error('列表里没有分片');
    log('列表', segs.length, '段', Math.round(clean.dur) + 's');
    setProg(pk, `抓到 ${segs.length} 段`, 0);
    await selfRemux(handle, segs, clean.dur, pk, item);
  }

  // ---------- 入口 ----------
  async function startDownload(item, segMode) {
    if (item._busy) return;
    item._busy = true;
    item._stop = false;
    scheduleRender();

    const pk = item.key || normKey(item.url);

    const isHls = item.type === 'HLS' || /\.m3u8/i.test(item.url);

    // 文件名要带总时长，列表还在探就等一小会儿。上限 0.9 秒，别把点击手势等没了，
    // 浏览器一旦认为没有用户手势，就不给弹保存框
    if (isHls && !item._dur && item._probeP) {
      await Promise.race([item._probeP, new Promise((r) => setTimeout(r, 900))]);
    }

    // 浏览器里直接封 mp4：HEVC 原样搬进容器，不转码，也不需要任何后台进程
    if (isHls && remuxReady() && !segMode) {
      try {
        await remuxDirect(item, replayName(item, '.mp4'), pk);
        item._busy = false;
        scheduleRender();
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          setProg(pk, '已取消', 0);
          item._busy = false;
          scheduleRender();
          return;
        }
        // 失败就停，错误留在面板上，可以再点一次重试
        const m = String((e && e.message) || e);
        const keptPct = (progress.get(pk) || {}).pct || 0;
        log('直封失败', e);
        setProg(pk, '直封失败：' + m, keptPct);
        toast('直封失败：' + m);
        item._busy = false;
        scheduleRender();
        return;
      }
    }
    // 扩展名要在弹保存框之前定下来，所以先探一下编码
    let fmt = { ext: '.mp4', container: 'unknown', vcodec: 'unknown' };
    if (isHls) {
      setProg(pk, '识别格式…', 0);
      try {
        // 先把列表读一遍再弹保存框，读不到就在面板上报错，别让人白等一个框
        fmt = await detectFormat(item, true);
      } catch (e) {
        const m = String((e && e.message) || e);
        setProg(pk, m, 0);
        toast(m);
        item._busy = false;
        scheduleRender();
        return;
      }
    }
    // detectFormat 刚刚读过列表，这里能拿到最准的场次时刻和总时长
    const fileName = replayName(item, fmt.ext);

    try {
      // 保存框紧跟点击弹，中间别插网络请求，否则浏览器认为没有用户手势
      let sink;
      try {
        sink = await Sink.create(fileName);
      } catch (e) {
        if (e && e.name === 'AbortError') {
          setProg(pk, '已取消', 0);
          return;
        }
        throw e;
      }

      setProg(pk, '连接中…', 0);
      speedState.delete(pk);

      if (isHls) {
        const r = await downloadHls(item.url, fileName, item, sink);
        const miss = r.total - r.completed;
        if (miss > 0) {
          const why = r.abortReason || (r.stopped ? '手动停止' : '部分失败');
          setProg(pk, `部分完成 ${fmt(r.bytes)}，缺 ${miss} 段（${why}）`, (r.completed / r.total) * 100);
          toast(`存了 ${fmt(r.bytes)}，缺 ${miss} 段：${why}`);
        } else if (!r.endlist) {
          setProg(pk, `完成 ✓ ${fmt(r.bytes)}（仅 ${Math.round(r.dur || 0)} 秒，列表未结束）`, 100);
          toast(`只下了 ${Math.round(r.dur || 0)} 秒。这条是切片窗口，不是整场回放`);
        } else {
          setProg(pk, `完成 ✓ ${fmt(r.bytes)}`, 100);
          if (fmt.ext === '.ts') {
            toast(`完成 ${fmt(r.bytes)}。这是 HEVC 流，存成 .ts 了，用 PotPlayer/VLC 打开；要 mp4 就跑 ffmpeg -i xxx.ts -c copy out.mp4`);
          } else {
            toast(`完成，共 ${fmt(r.bytes)}`);
          }
        }
        return;
      }

      if (sink.handle) {
        const p = await parallelDownload(item.url, fileName, item, sink);
        if (p.done < p.total) {
          setProg(pk, `部分完成 ${fmt(p.bytes)}`, (p.done / p.total) * 100);
          toast(`存了 ${fmt(p.bytes)}，没下完`);
        } else {
          setProg(pk, `完成 ✓ ${fmt(p.bytes)}`, 100);
          toast(`完成，共 ${fmt(p.bytes)}`);
        }
        return;
      }
      // 没有文件系统权限就退回单连接
      await downloadViaGM(item.url, fileName, item);
      setProg(pk, '完成 ✓', 100);
      toast('已保存');
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.error('[回放] 失败', e);
      if (e && e.name === 'AbortError') setProg(pk, '已取消', 0);
      else if (/不支持分段|没给文件大小/.test(msg)) {
        // 分块失败就老老实实单连接
        try {
          setProg(pk, '改单连接下载…', 0);
          await downloadViaGM(item.url, fileName, item);
          setProg(pk, '完成 ✓', 100);
          toast('已保存');
          return;
        } catch (e2) {
          setProg(pk, '失败：' + String((e2 && e2.message) || e2), 0);
        }
      } else {
        setProg(pk, '失败：' + msg, 0);
        toast('失败：' + msg);
      }
    } finally {
      item._busy = false;
      scheduleRender();
    }
  }

  // ---------- 面板 ----------
  function buildPanel() {
    if (panelReady || !document.body) return;
    panelReady = true;

    const wrap = document.createElement('div');
    wrap.id = '__dl_panel';
    wrap.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:20px', 'width:430px', 'max-height:470px',
      'background:rgba(20,20,22,.97)', 'color:#eaeaea', 'border:1px solid #3a3a3f',
      'border-radius:10px', 'z-index:2147483646', 'display:flex', 'flex-direction:column',
      'font:12px/1.5 -apple-system,"Microsoft YaHei",Consolas,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.5)', 'overflow:hidden',
    ].join(';');

    wrap.innerHTML = `
      <div id="__dl_head" style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:#26262a;cursor:move;user-select:none;">
        <span style="font-weight:600;font-size:13px;">回放下载</span>
        <span id="__dl_count" style="color:#7ee787;font-size:11px;">等待播放</span>
        <span style="flex:1"></span>
        <button id="__dl_toggle" style="background:none;border:none;color:#aaa;cursor:pointer;font-size:15px;padding:0 4px;">–</button>
      </div>
      <div id="__dl_body" style="padding:8px 10px 10px;overflow:auto;">
        <div id="__dl_list"></div>
      </div>
    `;
    document.body.appendChild(wrap);

    let collapsed = false;
    wrap.querySelector('#__dl_toggle').onclick = () => {
      collapsed = !collapsed;
      wrap.querySelector('#__dl_body').style.display = collapsed ? 'none' : 'block';
      wrap.querySelector('#__dl_toggle').textContent = collapsed ? '+' : '–';
    };

    const head = wrap.querySelector('#__dl_head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX, y: e.clientY, r: wrap.getBoundingClientRect() };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      wrap.style.left = drag.r.left + (e.clientX - drag.x) + 'px';
      wrap.style.top = drag.r.top + (e.clientY - drag.y) + 'px';
      wrap.style.right = 'auto';
      wrap.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => (drag = null));

    render();
  }

  function mkBtn(label, bg, fn, big) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      `background:${bg};color:#fff;border:none;border-radius:5px;cursor:pointer;` +
      `padding:${big ? '6px 12px' : '3px 8px'};font-size:${big ? '12px' : '11px'};margin-right:5px;`;
    b.onclick = fn;
    return b;
  }

  // 列表重建合并成一次，250ms 内多次新增只画一遍
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 250);
  }

  function render() {
    const list = document.getElementById('__dl_list');
    const cnt = document.getElementById('__dl_count');
    if (!list) return;

    const items = [...store.values()].sort((a, b) => b.ts - a.ts).slice(0, 8);
    cnt.textContent = store.size ? `已抓 ${store.size} 个` : '等待播放';
    list.innerHTML = '';

    items.forEach((it) => {
      const row = document.createElement('div');
      row.dataset.row = '1';
      row.style.cssText = 'border:1px solid #333;border-radius:6px;padding:8px;margin-bottom:8px;background:#1b1b1f;';

      const title = document.createElement('div');
      title.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:5px;';
      const tag = document.createElement('span');
      tag.textContent = it.type;
      tag.style.cssText =
        'background:' + (it.type === 'HLS' ? '#2d5c3a' : '#2d4a6b') + ';padding:1px 6px;border-radius:3px;font-size:10px;';
      const frm = document.createElement('span');
      frm.textContent = (it.from || '') + (it.ts ? ' ' + clockHM(it.ts) : '');
      frm.style.cssText = 'color:#8b949e;font-size:10px;';
      // 场次时刻：确定后显示出来，点下载前能核对
      const dtag = document.createElement('span');
      const dknown = it._sd || dateFromUrl(it.url);
      const stamp = it._start || stampFromUrl(it.url);
      if (stamp) {
        // 直接把最终文件名摆出来，点下载前能核对开播时刻和时长
        dtag.textContent = replayName(it, '.mp4');
        dtag.style.cssText = 'color:#58a6ff;font-size:10px;';
      } else if (dknown) {
        dtag.textContent = '场次 ' + dknown;
        dtag.style.cssText = 'color:#58a6ff;font-size:10px;';
      } else if (it._probeErr) {
        // 列表读不到就别一直挂着「识别中」，把原因摆出来
        dtag.textContent = '场次未知 · 列表读不到（' + String(it._probeErr).slice(0, 24) + '）';
        dtag.style.cssText = 'color:#f85149;font-size:10px;';
      } else {
        dtag.textContent = '场次识别中…';
        dtag.style.cssText = 'color:#6e7681;font-size:10px;';
      }
      title.append(tag, frm, dtag);
      if (it._probeErr && dknown) {
        const bad = document.createElement('span');
        bad.textContent = '· 地址取不到（' + String(it._probeErr).slice(0, 16) + '）';
        bad.style.cssText = 'color:#f85149;font-size:10px;';
        title.append(bad);
      }

      const urlLine = document.createElement('div');
      urlLine.textContent = it.url;
      urlLine.style.cssText = 'color:#6e7681;word-break:break-all;font-size:10px;max-height:26px;overflow:hidden;margin-bottom:6px;';

      const ops = document.createElement('div');
      ops.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;gap:4px;';
      // 只在下载中给「停止」，平时只有一个按钮
      ops.append(
        it._busy
          ? mkBtn('停止', '#8b5a00', () => {
              it._stop = true;
              toast('正在收尾保存…');
            })
          : mkBtn('一键下载', '#238636', () => startDownload(it), true)
      );

      const pw = document.createElement('div');
      pw.style.cssText = 'margin-top:7px;';
      const pt = document.createElement('div');
      pt.className = 'pg-text';
      const pv = progress.get(it.key);
      pt.textContent = pv ? pv.text : '';
      pt.style.cssText = 'color:#7ee787;font-size:10px;margin-bottom:3px;word-break:break-all;';
      const pb = document.createElement('div');
      pb.style.cssText = 'height:3px;background:#2a2a30;border-radius:2px;overflow:hidden;';
      const bar = document.createElement('div');
      bar.dataset.p = it.key;
      bar.style.cssText = `height:100%;width:${pv ? pv.pct || 0 : 0}%;background:#238636;transition:width .2s;`;
      pb.appendChild(bar);
      pw.append(pt, pb);

      if (pv) {
        pv._bar = bar;
        pv._txt = pt;
      }

      row.append(title, urlLine, ops, pw);

      if (it.variants && it.variants.length) {
        const vbox = document.createElement('div');
        vbox.style.cssText = 'margin-top:7px;border-top:1px dashed #333;padding-top:6px;';
        it.variants.forEach((v) => {
          const k = normKey(v.url);
          const line = document.createElement('div');
          line.style.cssText = 'display:flex;align-items:center;gap:6px;margin:3px 0;';
          const nm = document.createElement('span');
          nm.textContent = v.label;
          nm.style.cssText = 'color:#58a6ff;font-size:10px;min-width:110px;';
          const target = store.get(k) || { key: k, url: v.url, type: 'HLS' };
          line.append(nm, mkBtn('下这个', '#238636', () => startDownload(target)));
          vbox.appendChild(line);
        });
        row.appendChild(vbox);
      }

      list.appendChild(row);
    });
  }

  // 有任务在写盘时，关标签或刷新会丢掉浏览器还没提交的临时文件，
  // 2GB 白下。这里拦一下，让浏览器弹确认框。
  function anyBusy() {
    for (const v of store.values()) if (v._busy) return true;
    return false;
  }
  window.addEventListener('beforeunload', (e) => {
    if (!anyBusy()) return;
    e.preventDefault();
    e.returnValue = '正在下载并写出回放，离开会中断，已写入的部分会丢失。';
    return e.returnValue;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel);
  else buildPanel();
  setTimeout(buildPanel, 2500);

  log('面板已就绪（预取窗口 ' + HLS_WINDOW + ' 段 / 并发 ' + HLS_CONCURRENCY + '）');
})();
