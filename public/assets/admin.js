
  var csrfToken = '';
  var submission = null;
  var week = null;
  var monday = '';          // 空字串 = 讓後端用本週
  var editing = null;       // null = 新增模式


  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  async function api(path, options) {
    options = options || {};
    options.headers = Object.assign({ 'X-CSRF-Token': csrfToken }, options.headers || {});
    if (options.method && options.method !== 'GET') {
      options.headers['Content-Type'] = 'application/json';
      if (!options.body) options.body = '{}';
    }
    options.credentials = 'same-origin';
    var res = await fetch(path, options);
    var data = await res.json().catch(function () { return {}; });
    if (res.status === 401) { location.replace('/admin/login'); throw new Error('請重新登入。'); }
    if (!res.ok) throw new Error(data.error || '連線失敗，請稍後再試。');
    return data;
  }

  function load(m) {
    if (m !== undefined) monday = m;
    $('loading').style.display = 'block';
    $('loading').textContent = '載入中…';
    api('/api/admin/week' + (monday ? '?monday=' + encodeURIComponent(monday) : ''))
      .then(function (data) { week = data; monday = data.monday; render(); ['prev','this','next','addNew'].forEach(function (id) { $(id).disabled = false; }); })
      .catch(function (err) { $('loading').textContent = err.message || '載入失敗'; });
  }

  function render() {
    $('range').textContent = week.rangeLabel;
    var html = '<tr><th class="slotcol">時段</th>';
    week.days.forEach(function (d) {
      html += '<th class="' + (d.isToday ? 'today' : '') + '">' + d.weekday + ' ' + d.dayLabel +
        (d.closed ? '（公休）' : '') + (d.isToday ? ' ●' : '') + '</th>';
    });
    html += '</tr>';

    week.slotDefs.forEach(function (sd, si) {
      html += '<tr><td class="slotcol">' + sd.slot + '</td>';
      week.days.forEach(function (d, di) {
        if (d.closed) { html += '<td class="closed">公休</td>'; return; }
        html += '<td>' + cellHtml(d, d.slots[si], di, si) + '</td>';
      });
      html += '</tr>';
    });

    $('grid').innerHTML = html;
    $('loading').style.display = 'none';
    $('scroll').style.display = 'block';

    Array.prototype.forEach.call(document.querySelectorAll('.chip'), function (el) {
      el.addEventListener('click', function () {
        var d = week.days[Number(el.dataset.d)];
        var b = d.slots[Number(el.dataset.s)].bookings[Number(el.dataset.i)];
        openEdit(b);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.add'), function (el) {
      el.addEventListener('click', function () {
        openNew(week.days[Number(el.dataset.d)].date, week.slotDefs[Number(el.dataset.s)].slot);
      });
    });
  }

  function cellHtml(day, cell, di, si) {
    var head;
    if (cell.groups === 0) {
      head = '<span class="cnt">—</span>';
    } else if (cell.overCapacity) {
      head = '<span class="cnt">' + cell.totalPax + ' 人</span><span class="whole">舊資料超過上限，請調整</span>';
    } else {
      head = '<span class="cnt">' + cell.totalPax + ' / ' + week.maxPax + '</span>' +
        '<span>' + cell.groups + ' 組</span>' +
        (cell.full ? '<span style="color:var(--err)">已滿</span>' : '');
    }
    var out = '<div class="cellhead' + (cell.full ? ' full' : '') + '">' + head +
      '<button class="add" data-d="' + di + '" data-s="' + si + '" title="手動新增">＋</button></div>';

    if (cell.groups === 0) return out + '<div class="empty">無預約</div>';

    cell.bookings.forEach(function (b, i) {
      var bad = b.mailFailed;
      out += '<div class="chip' + (bad ? ' warn' : '') + '" data-d="' + di + '" data-s="' + si + '" data-i="' + i + '">' +
        '<div class="nm">' + esc(b.name) + ' <span class="cnt">x' + b.pax + '</span>' +
          (b.firstTime === '是' ? '<span class="tag first">初次</span>' : '') +
          (b.source !== 'WEB' ? '<span class="tag">' + esc(sourceLabel(b.source)) + '</span>' : '') +
          (b.mailFailed ? '<span class="tag err">信未寄出</span>' : (b.email && b.mailStatus === 'NOT_REQUESTED' ? '<span class="tag">尚未寄信</span>' : '')) +
        '</div>' +
        '<div class="meta">' + (b.line ? 'LINE ' + esc(b.line) + ' · ' : '') + esc(b.email || '無 Email') +
          (b.referral ? ' · 來自 ' + esc(b.referral) : '') + '</div>' +
        (b.note ? '<div class="meta">📝 ' + esc(b.note) + '</div>' : '') +
        '</div>';
    });
    return out;
  }

  function sourceLabel(s) {
    return { WALK_IN: '現場', LINE: 'LINE', PHONE: '電話', WEB: '網路' }[s] || s;
  }

  // ---------------- Modal
  function slotOptions(selected) {
    return week.slotDefs.map(function (s) {
      return '<option value="' + s.slot + '"' + (s.slot === selected ? ' selected' : '') + '>' + s.slot + '</option>';
    }).join('');
  }

  function openModal() {
    $('mMsg').className = 'mmsg';
    submission = null;
    $('mSave').textContent = '儲存';
    $('mask').className = 'mask on';
    $('modal').className = 'modal on';
  }
  function closeModal() {
    $('mask').className = 'mask';
    $('modal').className = 'modal';
  }

  function openNew(dateStr, slot) {
    editing = null;
    $('mTitle').textContent = '手動新增預約';
    $('fId').value = '';
    $('fName').value = '';
    $('fDate').value = dateStr || week.days[0].date;
    $('fPax').value = 1;
    $('fSlot').innerHTML = slotOptions(slot || week.slotDefs[0].slot);
    $('fFirst').value = '否';
    $('fSource').value = 'WALK_IN';
    $('fLine').value = '';
    $('fEmail').value = '';
    $('fReferral').value = '';
    $('fNote').value = '';
    $('fSendMail').checked = false;
    $('mailChk').style.display = 'flex';
    $('fSource').disabled = false;
    $('mCancelBooking').style.display = 'none';
    $('mResend').style.display = 'none';
    openModal();
  }

  function openEdit(b) {
    editing = b;
    $('mTitle').textContent = '編輯預約 · ' + b.name;
    $('fId').value = b.id;
    $('fName').value = b.name;
    $('fDate').value = b.date;
    $('fPax').value = b.pax;
    $('fSlot').innerHTML = slotOptions(b.slot);
    $('fFirst').value = b.firstTime === '是' ? '是' : '否';
    $('fSource').value = b.source || 'WEB';
    $('fSource').disabled = true;
    $('fLine').value = b.line;
    $('fEmail').value = b.email;
    $('fReferral').value = b.referral || '';
    $('fNote').value = b.note;
    $('mailChk').style.display = 'none';
    $('mCancelBooking').style.display = 'inline-block';
    $('mResend').style.display = b.email ? 'inline-block' : 'none';
    openModal();
  }

  function payload() {
    return {
      id: $('fId').value,
      name: $('fName').value.trim(),
      pax: Number($('fPax').value),
      date: $('fDate').value,
      slot: $('fSlot').value,
      firstTime: $('fFirst').value,
      source: $('fSource').value,
      line: $('fLine').value.trim(),
      email: $('fEmail').value.trim(),
      referral: $('fReferral').value,
      note: $('fNote').value.trim(),
      sendMail: $('fSendMail').checked
    };
  }

  function showMMsg(text) {
    $('mMsg').textContent = text;
    $('mMsg').className = 'mmsg on';
  }

  function busy(on) {
    $('mSave').disabled = on;
    $('mCancelBooking').disabled = on;
    $('mResend').disabled = on;
    $('mClose').disabled = on;
    if (on) $('mSave').textContent = '處理中…';
  }

  $('mSave').addEventListener('click', function () {
    var p = payload();
    if (!p.name) return showMMsg('請填寫預約人。');
    if (!p.date) return showMMsg('請選擇日期。');
    if (!p.email) return showMMsg('請填寫 Email，確認信會寄到這個信箱。');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return showMMsg('請填寫正確的 Email。');
    if (!Number.isInteger(p.pax) || p.pax < 1 || p.pax > 12) return showMMsg('人數請填 1 至 12 的整數。');
    var fingerprint = JSON.stringify(p);
    if (!submission || submission.fingerprint !== fingerprint) submission = { fingerprint: fingerprint, id: crypto.randomUUID() };
    p.requestId = submission.id;
    busy(true);

    var req = editing
      ? api('/api/admin/bookings/' + encodeURIComponent(p.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p)
        })
      : api('/api/admin/bookings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p)
        });

    req.then(function (res) {
      busy(false);
      closeModal();
      load();
    }).catch(function (err) {
      busy(false);
      $('mSave').textContent = '儲存';
      showMMsg(err.message || '操作失敗。');

    });
  });

  $('mCancelBooking').addEventListener('click', function () {
    if (!editing) return;
    if (!confirm('確定要取消「' + editing.name + ' x' + editing.pax + '人」的預約嗎？\n（不會寄取消信）')) return;
    busy(true);
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/cancel', { method: 'POST' })
      .then(function () { busy(false); closeModal(); load(); })
      .catch(function (err) { busy(false); $('mSave').textContent = '儲存'; showMMsg(err.message || '取消失敗。'); });
  });

  $('mClose').addEventListener('click', closeModal);
  $('mask').addEventListener('click', function () { if (!$('mSave').disabled) closeModal(); });
  $('prev').addEventListener('click', function () { load(week.prevMonday); });
  $('next').addEventListener('click', function () { load(week.nextMonday); });
  $('this').addEventListener('click', function () { load(week.thisMonday); });
  $('reload').addEventListener('click', function () { load(); });
  $('addNew').addEventListener('click', function () { openNew(null, null); });

  $('logout').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' }).then(function () { location.replace('/admin/login'); }).catch(function (err) { alert(err.message); });
  });
  $('mResend').addEventListener('click', function () {
    if (!editing) return;
    var current = payload();
    if (['name','pax','date','slot','email'].some(function (key) { return current[key] !== editing[key]; })) {
      showMMsg('請先儲存修改，再重寄確認信。'); return;
    }
    busy(true);
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/resend-mail', { method: 'POST' })
      .then(function () { showMMsg('確認信已交由寄信服務寄送。'); load(); })
      .catch(function (err) { showMMsg(err.message); })
      .finally(function () { busy(false); $('mSave').textContent = '儲存'; });
  });
  api('/api/admin/session').then(function (session) { csrfToken = session.csrfToken; load(); })
    .catch(function (err) { $('loading').textContent = err.message; });
