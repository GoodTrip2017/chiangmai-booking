
  var state = { slot: '', firstTime: '', slotMax: 0, loading: false, reviewedForm: null };

  var availabilityVersion = 0;
  var submission = null;
  var $ = function (id) { return document.getElementById(id); };

  // API helper：非 2xx 時丟出後端的 error 訊息
  async function api(path, options) {
    var res = await fetch(path, options);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || '連線失敗，請稍後再試。');
    return data;
  }

  // 今天（清邁時間）當作日期欄位下限
  api('/api/config').then(function (cfg) {
    $('date').min = cfg.today;
    $('publicHours').textContent = cfg.businessHours;
    $('publicServiceMinutes').textContent = cfg.serviceMinutes + ' 分鐘 / minutes';
    $('publicStartTime').textContent = cfg.startTime;
    $('publicCapacity').textContent = '同一時段合計最多 ' + cfg.maxPax + ' 人 / ' + cfg.maxPax + ' guests total at a time';
    var days = ['週一 / Mondays','週二 / Tuesdays','週三 / Wednesdays','週四 / Thursdays','週五 / Fridays','週六 / Saturdays','週日 / Sundays'];
    var closed = cfg.closedWeekdays.map(function (n) { return days[n - 1]; });
    $('publicClosedDays').textContent = closed.length ? closed.join('、') : '無固定公休 / No weekly closure';
    $('dateClosedHint').textContent = closed.length ? '（' + closed.join('、') + ' 公休）' : '';
  }).catch(function () {});

  function showMsg(text, kind) {
    var m = $('msg');
    m.textContent = text;
    m.className = 'msg show ' + (kind || 'error');
  }
  function clearMsg() { $('msg').className = 'msg'; }

  function updateGroupNotice() {
    var available = state.slot ? state.slotMax : 12;
    var largeGroup = Number($('pax').value) > available;
    $('groupPolicyText').textContent = state.slot
      ? '所選時段目前最多可容納 ' + available + ' 人。若同行人數較多，請透過 LINE 與店員確認其他安排。 / This slot currently has room for ' + available + ' guests. Please contact us about a larger group.'
      : '線上預約每個時段最多接待 12 人。超過 12 人的團體，請透過 LINE 私訊，由店員確認接待方式與時段。 / Please contact us on LINE for groups above 12.';
    $('groupNotice').className = 'msg info' + (largeGroup ? ' show' : '');
    $('go').disabled = state.loading || largeGroup;
    $('go').textContent = state.loading ? '送出中，請稍候…' : largeGroup ? '多人預約請先透過 LINE 聯絡' : '送出預約';
    return largeGroup;
  }
  $('pax').addEventListener('input', updateGroupNotice);

  // ---- 是否第一次接觸
  Array.prototype.forEach.call($('firstTime').children, function (el) {
    el.addEventListener('click', function () {
      state.firstTime = el.getAttribute('data-v');
      Array.prototype.forEach.call($('firstTime').children, function (o) {
        o.className = 'slot' + (o === el ? ' on' : '');
      });
    });
  });

  api('/api/discovery-sources').then(function (data) {
    data.sources.forEach(function (source) {
      var option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.labelZh + ' / ' + source.labelEn;
      $('discoverySource').appendChild(option);
    });
  }).catch(function () {
    showMsg('得知管道暫時無法載入，請重新整理 / Discovery sources could not be loaded. Please refresh.');
  });
  $('discoverySource').addEventListener('change', function () {
    var id = $('discoverySource').value;
    var needsDetail = ['other', 'hotel-accommodation', 'partner-event'].includes(id);
    $('discoveryDetailWrap').hidden = !needsDetail;
    $('discoveryDetail').value = '';
    $('discoveryDetailLabel').firstChild.textContent = id === 'hotel-accommodation'
      ? '旅宿名稱 / Accommodation name ' : id === 'partner-event'
        ? '店家或活動名稱 / Partner or event name ' : '補充說明 / Details ';
  });

  // ---- 日期 → 查空位
  $('date').addEventListener('change', function () {
    var version = ++availabilityVersion;
    var date = $('date').value;
    state.slot = '';
    state.slotMax = 0;
    updatePaxHint();
    if (!date) { renderSlotHint('請先選擇日期，即可查看各時段空位。', 'info'); return; }
    renderSlotHint('查詢空位中…', 'info');
    api('/api/availability?date=' + encodeURIComponent(date)).then(function (data) {
      if (version === availabilityVersion) renderSlots(data);
    }).catch(function (err) {
      if (version === availabilityVersion) renderSlotHint(err.message || '查詢失敗，請重新整理。', 'error');
    });
  });

  function renderSlotHint(text, kind) {
    var hint = document.createElement('div');
    hint.className = 'msg show ' + (kind || 'info');
    hint.textContent = text;
    $('slots').replaceChildren(hint);
  }

  function renderSlots(data) {
    state.slot = '';
    state.slotMax = 0;
    updatePaxHint();
    if (data.closed) { renderSlotHint(data.message, 'error'); return; }
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
      var status = document.createElement('span'); status.className = 's'; status.textContent = s.statusText;
      el.append(time, status);
      if (s.selectable) {
        el.addEventListener('click', function () { pickSlot(el, s); });
      }
      box.appendChild(el);
    });
    updatePaxHint();
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
    $('paxHint').textContent = '（此時段最多可再預約 ' + state.slotMax + ' 人；總上限 12 人）';
  }

  function showReview(form) {
    var labels = [
      ['預約人 / Name', form.name],
      ['到店日期 / Visit date', form.date],
      ['清邁時間 / Chiang Mai time', form.slot + ' (GMT+7)'],
      ['人數 / Guests', String(form.pax)],
      ['Email', form.email],
      ['LINE', form.line || '未填 / Not provided'],
      ['得知管道 / Discovery source', $('discoverySource').selectedOptions[0].textContent],
    ];
    if (form.discoveryDetail) labels.push(['補充 / Details', form.discoveryDetail]);
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
    $('reviewCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      discoveryDetail: $('discoveryDetailWrap').hidden ? '' : $('discoveryDetail').value.trim()
    };

    if (!form.name) return showMsg('請填寫預約人（綽號或本名）。');
    if (!form.date) return showMsg('請選擇預約日期。');
    if (!form.slot) return showMsg('請選擇預約時段。');
    if (!Number.isInteger(form.pax) || form.pax < 1 || form.pax > state.slotMax) return showMsg('人數請填 1 至 ' + state.slotMax + ' 的整數；每個時段合計最多 12 人。');
    if (!form.firstTime) return showMsg('請選擇是否為第一次接觸。');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) return showMsg('請填寫正確的 Email。');
    if (!form.discoverySourceId) return showMsg('請選擇得知管道 / Please select how you heard about us.');

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
    $('reviewSubmit').textContent = '送出中 / Sending…';

    api('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })
      .then(onDone)
      .catch(function (err) {
        state.loading = false;
        $('reviewSubmit').disabled = false;
        $('reviewSubmit').textContent = '確認送出 / Confirm booking';
        updateGroupNotice();
        var message = $('reviewMsg');
        message.textContent = err.message || '送出失敗 / Submission failed. Please try again.';
        message.className = 'msg show error';
        var retryDate = $('date').value;
        var retryVersion = ++availabilityVersion;
        if (retryDate) {
          api('/api/availability?date=' + encodeURIComponent(retryDate)).then(function (data) {
            if (retryVersion === availabilityVersion) renderSlots(data);
          }).catch(function () {});
        }
      });
  });

  function onDone(res) {
    var s = res.summary;
    $('formCard').style.display = 'none';
    var box = $('doneCard');
    box.replaceChildren();
    var heading = document.createElement('h2');
    heading.textContent = '預約成功 / Booking confirmed';
    box.appendChild(heading);
    var list = document.createElement('dl');
    [['預約編號 / Booking ID', s.bookingId], ['狀態 / Status', '已確認 / Confirmed'], ['預約人 / Name', s.name], ['日期 / Date', s.dateLabel], ['時段 / Time slot', s.slotLabel + '（GMT+7）'], ['人數 / Guests', s.pax + ' 人']].forEach(function (entry) {
      var label = document.createElement('dt');
      var value = document.createElement('dd');
      label.textContent = entry[0];
      value.textContent = entry[1];
      list.append(label, value);
    });
    box.appendChild(list);
    var mail = document.createElement('p');
    mail.textContent = res.mailStatus === 'ACCEPTED'
      ? '確認信已交由寄信服務寄送至 ' + s.email + '，若未收到請檢查垃圾信件匣。'
      : '您的預約已成立，但確認信尚未寄出。請保留此畫面；如需確認，請主動透過下方 LINE 聯絡店員。';
    box.appendChild(mail);
    var notice = document.createElement('p');
    notice.className = 'notice';
    notice.textContent = '座位保留 ' + s.graceMinutes + ' 分鐘，請於 ' + s.deadline + ' 前抵達。若有延誤請主動透過 LINE 聯絡店員，逾時座位由店員依現場情況安排。';
    box.appendChild(notice);
    box.style.display = 'block';
    $('reviewCard').hidden = true;
    window.scrollTo(0, 0);
  }
