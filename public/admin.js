const loginView = document.querySelector('#login-view');
const dashboardView = document.querySelector('#dashboard-view');
const loginStatus = document.querySelector('#login-status');
let inquiries = [];
let csrfToken = '';

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response;
    let body;
    try {
      response = await fetch(url, { ...options, signal: controller.signal });
      body = await response.json();
    } catch {
      throw new Error(
        controller.signal.aborted
          ? '请求超时，请刷新确认操作结果后重试。'
          : '网络连接异常，请检查网络后重试。',
      );
    }
    if (!response.ok) {
      const error = new Error(body.error?.message || '暂时无法加载数据。');
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function showLogin(message = '') {
  csrfToken = '';
  loginView.hidden = false;
  dashboardView.hidden = true;
  loginStatus.textContent = message;
  loginStatus.className = `form-status ${message ? 'error' : ''}`;
}
function showDashboard() {
  loginView.hidden = true;
  dashboardView.hidden = false;
}
function escapeHtml(value = '') {
  return String(value).replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[
        character
      ],
  );
}

function renderMetrics(metrics) {
  const cards = [
    ['访问量', metrics.visits, '同意统计的页面访问次数'],
    ['独立访客', metrics.visitors, '同意统计的去重随机标识'],
    ['总预约数', metrics.enquiries, '包含拒绝访问统计的家长预约'],
    [
      '统计转化率',
      `${metrics.conversion}%`,
      `${metrics.trackedConversions || 0} 位完成预约访客 / ${metrics.visitors || 0} 位统计访客`,
    ],
  ];
  document.querySelector('#metric-cards').innerHTML = cards
    .map(
      ([label, value, detail]) =>
        `<article><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`,
    )
    .join('');
}

function renderEngagement(engagement) {
  const cards = [
    ['资质区浏览', engagement.qualificationViews],
    ['成果区浏览', engagement.outcomeViews],
    ['证书图片打开', engagement.imageOpens],
    ['预约按钮点击', engagement.assessmentClicks],
  ];
  document.querySelector('#engagement-cards').innerHTML = cards
    .map(
      ([label, value]) =>
        `<article><span>${label}</span><strong>${value}</strong></article>`,
    )
    .join('');
}

function renderDaily(days) {
  const maximum = Math.max(
    1,
    ...days.flatMap((day) => [day.visits, day.enquiries]),
  );
  document.querySelector('#daily-chart').innerHTML = days
    .map(
      (day) =>
        `<div class="day-column"><div class="columns"><i title="${day.visits} 次访问" style="height:${Math.max(5, (day.visits / maximum) * 120)}px"></i><b title="${day.enquiries} 个预约" style="height:${Math.max(day.enquiries ? 8 : 2, (day.enquiries / maximum) * 120)}px"></b></div><span>${day.date.slice(5)}</span></div>`,
    )
    .join('');
}

function renderBars(selector, items) {
  const maximum = Math.max(1, ...items.map((item) => item.value));
  document.querySelector(selector).innerHTML = items.length
    ? items
        .map(
          (item) =>
            `<div class="bar-row"><span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span><div><i style="width:${(item.value / maximum) * 100}%"></i></div><b>${item.value}</b></div>`,
        )
        .join('')
    : '<p class="empty-state">暂无数据</p>';
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
function maskPhone(value) {
  const phone = String(value || '');
  if (!phone) return '未填写';
  if (phone.length <= 7) return `${phone.slice(0, 2)}***${phone.slice(-2)}`;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}
const statusLabels = {
  New: '新线索',
  Contacted: '已联系',
  Qualified: '已到店',
  Won: '已报名',
  Closed: '无效',
};

function renderInquiries() {
  const rows = document.querySelector('#inquiry-rows');
  rows.innerHTML = inquiries.length
    ? inquiries
        .map((inquiry) => {
          const parentName = inquiry.parentName || inquiry.name || '未填写';
          const grade = inquiry.grade || inquiry.company || '未填写';
          const course = inquiry.course || inquiry.product || '未填写';
          const preferredTime =
            inquiry.preferredTime || inquiry.volume || '未填写';
          const concern = inquiry.concern || inquiry.message || '未填写';
          return `<tr><td>${formatDate(inquiry.createdAt)}</td><td><strong>${escapeHtml(parentName)}</strong><br><span class="phone-value">${escapeHtml(maskPhone(inquiry.phone))}</span>${inquiry.phone ? `<br><button class="reveal-phone" type="button" data-phone-id="${escapeHtml(inquiry.id)}">显示电话</button>` : ''}</td><td>${escapeHtml(grade)}</td><td><strong>${escapeHtml(course)}</strong></td><td>${escapeHtml(preferredTime)}</td><td class="requirement">${escapeHtml(concern)}</td><td>${escapeHtml(inquiry.source || '未采集')}<br><small>${escapeHtml(inquiry.sourcePage || '—')}</small></td><td><select class="status-select" data-id="${inquiry.id}">${Object.keys(
            statusLabels,
          )
            .map(
              (status) =>
                `<option value="${status}" ${status === inquiry.status ? 'selected' : ''}>${statusLabels[status]}</option>`,
            )
            .join(
              '',
            )}</select><button class="delete-inquiry" type="button" data-delete-id="${inquiry.id}">删除</button></td></tr>`;
        })
        .join('')
    : '<tr><td colspan="8" class="empty-state">暂无预约记录</td></tr>';
  rows.querySelectorAll('.status-select').forEach((select) =>
    select.addEventListener('change', async () => {
      try {
        await request(`/api/inquiries/${select.dataset.id}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({ status: select.value }),
        });
        await loadDashboard();
      } catch (error) {
        alert(error.message);
      }
    }),
  );
  rows.querySelectorAll('.reveal-phone').forEach((button) =>
    button.addEventListener('click', () => {
      const inquiry = inquiries.find(
        (item) => item.id === button.dataset.phoneId,
      );
      if (!inquiry?.phone) return;
      const cell = button.closest('td');
      cell.querySelector('.phone-value').innerHTML =
        `<a href="tel:${escapeHtml(inquiry.phone)}">${escapeHtml(inquiry.phone)}</a>`;
      button.remove();
    }),
  );
  rows.querySelectorAll('.delete-inquiry').forEach((button) =>
    button.addEventListener('click', async () => {
      if (
        !confirm(
          '确定永久删除这条预约记录吗？建议仅在信息已无必要或响应当事人删除请求时操作。',
        )
      )
        return;
      try {
        await request(`/api/inquiries/${button.dataset.deleteId}`, {
          method: 'DELETE',
          headers: { 'x-csrf-token': csrfToken },
        });
        await loadDashboard();
      } catch (error) {
        alert(error.message);
      }
    }),
  );
}

async function loadDashboard() {
  try {
    const session = await request('/api/session');
    csrfToken = session.csrfToken;
    const [dashboard, inquiryData] = await Promise.all([
      request('/api/dashboard'),
      request('/api/inquiries'),
    ]);
    inquiries = inquiryData.inquiries;
    renderMetrics(dashboard.metrics);
    renderEngagement(dashboard.engagement);
    renderDaily(dashboard.daily);
    renderBars('#source-chart', dashboard.sources);
    renderBars('#top-image-chart', dashboard.engagement.topImages);
    renderInquiries();
    showDashboard();
  } catch (error) {
    if (error.status === 401) showLogin('');
    else showLogin(error.message);
  }
}

document
  .querySelector('#login-form')
  .addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.dataset.submitting === 'true') return;
    const fields = Object.fromEntries(new FormData(form));
    const button = form.querySelector('[type="submit"]');
    form.dataset.submitting = 'true';
    button.disabled = true;
    loginStatus.textContent = '登录中…';
    loginStatus.className = 'form-status';
    try {
      const session = await request('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fields),
      });
      csrfToken = session.csrfToken;
      form.reset();
      await loadDashboard();
    } catch (error) {
      loginStatus.textContent = error.message;
      loginStatus.className = 'form-status error';
    } finally {
      form.dataset.submitting = 'false';
      button.disabled = false;
    }
  });
document.querySelector('#logout').addEventListener('click', async () => {
  try {
    await request('/api/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
    });
    showLogin('已退出。');
  } catch (error) {
    alert(error.message);
  }
});
document.querySelector('#refresh').addEventListener('click', loadDashboard);
loadDashboard();
