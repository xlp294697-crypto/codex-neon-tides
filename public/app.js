const consentKey = 'jiuyueAnalyticsConsent';
const consentAtKey = 'jiuyueAnalyticsConsentAt';
const consentVersionKey = 'jiuyueAnalyticsConsentVersion';
const analyticsNoticeVersion = '2026-08-22';
const visitorKey = 'jiuyueVisitor';
const query = new URLSearchParams(location.search);
const consentPanel = document.querySelector('#analytics-consent');
const analyticsSettings = document.querySelector('#analytics-settings');
let analyticsStarted = false;
let visitorId = '';
let sectionObserver = null;

function getConsent() {
  try { return localStorage.getItem(consentKey) || ''; } catch { return ''; }
}

function setConsent(value) {
  try {
    if (value) localStorage.setItem(consentKey, value);
    else localStorage.removeItem(consentKey);
  } catch {}
}

function getConsentAt() {
  try { return localStorage.getItem(consentAtKey) || ''; } catch { return ''; }
}

function setConsentAt(value) {
  try {
    if (value) localStorage.setItem(consentAtKey, value);
    else localStorage.removeItem(consentAtKey);
  } catch {}
}

function getConsentVersion() {
  try { return localStorage.getItem(consentVersionKey) || ''; } catch { return ''; }
}

function setConsentVersion(value) {
  try {
    if (value) localStorage.setItem(consentVersionKey, value);
    else localStorage.removeItem(consentVersionKey);
  } catch {}
}

function hasAnalyticsConsent() {
  return getConsent() === 'yes' && getConsentVersion() === analyticsNoticeVersion && Boolean(getConsentAt());
}

function newVisitorId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function getVisitorId() {
  if (visitorId) return visitorId;
  try {
    visitorId = localStorage.getItem(visitorKey) || '';
    if (!visitorId) {
      visitorId = newVisitorId();
      localStorage.setItem(visitorKey, visitorId);
    }
  } catch {
    visitorId = newVisitorId();
  }
  return visitorId;
}

function campaignContext() {
  const clean = (name, maximum) => (query.get(name) || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maximum);
  return {
    source: clean('utm_source', 40),
    medium: clean('utm_medium', 40),
    campaign: clean('utm_campaign', 80),
  };
}

function referrerOrigin() {
  if (!document.referrer) return '';
  try {
    const parsed = new URL(document.referrer);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch { return ''; }
}

function eventContext() {
  return {
    page: location.pathname,
    visitorId: getVisitorId(),
    referrer: referrerOrigin(),
    utm: campaignContext(),
    device: innerWidth < 700 ? 'mobile' : 'desktop',
    analyticsConsent: true,
    analyticsNoticeVersion,
    analyticsConsentAt: getConsentAt(),
  };
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '提交失败，请稍后再试。');
  return data;
}

function track(eventType, details = {}) {
  if (!hasAnalyticsConsent()) return Promise.resolve();
  return request('/api/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...eventContext(), eventType, ...details }),
  }).catch(() => {});
}

function startAnalytics() {
  if (analyticsStarted || !hasAnalyticsConsent()) return;
  analyticsStarted = true;
  track('page_view');
  if ('IntersectionObserver' in window) {
    const observed = new Set();
    sectionObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
      const section = entry.target.dataset.section;
      if (entry.isIntersecting && !observed.has(section)) {
        observed.add(section);
        track('section_view', { section });
        sectionObserver.unobserve(entry.target);
      }
    }), { threshold: 0.28 });
    document.querySelectorAll('.observed-section').forEach((section) => sectionObserver.observe(section));
  }
}

function openConsentSettings() {
  consentPanel.hidden = false;
  consentPanel.querySelector('[data-analytics-accept]').focus();
}

function closeConsentSettings() {
  consentPanel.hidden = true;
}

consentPanel.querySelector('[data-analytics-accept]').addEventListener('click', () => {
  setConsent('yes');
  setConsentAt(new Date().toISOString());
  setConsentVersion(analyticsNoticeVersion);
  closeConsentSettings();
  startAnalytics();
});
consentPanel.querySelector('[data-analytics-reject]').addEventListener('click', () => {
  setConsent('no');
  setConsentAt('');
  setConsentVersion('');
  try { localStorage.removeItem(visitorKey); } catch {}
  visitorId = '';
  analyticsStarted = false;
  if (sectionObserver) sectionObserver.disconnect();
  sectionObserver = null;
  closeConsentSettings();
});
analyticsSettings.addEventListener('click', openConsentSettings);
const savedConsent = getConsent();
if (!['yes', 'no'].includes(savedConsent) || (savedConsent === 'yes' && !hasAnalyticsConsent())) {
  setConsent('');
  setConsentAt('');
  setConsentVersion('');
  openConsentSettings();
} else startAnalytics();

document.querySelectorAll('[data-assessment-source]').forEach((link) => link.addEventListener('click', () => {
  track('assessment_click', { section: link.dataset.assessmentSource });
}));

const galleryItems = [...document.querySelectorAll('[data-gallery-item]')];
const dialog = document.querySelector('#media-dialog');
const dialogImage = document.querySelector('#dialog-image');
const dialogTitle = document.querySelector('#dialog-title');
const dialogCount = document.querySelector('#dialog-count');
let activeIndex = 0;
let returnFocus = null;

function showItem(index, shouldTrack = true) {
  activeIndex = (index + galleryItems.length) % galleryItems.length;
  const item = galleryItems[activeIndex];
  const image = item.querySelector('img');
  dialogImage.src = image.src;
  dialogImage.alt = image.alt;
  dialogTitle.textContent = item.dataset.targetLabel;
  dialogCount.textContent = `${activeIndex + 1} / ${galleryItems.length}`;
  if (shouldTrack) track('image_open', { section: item.dataset.section, targetId: item.dataset.targetId, targetLabel: item.dataset.targetLabel });
}

function openDialog(index) {
  returnFocus = document.activeElement;
  showItem(index);
  dialog.hidden = false;
  document.body.style.overflow = 'hidden';
  dialog.querySelector('.dialog-close').focus();
}

function closeDialog() {
  dialog.hidden = true;
  dialogImage.src = '';
  document.body.style.overflow = '';
  if (returnFocus) returnFocus.focus();
}

galleryItems.forEach((item, index) => item.addEventListener('click', () => openDialog(index)));
dialog.querySelectorAll('[data-dialog-close]').forEach((button) => button.addEventListener('click', closeDialog));
dialog.querySelector('[data-dialog-prev]').addEventListener('click', () => showItem(activeIndex - 1));
dialog.querySelector('[data-dialog-next]').addEventListener('click', () => showItem(activeIndex + 1));
document.addEventListener('keydown', (event) => {
  if (dialog.hidden) return;
  if (event.key === 'Escape') closeDialog();
  if (event.key === 'ArrowLeft') showItem(activeIndex - 1);
  if (event.key === 'ArrowRight') showItem(activeIndex + 1);
});

document.querySelector('#booking-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  const status = document.querySelector('#status');
  status.textContent = '正在提交…';
  status.className = 'form-status';
  try {
    const analyticsAllowed = hasAnalyticsConsent();
    await request('/api/inquiries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        parentName: fields.parentName,
        phone: fields.phone,
        grade: fields.grade,
        course: fields.course,
        concern: fields.concern,
        preferredTime: fields.preferredTime,
        website: fields.website,
        privacyConsent: fields.privacyConsent === 'yes',
        sourcePage: analyticsAllowed ? location.pathname : '',
        sourceSection: analyticsAllowed ? (location.hash.replace('#', '') || 'assessment') : '',
        referrer: analyticsAllowed ? referrerOrigin() : '',
        utm: analyticsAllowed ? campaignContext() : {},
        analyticsConsent: analyticsAllowed,
        analyticsNoticeVersion: analyticsAllowed ? analyticsNoticeVersion : '',
        analyticsConsentAt: analyticsAllowed ? getConsentAt() : '',
      }),
    });
    await track('booking_success', { section: 'assessment' });
    event.currentTarget.reset();
    status.textContent = '预约已提交，我们会尽快与您电话联系。';
  } catch (error) {
    status.textContent = error.message;
    status.className = 'form-status error';
  }
});
