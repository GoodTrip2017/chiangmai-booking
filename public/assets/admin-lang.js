/**
 * 後台顯示語言（純畫面層）。
 * 後台所有文案都是「中文 / English」並排；這裡只決定畫面顯示哪一半，資料、API 與其他程式都不變。
 * 做法：掃描文字節點與少數屬性（placeholder、aria-label、title），符合「左半有中文、右半沒有中文」
 * 的「A / B」字串才替換；原文存在 WeakMap 裡，可隨時切回。之後新畫出來的節點由 MutationObserver 接手。
 * 不處理 <pre>、<textarea>、<script>、<style> 與標了 data-no-i18n 的區塊（例如通知訊息預覽要顯示實際送出的內容）。
 */
(function (root) {
  var CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

  /** 對一段文字依語言取出一半；泰文以英文半句查字典，查不到就顯示英文。不符合雙語格式的行原樣保留。 */
  function pickHalf(text, lang, dictionary) {
    if (lang !== 'zh' && lang !== 'en' && lang !== 'th') return text;
    var th = dictionary || {};
    return String(text).split('\n').map(function (line) {
      var parts = line.split(' / ');
      if (parts.length !== 2) return line;
      var left = parts[0], right = parts[1];
      if (!CJK.test(left) || CJK.test(right) || !/[A-Za-z]/.test(right)) return line;
      if (lang === 'zh') return left;
      if (lang === 'th') return Object.prototype.hasOwnProperty.call(th, right) ? th[right] : right;
      return right;
    }).join('\n');
  }

  if (typeof module !== 'undefined' && module.exports) { module.exports = { pickHalf: pickHalf }; return; }
  if (typeof document === 'undefined' || !document.body) return;

  var STORAGE_KEY = 'admin-lang';
  var ATTRS = ['placeholder', 'aria-label', 'title'];
  var SKIP = { PRE: true, TEXTAREA: true, SCRIPT: true, STYLE: true, OPTION_NEVER: false };
  var originals = new WeakMap();   // Text node → 原文；Element → { attr: 原文 }
  var applied = new WeakMap();     // Text node → 我們上次寫入的值（用來辨識是程式改的還是我們改的）
  var lang = 'both';
  var dictionary = root.ADMIN_LANG_TH || {};
  try { var saved = localStorage.getItem(STORAGE_KEY); if (saved === 'zh' || saved === 'en' || saved === 'th' || saved === 'both') lang = saved; } catch (err) { /* ignore */ }

  function skipped(node) {
    for (var el = node.nodeType === 1 ? node : node.parentNode; el && el.nodeType === 1; el = el.parentNode) {
      if (SKIP[el.tagName] || el.hasAttribute('data-no-i18n')) return true;
    }
    return false;
  }
  function localizeText(node) {
    if (skipped(node)) return;
    var original = originals.get(node);
    if (original === undefined || (applied.get(node) !== node.data)) { original = node.data; originals.set(node, original); }
    var next = pickHalf(original, lang, dictionary);
    if (node.data !== next) node.data = next;
    applied.set(node, next);
  }
  // 說明段落常是「中文<br>English」：單語模式只顯示該語言那一半（泰文模式顯示英文）。
  function localizeNote(el) {
    if (skipped(el)) return;
    var nodes = el.childNodes;
    if (nodes.length !== 3 || nodes[0].nodeType !== 3 || nodes[1].nodeName !== 'BR' || nodes[2].nodeType !== 3) return;
    var saved = originals.get(el) || {};
    if (saved.noteZh === undefined) {
      if (!CJK.test(nodes[0].data) || CJK.test(nodes[2].data)) return;
      saved.noteZh = nodes[0].data; saved.noteEn = nodes[2].data; originals.set(el, saved);
    }
    var showZh = lang === 'both' || lang === 'zh', showEn = lang === 'both' || lang === 'en' || lang === 'th';
    originals.set(nodes[0], showZh ? saved.noteZh : ''); nodes[0].data = showZh ? saved.noteZh : ''; applied.set(nodes[0], nodes[0].data);
    originals.set(nodes[2], showEn ? saved.noteEn : ''); nodes[2].data = showEn ? saved.noteEn : ''; applied.set(nodes[2], nodes[2].data);
    nodes[1].hidden = !(showZh && showEn);
  }
  function localizeAttrs(el) {
    if (skipped(el)) return;
    var saved = originals.get(el) || {};
    ATTRS.forEach(function (attr) {
      if (!el.hasAttribute(attr)) return;
      var current = el.getAttribute(attr);
      if (saved[attr] === undefined || saved['__applied_' + attr] !== current) saved[attr] = current;
      var next = pickHalf(saved[attr], lang, dictionary);
      if (current !== next) el.setAttribute(attr, next);
      saved['__applied_' + attr] = next;
    });
    originals.set(el, saved);
  }
  function localize(subtree) {
    if (!subtree) return;
    if (subtree.nodeType === 3) { localizeText(subtree); return; }
    if (subtree.nodeType !== 1 && subtree.nodeType !== 9) return;
    if (subtree.nodeType === 1) { localizeAttrs(subtree); localizeNote(subtree); }
    var walker = document.createTreeWalker(subtree, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) localizeText(node); else { localizeAttrs(node); localizeNote(node); }
    }
  }

  var titleOriginal = document.title;
  function applyLanguage(next) {
    lang = next === 'zh' || next === 'en' || next === 'th' ? next : 'both';
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (err) { /* ignore */ }
    document.documentElement.setAttribute('data-admin-lang', lang);
    document.documentElement.setAttribute('lang', lang === 'en' ? 'en' : lang === 'th' ? 'th' : 'zh-Hant');
    document.title = lang === 'en' ? 'GoodTrip x Herb Uncle Chiang Mai — Booking admin'
      : lang === 'th' ? 'GoodTrip x Herb Uncle เชียงใหม่ — ระบบจองหลังบ้าน' : titleOriginal;
    localize(document.body);
    Array.prototype.forEach.call(document.querySelectorAll('#adminLang [data-lang]'), function (button) {
      var on = button.getAttribute('data-lang') === lang;
      button.className = 'lang-btn' + (on ? ' on' : '');
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  var observer = new MutationObserver(function (records) {
    records.forEach(function (record) {
      if (record.type === 'characterData') { localizeText(record.target); return; }
      if (record.type === 'attributes') { localizeAttrs(record.target); return; }
      Array.prototype.forEach.call(record.addedNodes, localize);
    });
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

  var switcher = document.getElementById('adminLang');
  if (switcher) switcher.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-lang]') : null;
    if (button) applyLanguage(button.getAttribute('data-lang'));
  });
  applyLanguage(lang);
  root.adminLanguage = { apply: applyLanguage, pickHalf: pickHalf, current: function () { return lang; } };
})(typeof window !== 'undefined' ? window : globalThis);
