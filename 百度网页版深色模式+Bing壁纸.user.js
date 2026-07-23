// ==UserScript==
// @name         百度网页版 Bing 每日壁纸 (Baidu Bing Wallpaper)
// @version      1.0.0
// @description  为百度网页版主页套用 Bing 官方每日壁纸（cover 裁剪填满、不拉伸、1920x1080），并在顶部加一层纯渐变遮罩让壁纸自然过渡；搜索结果页(/s)不注入。壁纸来源：Bing 每日图片 API (cn.bing.com/HPImageArchive.aspx)。
// @icon         https://www.baidu.com/favicon.ico
// @author       CH4RL35HUNT3R
// @match        *://www.baidu.com/*
// @match        *://baidu.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      cn.bing.com
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  /* 搜索结果页（/s）不注入 */
  if (location.pathname === '/s') return;

  const WPID = 'bd-bing-wp-css';
  const BGID = 'bd-bing-bg';
  const TOPID = 'bd-bing-top';
  const API = 'https://cn.bing.com/HPImageArchive.aspx?format=js&idx=';

  /* ===== 壁纸层 + 顶部纯渐变遮罩样式 ===== */
  var wpCss = [
    '#bd-bing-bg{',
      'position:fixed;left:0;top:0;width:100%;height:100%;',
      'z-index:-2;pointer-events:none;',
      'background-color:#fff;background-repeat:no-repeat;',
      'background-position:center center;background-size:cover;',
      'background-attachment:fixed;',
    '}',
    /* 让百度自身的容器透明，露出壁纸 */
    '#wrapper,#content,#container,#main,#page,.wrapper,#ftCon,.foot,',
    '#s_top_wrap,#head,#header,.s-top{background:transparent!important}',

    /* 顶部纯渐变遮罩：白→透明，柔化顶部过渡，不做毛玻璃模糊 */
    '#bd-bing-top{',
      'position:fixed;left:0;top:0;width:100%;height:120px;',
      'z-index:-1;pointer-events:none;',
      'background:linear-gradient(to bottom, rgba(255,255,255,0.72), rgba(255,255,255,0));',
    '}'
  ].join('\n');

  function rmStyle(id) {
    var e = document.getElementById(id);
    if (e) e.remove();
  }
  function addStyle(id, text) {
    var s = document.createElement('style');
    s.id = id;
    s.textContent = text;
    (document.head || document.documentElement).appendChild(s);
  }
  function whenBody(cb) {
    if (document.body) cb();
    else document.addEventListener('DOMContentLoaded', cb, { once: true });
  }
  function localDate() {
    var d = new Date();
    var m = ('0' + (d.getMonth() + 1)).slice(-2);
    var day = ('0' + d.getDate()).slice(-2);
    return d.getFullYear() + '-' + m + '-' + day;
  }

  /* 直接套用 1920x1080 原图，不做高清替换 */
  function setBgImage(url) {
    var bg = document.getElementById(BGID);
    if (!bg) return;
    bg.style.backgroundImage = 'url("' + url + '")';
  }

  /* 取当日 Bing 图（idx=0），按本地日期缓存，每天只请求一次 API */
  function loadBingUrl(cb) {
    var today = localDate();
    var cached = GM_getValue('bd-bing-date', '');
    var url = GM_getValue('bd-bing-url', '');
    if (cached === today && url) { cb(url); return; }
    GM_xmlhttpRequest({
      method: 'GET',
      url: API + '0&n=1&mkt=zh-CN',
      onload: function (r) {
        try {
          var data = JSON.parse(r.responseText);
          var u = data.images[0].url;
          if (u.indexOf('http') !== 0) u = 'https://cn.bing.com' + u;
          GM_setValue('bd-bing-date', today);
          GM_setValue('bd-bing-url', u);
          cb(u);
        } catch (e) { if (url) cb(url); }
      },
      onerror: function () { if (url) cb(url); }
    });
  }

  function applyWallpaper() {
    if (!document.getElementById(WPID)) addStyle(WPID, wpCss);
    whenBody(function () {
      if (!document.getElementById(BGID)) {
        var bg = document.createElement('div');
        bg.id = BGID;
        document.body.appendChild(bg);
      }
      if (!document.getElementById(TOPID)) {
        var top = document.createElement('div');
        top.id = TOPID;
        document.body.appendChild(top);
      }
      loadBingUrl(function (u) { setBgImage(u); });
    });
  }

  applyWallpaper();
})();
