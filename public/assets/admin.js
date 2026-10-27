
  var csrfToken = '';
  var role = 'ADMIN';
  var submission = null;
  var week = null;
  var monday = '';          // 空字串 = 讓後端用本週
  var editing = null;       // null = 新增模式
  var discoverySources = [];


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
      .then(function (data) { week = data; monday = data.monday; render(); ['prev','this','next','addNew'].forEach(function (id) { $(id).disabled = false; });
        var today = data.days.find(function (d) { return d.isToday; });
        if (today && !$('reportFrom').value) { $('reportFrom').value = today.date; $('reportTo').value = today.date; }
      })
      .catch(function (err) { $('loading').textContent = err.message || '載入失敗'; });
  }

  function render() {
    $('range').textContent = week.rangeLabel;
    var html = '<tr><th class="slotcol">時段 / Time slot</th>';
    week.days.forEach(function (d) {
      html += '<th class="' + (d.isToday ? 'today' : '') + '">' + d.weekday + ' ' + d.dayLabel +
        (d.closed ? '（公休）' : '') + (d.isToday ? ' ●' : '') + '</th>';
    });
    html += '</tr>';

    week.slotDefs.forEach(function (sd, si) {
      html += '<tr><td class="slotcol">' + (sd.legacy ? '舊時段 ' : '') + sd.slot + '</td>';
      week.days.forEach(function (d, di) {
        if (d.closed) { html += '<td class="closed">公休</td>'; return; }
        html += '<td>' + cellHtml(d, d.slots[si], di, si, sd.legacy) + '</td>';
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

  function cellHtml(day, cell, di, si, legacy) {
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
      (legacy ? '' : '<button class="add" data-d="' + di + '" data-s="' + si + '" title="手動新增">＋</button>') + '</div>';

    if (cell.bookings.length === 0) return out + '<div class="empty">' +
      (cell.groups ? '由重疊的舊時段預約占用' : '無預約') + '</div>';

    cell.bookings.forEach(function (b, i) {
      var bad = b.mailFailed;
      out += '<div class="chip' + (bad ? ' warn' : '') + '" data-d="' + di + '" data-s="' + si + '" data-i="' + i + '">' +
        '<div class="nm">' + esc(b.name) + ' <span class="cnt">x' + b.pax + '</span><span class="tag">' + esc(statusLabel(b.status)) + '</span>' +
          (b.firstTime === '是' ? '<span class="tag first">初次</span>' : '') +
          (b.source !== 'WEB' ? '<span class="tag">' + esc(sourceLabel(b.source)) + '</span>' : '') +
          (b.mailFailed ? '<span class="tag err">信未寄出</span>' : (b.email && b.mailStatus === 'NOT_REQUESTED' ? '<span class="tag">尚未寄信</span>' : '')) +
        '</div>' +
        '<div class="meta">' + (b.line ? 'LINE ' + esc(b.line) + ' · ' : '') + esc(b.email || '無 Email') +
          (b.referral ? ' · 來自 ' + esc(b.referral) : '') + '</div>' +
        (b.note ? '<div class="meta">備註 / Note: ' + esc(b.note) + '</div>' : '') +
        '</div>';
    });
    return out;
  }

  function sourceLabel(s) {
    return { WALK_IN: '現場', LINE: 'LINE', PHONE: '電話', WEB: '網路' }[s] || s;
  }

  // ---------------- Modal
  function slotOptions(selected) {
    var options = week.slotDefs.filter(function (s) { return !s.legacy; }).map(function (s) {
      return '<option value="' + s.slot + '"' + (s.slot === selected ? ' selected' : '') + '>' + s.slot + '</option>';
    }).join('');
    if (week.slotDefs.some(function (s) { return s.legacy && s.slot === selected; })) {
      options += '<option value="' + selected + '" selected>舊時段 ' + selected + '</option>';
    }
    return options;
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
    $('mTitle').textContent = '手動新增預約 / Add booking';
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
    $('fDiscoverySource').value = '';
    $('fDiscoveryDetail').value = '';
    $('fNote').value = '';
    $('fSendMail').checked = false;
    $('mailChk').style.display = 'flex';
    $('fSource').disabled = false;
    $('mCancelBooking').style.display = 'none';
    $('mResend').style.display = 'none';
    $('statusPanel').style.display = 'none';
    openModal();
  }

  function openEdit(b) {
    editing = b;
    $('mTitle').textContent = '編輯預約 / Edit booking · ' + b.name;
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
    $('fDiscoverySource').value = b.discoverySourceId || '';
    $('fDiscoveryDetail').value = b.discoveryDetail || '';
    $('fNote').value = b.note;
    $('mailChk').style.display = 'none';
    $('mCancelBooking').style.display = ['PENDING', 'CONFIRMED'].includes(b.status) ? 'inline-block' : 'none';
    $('mResend').style.display = b.email ? 'inline-block' : 'none';
    $('statusPanel').style.display = 'block';
    $('statusCurrent').textContent = '目前狀態 / Current status: ' + statusLabel(b.status);
    $('fActualPax').value = b.actualPax === null || b.actualPax === undefined ? b.pax : b.actualPax;
    $('fStatusReason').value = '';
    renderStatusActions(b);
    openModal();
  }

  function statusLabel(status) {
    return { PENDING: '待確認 / Pending', CONFIRMED: '已確認 / Confirmed', CHECKED_IN: '已到店 / Checked in', COMPLETED: '已完成 / Completed', CANCELLED: '已取消 / Cancelled', NO_SHOW: '未到店 / No-show' }[status] || status;
  }
  function renderStatusActions(b) {
    var targets = { PENDING: ['CONFIRMED', 'CHECKED_IN'], CONFIRMED: ['CHECKED_IN', 'NO_SHOW'], CHECKED_IN: ['COMPLETED'] }[b.status] || [];
    $('statusActions').replaceChildren();
    targets.forEach(function (target) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = statusLabel(target);
      button.addEventListener('click', function () {
        var body = { status: target, revision: b.revision, reason: $('fStatusReason').value.trim() };
        if (target === 'CHECKED_IN') body.actualPax = Number($('fActualPax').value);
        busy(true);
        api('/api/admin/bookings/' + encodeURIComponent(b.id) + '/status', { method: 'POST', body: JSON.stringify(body) })
          .then(function () { busy(false); closeModal(); load(); })
          .catch(function (err) { busy(false); showMMsg(err.message); });
      });
      $('statusActions').appendChild(button);
    });
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
      discoverySourceId: $('fDiscoverySource').value,
      discoveryDetail: $('fDiscoveryDetail').value.trim(),
      revision: editing ? editing.revision : undefined,
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
    var reason = prompt('取消原因 / Cancellation reason');
    if (!reason || !reason.trim()) { busy(false); return; }
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/cancel', { method: 'POST', body: JSON.stringify({ revision: editing.revision, reason: reason.trim() }) })
      .then(function () { busy(false); closeModal(); load(); })
      .catch(function (err) { busy(false); $('mSave').textContent = '儲存'; showMMsg(err.message || '取消失敗。'); });
  });

  $('mClose').addEventListener('click', closeModal);
  $('mask').addEventListener('click', function () { if (!$('mSave').disabled) closeModal(); });
  $('prev').addEventListener('click', function () { load(week.prevMonday); });
  $('next').addEventListener('click', function () { load(week.nextMonday); });
  $('this').addEventListener('click', function () { load(week.thisMonday); });
  $('reload').addEventListener('click', function () { load(); });
  var reportMode = 'calendar';
  function setReportMode(mode) {
    reportMode = mode;
    var visible = mode === 'overview' || mode === 'analytics';
    $('reportPanel').hidden = !visible;
    $('accountsPanel').hidden = mode !== 'accounts';
    $('scroll').style.display = mode === 'calendar' ? 'block' : 'none';
    $('loading').style.display = mode === 'calendar' ? 'block' : 'none';
    $('reportTitle').textContent = mode === 'analytics' ? '數據分析 / Analytics' : '營運總覽 / Overview';
    if (visible) loadReport(); else if (mode === 'accounts') loadAccounts(); else load();
  }
  function reportQuery() {
    var p = new URLSearchParams({ from: $('reportFrom').value, to: $('reportTo').value, basis: $('reportBasis').value });
    if ($('reportStatus').value) p.set('status', $('reportStatus').value);
    return p;
  }
  function putMetric(label, value) {
    var item = document.createElement('div'); item.className = 'metric';
    var caption = document.createElement('span'); caption.textContent = label;
    var number = document.createElement('strong'); number.textContent = value === null ? '—' : String(value);
    item.append(caption, number); $('metrics').appendChild(item);
  }
  function loadReport() {
    if (!$('reportFrom').value || !$('reportTo').value) return;
    $('reportMessage').textContent = '載入中 / Loading…';
    api('/api/admin/analytics?' + reportQuery().toString()).then(function (data) {
      $('reportMessage').textContent = '清邁時間 / Asia/Bangkok · ' + data.filters.from + ' – ' + data.filters.to;
      $('metrics').replaceChildren();
      [['預約筆數 / Bookings', data.summary.bookings], ['預約人數 / Booked guests', data.summary.booked_guests],
       ['到店筆數 / Checked in', data.summary.checked_in_bookings], ['實際人數 / Actual guests', data.summary.actual_guests],
       ['完成服務 / Completed', data.summary.completed_bookings], ['取消 / Cancelled', data.summary.cancellations],
       ['未到 / No-show', data.summary.no_shows], ['已逾時未處理 / Unresolved', data.summary.overdue_unresolved],
       ['未知來源 / Unknown source', data.summary.unknown_discovery]].forEach(function (pair) { putMetric(pair[0], pair[1]); });
      $('sourceRows').replaceChildren();
      data.discovery.forEach(function (source) {
        var tr = document.createElement('tr');
        [source.label_zh + ' / ' + source.label_en, source.bookings, source.booked_guests, source.checked_in_bookings, source.actual_guests === null ? '—' : source.actual_guests].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        $('sourceRows').appendChild(tr);
      });
      loadReportBookings();
    }).catch(function (err) { $('reportMessage').textContent = err.message; });
  }
  function loadReportBookings() {
    var query = reportQuery(); query.set('search', $('reportSearch').value.trim());
    api('/api/admin/bookings?' + query.toString()).then(function (data) {
      $('bookingRows').replaceChildren();
      $('bookingCount').textContent = data.total + ' 筆結果 / results（顯示前 ' + data.items.length + ' 筆）';
      data.items.forEach(function (b) {
        var tr = document.createElement('tr');
        var link = document.createElement('button'); link.type = 'button'; link.textContent = b.id.slice(0, 8);
        if (role !== 'ANALYST') link.addEventListener('click', function () { showBookingDetail(b.id); });
        else link.disabled = true;
        var idCell = document.createElement('td'); idCell.appendChild(link); tr.appendChild(idCell);
        [b.date + ' ' + b.slot, b.name || '—', b.actual_pax === null ? b.pax + ' / —' : b.pax + ' / ' + b.actual_pax,
          statusLabel(b.status), (b.discovery_zh || '未知') + ' / ' + (b.discovery_en || 'Unknown')].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        $('bookingRows').appendChild(tr);
      });
    }).catch(function (err) { $('bookingCount').textContent = err.message; });
  }
  function showBookingDetail(id) {
    api('/api/admin/bookings/' + encodeURIComponent(id)).then(function (data) {
      var b = data.booking;
      var converted = { id: b.id, name: b.name, pax: b.pax, date: b.date, slot: b.slot, firstTime: b.first_time,
        source: b.source, line: b.line, email: b.email, referral: b.referral, note: b.note, status: b.status,
        revision: b.revision, actualPax: b.actual_pax, discoverySourceId: b.discovery_source_id, discoveryDetail: b.discovery_detail };
      openEdit(converted);
    }).catch(function (err) { $('reportMessage').textContent = err.message; });
  }
  $('overviewTab').addEventListener('click', function () { setReportMode('overview'); });
  $('calendarTab').addEventListener('click', function () { setReportMode('calendar'); });
  $('analyticsTab').addEventListener('click', function () { setReportMode('analytics'); });
  $('accountsTab').addEventListener('click', function () { setReportMode('accounts'); });
  $('reportRefresh').addEventListener('click', loadReport);
  $('searchBookings').addEventListener('click', loadReportBookings);
  function loadAccounts() {
    api('/api/admin/accounts').then(function (data) {
      $('accountRows').replaceChildren();
      data.accounts.forEach(function (account) {
        var tr = document.createElement('tr');
        [account.username, account.display_name, account.role,
          account.active ? '啟用 / Active' : '停用 / Disabled'].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        var cell = document.createElement('td'); var button = document.createElement('button');
        button.type = 'button'; button.textContent = account.active ? '停用 / Disable' : '啟用 / Enable';
        button.addEventListener('click', function () {
          api('/api/admin/accounts/' + encodeURIComponent(account.id), { method: 'PATCH', body: JSON.stringify({ active: !account.active }) })
            .then(function () { loadAccounts(); }).catch(function (err) { $('accountsMessage').textContent = err.message; });
        });
        cell.appendChild(button); tr.appendChild(cell); $('accountRows').appendChild(tr);
      });
    }).catch(function (err) { $('accountsMessage').textContent = err.message; });
  }
  $('createAccount').addEventListener('click', function () {
    var password = $('newPassword').value;
    if (password.length < 16) { $('accountsMessage').textContent = '密碼至少 16 字元 / Password must have at least 16 characters.'; return; }
    var body = { username: $('newUsername').value.trim(), displayName: $('newDisplayName').value.trim(), role: $('newRole').value, password: password };
    $('newPassword').value = '';
    api('/api/admin/accounts', { method: 'POST', body: JSON.stringify(body) })
      .then(function () { $('accountsMessage').textContent = '帳號已建立 / Account created.'; loadAccounts(); })
      .catch(function (err) { $('accountsMessage').textContent = err.message; });
  });
  function loadLineGroups() {
    $('lineStatus').textContent = '讀取中…';
    api('/api/admin/line/groups').then(function (data) {
      $('lineStatus').textContent = (data.webhookReady ? 'Webhook 已設定' : '尚未設定 LINE_CHANNEL_SECRET') +
        ' · ' + (data.pushReady ? '推播金鑰已設定' : '尚未設定 LINE_CHANNEL_ACCESS_TOKEN') +
        ' · ' + (data.selectedGroupId ? '通知群組已設定' : '尚未選定通知群組');
      $('lineGroupList').replaceChildren();
      if (!data.groups.length) { $('lineGroupList').textContent = '尚未收到群組事件。請確認 Bot 已入群、Webhook 已啟用，並在群組傳一則訊息。'; return; }
      data.groups.forEach(function (group) {
        var p = document.createElement('p');
        p.textContent = '群組 ID：' + group.group_id + '（最近收到：' + new Date(group.seen_at).toLocaleString() + '）';
        $('lineGroupList').appendChild(p);
      });
    }).catch(function (err) { $('lineStatus').textContent = err.message; });
  }
  $('lineGroups').addEventListener('click', function () {
    $('linePanel').style.display = $('linePanel').style.display === 'none' ? 'block' : 'none';
    if ($('linePanel').style.display === 'block') loadLineGroups();
  });
  $('lineRefresh').addEventListener('click', loadLineGroups);
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
  function loadDiscoverySources() {
    api('/api/admin/discovery-sources').then(function (data) {
      discoverySources = data.sources;
      $('fDiscoverySource').replaceChildren();
      var empty = document.createElement('option'); empty.value = ''; empty.textContent = '未提供 / Not provided'; $('fDiscoverySource').appendChild(empty);
      data.sources.forEach(function (item) {
        var option = document.createElement('option'); option.value = item.id;
        option.textContent = item.labelZh + ' / ' + item.labelEn + (item.active ? '' : '（已停用 / Inactive）');
        $('fDiscoverySource').appendChild(option);
      });
    }).catch(function (err) { console.error(err.message); });
  }
  api('/api/admin/session').then(function (session) {
    csrfToken = session.csrfToken; role = session.role;
    $('reportFrom').value = session.today; $('reportTo').value = session.today;
    $('accountsTab').hidden = role !== 'ADMIN';
    $('lineGroups').hidden = role !== 'ADMIN';
    ['prev','this','next','reload','calendarTab','addNew'].forEach(function (id) { if (role === 'ANALYST') $(id).hidden = true; });
    if (role === 'ANALYST') setReportMode('analytics'); else { loadDiscoverySources(); load(); }
  })
    .catch(function (err) { $('loading').textContent = err.message; });
