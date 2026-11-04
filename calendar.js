'use strict';

// The user's calendar, read from its secret iCal address (Google Calendar → Settings → your
// calendar → "Secret address in iCal format"). That address is read-only: DanGPT can see what's on,
// and to add something it puts a link on screen that opens Google Calendar with the event filled
// in, for the user to save. Moving or deleting is done in Google Calendar itself.
//
// The addresses are kept in ./data/calendar.json and never sent to the browser: anyone who has one
// can read that calendar.

const fs   = require('fs');
const path = require('path');
const { fmtTime, fmtDay, fmtDate, isoDate, midnight, parseDay, parseWhen, norm, wordSet } = require('./agent-util');

const FILE = process.env.CALENDAR_DATA_FILE || path.join(__dirname, 'data', 'calendar.json');
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CACHE_MS = 5 * 60000;

let cfg = { feeds: [], remote: false };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
function save() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(cfg, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
}

// ── Reading iCal ────────────────────────────────────────────────────────────

const unescape = v => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// "DTSTART;TZID=Europe/London:20261105T150000" → { name, params, value }
function parseLine(line) {
    let i = 0, quoted = false;
    for (; i < line.length; i++) {
        if (line[i] === '"') quoted = !quoted;
        else if (line[i] === ':' && !quoted) break;
    }
    const [name, ...rest] = line.slice(0, i).split(';');
    const params = {};
    for (const p of rest) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
    return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

// A date or date-time as its own fields, with the zone it's in: 'UTC', an IANA name, or null
// ("floating": whatever the local time is).
function parseDT(value, params = {}) {
    let m = String(value).match(/^(\d{4})(\d\d)(\d\d)$/);
    if (m || params.VALUE === 'DATE') {
        m = m || String(value).match(/^(\d{4})(\d\d)(\d\d)/);
        return m && { allDay: true, y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0, tz: null };
    }
    m = String(value).match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)?(Z)?$/);
    if (!m) return null;
    return { allDay: false, y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0), tz: m[7] ? 'UTC' : validTz(params.TZID) };
}

const tzOk = new Map();
function validTz(tz) {
    if (!tz) return null;
    if (!tzOk.has(tz)) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); tzOk.set(tz, true); } catch { tzOk.set(tz, false); } }
    return tzOk.get(tz) ? tz : null; // (an unknown zone name: treat as local time)
}

// How far ahead of UTC a zone is at a moment (ms).
const fmts = new Map();
function tzOffset(t, tz) {
    let f = fmts.get(tz);
    if (!f) fmts.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    const p = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, +x.value]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

// The moment those fields mean.
function toDate(f) {
    if (f.allDay || !f.tz) return new Date(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
    const wall = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s);
    if (f.tz === 'UTC') return new Date(wall);
    let t = wall - tzOffset(wall, f.tz);
    t = wall - tzOffset(t, f.tz); // (once more, in case that crossed a clock change)
    return new Date(t);
}

// Calendar arithmetic on fields, whatever the zone: Date.UTC never has clock changes.
function addDays(f, n) { const x = new Date(Date.UTC(f.y, f.mo - 1, f.d + n)); return { ...f, y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate() }; }
const weekday = f => new Date(Date.UTC(f.y, f.mo - 1, f.d)).getUTCDay(); // 0 = Sunday
const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const dayKey = f => f.y * 10000 + f.mo * 100 + f.d;
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseICS(text) {
    const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const events = [];
    let name = null, ev = null, depth = 0;
    for (const raw of lines) {
        if (!raw) continue;
        const l = parseLine(raw);
        if (l.name === 'BEGIN') { if (l.value === 'VEVENT' && depth === 0) ev = { exdates: [] }; else if (ev) depth++; continue; }
        if (l.name === 'END') { if (ev && depth) depth--; else if (ev && l.value === 'VEVENT') { events.push(ev); ev = null; } continue; }
        if (!ev) { if (l.name === 'X-WR-CALNAME') name = unescape(l.value); continue; }
        if (depth) continue; // (inside a VALARM)
        switch (l.name) {
            case 'UID': ev.uid = l.value; break;
            case 'SUMMARY': ev.summary = unescape(l.value); break;
            case 'LOCATION': ev.location = unescape(l.value); break;
            case 'DESCRIPTION': ev.description = unescape(l.value); break;
            case 'STATUS': ev.status = l.value.toUpperCase(); break;
            case 'DTSTART': ev.start = parseDT(l.value, l.params); break;
            case 'DTEND': ev.end = parseDT(l.value, l.params); break;
            case 'DURATION': ev.duration = l.value; break;
            case 'RRULE': ev.rrule = l.value; break;
            case 'RECURRENCE-ID': ev.recurrenceId = parseDT(l.value, l.params); break;
            case 'EXDATE': for (const v of l.value.split(',')) { const d = parseDT(v, l.params); if (d) ev.exdates.push(d); } break;
        }
    }
    return { name, events: events.filter(e => e.start) };
}

function durationMs(ev) {
    if (ev.end) return toDate(ev.end) - toDate(ev.start);
    const m = String(ev.duration || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (m) return (((+m[2] || 0) * 7 + (+m[3] || 0)) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
    return ev.start.allDay ? 86400000 : 0;
}

// The days a repeating event falls on, in order, from its first: yields fields (date only).
function* occurrenceDays(start, rule) {
    const freq = rule.FREQ, interval = Math.max(1, +rule.INTERVAL || 1);
    const byday = (rule.BYDAY || '').split(',').filter(Boolean).map(s => { const m = s.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/); return m && { n: +(m[1] || 0), wd: WD[m[2]] }; }).filter(Boolean);
    const bymonthday = (rule.BYMONTHDAY || '').split(',').filter(Boolean).map(Number);
    const bymonth = (rule.BYMONTH || '').split(',').filter(Boolean).map(Number);
    // Days in one month matching BYDAY (with "2nd Tuesday", "last Friday") or BYMONTHDAY.
    const inMonth = (y, mo) => {
        const n = daysIn(y, mo), out = new Set();
        if (byday.length) {
            for (const { n: nth, wd } of byday) {
                const all = [];
                for (let d = 1; d <= n; d++) if (weekday({ y, mo, d }) === wd) all.push(d);
                if (!nth) all.forEach(d => out.add(d));
                else { const d = nth > 0 ? all[nth - 1] : all[all.length + nth]; if (d) out.add(d); }
            }
        } else for (const md of (bymonthday.length ? bymonthday : [start.d])) { const d = md > 0 ? md : n + md + 1; if (d >= 1 && d <= n) out.add(d); }
        return [...out].sort((a, b) => a - b).map(d => ({ ...start, y, mo, d }));
    };
    for (let k = 0; k < 100000; k++) {
        let days;
        if (freq === 'DAILY') days = [addDays(start, k * interval)];
        else if (freq === 'WEEKLY') {
            const monday = addDays(start, -((weekday(start) + 6) % 7) + 7 * k * interval);
            const wds = byday.length ? byday.map(b => b.wd) : [weekday(start)];
            days = [...new Set(wds)].map(wd => addDays(monday, (wd + 6) % 7)).sort((a, b) => dayKey(a) - dayKey(b));
        } else if (freq === 'MONTHLY') {
            const t = start.mo - 1 + k * interval;
            days = inMonth(start.y + Math.floor(t / 12), (t % 12) + 1);
        } else if (freq === 'YEARLY') {
            const y = start.y + k * interval;
            days = (bymonth.length ? bymonth : [start.mo]).sort((a, b) => a - b).flatMap(mo => byday.length || bymonthday.length ? inMonth(y, mo) : (start.d <= daysIn(y, mo) ? [{ ...start, y, mo, d: start.d }] : []));
        } else return;
        if (bymonth.length && freq !== 'YEARLY') days = days.filter(d => bymonth.includes(d.mo));
        for (const d of days) if (dayKey(d) >= dayKey(start)) yield d;
    }
}

// Every time an event happens between two moments.
function instances(ev, from, to, moved) {
    const dur = durationMs(ev);
    const one = s => ({ summary: ev.summary || '(no title)', location: ev.location || '', description: ev.description || '', start: s, end: new Date(s.getTime() + dur), allDay: ev.start.allDay });
    if (!ev.rrule) { const s = toDate(ev.start); return s < to && s.getTime() + Math.max(dur, 1) > from ? [one(s)] : []; }
    const rule = Object.fromEntries(ev.rrule.split(';').map(p => p.split('=')).map(([k, v]) => [k.toUpperCase(), v]));
    const until = rule.UNTIL ? toDate(parseDT(rule.UNTIL) || {}) : null;
    const count = rule.COUNT ? +rule.COUNT : Infinity;
    const skip = new Set([...ev.exdates.map(d => toDate({ ...ev.start, ...d, tz: d.tz ?? ev.start.tz, allDay: ev.start.allDay }).getTime()), ...(moved || [])]);
    const out = [];
    let n = 0;
    for (const day of occurrenceDays(ev.start, rule)) {
        const s = toDate(day);
        if (++n > count || (until && s > until) || s >= to) break;
        if (s.getTime() + Math.max(dur, 1) <= from || skip.has(s.getTime())) continue;
        out.push(one(s));
        if (out.length > 500) break;
    }
    return out;
}

function eventsBetween(parsed, from, to) {
    // One-off changes to a repeating event replace that occurrence.
    const moved = new Map();
    for (const e of parsed.events) if (e.recurrenceId && e.uid) {
        if (!moved.has(e.uid)) moved.set(e.uid, []);
        moved.get(e.uid).push(toDate(e.recurrenceId).getTime());
    }
    return parsed.events.filter(e => e.status !== 'CANCELLED').flatMap(e => instances(e, from, to, !e.recurrenceId && moved.get(e.uid)));
}

// ── The feeds ───────────────────────────────────────────────────────────────

const cache = new Map(); // feed id → { at, parsed, error }

function cleanUrl(raw) {
    let u = String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://');
    let url;
    try { url = new URL(u); } catch { throw new Error("That isn't a web address. Copy the whole “Secret address in iCal format”."); }
    if (url.protocol !== 'https:') throw new Error('The address should start with https:// (or webcal://).');
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(url.hostname)) throw new Error('That address is on your own network, not a calendar service.');
    return url.href;
}

async function fetchFeed(feed, force = false) {
    const c = cache.get(feed.id);
    if (c && !force && Date.now() - c.at < CACHE_MS && !c.error) return c;
    try {
        const res = await fetch(feed.url, { headers: { 'User-Agent': 'DanGPT/1.0 (calendar)', 'Accept': 'text/calendar,*/*' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
        if (res.status === 404 || res.status === 403 || res.status === 401) throw new Error(`the calendar address was turned down (HTTP ${res.status}): it may have been reset in Google Calendar`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("that address didn't give a calendar (iCal) file");
        const entry = { at: Date.now(), parsed: parseICS(text) };
        cache.set(feed.id, entry);
        if (entry.parsed.name && feed.name !== entry.parsed.name) { feed.name = entry.parsed.name; save(); }
        return entry;
    } catch (err) {
        const msg = err.name === 'TimeoutError' ? 'the calendar took too long to answer' : err.message;
        if (c && !c.error) return { ...c, stale: msg }; // (an older copy beats nothing)
        const entry = { at: Date.now(), error: msg };
        cache.set(feed.id, entry);
        return entry;
    }
}

async function events(from, to) {
    const feeds = cfg.feeds;
    const loaded = await Promise.all(feeds.map(async f => ({ f, r: await fetchFeed(f) })));
    const errors = loaded.filter(x => x.r.error).map(x => `${x.f.name || 'a calendar'}: ${x.r.error}`);
    const list = loaded.filter(x => x.r.parsed).flatMap(x => eventsBetween(x.r.parsed, from, to).map(e => ({ ...e, cal: x.f.name || 'Calendar' })));
    list.sort((a, b) => a.start - b.start || b.allDay - a.allDay);
    return { list, errors };
}

const connected = () => cfg.feeds.length > 0;

async function addFeed(raw) {
    const url = cleanUrl(raw);
    if (cfg.feeds.some(f => f.url === url)) throw new Error("That calendar's already added.");
    const feed = { id: Date.now().toString(36), url, name: null, added: Date.now() };
    const r = await fetchFeed(feed, true);
    if (r.error) { cache.delete(feed.id); throw new Error(`Couldn't read it: ${r.error}.`); }
    cfg.feeds.push(feed);
    save();
    return feed;
}

function removeFeed(id) { cfg.feeds = cfg.feeds.filter(f => f.id !== id); cache.delete(id); save(); }
function setRemote(on) { cfg.remote = !!on; save(); }

// For Settings: never the address itself (it's a password, in effect).
async function status() {
    const feeds = await Promise.all(cfg.feeds.map(async f => {
        const r = await fetchFeed(f);
        let count = 0;
        if (r.parsed) { const now = new Date(); count = eventsBetween(r.parsed, midnight(now), midnight(now, 7)).length; }
        return { id: f.id, name: f.name || new URL(f.url).hostname, host: new URL(f.url).hostname, error: r.error || r.stale || null, nextWeek: count };
    }));
    return { feeds, remote: !!cfg.remote };
}

// ── Tools ───────────────────────────────────────────────────────────────────

const fn = (name, description, properties, required = []) =>
    ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const TOOLS = [
    fn('calendar_events', "Look at the user's calendar: what's on a day or over a few days, or when something is. Use for \"what's on tomorrow?\", \"am I free on Friday afternoon?\", \"when's my dentist appointment?\".", {
        date:   { type: 'string', description: 'The first day: "today", "tomorrow", a weekday, "this week", "next week", or YYYY-MM-DD. Default today.' },
        days:   { type: 'number', description: 'How many days to cover, from that date. Default 1 (7 for "this week").' },
        search: { type: 'string', description: 'Words to look for in events, e.g. "dentist", to find when something is (searches the next three months). Optional.' }
    }),
    fn('add_event', "Get an event ready to add to the user's Google Calendar. You can't add it yourself: this puts a link on the user's screen that opens Google Calendar with the event filled in, and they press Save.", {
        title:            { type: 'string', description: 'What it is, e.g. "Dentist"' },
        start:            { type: 'string', description: 'When it starts: "YYYY-MM-DD HH:MM", or e.g. "friday 3pm". Just a date (YYYY-MM-DD) for an all-day event.' },
        duration_minutes: { type: 'number', description: 'How long, in minutes. Default 60.' },
        location:         { type: 'string', description: 'Where. Optional.' },
        notes:            { type: 'string', description: 'Any details to keep with it. Optional.' }
    }, ['title', 'start'])
];

function timeRange(e) {
    if (e.allDay) {
        const days = Math.round((e.end - e.start) / 86400000);
        return days > 1 ? `all day (${days} days, to ${fmtDate(new Date(e.end - 86400000))})` : 'all day';
    }
    return e.end > e.start ? `${fmtTime(e.start)}–${fmtTime(e.end)}` : fmtTime(e.start);
}
const describe = (e, withDay, cals) => `${withDay ? `${fmtDate(e.start)}, ` : ''}${timeRange(e)}: ${e.summary}${e.location ? ` (at ${e.location})` : ''}${cals > 1 ? ` [${e.cal}]` : ''}`;

const gcalStamp = (d, allDay) => allDay ? isoDate(d).replace(/-/g, '') : `${isoDate(d).replace(/-/g, '')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;

const matches = (e, q) => {
    const words = [...wordSet(q)];
    const hay = norm(`${e.summary} ${e.location} ${e.description}`);
    return words.length > 0 && words.every(w => hay.includes(w.replace(/s$/, '')));
};

const RUN = {
    async calendar_events({ date, days, search } = {}) {
        const now = new Date();
        const cals = cfg.feeds.length;
        const note = errors => errors.length ? `\n(Couldn't read ${errors.join('; ')}.)` : '';
        // ("Am I free?" comes through as a search for "free": that's not a word to look for.)
        if (search && !norm(search).split(' ').some(w => !/^(free|busy|available|availability|any|anything|events?|plans?|on|schedule|calendar|diary|appointments?|meetings?|morning|afternoon|evening|today|tomorrow|week|weekend|day)$/.test(w))) search = '';
        if (search && !date) {
            const span = Number(days) > 0 ? Math.min(92, Math.round(Number(days))) : 92;
            const { list, errors } = await events(midnight(now), midnight(now, span));
            const hits = list.filter(e => matches(e, search) && e.end > now);
            if (!hits.length) return { content: `Nothing matching "${search}" in the next ${span === 92 ? 'three months' : `${span} days`}.${note(errors)}`, ok: !errors.length || list.length > 0 };
            return { content: `Events matching "${search}":\n${hits.slice(0, 10).map(e => `- ${describe(e, true, cals)}`).join('\n')}${note(errors)}`, ok: true };
        }
        const d = date ? parseDay(date, now) : { day: midnight(now), days: 1 };
        if (!d) return { content: `Couldn't tell which day "${date}" means. Give it as YYYY-MM-DD.` };
        const n = Math.min(31, Math.max(1, Math.round(Number(days) || d.days || 1)));
        const { list: all, errors } = await events(d.day, midnight(d.day, n));
        if (errors.length && errors.length === cals) return { content: `Couldn't read the calendar: ${errors.join('; ')}.` };
        const list = search ? all.filter(e => matches(e, search)) : all;
        const span = n === 1 ? `${fmtDay(d.day)} (${fmtDate(d.day)})` : `${fmtDate(d.day)} to ${fmtDate(midnight(d.day, n - 1))}`;
        if (!list.length) return { content: `Nothing in the calendar for ${span}${search ? ` matching "${search}"` : ''}.${note(errors)}`, ok: true };
        const lines = [];
        let lastDay = '';
        for (const e of list) {
            const shown = e.start < d.day ? d.day : e.start;
            if (n > 1 && isoDate(shown) !== lastDay) { lines.push(`${fmtDate(shown)}:`); lastDay = isoDate(shown); }
            lines.push(`- ${describe(e, false, cals)}${!e.allDay && e.end < now ? ' (already over)' : ''}`);
        }
        return { content: `Calendar for ${span}:\n${lines.join('\n')}${note(errors)}`, ok: true };
    },

    add_event({ title, start, duration_minutes, location, notes } = {}) {
        const summary = String(title || '').trim();
        if (!summary) return { content: 'The event needs a title.' };
        const now = new Date();
        const s = String(start || '').trim();
        const at = parseWhen(s, now);
        let dates, when;
        if (at) {
            if (at < new Date(now.getTime() - 5 * 60000)) return { content: `${fmtDay(at)} at ${fmtTime(at)} has already passed. Ask the user when they meant.` };
            const end = new Date(at.getTime() + Math.min(24 * 60 * 14, Math.max(5, Math.round(Number(duration_minutes) || 60))) * 60000);
            dates = `${gcalStamp(at)}/${gcalStamp(end)}`;
            when = `${fmtDay(at)} ${fmtTime(at)}–${fmtTime(end)}`;
        } else {
            const d = parseDay(s, now);
            if (!d || /\d{1,2}[:.]\d{2}|\d\s*(am|pm)/i.test(d.rest)) return { content: `Couldn't understand the time "${start}". Give it as "YYYY-MM-DD HH:MM", or just YYYY-MM-DD for all day.` };
            dates = `${gcalStamp(d.day, true)}/${gcalStamp(midnight(d.day, d.days), true)}`;
            when = `${fmtDay(d.day)}, all day`;
        }
        const url = 'https://calendar.google.com/calendar/render?' + new URLSearchParams({
            action: 'TEMPLATE', text: summary, dates, ctz: LOCAL_TZ,
            ...(location ? { location: String(location) } : {}), ...(notes ? { details: String(notes) } : {})
        });
        return {
            content: `It is NOT in the calendar yet. A link is now on the user's screen that opens Google Calendar with "${summary}", ${when}, filled in: tell them to open it and press Save.`,
            links: [{ title: `Add to Google Calendar: ${summary}, ${when}`, url }]
        };
    }
};

module.exports = { TOOLS, RUN, connected, remoteAllowed: () => !!cfg.remote, status, addFeed, removeFeed, setRemote, _test: { parseICS, eventsBetween, toDate } };
