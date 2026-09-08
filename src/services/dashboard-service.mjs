import { normalizeVisitorId } from '../validation/common.mjs';

export function createDashboard(data, timeZone, now = Date.now()) {
  const REPORT_TIME_ZONE = timeZone;
  const REPORT_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  function reportDateKey(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const parts = Object.fromEntries(
      REPORT_DATE_FORMATTER.formatToParts(date)
        .filter((part) => ['year', 'month', 'day'].includes(part.type))
        .map((part) => [part.type, part.value]),
    );
    return parts.year && parts.month && parts.day
      ? `${parts.year}-${parts.month}-${parts.day}`
      : '';
  }

  function recentReportDates(count = 7, now = Date.now()) {
    const dates = [];
    for (
      let offset = 0;
      dates.length < count && offset < count + 5;
      offset += 1
    ) {
      const date = reportDateKey(now - offset * 86400000);
      if (date && !dates.includes(date)) dates.unshift(date);
    }
    return dates;
  }

  function getDashboard() {
    const events = Array.isArray(data.events) ? data.events : [];
    const inquiries = Array.isArray(data.inquiries) ? data.inquiries : [];
    const attributedInquiries = inquiries.filter(
      (item) => item.analyticsAttributed === true,
    );
    const pageViews = events.filter(
      (event) => !event.eventType || event.eventType === 'page_view',
    );
    const bookingSuccessEvents = events.filter(
      (event) => event.eventType === 'booking_success',
    );
    const visitorIds = new Set(
      pageViews
        .map((event) => normalizeVisitorId(event.visitorId))
        .filter(Boolean),
    );
    const trackedConversionVisitorIds = new Set(
      bookingSuccessEvents
        .map((event) => normalizeVisitorId(event.visitorId))
        .filter((visitorId) => visitorId && visitorIds.has(visitorId)),
    );
    const daily = recentReportDates(7, now).map((date) => {
      const dailyPageViews = pageViews.filter(
        (event) => reportDateKey(event.createdAt) === date,
      );
      const dailyTrackedVisitors = new Set(
        bookingSuccessEvents
          .filter((event) => reportDateKey(event.createdAt) === date)
          .map((event) => normalizeVisitorId(event.visitorId))
          .filter((visitorId) => visitorId && visitorIds.has(visitorId)),
      );
      return {
        date,
        visits: dailyPageViews.length,
        visitors: new Set(
          dailyPageViews
            .map((event) => normalizeVisitorId(event.visitorId))
            .filter(Boolean),
        ).size,
        enquiries: inquiries.filter(
          (item) => reportDateKey(item.createdAt) === date,
        ).length,
        trackedConversions: dailyTrackedVisitors.size,
      };
    });
    const group = (items, labelFor) => {
      const counts = new Map();
      for (const item of items) {
        const label = labelFor(item) || '未知';
        counts.set(label, (counts.get(label) || 0) + 1);
      }
      return [...counts.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort(
          (a, b) =>
            b.value - a.value || a.label.localeCompare(b.label, 'zh-CN'),
        );
    };
    const imageOpenEvents = events.filter(
      (event) => event.eventType === 'image_open',
    );
    const imageGroups = new Map();
    for (const event of imageOpenEvents) {
      const key = JSON.stringify([
        event.targetId || '',
        event.targetLabel || '',
        event.section || '',
      ]);
      const current = imageGroups.get(key) || {
        id: event.targetId || '',
        label: event.targetLabel || '',
        section: event.section || '',
        value: 0,
      };
      current.value += 1;
      imageGroups.set(key, current);
    }
    const visits = pageViews.length;
    const visitors = visitorIds.size;
    const trackedConversions = trackedConversionVisitorIds.size;
    const topImages = [...imageGroups.values()].sort(
      (a, b) => b.value - a.value || a.id.localeCompare(b.id),
    );
    return {
      metrics: {
        visits,
        visitors,
        enquiries: inquiries.length,
        attributedEnquiries: attributedInquiries.length,
        trackedConversions,
        conversion: visitors
          ? Math.round((trackedConversions / visitors) * 1000) / 10
          : 0,
      },
      reportTimeZone: REPORT_TIME_ZONE,
      daily,
      sources: group(pageViews, (event) => event.source),
      pages: group(pageViews, (event) => event.page).slice(0, 6),
      engagement: {
        qualificationViews: events.filter(
          (event) =>
            event.eventType === 'section_view' &&
            event.section === 'qualifications',
        ).length,
        outcomeViews: events.filter(
          (event) =>
            event.eventType === 'section_view' && event.section === 'outcomes',
        ).length,
        imageOpens: imageOpenEvents.length,
        assessmentClicks: events.filter(
          (event) => event.eventType === 'assessment_click',
        ).length,
        bookingSuccesses: events.filter(
          (event) => event.eventType === 'booking_success',
        ).length,
        topImages,
      },
    };
  }

  return getDashboard();
}
