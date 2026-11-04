'use strict';

// YouTube: searching it, and reading what's said in videos, all free with no key.
//   Search and video details: YouTube's own web API (youtubei), as its pages use it
//   Transcripts: the video's captions (its own, or YouTube's automatic ones) when it has them;
//     otherwise the audio is fetched with yt-dlp and transcribed on this PC's GPU by the Whisper
//     server (stt/stt_server.py, POST /youtube), in the background: long streams take a while.
// Transcripts are kept in ./data/transcripts/<id>.json, so a video is only ever transcribed once.
//
// For a question about a long video, the passages that best match it are picked out (the whole of
// a 5-hour stream won't fit in a small model), with links that jump to those moments.

const fs   = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DIR = process.env.TRANSCRIPTS_DIR || path.join(__dirname, 'data', 'transcripts');
const STT = process.env.STT_URL || 'http://127.0.0.1:8890';
const BUDGET = 10000; // characters of transcript given to the model at once
const events = new EventEmitter();

// ── Videos ──────────────────────────────────────────────────────────────────

function videoId(raw) {
    const s = String(raw || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    const m = s.match(/(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
    return m ? m[1] : null;
}

const watchUrl = (id, t) => `https://www.youtube.com/watch?v=${id}${t ? `&t=${Math.floor(t)}s` : ''}`;

function clock(s) {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function spokenLength(s) {
    if (s < 60) return `${Math.round(s)} seconds`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.floor(m / 60), r = m % 60;
    return `${h} hour${h > 1 ? 's' : ''}${r ? ` ${r} minute${r === 1 ? '' : 's'}` : ''}`;
}

async function youtubei(endpoint, body, client = 'WEB') {
    const clients = {
        WEB:     { context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'GB' } }, ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
        ANDROID: { context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'GB' } }, ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' }
    };
    const c = clients[client];
    const res = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': c.ua },
        body: JSON.stringify({ context: c.context, ...body }), signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`YouTube answered HTTP ${res.status}`);
    return res.json();
}

const text = t => t?.simpleText ?? (t?.runs || []).map(r => r.text).join('') ?? '';

async function search(query, n = 6) {
    const d = await youtubei('search', { query: String(query) });
    const out = [];
    (function walk(o) {
        if (!o || typeof o !== 'object' || out.length >= n) return;
        if (o.videoRenderer?.videoId) {
            const v = o.videoRenderer;
            const live = (v.badges || []).some(b => /live/i.test(JSON.stringify(b))) || !v.lengthText;
            out.push({ id: v.videoId, title: text(v.title), channel: text(v.ownerText), length: text(v.lengthText) || (live ? 'live' : ''), published: text(v.publishedTimeText), views: text(v.viewCountText) || text(v.shortViewCountText) });
            return;
        }
        for (const k in o) walk(o[k]);
    })(d);
    return out;
}

async function details(id) {
    const d = await youtubei('player', { videoId: id }, 'ANDROID');
    const v = d.videoDetails || {};
    const status = d.playabilityStatus?.status;
    if (status && status !== 'OK' && !v.title) throw new Error(d.playabilityStatus?.reason || `the video isn't available (${status})`);
    return {
        id, title: v.title || '(untitled)', channel: v.author || '', duration: +v.lengthSeconds || 0, live: !!v.isLive || !!v.isLiveContent && !+v.lengthSeconds,
        tracks: d.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
    };
}

// ── Transcripts ─────────────────────────────────────────────────────────────

const file = id => path.join(DIR, `${id}.json`);
function saved(id) { try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; } }
function keep(t) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file(t.id) + '.tmp', JSON.stringify(t));
    fs.renameSync(file(t.id) + '.tmp', file(t.id));
    return t;
}

// Its own English captions first, then YouTube's automatic ones, then any language.
async function captions(info) {
    const tracks = info.tracks;
    if (!tracks.length) return null;
    const rank = t => (t.languageCode.startsWith('en') ? 0 : 2) + (t.kind === 'asr' ? 1 : 0);
    const t = [...tracks].sort((a, b) => rank(a) - rank(b))[0];
    const res = await fetch(t.baseUrl.replace(/&fmt=[^&]*/, '') + '&fmt=json3', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const segments = (j?.events || []).filter(e => e.segs).map(e => ({
        start: e.tStartMs / 1000, end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
        text: e.segs.map(s => s.utf8).join('').replace(/\s+/g, ' ').trim()
    })).filter(s => s.text && s.text !== '[Music]');
    if (!segments.length) return null;
    return { id: info.id, title: info.title, channel: info.channel, duration: info.duration, source: t.kind === 'asr' ? 'automatic captions' : 'captions', language: t.languageCode, segments, at: Date.now() };
}

// Whisper jobs for videos without captions (they carry on in the Whisper server).
const jobs = new Map(); // id → { title, channel, duration, started, status, progress }

async function sttJob(method, id) {
    const res = await fetch(method === 'POST' ? `${STT}/youtube` : `${STT}/youtube/${id}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ video: id }) : undefined, signal: AbortSignal.timeout(10000)
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `the speech-recognition server answered HTTP ${res.status}`);
    return d;
}

async function startWhisper(info) {
    let j = jobs.get(info.id);
    if (!j) {
        const d = await sttJob('POST', info.id);
        j = { title: info.title, channel: info.channel, duration: info.duration, started: Date.now(), status: d.status };
        jobs.set(info.id, j);
        console.log(`  [youtube] no captions: transcribing "${info.title}" (${spokenLength(info.duration)}) with Whisper`);
        watch(info.id);
    }
    return j;
}

function watch(id) {
    const timer = setInterval(async () => {
        const j = jobs.get(id);
        if (!j) return clearInterval(timer);
        let d;
        try { d = await sttJob('GET', id); }
        catch (err) { if (Date.now() - j.started > 6 * 3600000) { jobs.delete(id); clearInterval(timer); } return; }
        Object.assign(j, { status: d.status, done: d.done_seconds || 0, download: d.download, error: d.error, duration: d.duration || j.duration, title: d.title || j.title });
        if (d.status === 'transcribing' && !j.transcribingSince) j.transcribingSince = Date.now();
        if (d.status === 'done') {
            clearInterval(timer);
            jobs.delete(id);
            keep({ id, title: j.title, channel: j.channel, duration: j.duration, source: 'Whisper on this PC', language: 'en', segments: d.segments, at: Date.now() });
            console.log(`  [youtube] transcript ready: "${j.title}" after ${Math.round((Date.now() - j.started) / 1000)} s`);
            events.emit('ready', { id, title: j.title });
        } else if (d.status === 'error') {
            clearInterval(timer);
            jobs.delete(id);
            events.emit('failed', { id, title: j.title, error: d.error });
        }
    }, 4000);
}

// Roughly how long a Whisper job has left, from how fast it's going (or a first guess).
function eta(j) {
    if (j.status === 'transcribing' && j.transcribingSince && j.done > 60) {
        const rate = j.done / Math.max(1, (Date.now() - j.transcribingSince) / 1000);
        if (rate > 1) return Math.max(10, (j.duration - j.done) / rate);
    }
    return 40 + j.duration / 120; // (download, then about 150× real time on an RTX 5090: a 5½-hour stream took under 3 minutes)
}

function jobStatus(j) {
    const pct = j.duration ? Math.min(99, Math.round(100 * (j.done || 0) / j.duration)) : 0;
    const left = Math.max(1, Math.round(eta(j) / 60));
    const what = j.status === 'transcribing' ? `${pct}% transcribed` : j.status === 'downloading' ? `downloading the audio${j.download != null ? ` (${j.download}%)` : ''}` : 'starting';
    return `${what}, about ${left} minute${left === 1 ? '' : 's'} to go`;
}

// ── Picking out the passages that matter ────────────────────────────────────

// Segments joined into passages of about a minute.
function passages(t, seconds = 60) {
    const out = [];
    let cur = null;
    for (const s of t.segments) {
        if (!cur || s.start - cur.start >= seconds) { cur = { start: s.start, text: '' }; out.push(cur); }
        cur.text += (cur.text ? ' ' : '') + s.text;
    }
    for (const p of out) p.text = p.text.replace(/\s+/g, ' ').replace(/(\S+ )\1{3,}/g, '$1$1').trim();
    return out;
}

const STOP = new Set('the a an and or but of to in on at for with about from by is are was were be been it its this that these those he she they them his her their you your i me my we our what which who whom when where why how did does do has have had say said says talk talked talking mention mentioned video stream any anything something there here just like really get got can could would should will tell know think thing things also than then them so if not no yes up out into over'.split(' '));
const stem = w => w.replace(/'s$/, '').replace(/(ing|ed|es|s)$/, '').slice(0, 7);
const terms = s => String(s || '').toLowerCase().match(/[\p{L}\p{N}']+/gu)?.filter(w => w.length > 1 && !STOP.has(w)).map(stem) || [];

function pick(t, question) {
    const ps = passages(t);
    const total = ps.reduce((n, p) => n + p.text.length + 10, 0);
    const line = p => `[${clock(p.start)}] ${p.text}`;
    if (total <= BUDGET) return { kind: 'whole', text: ps.map(line).join('\n'), top: [] };

    const q = [...new Set(terms(question))];
    if (q.length) {
        // BM25 over the passages
        const docs = ps.map(p => terms(p.text));
        const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
        const df = Object.fromEntries(q.map(w => [w, docs.filter(d => d.includes(w)).length]));
        const scores = docs.map(d => q.reduce((sum, w) => {
            const f = d.filter(x => x === w).length;
            if (!f) return sum;
            const idf = Math.log(1 + (docs.length - df[w] + 0.5) / (df[w] + 0.5));
            return sum + idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.length / avg));
        }, 0));
        const ranked = scores.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
        if (ranked.length) {
            const chosen = new Set();
            let used = 0;
            for (const [, i] of ranked) {
                for (const k of [i, i - 1, i + 1]) { // (a little either side, for context)
                    if (k < 0 || k >= ps.length || chosen.has(k)) continue;
                    if (used + ps[k].text.length > BUDGET) break;
                    chosen.add(k); used += ps[k].text.length + 10;
                }
                if (used > BUDGET * 0.9) break;
            }
            const idx = [...chosen].sort((a, b) => a - b);
            const parts = [];
            idx.forEach((k, j) => { if (j && idx[j - 1] !== k - 1) parts.push('…'); parts.push(line(ps[k])); });
            return { kind: 'matches', text: parts.join('\n'), top: ranked.slice(0, 3).map(([, i]) => ps[i]), found: ranked.length };
        }
    }
    // No question (or nothing matched): passages spread evenly through the video.
    const want = Math.max(1, Math.floor(BUDGET / (total / ps.length)));
    const step = ps.length / want;
    const idx = [...new Set(Array.from({ length: want }, (_, k) => Math.floor(k * step)))];
    return { kind: q.length ? 'nomatch' : 'overview', text: idx.map(k => line(ps[k])).join('\n…\n'), top: [] };
}

// ── Tools ───────────────────────────────────────────────────────────────────

const fn = (name, description, properties, required = []) =>
    ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const TOOLS = [
    fn('youtube_search', 'Search YouTube for videos. Use to find a video, stream or channel the user means, before reading it with youtube_video.', {
        query: { type: 'string', description: 'What to search for, e.g. "yungfika rage room stream"' }
    }, ['query']),
    fn('youtube_video', 'Read what is said in a YouTube video (its transcript) to answer a question about it, summarise it, or find the moment something was said. Give the question so the right parts of a long video are found.', {
        video:    { type: 'string', description: 'The video: its link or 11-character id (e.g. from youtube_search)' },
        question: { type: 'string', description: 'What the user wants to know from it, e.g. "what did he say about the H3 drama". Leave out for a general summary.' }
    }, ['video'])
];

async function runSearch({ query } = {}) {
    if (!String(query || '').trim()) return { content: 'What should I search YouTube for?' };
    let list;
    try { list = await search(query); }
    catch (err) { return { content: `YouTube search didn't work: ${err.message}` }; }
    if (!list.length) return { content: `No YouTube videos found for "${query}".`, ok: true };
    return {
        content: `YouTube results for "${query}" (most relevant first):\n${list.map((v, i) => `${i + 1}. "${v.title}" by ${v.channel}${v.length ? `, ${v.length}` : ''}${v.published ? `, ${v.published}` : ''} [id: ${v.id}]`).join('\n')}\nTo read one, call youtube_video with its id. The links are on the user's screen.`,
        links: list.map(v => ({ title: `${v.title} (${v.channel}${v.length ? `, ${v.length}` : ''})`, url: watchUrl(v.id) })),
        ok: true
    };
}

async function runVideo({ video, question } = {}) {
    let id = videoId(video);
    if (!id && String(video || '').trim()) { // (a title instead of an id: the best search hit)
        try { id = (await search(video, 1))[0]?.id; } catch {}
    }
    if (!id) return { content: `Couldn't tell which video "${video}" is. Use youtube_search first, then pass its id.` };

    let t = saved(id);
    if (!t) {
        const j = jobs.get(id);
        if (j) return { content: `"${j.title}" has no captions, so it's being transcribed on this PC: ${jobStatus(j)}. Tell the user; they'll get a message when it's ready, and can ask again then.`, ok: true };
        let info;
        try { info = await details(id); }
        catch (err) { return { content: `Couldn't open that video: ${err.message}.` }; }
        if (info.live) return { content: `"${info.title}" is live right now, so there's no transcript yet. It can be read once the stream has ended.` };
        try { t = await captions(info); } catch {}
        if (t) keep(t);
        else {
            try {
                const job = await startWhisper(info);
                const mins = Math.max(1, Math.round(eta(job) / 60));
                return {
                    content: `"${info.title}" (${spokenLength(info.duration)}) has no captions, so it's now being transcribed on this PC with Whisper. That takes about ${mins} minute${mins === 1 ? '' : 's'}. Tell the user; they'll get a message when it's ready, and can ask again then.`,
                    action: `🎬 Transcribing “${info.title}” (about ${mins} min)`,
                    links: [{ title: `${info.title} (${info.channel})`, url: watchUrl(id) }]
                };
            } catch (err) {
                return { content: `"${info.title}" has no captions, and transcribing it on this PC didn't start: ${err.message}.` };
            }
        }
    }

    const p = pick(t, question);
    const head = `"${t.title}" by ${t.channel} (${spokenLength(t.duration)}; transcript from ${t.source}).`;
    const how = {
        whole: 'The whole transcript:',
        matches: `The parts that best match "${question}" (${p.found} of ${passages(t).length} one-minute passages mention it; '…' marks skipped parts):`,
        nomatch: `Nothing in it matches "${question}" closely; here are parts spread through the video instead, so say if it isn't covered:`,
        overview: `It's long, so these are parts spread evenly through it (not everything):`
    }[p.kind];
    const links = [{ title: `${t.title} (${t.channel})`, url: watchUrl(id) }, ...p.top.map(x => ({ title: `▶ ${clock(x.start)}: “${x.text.slice(0, 70).trim()}…”`, url: watchUrl(id, x.start) }))];
    return {
        content: `${head}\n${how}\n${p.text}\n\n${p.kind === 'matches' ? "These parts were picked because they share words with the question, so they may not really be about it: only say the video covers it if the text plainly does; otherwise say it doesn't seem to, and quote what it does say. " : ''}Answer from this transcript only, and say when you're not sure. Auto-generated transcripts mishear names. [h:mm:ss] is where each part is; ${p.top.length ? 'links to the best-matching moments are on the user\'s screen.' : 'a link to the video is on the user\'s screen.'}`,
        links, ok: true
    };
}

// For a YouTube link pasted into the chat: its transcript, as the page text (or null to fall back).
async function forLink(url) {
    const id = videoId(url);
    if (!id) return null;
    let t = saved(id);
    if (!t) {
        const info = await details(id).catch(() => null);
        if (!info) return null;
        t = await captions(info).catch(() => null);
        if (t) keep(t);
        else return { title: info.title, text: `YouTube video "${info.title}" by ${info.channel} (${spokenLength(info.duration)}). It has no captions; to read it, use the youtube_video tool with id ${id} (it gets transcribed on the PC).` };
    }
    const p = pick(t, '');
    return { title: t.title, text: `YouTube video "${t.title}" by ${t.channel} (${spokenLength(t.duration)}), video id ${id}. Transcript (${t.source})${p.kind === 'whole' ? '' : ', parts spread through it (ask youtube_video about specific things)'}:\n${p.text}` };
}

const RUN = { youtube_search: runSearch, youtube_video: runVideo };

module.exports = { TOOLS, RUN, events, forLink, videoId, _test: { search, details, captions, pick, passages } };
