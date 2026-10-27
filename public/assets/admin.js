
  var csrfToken = '';
  var role = 'ADMIN';
  var submission = null;
  var week = null;
  var monday = '';          // 空字串 = 讓後端用本週
  var editing = null;       // null = 新增模式
  var discoverySources = [];
  var reportPage = 1;
  var reportTotal = 0;
  var reportPageSize = 25;
  var manualNotificationPreview = null;
  var calendarView = 'week';
  var calendarDay = '';
  var todayBangkok = '';


  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    if (res.status === 401) { location.replace('/admin/login'); throw new Error('請重新登入 / Sign in again.'); }
    if (!res.ok) { var err = new Error(data.error || '連線失敗，請稍後再試 / Connection failed; try again.'); err.details = data; throw err; }
    return data;
  }

  function load(m) {
    if (m !== undefined) monday = m;
    $('loading').style.display = 'block';
    $('loading').textContent = '載入中 / Loading…';
    api('/api/admin/week' + (monday ? '?monday=' + encodeURIComponent(monday) : ''))
      .then(function (data) { week = data; monday = data.monday; render(); ['prev','this','next','addNew'].forEach(function (id) { $(id).disabled = false; });
        var today = data.days.find(function (d) { return d.isToday; });
        if (today && !$('reportFrom').value) { $('reportFrom').value = today.date; $('reportTo').value = today.date; }
      })
      .catch(function (err) { $('loading').textContent = err.message || '載入失敗 / Loading failed.'; });
  }

  function render() {
    $('range').textContent = calendarView === 'day' ? calendarDay + ' · 日曆 / Day' : week.rangeLabel;
    var visibleDays = week.days.map(function (day, index) { return { day: day, index: index }; })
      .filter(function (entry) { return calendarView !== 'day' || entry.day.date === calendarDay; });
    var html = '<tr><th class="slotcol">時段 / Time slot</th>';
    visibleDays.forEach(function (entry) { var d = entry.day;
      html += '<th class="' + (d.isToday ? 'today' : '') + '">' + esc(d.weekday) + ' ' + esc(d.dayLabel) +
        (d.closed ? '（公休 / Closed）' : '') + (d.isToday ? ' ●' : '') + '</th>';
    });
    html += '</tr>';

    week.slotDefs.forEach(function (sd, si) {
      html += '<tr><td class="slotcol">' + (sd.legacy ? '舊時段 ' : '') + esc(sd.slot) + '</td>';
      visibleDays.forEach(function (entry) { var d = entry.day, di = entry.index;
        if (d.closed && d.slots[si].bookings.length === 0) { html += '<td class="closed">公休 / Closed</td>'; return; }
        html += '<td>' + cellHtml(d, d.slots[si], di, si, sd.legacy) + '</td>';
      });
      html += '</tr>';
    });

    $('grid').innerHTML = html;
    $('grid').classList.toggle('day-view', calendarView === 'day');
    $('loading').style.display = 'none';
    $('scroll').style.display = reportMode === 'calendar' ? 'block' : 'none';

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
      head = '<span class="cnt">' + cell.totalPax + ' 人 / guests</span><span class="whole">舊資料超過上限，請調整 / Legacy booking exceeds capacity</span>';
    } else {
      head = '<span class="cnt">' + cell.totalPax + ' / ' + week.maxPax + '</span>' +
        '<span>' + cell.groups + ' 組 / groups</span>' +
        (cell.full ? '<span style="color:var(--err)">已滿 / Full</span>' : '');
    }
    var out = '<div class="cellhead' + (cell.full ? ' full' : '') + '">' + head +
      (!cell.bookable ? '' : '<button class="add" data-d="' + di + '" data-s="' + si + '" title="手動新增 / Add booking">＋</button>') + '</div>';

    if (cell.bookings.length === 0) return out + '<div class="empty">' +
      (cell.groups ? '由重疊的舊時段預約占用 / Occupied by overlapping legacy booking' : '無預約 / No bookings') + '</div>';

    cell.bookings.forEach(function (b, i) {
      var bad = b.mailFailed;
      out += '<div class="chip' + (bad ? ' warn' : '') + '" data-d="' + di + '" data-s="' + si + '" data-i="' + i + '">' +
        '<div class="nm">' + esc(b.name) + ' <span class="cnt">x' + b.pax + '</span><span class="tag">' + esc(statusLabel(b.status)) + '</span>' +
          (b.firstTime === '是' ? '<span class="tag first">初次 / First</span>' : '') +
          (b.source !== 'WEB' ? '<span class="tag">' + esc(sourceLabel(b.source)) + '</span>' : '') +
          (b.mailFailed ? '<span class="tag err">信未寄出 / Email failed</span>' : (b.email && b.mailStatus === 'NOT_REQUESTED' ? '<span class="tag">尚未寄信 / Email not sent</span>' : '')) +
        '</div>' +
        '<div class="meta">' + (b.line ? 'LINE ' + esc(b.line) + ' · ' : '') + esc(b.email || '無 Email / No email') +
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
  function setSlotOptions(selected) {
    var options = week.slotDefs.filter(function (s) { return !s.legacy; }).map(function (s) {
      return new Option(s.slot, s.slot);
    });
    if (week.slotDefs.some(function (s) { return s.legacy && s.slot === selected; })) {
      options.push(new Option('舊時段 / Legacy slot ' + selected, selected));
    }
    $('fSlot').replaceChildren(...options);
    $('fSlot').value = selected || (options[0] && options[0].value) || '';
  }

  function openModal() {
    $('mMsg').className = 'mmsg';
    submission = null;
    $('mSave').textContent = '儲存 / Save';
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
    setSlotOptions(slot || week.slotDefs[0].slot);
    $('fFirst').value = '否';
    $('fSource').value = 'WALK_IN';
    $('fLine').value = '';
    $('fEmail').value = '';
    $('fReferral').value = '';
    $('fDiscoverySource').value = '';
    $('fDiscoveryDetail').value = '';
    $('fNote').value = '';
    $('fEditReason').value = '';
    $('fSendMail').checked = false;
    $('mailChk').style.display = 'flex';
    $('fSource').disabled = false;
    $('mCancelBooking').style.display = 'none';
    $('mResend').style.display = 'none';
    $('statusPanel').style.display = 'none';
    $('correctionPanel').hidden = true;
    $('bookingDetailPanel').hidden = true;
    openModal();
  }

  function openEdit(b, detail) {
    editing = b;
    $('mTitle').textContent = '編輯預約 / Edit booking · ' + b.name;
    $('fId').value = b.id;
    $('fName').value = b.name;
    $('fDate').value = b.date;
    $('fPax').value = b.pax;
    setSlotOptions(b.slot);
    $('fFirst').value = b.firstTime === '是' ? '是' : '否';
    $('fSource').value = b.source || 'WEB';
    $('fSource').disabled = true;
    $('fLine').value = b.line;
    $('fEmail').value = b.email;
    $('fReferral').value = b.referral || '';
    $('fDiscoverySource').value = b.discoverySourceId || '';
    $('fDiscoveryDetail').value = b.discoveryDetail || '';
    $('fNote').value = b.note;
    $('fEditReason').value = '';
    $('mailChk').style.display = 'none';
    $('mCancelBooking').style.display = ['PENDING', 'CONFIRMED'].includes(b.status) ? 'inline-block' : 'none';
    $('mResend').style.display = b.email ? 'inline-block' : 'none';
    $('statusPanel').style.display = 'block';
    $('statusCurrent').textContent = '目前狀態 / Current status: ' + statusLabel(b.status);
    $('fActualPax').value = b.actualPax === null || b.actualPax === undefined ? b.pax : b.actualPax;
    $('fStatusReason').value = '';
    renderStatusActions(b);
    var correctionTargets = { CHECKED_IN: ['CONFIRMED'], COMPLETED: ['CHECKED_IN'],
      CANCELLED: ['CONFIRMED', 'CHECKED_IN'], NO_SHOW: ['CONFIRMED', 'CHECKED_IN'] }[b.status] || [];
    $('correctionPanel').hidden = role !== 'ADMIN' || !correctionTargets.length;
    $('correctionStatus').replaceChildren();
    correctionTargets.forEach(function (target) { $('correctionStatus').appendChild(new Option(statusLabel(target), target)); });
    $('correctionReason').value = '';
    $('bookingDetailPanel').hidden = false;
    $('manualNotificationPanel').hidden = role !== 'ADMIN';
    $('manualNotificationRecipient').textContent = '';
    $('manualNotificationText').textContent = '';
    $('sendManualNotification').disabled = true;
    manualNotificationPreview = null;
    $('bookingNotifications').textContent = '載入中 / Loading…';
    $('bookingHistory').textContent = '載入中 / Loading…';
    $('fAdministrationReason').value = '';
    openModal();
    if (detail) renderBookingExtras(detail);
    else api('/api/admin/bookings/' + encodeURIComponent(b.id)).then(renderBookingExtras)
      .catch(function (err) { $('bookingHistory').textContent = err.message; });
  }

  function formatBangkok(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  }
  function renderBookingExtras(data) {
    if (!editing || editing.id !== data.booking.id) return;
    $('fInternalNote').value = data.booking.internal_note || '';
    Promise.all([api('/api/admin/assignees')]).then(function (results) {
      if (!editing || editing.id !== data.booking.id) return;
      $('fAssignee').replaceChildren(new Option('未指派 / Unassigned', ''));
      results[0].items.forEach(function (person) {
        $('fAssignee').appendChild(new Option(person.display_name + ' / ' + person.role, person.id));
      });
      $('fAssignee').value = data.booking.assigned_staff_id || '';
    }).catch(function (err) { $('bookingHistory').textContent = err.message; });
    $('bookingNotifications').replaceChildren();
    if (!data.notifications.length) $('bookingNotifications').textContent = '尚無通知紀錄 / No notification records.';
    var kindLabel = { LINE_GROUP: 'LINE 群組 / Staff group', CUSTOMER_EMAIL: '客人 Email / Customer email' };
    data.notifications.forEach(function (n) {
      var row = document.createElement('p');
      row.textContent = formatBangkok(n.attempted_at || n.scheduled_at) + ' · ' + (kindLabel[n.recipient_kind] || n.recipient_kind) + ' · ' + n.event_type + ' · ' +
        n.status + ' · ' + n.attempt_count + ' 次嘗試 / attempts' +
        (n.failure_reason ? ' · ' + n.failure_reason : '');
      $('bookingNotifications').appendChild(row);
    });
    $('bookingHistory').replaceChildren();
    if (!data.history.length) $('bookingHistory').textContent = '尚無異動紀錄 / No change records.';
    data.history.forEach(function (event) {
      var row = document.createElement('p');
      row.textContent = formatBangkok(event.created_at) + ' · ' + event.event_type + ' · ' +
        (event.actor_name || event.actor_type) +
        (event.reason ? ' · ' + event.reason : '');
      $('bookingHistory').appendChild(row);
    });
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
        // 留空代表依預約人數報到，交給後端決定；不要送出 null。
        if (target === 'CHECKED_IN' && $('fActualPax').value !== '') body.actualPax = Number($('fActualPax').value);
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
      changeReason: $('fEditReason').value.trim(),
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
    if (on) $('mSave').textContent = '處理中 / Saving…';
  }

  $('mSave').addEventListener('click', function () {
    var p = payload();
    if (!p.name) return showMMsg('請填寫預約人 / Enter the booking contact.');
    if (!p.date) return showMMsg('請選擇日期 / Select a visit date.');
    if (!p.email) return showMMsg('請填寫 Email，確認信會寄到這個信箱 / Enter an email address for confirmation.');
    if (editing && !p.changeReason) return showMMsg('請填寫修改原因 / A change reason is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return showMMsg('請填寫正確的 Email / Enter a valid email address.');
    if (!Number.isInteger(p.pax) || p.pax < 1 || p.pax > 12) return showMMsg('人數請填 1 至 12 的整數 / Guests must be a whole number from 1 to 12.');
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
      $('mSave').textContent = '儲存 / Save';
      showMMsg(err.message || '操作失敗 / Action failed.');

    });
  });

  $('mCancelBooking').addEventListener('click', function () {
    if (!editing) return;
    if (!confirm('確定要取消「' + editing.name + ' x' + editing.pax + '人」的預約嗎？系統會寄取消通知給客人並推播工作群組。\nCancel this booking? The customer will receive a cancellation email and the staff group will be notified.')) return;
    busy(true);
    var reason = prompt('取消原因 / Cancellation reason');
    if (!reason || !reason.trim()) { busy(false); return; }
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/cancel', { method: 'POST', body: JSON.stringify({ revision: editing.revision, reason: reason.trim() }) })
      .then(function () { busy(false); closeModal(); load(); })
      .catch(function (err) { busy(false); $('mSave').textContent = '儲存 / Save'; showMMsg(err.message || '取消失敗 / Cancellation failed.'); });
  });

  $('mClose').addEventListener('click', closeModal);
  $('mask').addEventListener('click', function () { if (!$('mSave').disabled) closeModal(); });
  function shiftDay(days) {
    var date = new Date(calendarDay + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + days);
    calendarDay = date.toISOString().slice(0, 10);
    $('calendarDate').value = calendarDay; load(calendarDay);
  }
  $('prev').addEventListener('click', function () { if (calendarView === 'day') shiftDay(-1); else load(week.prevMonday); });
  $('next').addEventListener('click', function () { if (calendarView === 'day') shiftDay(1); else load(week.nextMonday); });
  $('this').addEventListener('click', function () {
    if (calendarView === 'day') { calendarDay = todayBangkok; $('calendarDate').value = calendarDay; load(calendarDay); }
    else load(week.thisMonday);
  });
  $('reload').addEventListener('click', function () { if (calendarView === 'month') loadMonth(); else load(calendarView === 'day' ? calendarDay : undefined); });
  $('calendarDayView').addEventListener('click', function () {
    calendarView = 'day'; calendarDay = $('calendarDate').value || $('reportFrom').value;
    $('calendarDate').value = calendarDay; setReportMode('calendar');
  });
  $('calendarWeekView').addEventListener('click', function () { calendarView = 'week'; setReportMode('calendar'); });
  $('calendarMonthView').addEventListener('click', function () {
    calendarView = 'month'; $('calendarMonthInput').value = $('calendarMonthInput').value || $('reportFrom').value.slice(0, 7);
    setReportMode('calendar');
  });
  $('calendarDate').addEventListener('change', function () {
    calendarDay = $('calendarDate').value; calendarView = 'day'; setReportMode('calendar');
  });
  $('calendarMonthInput').addEventListener('change', function () { calendarView = 'month'; setReportMode('calendar'); });
  var reportMode = 'calendar';
  function setReportMode(mode) {
    reportMode = mode;
    var visible = mode === 'analytics';
    $('reportPanel').hidden = !visible;
    $('overviewPanel').hidden = mode !== 'overview';
    $('accountsPanel').hidden = mode !== 'accounts';
    $('availabilityPanel').hidden = mode !== 'availability';
    $('sourcesPanel').hidden = mode !== 'sources';
    $('customersPanel').hidden = mode !== 'customers';
    $('notificationsPanel').hidden = mode !== 'notifications';
    $('calendarControls').hidden = mode !== 'calendar' || role === 'ANALYST';
    $('monthGrid').hidden = mode !== 'calendar' || calendarView !== 'month';
    ['prev','next','this'].forEach(function (id) { $(id).hidden = role === 'ANALYST' || (mode === 'calendar' && calendarView === 'month'); });
    $('scroll').style.display = mode === 'calendar' ? 'block' : 'none';
    $('loading').style.display = mode === 'calendar' ? 'block' : 'none';
    $('reportTitle').textContent = mode === 'analytics' ? '數據分析 / Analytics' : '營運總覽 / Overview';
    if (visible) loadReport(); else if (mode === 'overview') loadOverview(); else if (mode === 'accounts') loadAccounts(); else if (mode === 'availability') loadAvailability(); else if (mode === 'sources') loadSourceOptions(); else if (mode === 'customers') loadCustomers(); else if (mode === 'notifications') loadNotifications(); else if (calendarView === 'month') loadMonth(); else load(calendarView === 'day' ? calendarDay : undefined);
  }
  function loadMonth() {
    var month = $('calendarMonthInput').value;
    $('loading').style.display = 'block'; $('loading').textContent = '載入月份 / Loading month…';
    $('scroll').style.display = 'none'; $('monthGrid').hidden = false;
    api('/api/admin/calendar?month=' + encodeURIComponent(month)).then(function (data) {
      $('loading').style.display = 'none'; $('range').textContent = month + ' · 月曆 / Month';
      var grid = $('monthGrid'); grid.replaceChildren();
      ['一 / Mon','二 / Tue','三 / Wed','四 / Thu','五 / Fri','六 / Sat','日 / Sun'].forEach(function (label) {
        var head = document.createElement('div'); head.className = 'weekday'; head.textContent = label; grid.appendChild(head);
      });
      var offset = (new Date(data.first + 'T00:00:00Z').getUTCDay() + 6) % 7;
      for (var blank = 0; blank < offset; blank++) {
        var spacer = document.createElement('div'); spacer.className = 'blank'; grid.appendChild(spacer);
      }
      var byDate = new Map(data.days.map(function (item) { return [item.date, item]; }));
      var count = Number(data.last.slice(8));
      for (var day = 1; day <= count; day++) {
        var date = month + '-' + String(day).padStart(2, '0');
        var item = byDate.get(date);
        var button = document.createElement('button'); button.type = 'button'; button.className = 'day';
        var number = document.createElement('strong'); number.textContent = day;
        var summary = document.createElement('span'); summary.textContent = item
          ? item.active_bookings + ' 筆 / bookings · ' + item.booked_guests + ' 人 / guests'
          : '0 筆 / bookings';
        button.append(number, summary);
        button.addEventListener('click', (function (selected) { return function () {
          calendarDay = selected; $('calendarDate').value = selected; calendarView = 'day';
          $('monthGrid').hidden = true; setReportMode('calendar');
        }; })(date));
        grid.appendChild(button);
      }
    }).catch(function (err) { $('loading').textContent = err.message; });
  }
  function loadOverview() {
    $('overviewMessage').textContent = '載入中 / Loading…';
    api('/api/admin/overview').then(function (data) {
      $('overviewMessage').textContent = data.date + ' · 清邁時間 / Asia/Bangkok';
      $('overviewMetrics').replaceChildren();
      [['有效預約 / Active bookings', data.metrics.active_bookings], ['預約人數 / Booked guests', data.metrics.booked_guests],
        ['實際到店人數 / Actual guests', data.metrics.actual_guests], ['待確認 / Pending', data.metrics.pending],
        ['兩小時內到店 / Upcoming in two hours', data.metrics.upcoming],
        ['逾時未處理 / Overdue unresolved', data.metrics.overdue_unresolved],
        ['未填實際人數 / Missing actual guests', data.metrics.missing_actual_guests],
        ['已報到未結案 / Checked in, unfinished', data.metrics.unfinished],
        ['LINE 通知失敗 / LINE failures', data.metrics.line_failures],
        ['剩餘可預約名額 / Places left', data.remaining_bookable_places]
      ].forEach(function (pair) {
        var card = document.createElement('div'); card.className = 'metric';
        var caption = document.createElement('span'); caption.textContent = pair[0];
        var count = document.createElement('strong'); count.textContent = pair[1];
        card.append(caption, count); $('overviewMetrics').appendChild(card);
      });
      $('overviewCapacityNote').textContent = data.capacity_note;
      $('overviewSlots').replaceChildren();
      data.slots.forEach(function (slot) {
        var row = document.createElement('tr');
        [slot.slot, slot.status, slot.remaining].forEach(function (value) {
          var cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
        });
        $('overviewSlots').appendChild(row);
      });
    }).catch(function (err) { $('overviewMessage').textContent = err.message; });
  }
  function reportQuery() {
    var p = new URLSearchParams({ from: $('reportFrom').value, to: $('reportTo').value,
      basis: $('reportBasis').value, trendGroup: $('trendGroup').value });
    if ($('reportStatus').value) p.set('status', $('reportStatus').value);
    if ($('reportDiscovery').value) p.set('discovery', $('reportDiscovery').value);
    if ($('reportSlot').value.trim()) p.set('slot', $('reportSlot').value.trim());
    if ($('reportTracking').value.trim()) p.set('trackingSource', $('reportTracking').value.trim());
    if ($('reportAssignee').value) p.set('assignedStaffId', $('reportAssignee').value);
    if ($('reportVisitHistory').value) p.set('visitHistory', $('reportVisitHistory').value);
    if ($('reportFailed').checked) p.set('notificationFailed', 'true');
    return p;
  }
  function putMetric(label, value) {
    var item = document.createElement('div'); item.className = 'metric';
    var caption = document.createElement('span'); caption.textContent = label;
    var number = document.createElement('strong'); number.textContent = value === null ? '—' : String(value);
    item.append(caption, number); $('metrics').appendChild(item);
  }
  function percentWithCounts(rate, numerator, denominator) {
    return rate === null ? '—' : (rate * 100).toFixed(1) + '% (' + numerator + '/' + denominator + ')';
  }
  function loadReport() {
    if (!$('reportFrom').value || !$('reportTo').value) return;
    reportPage = 1;
    $('reportMessage').textContent = '載入中 / Loading…';
    api('/api/admin/analytics?' + reportQuery().toString()).then(function (data) {
      $('reportMessage').textContent = '清邁時間 / Asia/Bangkok · ' + data.filters.from + ' – ' + data.filters.to;
      $('metrics').replaceChildren();
      [['預約筆數 / Bookings', data.summary.bookings], ['預約人數 / Booked guests', data.summary.booked_guests],
       ['到店筆數 / Checked in', data.summary.checked_in_bookings], ['實際人數 / Actual guests', data.summary.actual_guests],
       ['完成服務 / Completed', data.summary.completed_bookings], ['取消 / Cancelled', data.summary.cancellations],
       ['未到 / No-show', data.summary.no_shows], ['已逾時未處理 / Unresolved', data.summary.overdue_unresolved],
       ['未知來源 / Unknown source', data.summary.unknown_discovery],
       ['首次記錄到店 / First recorded visitors', data.summary.first_recorded_visitors],
       ['回訪預約者 / Returning visitors', data.summary.returning_visitors],
       ['取消率 / Cancellation rate', data.summary.cancellation_rate === null ? null : (data.summary.cancellation_rate * 100).toFixed(1) + '% (' + data.summary.cancelled_due + '/' + data.summary.decided_due + ')'],
       ['未到率 / No-show rate', data.summary.no_show_rate === null ? null : (data.summary.no_show_rate * 100).toFixed(1) + '% (' + data.summary.no_show_due + '/' + data.summary.attendance_due + ')'],
       ['平均每筆人數 / Average party size', data.summary.average_party_size === null ? null : data.summary.average_party_size.toFixed(2)]
      ].forEach(function (pair) { putMetric(pair[0], pair[1]); });
      $('previousComparison').textContent = '前一相同長度期間 / Previous equal period: ' + data.previous.from + ' – ' + data.previous.to +
        ' · 預約 / Bookings ' + data.previous.summary.bookings + ' · 人數 / Guests ' + data.previous.summary.booked_guests +
        '。取消率分母為已到期且結果明確的預約；未到率排除取消。 / Rates include due, decided bookings only; no-show rate excludes cancellations.';
      $('bookingTrend').replaceChildren();
      var maximum = Math.max(1, ...data.trend.map(function (item) { return item.bookings; }));
      if (!data.trend.length) $('bookingTrend').textContent = '此區間沒有資料 / No data in this period.';
      data.trend.forEach(function (item) {
        var row = document.createElement('div'); row.className = 'trend-row';
        var day = document.createElement('span'); day.textContent = item.day.slice(0, 10);
        var track = document.createElement('div'); track.className = 'trend-track';
        var bar = document.createElement('div'); bar.className = 'trend-bar';
        bar.style.width = Math.max(2, item.bookings / maximum * 100) + '%'; track.appendChild(bar);
        var count = document.createElement('span'); count.textContent = item.bookings + ' 筆 / orders';
        row.append(day, track, count); $('bookingTrend').appendChild(row);
      });
      $('sourceRows').replaceChildren();
      data.discovery.forEach(function (source) {
        var tr = document.createElement('tr');
        [source.label_zh + ' / ' + source.label_en, source.bookings,
          percentWithCounts(source.share, source.bookings, data.summary.bookings), source.booked_guests,
          source.checked_in_bookings, source.actual_guests === null ? '—' : source.actual_guests,
          percentWithCounts(source.cancellation_rate, source.cancelled_due, source.decided_due),
          percentWithCounts(source.no_show_rate, source.no_show_due, source.attendance_due)].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        $('sourceRows').appendChild(tr);
      });
      $('entryRows').replaceChildren();
      data.entries.forEach(function (entry) {
        var tr = document.createElement('tr');
        [entry.source, entry.bookings, entry.booked_guests].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        $('entryRows').appendChild(tr);
      });
      $('trackingRows').replaceChildren();
      data.tracked.forEach(function (item) {
        var tr = document.createElement('tr');
        [item.source + ' / ' + item.medium + ' / ' + item.campaign + ' / ' + item.code,
          item.bookings, percentWithCounts(item.share, item.bookings, data.summary.bookings),
          item.booked_guests, item.checked_in_bookings,
          percentWithCounts(item.cancellation_rate, item.cancelled_due, item.decided_due),
          percentWithCounts(item.no_show_rate, item.no_show_due, item.attendance_due)].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        $('trackingRows').appendChild(tr);
      });
      $('cohortDefinition').textContent = data.cohorts.definition + ' 日期固定使用到店日 / Cohorts always use visit date.';
      $('cohortRows').replaceChildren();
      function cohortRate(row, days) {
        var denominator = row['eligible_' + days];
        return denominator ? (row['returned_' + days] / denominator * 100).toFixed(1) + '% (' + row['returned_' + days] + '/' + denominator + ')' : '—';
      }
      if (!data.cohorts.rows.length) {
        var empty = document.createElement('tr'), cell = document.createElement('td');
        cell.colSpan = 6; cell.textContent = '此區間沒有已報到的預約聯絡人 / No checked-in booking contacts in this period.';
        empty.appendChild(cell); $('cohortRows').appendChild(empty);
      }
      data.cohorts.rows.forEach(function (cohort) {
        var tr = document.createElement('tr');
        [cohort.cohort_month.slice(0, 7), cohort.first_recorded, cohortRate(cohort, 30), cohortRate(cohort, 60),
          cohortRate(cohort, 90), cohort.average_return_days === null ? '—' : cohort.average_return_days].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        $('cohortRows').appendChild(tr);
      });
      $('operationsDefinition').textContent = data.operations.definition;
      var heat = $('heatmapTable'); heat.replaceChildren();
      var times = Array.from(new Set(data.operations.heatmap.map(function (x) { return x.start_time; }))).sort();
      var header = document.createElement('tr');
      ['星期 / Day'].concat(times).forEach(function (value) { var th = document.createElement('th'); th.textContent = value; header.appendChild(th); });
      heat.appendChild(header);
      var peak = Math.max(1, ...data.operations.heatmap.map(function (x) { return x.bookings; }));
      var weekdays = ['週一 / Mon','週二 / Tue','週三 / Wed','週四 / Thu','週五 / Fri','週六 / Sat','週日 / Sun'];
      weekdays.forEach(function (label, dayIndex) {
        var row = document.createElement('tr'), head = document.createElement('th'); head.textContent = label; row.appendChild(head);
        times.forEach(function (time) {
          var record = data.operations.heatmap.find(function (x) { return x.weekday === dayIndex + 1 && x.start_time === time; });
          var cell = document.createElement('td'); var count = record ? record.bookings : 0;
          cell.textContent = count + ' 筆 / bookings' + (record?.no_shows ? ' · ' + record.no_shows + ' 未到 / no-show' : '');
          cell.style.background = 'rgba(198,170,120,' + (count ? (0.12 + count / peak * 0.4).toFixed(2) : '0') + ')';
          row.appendChild(cell);
        }); heat.appendChild(row);
      });
      $('partyRows').replaceChildren();
      data.operations.partySize.forEach(function (item) {
        var row = document.createElement('tr'); [item.group_size, item.bookings, item.booked_guests].forEach(function (value) {
          var cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
        }); $('partyRows').appendChild(row);
      });
      $('leadRows').replaceChildren();
      var leadLabels = { BACKDATED: '後台補登過去日期 / Backdated', SAME_DAY: '當日 / Same day',
        '1-3': '1–3 天 / days', '4-7': '4–7 天 / days', '8+': '8 天以上 / 8+ days' };
      data.operations.leadTime.forEach(function (item) {
        var row = document.createElement('tr'); [leadLabels[item.lead_bucket] || item.lead_bucket,
          item.bookings + (item.no_shows ? '（未到 ' + item.no_shows + ' / no-show）' : '')].forEach(function (value) {
          var cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
        }); $('leadRows').appendChild(row);
      });
      $('rescheduleSummary').textContent = '改期事件 / Reschedule events: ' + data.operations.reschedules.events +
        '；涉及預約 / Changed bookings: ' + data.operations.reschedules.changed_bookings;
      $('cancellationRows').replaceChildren();
      if (role === 'ANALYST') {
        var restrictedRow = document.createElement('tr'), restricted = document.createElement('td');
        restricted.colSpan = 2; restricted.textContent = '取消原因可能包含個資，唯讀分析角色不顯示。 / Cancellation notes may contain personal data and are hidden from analysts.';
        restrictedRow.appendChild(restricted); $('cancellationRows').appendChild(restrictedRow);
      }
      data.operations.cancellationReasons.forEach(function (item) {
        var row = document.createElement('tr'); [item.reason, item.bookings].forEach(function (value) {
          var cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
        }); $('cancellationRows').appendChild(row);
      });
      $('cancellationTimingRows').replaceChildren();
      var cancellationLabels = { UNKNOWN: '未知 / Unknown', AFTER_VISIT_DATE: '到店日後 / After visit date',
        SAME_DAY: '當日 / Same day', '1-3': '提前 1–3 天 / 1–3 days', '4+': '提前 4 天以上 / 4+ days' };
      data.operations.cancellationTiming.forEach(function (item) {
        var row = document.createElement('tr'); [cancellationLabels[item.lead_bucket] || item.lead_bucket, item.bookings].forEach(function (value) {
          var cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
        }); $('cancellationTimingRows').appendChild(row);
      });
      $('noShowSourceRows').replaceChildren();
      data.operations.noShowSources.forEach(function (item) {
        var row = document.createElement('tr'); [item.label_zh + ' / ' + item.label_en, item.no_shows].forEach(function (value) {
          var cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
        }); $('noShowSourceRows').appendChild(row);
      });
      loadReportBookings();
    }).catch(function (err) { $('reportMessage').textContent = err.message; });
  }
  function loadReportBookings() {
    var query = reportQuery(); query.set('search', $('reportSearch').value.trim());
    query.set('sort', $('reportSort').value); query.set('page', String(reportPage));
    api('/api/admin/bookings?' + query.toString()).then(function (data) {
      $('bookingRows').replaceChildren();
      reportTotal = data.total;
      reportPageSize = data.pageSize || reportPageSize;
      $('bookingCount').textContent = data.total + ' 筆結果 / results · 第 ' + data.page + ' 頁 / page';
      $('bookingPrevious').disabled = reportPage <= 1;
      $('bookingNext').disabled = reportPage * data.pageSize >= reportTotal;
      data.items.forEach(function (b) {
        var tr = document.createElement('tr');
        var link = document.createElement('button'); link.type = 'button'; link.textContent = b.id.slice(0, 8);
        if (role !== 'ANALYST') link.addEventListener('click', function () { showBookingDetail(b.id); });
        else link.disabled = true;
        var idCell = document.createElement('td'); idCell.appendChild(link); tr.appendChild(idCell);
        [b.date + ' ' + b.slot, b.name || '—', b.actual_pax === null ? b.pax + ' / —' : b.pax + ' / ' + b.actual_pax,
          statusLabel(b.status), (b.discovery_zh || '未知') + ' / ' + (b.discovery_en || 'Unknown'),
          b.line_notification_status || '未排程 / Not scheduled', b.assigned_staff_name || '未指派 / Unassigned'].forEach(function (value) {
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
      openEdit(converted, data);
    }).catch(function (err) { $('reportMessage').textContent = err.message; });
  }
  $('overviewTab').addEventListener('click', function () { setReportMode('overview'); });
  $('overviewBookings').addEventListener('click', function () { setReportMode('analytics'); });
  $('calendarTab').addEventListener('click', function () { setReportMode('calendar'); });
  $('analyticsTab').addEventListener('click', function () { setReportMode('analytics'); });
  $('accountsTab').addEventListener('click', function () { setReportMode('accounts'); });
  $('availabilityTab').addEventListener('click', function () { setReportMode('availability'); });
  $('sourcesTab').addEventListener('click', function () { setReportMode('sources'); });
  $('customersTab').addEventListener('click', function () { setReportMode('customers'); });
  $('notificationsTab').addEventListener('click', function () { setReportMode('notifications'); });
  $('reportRefresh').addEventListener('click', loadReport);
  $('searchBookings').addEventListener('click', function () { reportPage = 1; loadReportBookings(); });
  $('bookingPrevious').addEventListener('click', function () { if (reportPage > 1) { reportPage--; loadReportBookings(); } });
  $('bookingNext').addEventListener('click', function () { if (reportPage * reportPageSize < reportTotal) { reportPage++; loadReportBookings(); } });
  $('saveAdministration').addEventListener('click', function () {
    if (!editing) return;
    var reason = $('fAdministrationReason').value.trim();
    if (!reason) return showMMsg('請填寫變更原因 / A change reason is required.');
    $('saveAdministration').disabled = true;
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/administration', {
      method: 'PATCH', body: JSON.stringify({ revision: editing.revision, assignedStaffId: $('fAssignee').value,
        internalNote: $('fInternalNote').value.trim(), reason: reason })
    }).then(function () {
      $('saveAdministration').disabled = false;
      closeModal(); load();
    }).catch(function (err) { $('saveAdministration').disabled = false; showMMsg(err.message); });
  });
  $('saveCorrection').addEventListener('click', function () {
    if (!editing || role !== 'ADMIN') return;
    var reason = $('correctionReason').value.trim();
    if (!reason) return showMMsg('請填寫更正原因 / A correction reason is required.');
    var status = $('correctionStatus').value;
    if (!confirm('確定將此預約更正為「' + statusLabel(status) + '」？原狀態會保留在異動歷程。\nCorrect this booking to "' + statusLabel(status) + '"? The previous status stays in the change history.')) return;
    $('saveCorrection').disabled = true;
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/correct-status', { method: 'POST',
      body: JSON.stringify({ revision: editing.revision, status: status,
        actualPax: status === 'CHECKED_IN' && $('fActualPax').value !== '' ? Number($('fActualPax').value) : undefined, reason: reason }) })
      .then(function () { $('saveCorrection').disabled = false; closeModal(); load(); })
      .catch(function (err) { $('saveCorrection').disabled = false; showMMsg(err.message); });
  });
  $('manualNotificationType').addEventListener('change', function () {
    manualNotificationPreview = null;
    $('manualNotificationRecipient').textContent = '';
    $('manualNotificationText').textContent = '';
    $('sendManualNotification').disabled = true;
  });
  $('previewManualNotification').addEventListener('click', function () {
    if (!editing || role !== 'ADMIN') return;
    var eventType = $('manualNotificationType').value;
    $('manualNotificationRecipient').textContent = '載入預覽 / Loading preview…';
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/notification-preview?eventType=' + encodeURIComponent(eventType))
      .then(function (data) {
        manualNotificationPreview = { bookingId: editing.id, eventType: eventType,
          requestId: crypto.randomUUID(), recipientId: data.recipientId };
        $('manualNotificationRecipient').textContent = '發送至 / Recipient: ' + (data.recipientId || '未設定 / Not configured') +
          (data.enabled ? '' : ' · 已停用 / Disabled') + (data.eligible ? '' : ' · 與目前狀態不符 / Not eligible');
        $('manualNotificationText').textContent = data.message;
        $('sendManualNotification').disabled = !data.enabled || !data.configured || !data.eligible;
      }).catch(function (err) { $('manualNotificationRecipient').textContent = err.message; });
  });
  $('sendManualNotification').addEventListener('click', function () {
    var preview = manualNotificationPreview;
    if (!preview || !editing || preview.bookingId !== editing.id || preview.eventType !== $('manualNotificationType').value) return;
    if (!confirm('確定要把上方預覽訊息送到工作群組 ' + preview.recipientId + '？\nSend this message to the staff group?')) return;
    $('sendManualNotification').disabled = true;
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/resend-notification', {
      method: 'POST', body: JSON.stringify({ eventType: preview.eventType, requestId: preview.requestId })
    }).then(function (result) {
      $('manualNotificationRecipient').textContent = '已排程 / Queued · ' + result.status + '；API 接受不代表送達 / API acceptance does not prove delivery.';
      manualNotificationPreview = null;
    }).catch(function (err) { $('manualNotificationRecipient').textContent = err.message; $('sendManualNotification').disabled = false; });
  });
  $('exportBookings').addEventListener('click', async function () {
    var query = reportQuery(); query.set('search', $('reportSearch').value.trim());
    $('reportMessage').textContent = '正在匯出 / Preparing export…';
    try {
      var res = await fetch('/api/admin/bookings.csv?' + query.toString(), {
        credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken }
      });
      if (res.status === 401) { location.replace('/admin/login'); return; }
      if (!res.ok) {
        var error = await res.json(); throw new Error(error.error || '匯出失敗 / Export failed.');
      }
      var url = URL.createObjectURL(await res.blob());
      var link = document.createElement('a'); link.href = url; link.download = 'chiangmai-bookings.csv';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      $('reportMessage').textContent = 'CSV 已下載 / CSV downloaded.';
    } catch (err) { $('reportMessage').textContent = err.message; }
  });
  $('exportAnalytics').addEventListener('click', async function () {
    $('reportMessage').textContent = '正在匯出分析 / Preparing analytics export…';
    try {
      var res = await fetch('/api/admin/analytics.csv?' + reportQuery().toString(), {
        credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken }
      });
      if (res.status === 401) { location.replace('/admin/login'); return; }
      if (!res.ok) { var error = await res.json(); throw new Error(error.error || '匯出失敗 / Export failed.'); }
      var url = URL.createObjectURL(await res.blob());
      var link = document.createElement('a'); link.href = url; link.download = 'chiangmai-analytics.csv';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      $('reportMessage').textContent = '分析 CSV 已下載 / Analytics CSV downloaded.';
    } catch (err) { $('reportMessage').textContent = err.message; }
  });
  function loadNotifications() {
    $('notificationMessage').textContent = '載入中 / Loading…';
    api('/api/admin/notification-settings').then(function (data) {
      $('notificationMessage').textContent = '';
      $('notificationVariables').textContent = '可用變數 / Available variables: ' + data.variables.map(function (v) { return '{{' + v + '}}'; }).join('  ');
      $('notificationSettings').replaceChildren();
      var titles = { BOOKING_CONFIRMED: '預約確認 / Booking confirmed', BOOKING_UPDATED: '預約修改 / Booking updated',
        BOOKING_CANCELLED: '預約取消 / Booking cancelled', REMINDER: '行前提醒 / Reminder' };
      data.items.forEach(function (item) {
        var card = document.createElement('div'); card.className = 'metric'; card.style.marginBottom = '18px';
        var title = document.createElement('h3'); title.textContent = titles[item.event_type] || item.event_type; card.appendChild(title);
        var toggleLabel = document.createElement('label'); toggleLabel.className = 'chk';
        var toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = item.enabled;
        toggleLabel.append(toggle, document.createTextNode('啟用 / Enabled')); card.appendChild(toggleLabel);
        function field(labelText, value) {
          var label = document.createElement('label'); label.textContent = labelText; label.style.display = 'grid'; label.style.gap = '6px'; label.style.margin = '12px 0';
          var box = document.createElement('textarea'); box.rows = 5; box.maxLength = 2000; box.value = value;
          box.style.width = '100%'; box.style.background = 'var(--card2)'; box.style.color = 'var(--text)'; box.style.padding = '10px';
          label.appendChild(box); card.appendChild(label); return box;
        }
        var zh = field('繁體中文範本 / Chinese template', item.template_zh);
        var en = field('英文範本 / English template', item.template_en);
        var minutes = document.createElement('input'); minutes.type = 'number'; minutes.min = 30; minutes.max = 10080;
        minutes.value = item.reminder_minutes; minutes.style.width = '100px';
        if (item.event_type === 'REMINDER') {
          var lead = document.createElement('label'); lead.textContent = '提前分鐘 / Minutes before visit: '; lead.appendChild(minutes); card.appendChild(lead);
        }
        var preview = document.createElement('pre'); preview.style.whiteSpace = 'pre-wrap'; preview.style.overflowWrap = 'anywhere';
        var previewButton = document.createElement('button'); previewButton.type = 'button'; previewButton.textContent = '預覽 / Preview';
        previewButton.addEventListener('click', function () {
          api('/api/admin/notification-settings/' + item.event_type + '/preview', { method: 'POST',
            body: JSON.stringify({ templateZh: zh.value, templateEn: en.value }) })
            .then(function (result) { preview.textContent = result.preview; })
            .catch(function (err) { preview.textContent = err.message; });
        });
        var save = document.createElement('button'); save.type = 'button'; save.textContent = '儲存範本 / Save template';
        save.addEventListener('click', function () {
          save.disabled = true;
          api('/api/admin/notification-settings/' + item.event_type, { method: 'PUT', body: JSON.stringify({
            enabled: toggle.checked, templateZh: zh.value, templateEn: en.value, reminderMinutes: Number(minutes.value)
          }) }).then(function () { $('notificationMessage').textContent = '通知設定已儲存 / Notification settings saved.'; save.disabled = false; })
            .catch(function (err) { $('notificationMessage').textContent = err.message; save.disabled = false; });
        });
        card.append(previewButton, save, preview); $('notificationSettings').appendChild(card);
      });
    }).catch(function (err) { $('notificationMessage').textContent = err.message; });
  }
  function loadAccounts() {
    api('/api/admin/system-events').then(function (data) {
      $('systemEventRows').replaceChildren();
      data.items.forEach(function (event) {
        var tr = document.createElement('tr');
        [formatBangkok(event.created_at), event.actor_id, event.action, event.target || '—'].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        $('systemEventRows').appendChild(tr);
      });
    }).catch(function (err) { $('accountsMessage').textContent = err.message; });
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
  function loadAvailability() {
    api('/api/admin/availability-settings').then(function (data) {
      var s = data.settings;
      $('settingOpen').value = s.open_time; $('settingClose').value = s.close_time;
      $('settingService').value = s.service_minutes; $('settingInterval').value = s.interval_minutes;
      $('settingCapacity').value = s.max_pax; $('settingCutoff').value = s.cutoff_minutes;
      $('settingAdvance').value = s.max_advance_days === null ? '' : s.max_advance_days;
      $('settingFinish').checked = s.finish_before_close;
      $('closedWeekdays').replaceChildren();
      ['週一 / Mon','週二 / Tue','週三 / Wed','週四 / Thu','週五 / Fri','週六 / Sat','週日 / Sun'].forEach(function (label, index) {
        var box = document.createElement('label'); box.className = 'chk';
        var input = document.createElement('input'); input.type = 'checkbox'; input.value = index + 1;
        input.checked = s.closed_weekdays.includes(index + 1); input.className = 'closed-weekday';
        box.append(input, document.createTextNode('公休 / Closed ' + label)); $('closedWeekdays').appendChild(box);
      });
    }).catch(function (err) { $('availabilityMessage').textContent = err.message; });
    api('/api/admin/availability-exceptions').then(renderExceptionList)
      .catch(function (err) { $('availabilityMessage').textContent = err.message; });
  }
  function renderExceptionList(data) {
    var table = $('exceptionList');
    table.replaceChildren();
    var head = document.createElement('tr');
    ['類型 / Type', '日期 / Date', '時段 / Slot', '狀態 / State', '容量 / Capacity', '原因 / Reason'].forEach(function (text) {
      var th = document.createElement('th'); th.textContent = text; head.appendChild(th);
    });
    table.appendChild(head);
    var items = (data.exceptions || []).map(function (row) {
      var hours = (row.open_time || row.close_time) ? (row.open_time || '') + '–' + (row.close_time || '') : '';
      return { kind: 'date', row: row, cells: ['日期 / Date', row.date, '',
        row.closed ? '停開 / Closed' : (hours ? '特殊時間 ' + hours + ' / Special hours' : '營業 / Open'),
        row.max_pax === null ? '' : String(row.max_pax), row.reason] };
    }).concat((data.overrides || []).map(function (row) {
      return { kind: 'slot', row: row, cells: ['時段 / Slot', row.date, row.slot,
        row.blocked ? '封鎖 / Blocked' : '開放 / Open', row.max_pax === null ? '' : String(row.max_pax), row.reason] };
    }));
    if (!items.length) {
      var empty = document.createElement('tr'); var cell = document.createElement('td');
      cell.colSpan = 6; cell.textContent = '目前沒有例外設定 / No exceptions saved.'; empty.appendChild(cell); table.appendChild(empty); return;
    }
    items.forEach(function (item) {
      var tr = document.createElement('tr'); tr.className = 'exception-row'; tr.tabIndex = 0;
      item.cells.forEach(function (value) { var td = document.createElement('td'); td.textContent = value; tr.appendChild(td); });
      function load() {
        var row = item.row;
        if (item.kind === 'date') {
          $('exceptionDate').value = row.date; $('exceptionOpen').value = row.open_time || ''; $('exceptionClose').value = row.close_time || '';
          $('exceptionCapacity').value = row.max_pax === null ? '' : row.max_pax; $('exceptionReason').value = row.reason; $('exceptionClosed').checked = row.closed;
          $('exceptionDate').scrollIntoView({ block: 'center' });
        } else {
          $('overrideDate').value = row.date; $('overrideSlot').value = row.slot;
          $('overrideCapacity').value = row.max_pax === null ? '' : row.max_pax; $('overrideReason').value = row.reason; $('overrideBlocked').checked = row.blocked;
          $('overrideDate').scrollIntoView({ block: 'center' });
        }
        $('availabilityMessage').textContent = '已載入到上方表單，修改後請儲存 / Loaded into the form above; save to apply.';
      }
      tr.addEventListener('click', load);
      tr.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); load(); } });
      table.appendChild(tr);
    });
  }
  function showAvailabilityError(err) {
    if (err.details && err.details.affected && err.details.affected.length) {
      $('availabilityImpact').textContent = '下列現有預約將受影響 / Existing bookings affected:\n' +
        err.details.affected.map(function (b) { return b.date + ' ' + b.slot + ' · ' + b.id + ' · ' + b.reason; }).join('\n') +
        '\n請先處理，再勾選「已檢查受影響預約」並重新儲存。 / Review them, check the acknowledgement, then save again.';
      $('availabilityImpact').style.whiteSpace = 'pre-line';
    } else $('availabilityMessage').textContent = err.message;
  }
  $('saveAvailability').addEventListener('click', function () {
    var body = { open_time: $('settingOpen').value, close_time: $('settingClose').value,
      service_minutes: Number($('settingService').value), interval_minutes: Number($('settingInterval').value),
      max_pax: Number($('settingCapacity').value), cutoff_minutes: Number($('settingCutoff').value),
      max_advance_days: $('settingAdvance').value === '' ? null : Number($('settingAdvance').value),
      finish_before_close: $('settingFinish').checked,
      closed_weekdays: Array.from(document.querySelectorAll('.closed-weekday')).filter(function (el) { return el.checked; }).map(function (el) { return Number(el.value); }),
      acknowledgeAffected: $('settingAcknowledge').checked };
    api('/api/admin/availability-settings', { method: 'PUT', body: JSON.stringify(body) })
      .then(function () { $('availabilityImpact').textContent = ''; $('availabilityMessage').textContent = '營業規則已儲存 / Availability rules saved.'; setReportMode('calendar'); })
      .catch(showAvailabilityError);
  });
  $('saveException').addEventListener('click', function () {
    var date = $('exceptionDate').value;
    var body = { closed: $('exceptionClosed').checked, open_time: $('exceptionOpen').value || null,
      close_time: $('exceptionClose').value || null, max_pax: $('exceptionCapacity').value === '' ? null : Number($('exceptionCapacity').value),
      reason: $('exceptionReason').value.trim(), acknowledgeAffected: $('settingAcknowledge').checked };
    api('/api/admin/availability-exceptions/' + encodeURIComponent(date), { method: 'PUT', body: JSON.stringify(body) })
      .then(function () { $('availabilityImpact').textContent = ''; $('availabilityMessage').textContent = '日期設定已儲存 / Date saved.'; setReportMode('calendar'); })
      .catch(showAvailabilityError);
  });
  $('saveOverride').addEventListener('click', function () {
    var date = $('overrideDate').value, slot = $('overrideSlot').value.trim();
    var body = { blocked: $('overrideBlocked').checked,
      max_pax: $('overrideCapacity').value === '' ? null : Number($('overrideCapacity').value),
      reason: $('overrideReason').value.trim(), acknowledgeAffected: $('settingAcknowledge').checked };
    api('/api/admin/slot-overrides/' + encodeURIComponent(date) + '/' + encodeURIComponent(slot), { method: 'PUT', body: JSON.stringify(body) })
      .then(function () { $('availabilityImpact').textContent = ''; $('availabilityMessage').textContent = '時段設定已儲存 / Slot saved.'; setReportMode('calendar'); })
      .catch(showAvailabilityError);
  });
  function loadSourceOptions() {
    loadTrackingLinks();
    api('/api/admin/discovery-sources').then(function (data) {
      $('sourceOptionsRows').replaceChildren();
      data.sources.forEach(function (source) {
        var tr = document.createElement('tr');
        function field(value, type) {
          var td = document.createElement('td'); var input = document.createElement('input');
          input.type = type || 'text'; input.value = value; input.style.width = '100%';
          input.style.minWidth = '90px'; input.style.background = 'var(--card2)'; input.style.color = 'var(--text)';
          td.appendChild(input); tr.appendChild(td); return input;
        }
        var zh = field(source.labelZh), en = field(source.labelEn), order = field(source.sortOrder, 'number');
        var activeCell = document.createElement('td'), active = document.createElement('input');
        active.type = 'checkbox'; active.checked = source.active; activeCell.appendChild(active); tr.appendChild(activeCell);
        var action = document.createElement('td'), save = document.createElement('button');
        save.type = 'button'; save.textContent = '儲存 / Save';
        save.addEventListener('click', function () {
          api('/api/admin/discovery-sources/' + encodeURIComponent(source.id), { method: 'PUT', body: JSON.stringify({
            labelZh: zh.value.trim(), labelEn: en.value.trim(), sortOrder: Number(order.value), active: active.checked }) })
            .then(function () { $('sourcesMessage').textContent = '已儲存 / Saved.'; loadSourceOptions(); loadDiscoverySources(); })
            .catch(function (err) { $('sourcesMessage').textContent = err.message; });
        });
        action.appendChild(save); tr.appendChild(action); $('sourceOptionsRows').appendChild(tr);
      });
    }).catch(function (err) { $('sourcesMessage').textContent = err.message; });
  }
  $('createSource').addEventListener('click', function () {
    api('/api/admin/discovery-sources', { method: 'POST', body: JSON.stringify({
      labelZh: $('sourceZh').value.trim(), labelEn: $('sourceEn').value.trim(), sortOrder: Number($('sourceOrder').value) }) })
      .then(function () { $('sourceZh').value = ''; $('sourceEn').value = ''; $('sourcesMessage').textContent = '來源已新增 / Source added.'; loadSourceOptions(); loadDiscoverySources(); })
      .catch(function (err) { $('sourcesMessage').textContent = err.message; });
  });
  function loadTrackingLinks() {
    api('/api/admin/tracking-links').then(function (data) {
      $('trackingLinkRows').replaceChildren();
      data.items.forEach(function (item) {
        var tr = document.createElement('tr');
        [item.code, item.name, item.kind, item.url, item.active ? '啟用 / Active' : '停用 / Disabled'].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; td.style.overflowWrap = 'anywhere'; tr.appendChild(td);
        });
        var action = document.createElement('td');
        var copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '複製連結 / Copy link';
        copy.addEventListener('click', function () {
          if (!navigator.clipboard) { $('trackingMessage').textContent = '請直接選取網址複製 / Please select and copy the URL.'; return; }
          navigator.clipboard.writeText(item.url).then(function () { $('trackingMessage').textContent = '連結已複製 / Link copied.'; })
            .catch(function () { $('trackingMessage').textContent = '請直接選取網址複製 / Please select and copy the URL.'; });
        });
        var toggle = document.createElement('button'); toggle.type = 'button';
        toggle.textContent = item.active ? '停用 / Disable' : '啟用 / Enable';
        toggle.addEventListener('click', function () {
          api('/api/admin/tracking-links/' + encodeURIComponent(item.code), { method: 'PATCH', body: JSON.stringify({ name: item.name, active: !item.active }) })
            .then(loadTrackingLinks).catch(function (err) { $('trackingMessage').textContent = err.message; });
        });
        var qr = document.createElement('a');
        qr.href = '/api/admin/tracking-links/' + encodeURIComponent(item.code) + '/qr.svg';
        qr.textContent = '下載 QR / Download QR'; qr.download = 'booking-' + item.code + '.svg';
        qr.style.display = 'block'; qr.style.marginTop = '8px';
        action.append(copy, toggle, qr); tr.appendChild(action); $('trackingLinkRows').appendChild(tr);
      });
    }).catch(function (err) { $('trackingMessage').textContent = err.message; });
  }
  $('createTracking').addEventListener('click', function () {
    var body = { code: $('trackingCode').value.trim(), name: $('trackingName').value.trim(), kind: $('trackingKind').value,
      utmSource: $('trackingUtmSource').value.trim(), utmMedium: $('trackingUtmMedium').value.trim(),
      utmCampaign: $('trackingUtmCampaign').value.trim() };
    api('/api/admin/tracking-links', { method: 'POST', body: JSON.stringify(body) })
      .then(function () { $('trackingMessage').textContent = '追蹤連結已建立 / Tracking link created.'; loadTrackingLinks(); })
      .catch(function (err) { $('trackingMessage').textContent = err.message; });
  });
  function loadCustomers() {
    api('/api/admin/customers?search=' + encodeURIComponent($('customerSearch').value.trim())).then(function (data) {
      $('customerRows').replaceChildren();
      $('customerMessage').textContent = data.items.length + ' 筆顧客 / customers（顯示前 ' + data.pageSize + ' 筆）';
      data.items.forEach(function (customer) {
        var tr = document.createElement('tr'), first = document.createElement('td');
        var button = document.createElement('button'); button.type = 'button'; button.textContent = customer.normalized_email;
        button.addEventListener('click', function () { showCustomerDetail(customer.id); });
        first.appendChild(button); tr.appendChild(first);
        [customer.booking_count, customer.checked_in_count, customer.cancellation_count, customer.no_show_count,
          customer.first_recorded_visit || '—', customer.last_recorded_visit || '—',
          customer.line_bound ? '已綁定 / Linked' : '未綁定 / Not linked'].forEach(function (value) {
          var td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
        });
        $('customerRows').appendChild(tr);
      });
    }).catch(function (err) { $('customerMessage').textContent = err.message; });
  }
  function showCustomerDetail(id) {
    api('/api/admin/customers/' + encodeURIComponent(id)).then(function (data) {
      $('customerDetail').replaceChildren();
      var heading = document.createElement('h3'); heading.textContent = '顧客 / Customer: ' + data.customer.normalized_email;
      $('customerDetail').appendChild(heading);
      var noteLabel = document.createElement('label'); noteLabel.textContent = '內部備註 / Internal note（不對客人顯示 / Staff only）';
      var note = document.createElement('textarea'); note.rows = 3; note.maxLength = 2000;
      note.value = data.customer.internal_note || ''; note.style.width = '100%';
      note.style.background = 'var(--card)'; note.style.color = 'var(--text)'; note.style.padding = '10px';
      var reasonLabel = document.createElement('label'); reasonLabel.textContent = '修改原因 / Change reason';
      var reason = document.createElement('input'); reason.type = 'text'; reason.maxLength = 300;
      reason.style.background = 'var(--card)'; reason.style.color = 'var(--text)'; reason.style.padding = '10px'; reason.style.width = '100%';
      var save = document.createElement('button'); save.type = 'button'; save.textContent = '儲存顧客備註 / Save customer note';
      save.addEventListener('click', function () {
        if (!reason.value.trim()) { $('customerMessage').textContent = '請填寫修改原因 / A change reason is required.'; return; }
        save.disabled = true;
        api('/api/admin/customers/' + encodeURIComponent(id) + '/note', { method: 'PATCH', body: JSON.stringify({
          revision: data.customer.revision, internalNote: note.value, reason: reason.value.trim()
        }) }).then(function () { $('customerMessage').textContent = '內部備註已儲存 / Internal note saved.'; showCustomerDetail(id); })
          .catch(function (err) { $('customerMessage').textContent = err.message; save.disabled = false; });
      });
      $('customerDetail').append(noteLabel, note, reasonLabel, reason, save);
      var historyTitle = document.createElement('h4'); historyTitle.textContent = '過往預約 / Booking history'; $('customerDetail').appendChild(historyTitle);
      data.bookings.forEach(function (b) {
        var p = document.createElement('p');
        p.textContent = b.date + ' ' + b.slot + ' · ' + statusLabel(b.status) + ' · ' + b.pax + ' 預約 / booked · ' +
          (b.actual_pax === null ? '實際未知 / actual unknown' : b.actual_pax + ' 實際 / actual');
        $('customerDetail').appendChild(p);
      });
    }).catch(function (err) { $('customerMessage').textContent = err.message; });
  }
  $('customerSearchButton').addEventListener('click', loadCustomers);
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
      showMMsg('請先儲存修改，再重寄確認信 / Save your changes before resending.'); return;
    }
    busy(true);
    api('/api/admin/bookings/' + encodeURIComponent(editing.id) + '/resend-mail', { method: 'POST' })
      .then(function () { showMMsg('確認信已交由寄信服務寄送 / The mail service accepted the confirmation.'); load(); })
      .catch(function (err) { showMMsg(err.message); })
      .finally(function () { busy(false); $('mSave').textContent = '儲存 / Save'; });
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
      $('reportDiscovery').replaceChildren(new Option('全部 / All', ''));
      data.sources.forEach(function (item) {
        $('reportDiscovery').appendChild(new Option(item.labelZh + ' / ' + item.labelEn, item.id));
      });
    }).catch(function (err) { console.error(err.message); });
  }
  api('/api/admin/session').then(function (session) {
    csrfToken = session.csrfToken; role = session.role;
    $('reportFrom').value = session.today; $('reportTo').value = session.today;
    todayBangkok = session.today;
    $('logout').disabled = false;
    $('calendarDate').value = session.today; $('calendarMonthInput').value = session.today.slice(0, 7); calendarDay = session.today;
    $('accountsTab').hidden = role !== 'ADMIN';
    $('notificationsTab').hidden = role !== 'ADMIN';
    $('exportBookings').hidden = role !== 'ADMIN';
    $('exportAnalytics').hidden = role === 'STAFF';
    $('availabilityTab').hidden = role !== 'ADMIN';
    $('sourcesTab').hidden = role !== 'ADMIN';
    $('customersTab').hidden = role === 'ANALYST';
    $('overviewTab').hidden = role === 'ANALYST';
    $('lineGroups').hidden = role !== 'ADMIN';
    $('reportAssigneeWrap').hidden = role === 'ANALYST';
    if (role !== 'ANALYST') api('/api/admin/assignees').then(function (data) {
      $('reportAssignee').replaceChildren(new Option('全部 / All', ''));
      data.items.forEach(function (person) {
        $('reportAssignee').appendChild(new Option(person.display_name, person.id));
      });
    }).catch(function (err) { $('reportMessage').textContent = err.message; });
    ['prev','this','next','reload','calendarTab','addNew'].forEach(function (id) { if (role === 'ANALYST') $(id).hidden = true; });
    loadDiscoverySources();
    if (role === 'ANALYST') setReportMode('analytics'); else load();
  })
    .catch(function (err) { $('loading').textContent = err.message; });
