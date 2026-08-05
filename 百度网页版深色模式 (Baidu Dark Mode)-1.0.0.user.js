// ==UserScript==
// @name         百度网页版深色模式 (Baidu Dark Mode)
// @version      1.0.0
// @description  为百度网页版桌面端提供深色模式，仅系统深色时生效，且不在搜索结果页(/s)生效。
// @icon         https://www.baidu.com/favicon.ico
// @author       CH4RL35HUNT3R
// @match        *://www.baidu.com/*
// @match        *://baidu.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  /* 搜索结果页（/s）直接跳过：不注入任何样式，不做任何监听/菜单。 */
  if (location.pathname === '/s') return;

  const SID = 'bd-dark-css';
  const IID = 'bd-dark-inv';

  /* ===== 系统主题检测：仅系统为深色时脚本才生效 ===== */
  var mql = (typeof window.matchMedia === 'function')
    ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function sysDark() {
    return mql ? mql.matches : false;
  }

  /* ===== CSS 深色方案 ===== */
  var css = [
    'html,body{background:#0e0e10!important;color:#e8e8ea!important}',
    '#wrapper,#content,#container,#main,#page,.wrapper,#ftCon,.foot,',
    '#s_top_wrap,#head,#header{background:#0e0e10!important}',

    '*:not(img):not(video):not(canvas):not(svg){',
      'background-color:transparent!important;',
      'background-image:none!important;',
      'color:#e8e8ea!important;',
      'border-color:#2a2a2e!important;',
      'box-shadow:none!important;',
    '}',

    'a{color:#7aa7ff!important}',
    'a:visited{color:#c39bff!important}',
    'a:hover{color:#a9c5ff!important}',

    '#s_top_wrap,.s-top{background:#161618!important}',

    /* 搜索框区域：父容器白底来自 background-image，必须清除 */
    '.s_ipt_wr,.s_ipt_wr.bg,',
    '[class*="ipt_wr"],[class*="IptWr"],',
    '#s_fm .s_ipt_wr,',
    '*:has(> #kw),*:has(> #wd),*:has(> .s_ipt){',
      'background:#1c1c20!important;',
      'border:1px solid #2e2e33!important;',
      'border-radius:10px!important;',
      'padding:3px 6px!important;',
    '}',

    '#kw,#wd,.s_ipt,',
    'input[type="text"],input[type="search"],',
    'textarea{',
      'background:transparent!important;',
      'background-image:none!important;',
      'color:#e8e8ea!important;',
      'border:none!important;',
      'outline:none!important;',
      'box-shadow:none!important;',
    '}',

    '#kw:focus,#wd:focus,.s_ipt:focus,',
    'input[type="text"]:focus,input[type="search"]:focus{outline:none!important}',

    '.s_ipt_wr:has(#kw:focus),.s_ipt_wr:has(.s_ipt:focus),',
    '*:has(> #kw:focus),*:has(> .s_ipt:focus){',
      'border-color:#3b82f6!important;',
      'box-shadow:0 0 0 2px rgba(59,130,246,.18)!important;',
    '}',

    'input:-webkit-autofill,input:-webkit-autofill:hover,',
    'input:-webkit-autofill:focus,input:-webkit-autofill:active{',
      '-webkit-text-fill-color:#e8e8ea!important;',
      'box-shadow:0 0 0 1000px #1c1c20 inset!important;',
      'transition:background-color 9999s ease-in-out 0s!important;',
    '}',

    '#su,.s_btn,.btn-search,#s_btn,button.s_btn,',
    '.s_btn_wr button{',
      'background:#3b82f6!important;',
      'background-image:none!important;',
      'color:#fff!important;',
      'border:1px solid #3b82f6!important;',
      'border-radius:10px!important;',
      'padding:10px 22px!important;',
      'cursor:pointer!important;',
      'font-weight:600!important;',
    '}',
    '#su:hover,.s_btn:hover{background:#2563eb!important}',

    '.bdsug,.bdsug ul,.bdsug li{',
      'background:#161618!important;',
      'color:#e8e8ea!important;',
      'border-color:#2a2a2e!important;',
    '}',
    '.bdsug li:hover{background:#232327!important}',

    '::-webkit-scrollbar{width:10px;height:10px}',
    '::-webkit-scrollbar-track{background:#0e0e10}',
    '::-webkit-scrollbar-thumb{background:#2a2a2e;border-radius:6px}',
    '::-webkit-scrollbar-thumb:hover{background:#3a3a40}',

    '::selection{background:#3b82f6;color:#fff}'
  ].join('\n');

  var invCss = [
    'html{filter:invert(1) hue-rotate(180deg)!important}',
    'img,video,canvas,[class*="logo"]{filter:invert(1) hue-rotate(180deg)!important}'
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

  function applyDark() {
    rmStyle(IID);
    if (!document.getElementById(SID)) addStyle(SID, css);
  }
  function applyInvert() {
    rmStyle(SID);
    if (!document.getElementById(IID)) addStyle(IID, invCss);
  }
  function clearAll() {
    rmStyle(SID);
    rmStyle(IID);
  }

  function apply() {
    if (!sysDark()) { clearAll(); return; }
    if (inv) { applyInvert(); } else { applyDark(); }
  }

  var inv = GM_getValue('bd-invert', false);

  apply();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      if (sysDark() && !inv) applyDark();
    });
  }

  if (mql) {
    var onChange = function() { apply(); };
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange);
  }

  var mo = new MutationObserver(function() {
    if (!sysDark()) { clearAll(); return; }
    if (inv) { rmStyle(SID); } else { if (!document.getElementById(SID)) applyDark(); }
  });
  var ti = setInterval(function() {
    if (document.head) {
      clearInterval(ti);
      mo.observe(document.head, {childList:true});
      mo.observe(document.documentElement, {childList:true, subtree:false});
    }
  }, 80);

  var n = 0;
  var gi = setInterval(function() {
    if (!sysDark()) { clearAll(); }
    else if (inv) { rmStyle(SID); } else { if (!document.getElementById(SID)) applyDark(); }
    if (++n > 12) clearInterval(gi);
  }, 400);

  GM_registerMenuCommand(
    '\u{1F319} \u5207\u6362\u6574\u9875\u53CD\u8272\uFF08\u7CFB\u7EDF\u6DF1\u8272:' +
    (sysDark() ? '\u662F' : '\u5426') + '|\u53CD\u8272:' + (inv ? '\u5F00' : '\u5173') + '\uFF09',
    function() {
      inv = !inv;
      GM_setValue('bd-invert', inv);
      apply();
    }
  );
})();
