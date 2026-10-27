(function () {
  var $ = function (id) { return document.getElementById(id); };
  var LANG = 'zh';
  function t(zh, en) { return LANG === 'en' ? en : zh; }
  // 後端訊息格式是「中文 / English」；依目前語言取一半。
  function pick(text) {
    var s = String(text === undefined || text === null ? '' : text);
    var i = s.indexOf(' / ');
    if (i < 0) return s;
    return LANG === 'en' ? s.slice(i + 3) : s.slice(0, i);
  }
  function detectLanguage() {
    try { var saved = localStorage.getItem('booking-lang'); if (saved === 'zh' || saved === 'en') return saved; } catch (err) { /* ignore */ }
    try { var nav = navigator.language || ''; if (nav && !/^zh/i.test(nav)) return 'en'; } catch (err) { /* ignore */ }
    return 'zh';
  }
  var view = null;
  var finished = null;
  function applyLanguage(lang) {
    LANG = lang === 'en' ? 'en' : 'zh';
    try { localStorage.setItem('booking-lang', LANG); } catch (err) { /* ignore */ }
    document.documentElement.setAttribute('data-lang', LANG);
    document.documentElement.setAttribute('lang', LANG === 'en' ? 'en' : 'zh-Hant');
    document.title = t('取消預約 — GoodTrip x Herb Uncle', 'Cancel booking — GoodTrip x Herb Uncle');
    $('langZh').className = 'lang-btn' + (LANG === 'zh' ? ' on' : '');
    $('langEn').className = 'lang-btn' + (LANG === 'en' ? ' on' : '');
    render();
  }
  $('langZh').addEventListener('click', function () { applyLanguage('zh'); });
  $('langEn').addEventListener('click', function () { applyLanguage('en'); });

  // 連結參數放在 # 之後（不會送到伺服器或進入存取紀錄）；仍相容早期信件的 ? 形式。只讀一次，然後從網址列移除。
  function readParams() {
    var raw = location.hash && location.hash.length > 1 ? location.hash.slice(1) : String(location.search || '').replace(/^\?/, '');
    var params = new URLSearchParams(raw);
    return { bookingId: params.get('booking') || '', token: params.get('token') || '' };
  }
  var linkParams = readParams();
  var bookingId = linkParams.bookingId;
  var token = linkParams.token;
  try { history.replaceState(null, '', location.pathname); } catch (err) { /* ignore */ }

  function showStatus(text, kind) {
    var box = $('status');
    box.textContent = text;
    box.className = 'msg show ' + kind;
  }
  function render() {
    var button = $('cancelButton');
    button.textContent = t('確認取消預約', 'Confirm cancellation');
    if (!bookingId || !token) {
      $('details').hidden = true; button.disabled = true;
      showStatus(t('這個連結不完整，請使用確認信裡的完整連結。', 'This link is incomplete. Please use the full link from your confirmation email.'), 'error');
      return;
    }
    if (!view) return;
    var list = $('details');
    list.replaceChildren();
    [[t('預約人', 'Name'), view.name], [t('日期', 'Date'), view.dateLabel], [t('時段', 'Time slot'), view.slotLabel + ' (GMT+7)'], [t('人數', 'Guests'), String(view.pax)]].forEach(function (entry) {
      var dt = document.createElement('dt'); var dd = document.createElement('dd');
      dt.textContent = entry[0]; dd.textContent = entry[1]; list.append(dt, dd);
    });
    list.hidden = false;
    if (finished) {
      button.disabled = true;
      button.textContent = t('已取消', 'Cancelled');
      showStatus(finished.alreadyCancelled
        ? t('這筆預約先前已經取消。', 'This booking was already cancelled.')
        : finished.mailStatus === 'ACCEPTED'
          ? t('預約已取消，取消通知信將寄到您的信箱。', 'Your booking is cancelled. A cancellation email is on its way.')
          : t('預約已取消。若未收到取消通知信，請以本畫面為準。', 'Your booking is cancelled. Keep this page as your record if no email arrives.'), 'ok');
      return;
    }
    if (view.cancellable) {
      button.disabled = false;
      $('status').className = 'msg';
    } else {
      button.disabled = true;
      showStatus(view.reason === 'ALREADY_CANCELLED'
        ? t('這筆預約已經取消。', 'This booking has already been cancelled.')
        : view.reason === 'VISIT_STARTED'
          ? t('預約時間已開始，無法線上取消；請透過 LINE 聯絡店員。', 'The visit has already started and cannot be cancelled online. Please contact staff on LINE.')
          : t('這筆預約目前無法線上取消，請透過 LINE 聯絡店員。', 'This booking cannot be cancelled online. Please contact staff on LINE.'), 'info');
    }
  }
  async function api(path) {
    var res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || '連線失敗，請稍後再試。 / Connection failed. Please try again.');
    return data;
  }
  $('cancelButton').addEventListener('click', function () {
    var button = $('cancelButton');
    if (button.disabled || !view || !view.cancellable) return;
    button.disabled = true;
    button.textContent = t('取消中…', 'Cancelling…');
    api('/api/bookings/' + encodeURIComponent(bookingId) + '/cancellation').then(function (data) {
      finished = data;
      if (data.booking) view = data.booking;
      render();
    }).catch(function (err) {
      showStatus(pick(err.message), 'error');
      button.disabled = false;
      button.textContent = t('確認取消預約', 'Confirm cancellation');
    });
  });

  applyLanguage(detectLanguage());
  if (bookingId && token) {
    showStatus(t('讀取預約資料中…', 'Loading your booking…'), 'info');
    api('/api/bookings/' + encodeURIComponent(bookingId) + '/cancellation/preview').then(function (data) {
      view = data; render();
    }).catch(function (err) {
      $('cancelButton').disabled = true;
      showStatus(pick(err.message), 'error');
    });
  }
})();
