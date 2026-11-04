'use strict';

// Helpers shared by the tools (agent.js, places.js, calendar.js): reading the dates and times models
// give ("tomorrow 3pm", "friday", "2026-11-05 09:00"), saying them back naturally, and matching
// what the model said against stored things ("the dentist" → "Dentist appointment").

// ── Saying dates and times ──────────────────────────────────────────────────

const fmtTime = d => d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', ' ');

function dayDiff(d, now = new Date()) {
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    return Math.round((day - today) / 86400000);
}

// "today", "tomorrow", "Friday", "Friday 13 November"
function fmtDay(d, now = new Date()) {
    const diff = dayDiff(d, now);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    if (diff > 1 && diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

// "Friday 13 November", always with the date (for headings, where "Friday" alone is ambiguous).
const fmtDate = d => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

const fmtWhen = (d, now = new Date()) => `${fmtDay(d, now)} at ${fmtTime(d)}`;

// "1 hour 20 minutes"; as an adjective ("a 5-minute timer") the units stay singular.
function fmtDuration(ms, adjective = false) {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const unit = (n, u) => adjective ? `${n}-${u}` : `${n} ${u}${n > 1 ? 's' : ''}`;
    const parts = [];
    if (h) parts.push(unit(h, 'hour'));
    if (m) parts.push(unit(m, 'minute'));
    if (sec && !h) parts.push(unit(sec, 'second'));
    return parts.join(' ') || unit(0, 'second');
}

// For the system prompt: the model needs "now" to turn "at 3" or "tomorrow morning" into a time.
function nowLine() {
    const d = new Date();
    return `The current local date and time is ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${fmtTime(d)} (24-hour: ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}; ISO date ${isoDate(d)}).`;
}

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoLocal = d => `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`; // (no offset: sent with a timeZone)

// ── Reading dates and times ─────────────────────────────────────────────────

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WD = '(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?';
const MO = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

const midnight = (d, add = 0) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() + add); return x; };

// The day a phrase names, if it names one: { day (midnight), days (how many), rest (the phrase
// without it) }. "today", "tonight", "tomorrow", "friday", "next friday", "this weekend",
// "in 3 days", "13 november", "nov 13th", "2026-11-13".
function parseDay(raw, now = new Date()) {
    const s = String(raw || '').toLowerCase();
    const hit = (re, day, days = 1) => {
        const m = s.match(re);
        return m && { day, days, rest: (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() };
    };
    let m;
    if ((m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})/))) {
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        if (!isNaN(d)) return hit(/\b(\d{4})-(\d{1,2})-(\d{1,2})(?=[ t]|$)t?/, d);
    }
    if (/\bday after tomorrow\b/.test(s)) return hit(/\b(the )?day after tomorrow\b/, midnight(now, 2));
    if (/\btomorrow\b/.test(s)) return hit(/\btomorrow\b/, midnight(now, 1));
    if (/\b(today|tonight|this (morning|afternoon|evening))\b/.test(s)) return hit(/\b(today|tonight)\b/, midnight(now)) || { day: midnight(now), days: 1, rest: s };
    if (/\byesterday\b/.test(s)) return hit(/\byesterday\b/, midnight(now, -1));
    if ((m = s.match(/\bin (\d+|a|one|two|three) (days?|weeks?)\b/))) {
        const n = { a: 1, one: 1, two: 2, three: 3 }[m[1]] ?? +m[1];
        return hit(/\bin (\d+|a|one|two|three) (days?|weeks?)\b/, midnight(now, n * (m[2].startsWith('week') ? 7 : 1)));
    }
    if (/\b(this|next|coming) week\b/.test(s)) { // this week: today to Sunday; next week: Monday to Sunday
        if (/\bthis week\b/.test(s)) return hit(/\bthis week\b/, midnight(now), 7 - ((now.getDay() + 6) % 7));
        return hit(/\b(next|coming) week\b/, midnight(now, 7 - ((now.getDay() + 6) % 7)), 7);
    }
    if (/\b(this |next )?weekend\b/.test(s)) {
        const sat = (6 - now.getDay() + 7) % 7;
        const start = now.getDay() === 0 ? midnight(now) : midnight(now, sat + (/\bnext weekend\b/.test(s) ? 7 : 0));
        return hit(/\b(this |next )?weekend\b/, start, now.getDay() === 0 ? 1 : 2);
    }
    // "13 november", "13th of nov", "november 13", "nov 13th" (this year, or next if it's passed)
    const dm = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MO}\\b`)) || null;
    const md = !dm && s.match(new RegExp(`\\b${MO} (\\d{1,2})(?:st|nd|rd|th)?\\b`));
    if (dm || md) {
        const dayN = +(dm ? dm[1] : md[2]);
        const mon = MONTHS.findIndex(x => x.startsWith((dm ? dm[2] : md[1]).slice(0, 3)));
        let d = new Date(now.getFullYear(), mon, dayN);
        if (d < midnight(now, -7)) d = new Date(now.getFullYear() + 1, mon, dayN);
        const re = dm ? new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MO}\\b`) : new RegExp(`\\b${MO} (\\d{1,2})(?:st|nd|rd|th)?\\b`);
        if (d.getDate() === dayN) return hit(re, d);
    }
    if ((m = s.match(new RegExp(`\\b(next |this |on )?${WD}\\b`)))) {
        const target = WEEKDAYS.findIndex(w => w.startsWith(m[2].slice(0, 3)));
        let add = (target - now.getDay() + 7) % 7;
        if (add === 0 && m[1] === 'next ') add = 7;
        return hit(new RegExp(`\\b(next |this |on )?${WD}\\b`), midnight(now, add));
    }
    return null;
}

// A clock time in a phrase: { h, min, ampm } or null. "3pm", "15:30", "half past 2", "noon".
function parseClock(s) {
    s = String(s || '').toLowerCase();
    if (/\bnoon\b|\bmidday\b/.test(s)) return { h: 12, min: 0, ampm: 'pm' };
    if (/\bmidnight\b/.test(s)) return { h: 0, min: 0, ampm: 'am' };
    let m = s.match(/\b(half|quarter) (past|to) (\d{1,2})\b/);
    if (m) {
        const base = +m[3], off = m[1] === 'half' ? 30 : 15;
        return m[2] === 'past' ? { h: base, min: off, ampm: '' } : { h: base - 1, min: 60 - off, ampm: '' };
    }
    m = s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|o'?clock)?(?![\d-])/);
    if (!m) return null;
    let h = +m[1];
    const min = m[2] != null ? +m[2] : 0;
    const ampm = (m[3] || '').replace(/\./g, '').replace(/o'?clock/, '');
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    // A bare "3" or "3:30" is only a time if it looks like one (not "3 items").
    if (!ampm && m[2] == null && !m[3] && !/\b(at|from|by|until|till|to|for|around|about)\s+\d/.test(s) && s.trim() !== m[0].trim()) return null;
    return { h, min, ampm };
}

// "14:30", "2:30pm", "3 pm", "tomorrow 9am", "friday at 3", "2026-11-05 09:00".
// Without a day: the next time it comes round. On a given day, a bare 1–6 means afternoon.
function parseWhen(raw, now = new Date()) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    const day = parseDay(s, now);
    const t = parseClock(day ? day.rest : s);
    if (!t) return null;
    let { h } = t;
    if (day) {
        if (!t.ampm && h >= 1 && h < 12 && (h <= 6 || /\b(tonight|evening|afternoon)\b/.test(s))) h += 12;
        const d = new Date(day.day);
        d.setHours(h, t.min, 0, 0);
        return d;
    }
    const d = new Date(now);
    d.setHours(h, t.min, 0, 0);
    if (d <= now) {
        // "at 3" said at 2pm means 3pm; otherwise the next time it comes round.
        if (!t.ampm && h < 12 && d.getTime() + 12 * 3600000 > now.getTime()) d.setHours(h + 12);
        else d.setDate(d.getDate() + 1);
    }
    return d;
}

// ── Matching what the model said to stored things ───────────────────────────

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
const wordSet = s => new Set(norm(s).split(' ').filter(w => w.length > 2 || /\d/.test(w)));

// The stored item that best matches what the model described (it rarely quotes it exactly).
function bestMatch(items, query, get = x => x) {
    const q = norm(query);
    if (!q) return null;
    const exact = items.find(i => norm(get(i)) === q) || items.find(i => norm(get(i)).includes(q) || q.includes(norm(get(i))));
    if (exact) return exact;
    const qw = wordSet(query);
    let best = null, bestScore = 0;
    for (const i of items) {
        const w = wordSet(get(i));
        const shared = [...qw].filter(x => w.has(x)).length;
        const score = shared / Math.max(1, Math.min(qw.size, w.size));
        if (score > bestScore) { best = i; bestScore = score; }
    }
    return bestScore >= 0.5 ? best : null;
}

module.exports = { fmtTime, fmtDay, fmtDate, fmtWhen, fmtDuration, nowLine, isoDate, isoLocal, dayDiff, midnight, parseDay, parseClock, parseWhen, norm, wordSet, bestMatch };
