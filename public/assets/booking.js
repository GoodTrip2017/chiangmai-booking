
  var state = { slot: '', firstTime: '', slotMax: 0, maxPax: 12, loading: false, reviewedForm: null };
  // 顯示語言只影響畫面文字；送出的欄位值（是／否、來源 ID 等）與後台紀錄一律相同。
  var LANG = 'zh';
  var cfgCache = null;
  var sourcesCache = [];
  var availabilityCache = null;
  var doneCache = null;

  var availabilityVersion = 0;
  var submission = null;
  var tracking = { firstTouchSource: '', firstTouchMedium: '', firstTouchCampaign: '', trackingCode: '' };
  var $ = function (id) { return document.getElementById(id); };

  try {
    if (window.location && typeof URLSearchParams !== 'undefined') {
      var params = new URLSearchParams(window.location.search || '');
      var current = {
        firstTouchSource: (params.get('utm_source') || '').slice(0, 80),
        firstTouchMedium: (params.get('utm_medium') || '').slice(0, 80),
        firstTouchCampaign: (params.get('utm_campaign') || '').slice(0, 80)
      };
      var stored = window.sessionStorage && window.sessionStorage.getItem('booking-first-touch');
      if (stored) {
        var saved = JSON.parse(stored);
        ['firstTouchSource','firstTouchMedium','firstTouchCampaign'].forEach(function (key) {
          if (typeof saved[key] === 'string') tracking[key] = saved[key].slice(0, 80);
        });
      }
      else if (current.firstTouchSource || current.firstTouchMedium || current.firstTouchCampaign) {
        Object.assign(tracking, current);
        if (window.sessionStorage) window.sessionStorage.setItem('booking-first-touch', JSON.stringify(current));
      }
      tracking.trackingCode = (params.get('ref') || '').slice(0, 40);
    }
  } catch (err) { /* Storage may be unavailable; booking still works. */ }

  // ---- 語言
  function t(zh, en) { return LANG === 'en' ? en : zh; }
  // 後端訊息格式是「中文 / English」；依目前語言取一半，沒有分隔符就原樣顯示。
  function pick(text) {
    var s = String(text === undefined || text === null ? '' : text);
    var i = s.indexOf(' / ');
    if (i < 0) return s;
    return LANG === 'en' ? s.slice(i + 3) : s.slice(0, i);
  }
  function detectLanguage() {
    try {
      if (typeof localStorage !== 'undefined') {
        var saved = localStorage.getItem('booking-lang');
        if (saved === 'zh' || saved === 'en') return saved;
      }
    } catch (err) { /* ignore */ }
    try {
      var nav = typeof navigator !== 'undefined' ? (navigator.language || '') : '';
      if (nav && !/^zh/i.test(nav)) return 'en';
    } catch (err) { /* ignore */ }
    return 'zh';
  }
  function applyLanguage(lang) {
    LANG = lang === 'en' ? 'en' : 'zh';
    try { if (typeof localStorage !== 'undefined') localStorage.setItem('booking-lang', LANG); } catch (err) { /* ignore */ }
    try {
      var root = document.documentElement;
      if (root && root.setAttribute) {
        root.setAttribute('data-lang', LANG);
        root.setAttribute('lang', LANG === 'en' ? 'en' : 'zh-Hant');
      }
      document.title = t('GoodTrip x Herb Uncle 清邁尼曼店 — 預約飛行體驗', 'GoodTrip x Herb Uncle Chiang Mai — Book a Visit');
    } catch (err) { /* ignore */ }
    [['langZh', 'zh'], ['langEn', 'en']].forEach(function (entry) {
      var button = $(entry[0]);
      var on = entry[1] === LANG;
      button.className = 'lang-btn' + (on ? ' on' : '');
      if (button.setAttribute) button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    renderConfig();
    renderSources();
    updateDiscoveryDetailLabel();
    updatePaxHint();
    updateGroupNotice();
    if (!state.loading) $('reviewSubmit').textContent = t('確認送出', 'Confirm booking');
    if (availabilityCache) renderSlots(availabilityCache, true);
    if (state.reviewedForm && !$('reviewCard').hidden) showReview(state.reviewedForm);
    if (doneCache) renderDone(doneCache);
  }
  $('langZh').addEventListener('click', function () { applyLanguage('zh'); });
  $('langEn').addEventListener('click', function () { applyLanguage('en'); });

  // API helper：非 2xx 時丟出後端的 error 訊息
  async function api(path, options) {
    var res = await fetch(path, options);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var err = new Error(data.error || '連線失敗，請稍後再試。 / Connection failed. Please try again.');
      err.code = data.code; err.contactUrl = data.contactUrl;
      throw err;
    }
    return data;
  }

  var WEEKDAYS_ZH = ['週一', '週二', '週三', '週四', '週五', '週六', '週日'];
  var WEEKDAYS_EN = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
  function renderConfig() {
    var cfg = cfgCache;
    if (!cfg) return;
    $('publicHours').textContent = cfg.businessHours;
    $('publicServiceMinutes').textContent = cfg.serviceMinutes + t(' 分鐘', ' minutes');
    $('publicStartTime').textContent = cfg.startTime;
    $('publicCapacity').textContent = t('同一時段合計最多 ' + cfg.maxPax + ' 人', cfg.maxPax + ' guests total at a time');
    var days = (cfg.closedWeekdays || []).map(function (n) { return t(WEEKDAYS_ZH[n - 1], WEEKDAYS_EN[n - 1]); });
    var joined = days.join(t('、', ', '));
    $('publicClosedDays').textContent = days.length ? joined : t('無固定公休', 'No weekly closure');
    $('dateClosedHint').textContent = days.length ? t('（' + joined + ' 公休）', '(closed ' + joined + ')') : '';
  }
  // 今天（清邁時間）當作日期欄位下限
  api('/api/config').then(function (cfg) {
    cfgCache = cfg;
    state.maxPax = cfg.maxPax || 12;
    $('date').min = cfg.today;
    renderConfig();
    updateGroupNotice();
  }).catch(function () {});

  function showMsg(text, kind) {
    var m = $('msg');
    m.textContent = text;
    m.className = 'msg show ' + (kind || 'error');
  }
  function clearMsg() { $('msg').className = 'msg'; }

  function updateGroupNotice() {
    var available = state.slot ? state.slotMax : state.maxPax;
    var largeGroup = Number($('pax').value) > available;
    $('groupPolicyText').textContent = state.slot
      ? t('所選時段目前最多可容納 ' + available + ' 人。若同行人數較多，請透過 LINE 與店員確認其他安排。',
        'This slot currently has room for ' + available + ' guests. Please contact us on LINE about a larger group.')
      : t('線上預約每個時段最多接待 ' + state.maxPax + ' 人。超過 ' + state.maxPax + ' 人的團體，請透過 LINE 私訊，由店員確認接待方式與時段。',
        'Online bookings allow up to ' + state.maxPax + ' guests at one time. Please contact us on LINE for groups above ' + state.maxPax + '.');
    $('groupNotice').className = 'msg info' + (largeGroup ? ' show' : '');
    $('go').disabled = state.loading || largeGroup;
    $('go').textContent = state.loading ? t('送出中…', 'Sending…') : largeGroup ? t('多人預約請先透過 LINE 聯絡', 'Contact us on LINE for groups') : t('檢查預約資料', 'Review booking');
    return largeGroup;
  }
  $('pax').addEventListener('input', updateGroupNotice);

  // ---- 是否第一次接觸（送出的值固定為「是」／「否」）
  Array.prototype.forEach.call($('firstTime').children, function (el) {
    el.addEventListener('click', function () {
      state.firstTime = el.getAttribute('data-v');
      Array.prototype.forEach.call($('firstTime').children, function (o) {
        o.className = 'slot' + (o === el ? ' on' : '');
      });
    });
  });

  function sourceLabel(source) { return t(source.labelZh, source.labelEn); }
  function renderSources() {
    if (!sourcesCache.length) {
      // 來源清單尚未載入時，至少讓預設項跟著語言。
      try { var first = $('discoverySource').options && $('discoverySource').options[0]; if (first) first.textContent = t('請選擇', 'Please select'); } catch (err) { /* ignore */ }
      return;
    }
    var select = $('discoverySource');
    var selected = select.value;
    select.replaceChildren();
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('請選擇', 'Please select');
    select.appendChild(placeholder);
    sourcesCache.forEach(function (source) {
      var option = document.createElement('option');
      option.value = source.id;
      option.textContent = sourceLabel(source);
      select.appendChild(option);
    });
    select.value = selected;
  }
  api('/api/discovery-sources').then(function (data) {
    sourcesCache = data.sources || [];
    renderSources();
  }).catch(function () {
    showMsg(t('得知管道暫時無法載入，請重新整理。', 'Discovery sources could not be loaded. Please refresh.'));
  });
  function updateDiscoveryDetailLabel() {
    var id = $('discoverySource').value;
    $('discoveryDetailLabel').textContent = id === 'hotel-accommodation'
      ? t('旅宿名稱', 'Accommodation name') : id === 'partner-event'
        ? t('店家或活動名稱', 'Partner or event name') : t('補充說明', 'Details');
  }
  $('discoverySource').addEventListener('change', function () {
    var id = $('discoverySource').value;
    var needsDetail = ['other', 'hotel-accommodation', 'partner-event'].includes(id);
    $('discoveryDetailWrap').hidden = !needsDetail;
    $('discoveryDetail').value = '';
    updateDiscoveryDetailLabel();
  });

  // ---- 日期 → 查空位
  $('date').addEventListener('change', function () {
    var version = ++availabilityVersion;
    var date = $('date').value;
    state.slot = '';
    state.slotMax = 0;
    availabilityCache = null;
    updatePaxHint();
    if (!date) { renderSlotHint(t('請先選擇日期，即可查看各時段空位。', 'Select a date to see available times.'), 'info'); return; }
    renderSlotHint(t('查詢空位中…', 'Checking availability…'), 'info');
    api('/api/availability?date=' + encodeURIComponent(date)).then(function (data) {
      if (version === availabilityVersion) renderSlots(data);
    }).catch(function (err) {
      if (version === availabilityVersion) renderSlotHint(err.message ? pick(err.message) : t('查詢失敗，請重新整理。', 'Availability could not be loaded. Please refresh.'), 'error');
    });
  });

  function renderSlotHint(text, kind) {
    var hint = document.createElement('div');
    hint.className = 'msg show ' + (kind || 'info');
    hint.textContent = text;
    $('slots').replaceChildren(hint);
  }

  // preserve：切換語言時重畫，保留已選時段。
  function renderSlots(data, preserve) {
    availabilityCache = data;
    var keep = preserve ? state.slot : '';
    state.slot = '';
    state.slotMax = 0;
    if (data.closed) { renderSlotHint(pick(data.message || '此日期公休 / Closed on this date.'), 'error'); updatePaxHint(); return; }
    var box = $('slots');
    box.innerHTML = '';
    data.slots.forEach(function (s) {
      var cls = 'slot';
      if (!s.selectable) cls += ' off';
      if (s.status === 'OPEN') cls += ' free';
      else if (s.status === 'PARTIAL') cls += ' few';
      else cls += ' no';

      var el = document.createElement('div');
      el.className = cls;
      var time = document.createElement('span'); time.className = 't'; time.textContent = s.slot;
      var status = document.createElement('span'); status.className = 's';
      status.textContent = pick(s.statusText || '暫停預約 / Unavailable');
      el.append(time, status);
      if (s.selectable) {
        el.addEventListener('click', function () { pickSlot(el, s); });
        if (keep && keep === s.slot) { state.slot = s.slot; state.slotMax = s.maxPax; el.className += ' on'; }
      }
      box.appendChild(el);
    });
    updatePaxHint();
    updateGroupNotice();
  }

  function pickSlot(el, s) {
    state.slot = s.slot;
    state.slotMax = s.maxPax;
    Array.prototype.forEach.call($('slots').children, function (o) {
      o.className = o.className.replace(' on', '');
    });
    el.className += ' on';
    updatePaxHint();
    updateGroupNotice();
    clearMsg();
  }

  function updatePaxHint() {
    if (!state.slot) { $('paxHint').textContent = ''; return; }
    $('paxHint').textContent = t('（此時段可再預約 ' + state.slotMax + ' 人；同時總上限 ' + state.maxPax + ' 人）',
      '(' + state.slotMax + ' places left; ' + state.maxPax + ' guests total at a time)');
  }

  function selectedSourceLabel(form) {
    var match = sourcesCache.filter(function (source) { return source.id === form.discoverySourceId; })[0];
    return match ? sourceLabel(match) : form.discoverySourceId;
  }
  function showReview(form) {
    var labels = [
      [t('預約人', 'Name'), form.name],
      [t('到店日期', 'Visit date'), form.date],
      [t('清邁時間', 'Chiang Mai time'), form.slot + ' (GMT+7)'],
      [t('人數', 'Guests'), String(form.pax)],
      ['Email', form.email],
      ['LINE', form.line || t('未填', 'Not provided')],
      [t('得知管道', 'Discovery source'), selectedSourceLabel(form)],
    ];
    if (form.discoveryDetail) labels.push([t('補充', 'Details'), form.discoveryDetail]);
    var list = $('reviewDetails');
    list.replaceChildren();
    labels.forEach(function (entry) {
      var dt = document.createElement('dt');
      var dd = document.createElement('dd');
      dt.textContent = entry[0];
      dd.textContent = entry[1];
      list.append(dt, dd);
    });
    $('formCard').hidden = true;
    $('reviewCard').hidden = false;
    $('reviewMsg').className = 'msg';
    if ($('reviewCard').scrollIntoView) $('reviewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('reviewEdit').addEventListener('click', function () {
    $('reviewCard').hidden = true;
    $('formCard').hidden = false;
    state.reviewedForm = null;
    $('formCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---- 先檢查，再確認送出
  $('go').addEventListener('click', function () {
    if (state.loading) return;
    clearMsg();
    if (updateGroupNotice()) {
      $('groupNotice').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    var form = {
      name: $('name').value.trim(),
      pax: Number($('pax').value),
      date: $('date').value,
      slot: state.slot,
      firstTime: state.firstTime,
      line: $('line').value.trim(),
      email: $('email').value.trim(),
      discoverySourceId: $('discoverySource').value,
      discoveryDetail: $('discoveryDetailWrap').hidden ? '' : $('discoveryDetail').value.trim(),
      firstTouchSource: tracking.firstTouchSource,
      firstTouchMedium: tracking.firstTouchMedium,
      firstTouchCampaign: tracking.firstTouchCampaign,
      trackingCode: tracking.trackingCode
    };

    if (!form.name) return showMsg(t('請填寫預約人（綽號或本名）。', 'Enter the booking contact name.'));
    if (!form.date) return showMsg(t('請選擇預約日期。', 'Select a visit date.'));
    if (!form.slot) return showMsg(t('請選擇預約時段。', 'Select a time slot.'));
    if (!Number.isInteger(form.pax) || form.pax < 1 || form.pax > state.slotMax) return showMsg(t('人數請填 1 至 ' + state.slotMax + ' 的整數；同時最多 ' + state.maxPax + ' 人。', 'Enter 1–' + state.slotMax + ' guests; shared capacity is ' + state.maxPax + '.'));
    if (!form.firstTime) return showMsg(t('請選擇是否為第一次接觸。', 'Select whether this is your first experience.'));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return showMsg(t('請填寫正確的 Email。', 'Enter a valid email address.'));
    if (!form.discoverySourceId) return showMsg(t('請選擇得知管道。', 'Please select how you heard about us.'));

    state.reviewedForm = form;
    showReview(form);
  });

  $('reviewSubmit').addEventListener('click', function () {
    if (state.loading || !state.reviewedForm) return;
    var form = state.reviewedForm;

    var fingerprint = JSON.stringify(form);
    if (!submission || submission.fingerprint !== fingerprint) submission = { fingerprint: fingerprint, id: crypto.randomUUID() };
    form.requestId = submission.id;
    state.loading = true;
    $('reviewSubmit').disabled = true;
    $('reviewSubmit').textContent = t('送出中…', 'Sending…');

    api('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
      .then(onDone)
      .catch(function (err) {
        state.loading = false;
        $('reviewSubmit').disabled = false;
        $('reviewSubmit').textContent = t('確認送出', 'Confirm booking');
        updateGroupNotice();
        var message = $('reviewMsg');
        message.textContent = err.message ? pick(err.message) : t('送出失敗，請再試一次。', 'Submission failed. Please try again.');
        message.className = 'msg show error';
        if (err.code === 'GROUP_CONTACT_REQUIRED' && err.contactUrl) {
          var link = document.createElement('a');
          link.href = err.contactUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = t('透過 LINE 洽詢多人預約', 'Ask about group visits on LINE');
          message.append(' ', link);
        }
        var retryDate = $('date').value;
        var retryVersion = ++availabilityVersion;
        if (retryDate) {
          api('/api/availability?date=' + encodeURIComponent(retryDate)).then(function (data) {
            if (retryVersion === availabilityVersion) renderSlots(data);
          }).catch(function () {});
        }
      });
  });

  function renderDone(res) {
    var s = res.summary;
    var box = $('doneCard');
    box.replaceChildren();
    var heading = document.createElement('h2');
    heading.textContent = t('預約成功', 'Booking confirmed');
    box.appendChild(heading);
    var list = document.createElement('dl');
    [[t('預約編號', 'Booking ID'), s.bookingId], [t('狀態', 'Status'), t('已確認', 'Confirmed')], [t('預約人', 'Name'), s.name],
      [t('日期', 'Date'), s.dateLabel], [t('時段', 'Time slot'), s.slotLabel + ' (GMT+7)'], [t('人數', 'Guests'), String(s.pax)]].forEach(function (entry) {
      var label = document.createElement('dt');
      var value = document.createElement('dd');
      label.textContent = entry[0];
      value.textContent = entry[1];
      list.append(label, value);
    });
    box.appendChild(list);
    var mail = document.createElement('p');
    mail.textContent = res.mailStatus === 'ACCEPTED'
      ? t('確認信已交由寄信服務寄送至 ' + s.email + '，若未收到請檢查垃圾信件匣。', 'The email service accepted the confirmation for ' + s.email + '; please check spam if it does not arrive.')
      : t('您的預約已成立，但確認信尚未寄出。請保留此畫面；如需確認，請主動透過下方 LINE 聯絡店員。', 'Your booking is confirmed, but the email was not sent. Keep this page and contact us on LINE if needed.');
    box.appendChild(mail);
    var notice = document.createElement('p');
    notice.className = 'notice';
    notice.textContent = t('座位保留 ' + s.graceMinutes + ' 分鐘，請於 ' + s.deadline + ' 前抵達。若有延誤請透過 LINE 聯絡店員，逾時座位由店員依現場情況安排。',
      'Please arrive by ' + s.deadline + ' (Chiang Mai time). Contact our staff on LINE if delayed; late arrivals are handled by staff based on availability.');
    box.appendChild(notice);
    box.style.display = 'block';
  }
  function onDone(res) {
    doneCache = res;
    $('formCard').style.display = 'none';
    renderDone(res);
    $('reviewCard').hidden = true;
    window.scrollTo(0, 0);
  }

  applyLanguage(detectLanguage());
