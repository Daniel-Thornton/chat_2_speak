'use strict';

// DanGPT server.
//
// Serves the app, keeps saved chats in ./chats, and sits in front of the local AI services:
//   Ollama        (LLM)            http://localhost:11434   — streamed to the browser as SSE
//   Breeze TTS 2  (voice)          http://127.0.0.1:7860    — streamed to the browser as raw PCM
//   Whisper STT   (speech-to-text) http://127.0.0.1:8890
//
// Breeze voices are "designed" once from a written description (voice design), saved in ./voices,
// and then cloned for every sentence, so the assistant sounds the same from line to line.

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const agent  = require('./agent');

const PORT       = Number(process.env.PORT) || 8788;
const OLLAMA_URL = new URL(process.env.OLLAMA_URL || 'http://localhost:11434');
const BREEZE_URL = new URL(process.env.BREEZE_URL || 'http://127.0.0.1:7860');
const STT_URL    = new URL(process.env.STT_URL    || 'http://127.0.0.1:8890');

const ROOT       = __dirname;
const CHATS_DIR  = path.join(ROOT, 'chats');
const VOICES_DIR = path.join(ROOT, 'voices');
for (const d of [CHATS_DIR, VOICES_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

// What every designed voice says once. Later sentences clone this clip, so it must be its exact transcript.
const VOICE_SAMPLE = "Oh, hey! It's really good to hear from you. I was just thinking about what we talked about last time. So, what's on your mind today?";
const BREEZE_RATE  = 24000;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':   '*',
    'Access-Control-Allow-Methods':  'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':  'Content-Type',
    'Access-Control-Expose-Headers': 'X-Sample-Rate',
    'Access-Control-Max-Age':        '86400'
};

const SEARCH_TOOL = {
    type: 'function',
    function: {
        name: 'web_search',
        description: 'Search the web for current information, recent news, or facts you are uncertain about. Use this whenever the user asks about something that may have changed recently or that you don\'t know with confidence.',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'The search query' } },
            required: ['query']
        }
    }
};

// Links for the user to click: shown on screen (in a voice chat nothing said can be clicked).
const SHOW_LINKS_TOOL = {
    type: 'function',
    function: {
        name: 'show_links',
        description: "Show web links on the user's screen as clickable links. Use it whenever the user asks for links, websites, listings, sources or where to find something (in a voice chat they can't click anything you say). Use real addresses: from web_search results, or ones you're certain exist. Never invent them.",
        parameters: {
            type: 'object',
            properties: {
                links: {
                    type: 'array',
                    description: 'The links to show',
                    items: {
                        type: 'object',
                        properties: {
                            title: { type: 'string', description: 'A short label, e.g. "The Bio Dude: arid substrate"' },
                            url:   { type: 'string', description: 'The full address' }
                        },
                        required: ['url']
                    }
                }
            },
            required: ['links']
        }
    }
};
const LINKS_PROMPT = "To give the user web links (sites, shops, listings, sources), call show_links: they appear on the user's screen as clickable links. Don't read web addresses out or write them in your reply; just say they're on screen. Never invent an address: use ones from web_search results, or that you're certain exist.";

// ── Helpers ─────────────────────────────────────────────────────────────────

function json(res, status, data) {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(data));
}

function readBody(req, limit = 50 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function readJson(req) {
    return JSON.parse((await readBody(req)).toString());
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A request to one of the local services. Resolves with the response (unread) once headers arrive.
function request(base, pathname, { method = 'GET', headers = {}, body = null, timeout = 0 } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: base.hostname,
            port:     base.port,
            path:     pathname,
            method,
            headers:  body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers
        }, resolve);
        req.on('error', reject);
        if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
        if (body) req.write(body);
        req.end();
    });
}

function collect(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

async function getJson(base, pathname, timeout = 1500) {
    const res = await request(base, pathname, { timeout });
    const body = await collect(res);
    let data = null;
    try { data = JSON.parse(body.toString()); } catch {}
    return { status: res.statusCode, data };
}

// ── Saved chats ─────────────────────────────────────────────────────────────

function safeChatPath(id) {
    if (!/^chat_\d+$/.test(id)) return null;
    return path.join(CHATS_DIR, id + '.json');
}

function listChats() {
    try {
        return fs.readdirSync(CHATS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const { messages, ...meta } = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
                    return { ...meta, messageCount: messages?.length || 0 };
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch { return []; }
}

async function handleChatsApi(req, res, pathname) {
    const id = pathname.length > '/api/chats'.length ? pathname.slice('/api/chats/'.length) : null;

    if (!id) {
        if (req.method === 'GET') return json(res, 200, listChats());
        return json(res, 405, { error: 'Method not allowed' });
    }

    const chatPath = safeChatPath(id);
    if (!chatPath) return json(res, 400, { error: 'Invalid chat ID' });

    if (req.method === 'GET') {
        try { return json(res, 200, JSON.parse(fs.readFileSync(chatPath, 'utf8'))); }
        catch { return json(res, 404, { error: 'Chat not found' }); }
    }

    if (req.method === 'POST') {
        let body;
        try { body = await readJson(req); }
        catch { return json(res, 400, { error: 'Invalid JSON' }); }
        fs.writeFileSync(chatPath, JSON.stringify(body, null, 2));
        return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
        try { fs.unlinkSync(chatPath); console.log(`  [chats] deleted ${id}`); } catch {}
        return json(res, 200, { ok: true });
    }

    json(res, 405, { error: 'Method not allowed' });
}

// ── Web search (Brave) ──────────────────────────────────────────────────────

function braveSearch(query, apiKey) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: 'api.search.brave.com',
            path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
            method: 'GET',
            headers: { 'Accept': 'application/json', 'Accept-Encoding': 'identity', 'X-Subscription-Token': apiKey }
        }, res => {
            collect(res).then(b => {
                try { resolve(JSON.parse(b.toString())); }
                catch { reject(new Error('Invalid JSON from Brave')); }
            }, reject);
        });
        req.on('error', reject);
        req.end();
    });
}

function formatSearchResults(data) {
    const results = data?.web?.results ?? [];
    if (results.length === 0) return 'No search results found.';
    return results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description || ''}`).join('\n\n');
}

// Runs one tool call. Returns { content } for the model, plus { action } (a line for the user) when
// something was actually done.
async function runTool(call, ctx) {
    const name = call.function?.name;
    let args = call.function?.arguments || {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (name === 'web_search') {
        if (!ctx.braveApiKey) return { content: 'Web search is not set up.' };
        try {
            console.log(`  [search] "${args.query}"`);
            const data = await braveSearch(args.query, ctx.braveApiKey);
            const links = (data?.web?.results ?? []).slice(0, 5).filter(r => r.url).map(r => ({ title: stripTags(r.title || ''), url: r.url }));
            for (const l of links) ctx.knownUrls?.add(normUrl(l.url));
            return { content: formatSearchResults(data), links };
        } catch (err) {
            return { content: `Search failed: ${err.message}` };
        }
    }
    if (name === 'show_links') return showLinks(args, ctx);
    const result = await agent.run(name, args, ctx);
    console.log(`  [tool] ${name} ${JSON.stringify(args).slice(0, 120)} -> ${String(result.content).slice(0, 120).replace(/\n/g, ' ')}`);
    return result;
}

const stripTags = s => String(s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

function normUrl(raw) {
    try {
        const u = new URL(raw);
        u.hash = '';
        return (u.origin.toLowerCase() + u.pathname.replace(/\/+$/, '') + u.search);
    } catch { return String(raw); }
}

// Every address that's come up in the conversation so far (pasted, searched for, already shown).
function knownUrls(messages) {
    const set = new Set();
    for (const m of messages) for (const u of String(m.content || '').match(URL_RE) || []) set.add(normUrl(u));
    return set;
}

// Does this address actually lead somewhere? (A made-up one usually doesn't resolve, or gives 404.)
async function linkWorks(raw) {
    try {
        let url = await checkPublicUrl(raw);
        for (let hop = 0; hop < 4; hop++) {
            const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0 (DanGPT link check)', 'Accept': 'text/html,*/*;q=0.8' } });
            res.body?.cancel().catch(() => {});
            const loc = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && loc) { url = await checkPublicUrl(new URL(loc, url).href); continue; }
            return res.status < 400 || [401, 403, 405, 429, 999].includes(res.status); // (some sites turn away anything that isn't a browser)
        }
        return true;
    } catch { return false; }
}

async function showLinks(args, ctx) {
    let list = args.links ?? args.urls ?? args;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = list.match(URL_RE) || []; } }
    if (!Array.isArray(list)) list = list && typeof list === 'object' && list.url ? [list] : [];
    list = list.map(l => (typeof l === 'string' ? { url: l } : l)).filter(l => l && l.url).slice(0, 10).map(l => {
        let url = String(l.url).trim();
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url.replace(/^\/+/, '');
        return { title: String(l.title || l.name || '').trim(), url };
    });
    if (!list.length) return { content: 'Not done. No links were given.' };
    const checked = await Promise.all(list.map(async l => ({ ...l, ok: ctx.knownUrls?.has(normUrl(l.url)) || await linkWorks(l.url) })));
    const shown = checked.filter(l => l.ok).map(({ title, url }) => ({ title: title || new URL(url).hostname.replace(/^www\./, ''), url }));
    const dropped = checked.filter(l => !l.ok).map(l => l.url);
    console.log(`  [links] showing ${shown.length}${dropped.length ? `, dropped ${dropped.length} that don't work: ${dropped.join(' ')}` : ''}`);
    if (!shown.length) return { content: `Not done. None of those links work (${dropped.join(', ')}), so nothing was shown. ${ctx.braveApiKey ? 'Use web_search to find real ones, or' : ''} tell the user you couldn't find working links.` };
    for (const l of shown) ctx.knownUrls?.add(normUrl(l.url));
    return {
        content: `Shown on the user's screen as clickable links: ${shown.map(l => l.title).join('; ')}.${dropped.length ? ` Left out because they don't work: ${dropped.join(', ')}.` : ''} Tell the user they're on screen; don't read the addresses out.`,
        links: shown,
        ok: true
    };
}

// What the page shows while a tool runs.
function toolLabel(name, args = {}) {
    switch (name) {
        case 'web_search':       return `Searching the web for “${args.query || ''}”…`;
        case 'show_links':       return 'Checking the links…';
        case 'set_timer':        return 'Setting a timer…';
        case 'set_reminder':     return 'Setting a reminder…';
        case 'list_reminders':   return 'Checking your reminders…';
        case 'cancel_reminder':  return 'Cancelling…';
        case 'remember':         return 'Making a note of that…';
        case 'forget':           return 'Forgetting that…';
        case 'add_to_list':
        case 'remove_from_list': return args.list ? `Updating the ${args.list} list…` : 'Updating your list…';
        case 'read_list':        return 'Looking at your lists…';
        case 'open_app':         return `Opening ${args.name || 'the app'}…`;
        case 'open_website':     return 'Opening the website…';
        case 'open_folder':      return `Opening ${args.folder || 'the folder'}…`;
        case 'get_weather':      return `Checking the weather${args.place ? ` in ${args.place}` : ''}…`;
        case 'travel_time':      return `Working out the route${args.to ? ` to ${args.to}` : ''}…`;
        case 'set_home':         return 'Saving where you live…';
        case 'calendar_events':  return 'Looking at your calendar…';
        case 'add_event':        return 'Getting the event ready…';
        case 'youtube_search':   return `Searching YouTube for “${args.query || ''}”…`;
        case 'youtube_video':    return 'Reading the video…';
        case 'keep_note':        return 'Saving it to Keep…';
        case 'keep_list_add':
        case 'keep_list_tick':   return args.list ? `Updating “${args.list}” in Keep…` : 'Updating Keep…';
        case 'keep_search':      return 'Looking in Keep…';
        default:                 return 'Using a tool…';
    }
}

// Did this request come from this PC itself, rather than through the Cloudflare tunnel?
// (cloudflared connects from 127.0.0.1 too, but adds the visitor's address in these headers.)
function isLocalRequest(req) {
    const h = req.headers;
    if (h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h['cdn-loop']) return false;
    const a = req.socket.remoteAddress || '';
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Did the request come from DanGPT's own page (or no web page at all), rather than some other
// website the user happens to have open? (Browsers send Origin on cross-site requests, and this
// server answers anyone, for the Server URL setting.) Private things, like the calendar, need this.
function isTrustedRequest(req) {
    const origin = req.headers.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// The tools to offer and the extra system-prompt text, for a model that can use tools.
async function agentSetup(req, model, braveApiKey, groups) {
    const ctx = { braveApiKey, local: isLocalRequest(req), trusted: isTrustedRequest(req), groups: Array.isArray(groups) ? groups : [], turn: crypto.randomBytes(6).toString('hex') };
    const info = await modelInfo(model);
    const canUse = !info || info.capabilities.includes('tools');
    const page = Array.isArray(groups); // (a request from the app's chat, not e.g. a chat title)
    const tools = canUse ? [...(braveApiKey ? [SEARCH_TOOL] : []), ...(page ? [SHOW_LINKS_TOOL] : []), ...agent.toolsFor(ctx.groups, ctx)] : [];
    let prompt = agent.promptFor(canUse ? ctx.groups : [], ctx);
    if (canUse && page) prompt += `\n\n${LINKS_PROMPT}`;
    return { ctx, tools, prompt };
}

// Small models sometimes answer "I've set that reminder" without calling the tool. When the user
// seems to be asking for an action, the start of the reply is held back until it's clear it isn't
// such a claim; if it is, that answer is dropped unseen and the model is asked again, once.
const ACTION_REQUEST = /\b(remind|reminder|timer|alarm|remember|forget|list|add|put|remove|delete|cancel|clear|open|launch|start|pull up|note|save|links?|urls?|websites?|sites?|listings?|sources?|where (?:can|do|could) i (?:get|buy|find)|calendar|diary|schedule|appointment|meeting|event|book|move|reschedule|push|bring forward|directions?)\b/i;
// Questions it must answer from a tool, not from what it imagines: weather, travel, the calendar.
// A reply that starts giving temperatures, journey times or calendar entries without a tool call
// is dropped and asked again, like a claim to have acted.
const INFO_REQUEST = /\b(weather|forecast|rain(?:ing|y)?|snow(?:ing)?|sunny|temperature|degrees|cold|warm|hot|windy|umbrella|coat|how (?:long|far)|travel|drive|driving|walk|cycle|journey|get to|calendar|diary|what's on|whats on|what is on|am i (?:free|busy)|my (?:day|week|morning|afternoon|evening)|appointments?|meetings?)\b/i;
const INFO_CLAIM = new RegExp([
    "\\b-?\\d+(?:\\.\\d+)?\\s*(?:°|degrees?|celsius|fahrenheit|mph|km\\/h|mm|%)",
    "\\b(?:about|around|roughly|takes?|it's)\\s+(?:an? |\\d+\\s*)(?:hours?|minutes?|mins?|miles?|km|kilomet(?:er|re)s?)\\b",
    "\\b\\d+(?:\\.\\d+)?\\s*(?:hours?|minutes?|mins?|miles?|km|kilomet(?:er|re)s?)\\s+(?:drive|walk|away|by car|on foot|journey)\\b",
    "\\b(?:you have|you've got|there's|there is|nothing)\\b[^.?!]{0,40}\\b(?:on your|in your)\\s+(?:calendar|diary|schedule)\\b",
    "\\byour (?:calendar|diary|schedule)\\s+(?:is|has|shows|looks)\\b",
    "\\b(?:don't|do not|can't|cannot|couldn't|could not)\\s+(?:see|find)\\b[^.?!]{0,60}\\b(?:in|on)\\s+your\\s+(?:calendar|diary|schedule)\\b",
    "\\bno (?:event|appointment|meeting)s?\\b[^.?!]{0,40}\\b(?:calendar|diary|schedule)\\b",
    "\\b(?:it'?s|it is|it will be|it'll be|expect)\\s+(?:going to be\\s+)?(?:sunny|cloudy|rainy|dry|wet|cold|warm|mild|chilly|clear|overcast|windy|freezing)\\b"
].join('|'), 'i');
const ACTION_CLAIM = new RegExp([
    "\\bI(?:'ve| have| will|'ll|'m going to| am going to)?\\s+(?:now\\s+|just\\s+|also\\s+|gone ahead and\\s+)?(?:set|added|add|opened|open|removed|remove|cancel+ed|cancel|remembered|remember|forgot|forgotten|forget|saved|save|noted|note|created|deleted|delete|put|started|start|cleared|clear|made a note|taken note|launched|launch)\\b",
    "\\b(?:has|have)\\s+been\\s+(?:set|added|opened|removed|cancel+ed|saved|cleared|deleted|forgotten|noted|created|launched)\\b",
    "^\\s*(?:done|all set|consider it done)\\b",
    "\\b(?:is|are)\\s+now\\s+(?:open|set|on (?:your|the))\\b",
    "\\bhere(?: are|'s| is)\\b[^.?!]{0,30}\\b(?:links?|listings?|sites?|websites?|sources?|options)\\b",
    "\\b(?:links?|listings?|urls?)\\b[^.?!]{0,40}\\b(?:on (?:your|the) screen|below|above)\\b",
    "\\bI(?:'ve| have)\\s+(?:got|found|pulled up|shared|sent|listed|included)\\s+(?:a few|some|several|you|three|two|four|five|the)\\b"
].join('|'), 'i');
const ACTION_NUDGE = "Nothing has actually been done yet: no tool call in this turn has succeeded at it. If the user is asking for something one of your tools does, call that tool now, with details that match what the user said and what the tool results show. If it can't be done, say so plainly.";

function addToSystem(messages, text) {
    if (!text) return;
    const i = messages.findIndex(m => m.role === 'system');
    if (i >= 0) messages[i] = { ...messages[i], content: `${messages[i].content}\n\n${text}` };
    else messages.unshift({ role: 'system', content: text });
}

// ── Chat (Ollama) ───────────────────────────────────────────────────────────

// One Ollama /api/chat call. Streaming: calls onChunk for each NDJSON object as it arrives.
// Resolves { status, data } (non-streaming) or { status, error } on failure. abort() hangs up,
// which makes Ollama stop generating.
function ollamaChat(body, onChunk = null) {
    let upstream = null;
    const promise = new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        upstream = http.request({
            hostname: OLLAMA_URL.hostname,
            port:     OLLAMA_URL.port || 11434,
            path:     '/api/chat',
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, res => {
            if (res.statusCode !== 200 || !onChunk) {
                collect(res).then(b => {
                    let data = null;
                    try { data = JSON.parse(b.toString()); } catch {}
                    resolve({ status: res.statusCode, data, error: data?.error || (res.statusCode !== 200 ? b.toString() : null) });
                }, reject);
                return;
            }
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', s => {
                buf += s;
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    try { onChunk(JSON.parse(line)); } catch {}
                }
            });
            res.on('end', () => {
                if (buf.trim()) { try { onChunk(JSON.parse(buf)); } catch {} }
                resolve({ status: 200 });
            });
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('aborted')));
            res.on('close', () => reject(new Error('closed'))); // (no-op once it has ended normally)
        });
        upstream.on('error', reject);
        upstream.write(payload);
        upstream.end();
    });
    promise.abort = () => upstream?.destroy();
    return promise;
}

// What each model accepts for `think`, from /api/show: e.g. [false] (can't think), [false, true]
// (qwen3.5), ['low', 'medium', 'high'] (gpt-oss). Cached per model.
// Also whether it can see images ('vision' in its capabilities).
const modelInfos = new Map();
async function modelInfo(model) {
    if (modelInfos.has(model)) return modelInfos.get(model);
    let info = null;
    try {
        const body = JSON.stringify({ model });
        const res = await request(OLLAMA_URL, '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeout: 3000 });
        const data = JSON.parse((await collect(res)).toString());
        if (res.statusCode === 200) info = { thinking: data.thinking || { values: [false], default: false }, capabilities: data.capabilities || [] };
    } catch {}
    if (info) modelInfos.set(model, info);
    return info;
}

async function thinkingFor(model) {
    return (await modelInfo(model))?.thinking || null;
}

// A model that can't see images would refuse (or ignore) them: take them out, tell the model
// they were there, and return a notice for the user.
async function adaptImages(model, messages) {
    const count = messages.reduce((n, m) => n + (m.images?.length || 0), 0);
    if (!count) return null;
    const info = await modelInfo(model);
    if (!info || info.capabilities.includes('vision')) return null;
    for (const [i, m] of messages.entries()) {
        if (!m.images?.length) continue;
        const { images, ...rest } = m;
        messages[i] = { ...rest, content: `${rest.content || ''}\n\n[The user attached ${images.length} image${images.length > 1 ? 's' : ''} here, but you can't see images.]`.trim() };
    }
    return `${model} can't see images, so it only knows you shared ${count === 1 ? 'one' : count}. Pick a vision model (e.g. qwen3.5:4b or gemma4:e4b) in Settings to discuss them.`;
}

// Turn the app's request (true / false / a level) into something this model accepts.
async function adaptThink(body) {
    if (!('think' in body) || !body.model) return;
    const info = await thinkingFor(body.model);
    if (!info) return; // unknown: send as asked (and retry without it if refused)
    const values = info.values || [];
    const levels = values.filter(v => typeof v === 'string');
    const want = body.think;
    if (!values.some(v => v !== false)) delete body.think;                 // can't think at all
    else if (want === false && !values.includes(false)) body.think = levels[0] ?? info.default; // can't switch off: least thinking
    else if (want === true && levels.length) body.think = info.default;     // has levels: its default level
    else if (typeof want === 'string' && !values.includes(want)) body.think = values.includes(true) ? true : info.default;
}

// Models that can't "think" refuse { think: false }; retry such a request without it.
async function ollamaChatCompat(body, onChunk) {
    let call = ollamaChat(body, onChunk);
    let result = await call;
    if (result.status === 400 && 'think' in body && /think/i.test(result.error || '')) {
        const { think, ...rest } = body;
        call = ollamaChat(rest, onChunk);
        result = await call;
    }
    return result;
}

async function handleChat(req, res) {
    let body;
    try { body = await readJson(req); }
    catch { return json(res, 400, { error: 'Invalid JSON body' }); }

    const { braveApiKey, stream, agentTools, ...ollamaBody } = body;
    if (!ollamaBody.keep_alive) ollamaBody.keep_alive = '30m';
    const messages = [...(ollamaBody.messages || [])];
    const { ctx, tools, prompt } = await agentSetup(req, ollamaBody.model, braveApiKey, agentTools);
    ctx.knownUrls = knownUrls(messages);
    if (tools.length) ollamaBody.tools = tools;
    if (agentTools) addToSystem(messages, prompt); // (not for chat titles, which send no tool list)
    await adaptThink(ollamaBody);
    const notice = await adaptImages(ollamaBody.model, messages);

    if (!stream) return handleChatOnce(res, ollamaBody, messages, ctx);

    // ── Streaming: Server-Sent Events, one per token ──
    res.writeHead(200, {
        'Content-Type':      'text/event-stream; charset=utf-8',
        'Cache-Control':     'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection':        'keep-alive',
        ...CORS_HEADERS
    });
    res.flushHeaders?.();
    const send = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    if (notice) send({ type: 'notice', text: notice });

    let closed = false;
    let current = null;
    res.on('close', () => { closed = true; current?.abort(); });

    const t0 = Date.now();
    let first = 0;
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    ctx.lastUser = typeof lastUser === 'string' ? lastUser : '';
    const infoTools = tools.some(t => /^(get_weather|travel_time|calendar_events)$/.test(t.function.name));
    const infoAsked = infoTools && INFO_REQUEST.test(ctx.lastUser);
    const guard = tools.length > 0 && ctx.groups.length > 0 && (ACTION_REQUEST.test(ctx.lastUser) || infoAsked);
    const isClaim = text => ACTION_CLAIM.test(text) || (infoTools && INFO_CLAIM.test(text)); // (only checked while guarding)
    let acted = false, retried = false; // acted: a tool has actually done something this turn
    const ran = new Map(); // identical calls in one turn (some models repeat them) run once
    try {
        // Agentic loop: at most 3 rounds of tool calls before the final answer.
        for (let turn = 0; turn < 4 && !closed; turn++) {
            const toolCalls = [];
            let content = '';
            let held = guard && !acted && !retried ? '' : null; // (null: not holding back)
            let claimed = false;
            const release = () => { if (held) send({ type: 'token', text: held }); held = null; };
            const onChunk = chunk => {
                if (claimed) return;
                if (chunk.error) { send({ type: 'error', error: chunk.error }); return; }
                const m = chunk.message;
                if (!m) return;
                if (m.thinking) send({ type: 'thinking', text: m.thinking });
                if (m.content) {
                    if (!first) first = Date.now();
                    content += m.content;
                    if (held === null) send({ type: 'token', text: m.content });
                    else {
                        held += m.content;
                        if (isClaim(held)) { claimed = true; current.abort(); return; }
                        if ((/[.!?\n]/.test(held) && held.length > 30) || held.length > 160) release();
                    }
                }
                if (m.tool_calls?.length) toolCalls.push(...m.tool_calls);
            };
            const opts = { ...ollamaBody, messages, stream: true };
            if (turn === 3) delete opts.tools; // last round: answer, no more tools
            current = ollamaChat(opts, onChunk);
            let result;
            try {
                result = await current;
                if (result.status === 400 && 'think' in opts && /think/i.test(result.error || '')) {
                    const { think, ...rest } = opts;
                    current = ollamaChat(rest, onChunk);
                    result = await current;
                }
            } catch (err) {
                if (!claimed) {
                    if (!closed) send({ type: 'error', error: 'Ollama is not reachable on this PC.' });
                    break;
                }
            }
            if (claimed) {
                console.log(`  [guard] said it acted, or gave facts, without a tool ("${content.trim().slice(0, 70)}"), asking again`);
                retried = true;
                messages.push({ role: 'system', content: ACTION_NUDGE });
                turn--;
                continue;
            }
            release();
            // Nothing at all (a tool call the model garbled, which Ollama drops): try once more.
            if (result.status === 200 && !toolCalls.length && !content.trim() && !retried && !closed) {
                console.log(`  [chat] ${ollamaBody.model}: empty reply, asking again`);
                retried = true;
                turn--;
                continue;
            }
            if (result.status !== 200) {
                send({ type: 'error', error: result.error || `Ollama returned HTTP ${result.status}` });
                break;
            }
            if (!toolCalls.length) {
                send({ type: 'done' });
                const ttft = first ? `${first - t0} ms to first token, ` : '';
                console.log(`  [chat] ${ollamaBody.model}: ${ttft}${content.length} chars`);
                break;
            }
            // The calls and their results go back to the page too, to keep in the chat history:
            // a model that can't see how it did things last time starts claiming it did them
            // without calling the tools.
            const round = [{ role: 'assistant', content, tool_calls: toolCalls }];
            for (const call of toolCalls) {
                const name = call.function?.name;
                send({ type: 'tool', name, label: toolLabel(name, call.function?.arguments), query: call.function?.arguments?.query || '' });
                const key = name + JSON.stringify(call.function?.arguments || {});
                const r = ran.has(key) ? { content: `(Already done a moment ago, not repeated.) ${ran.get(key).content}` } : await runTool(call, ctx);
                if (!ran.has(key)) ran.set(key, r);
                if (r.action || r.ok) acted = true; // (ok: nothing needed doing, e.g. already remembered)
                if (r.action) send({ type: 'action', name, text: r.action });
                if (r.links?.length) {
                    for (const l of r.links) ctx.knownUrls?.add(normUrl(l.url));
                    send({ type: 'links', kind: name === 'web_search' ? 'sources' : 'shared', links: r.links });
                }
                round.push({ role: 'tool', content: String(r.content), tool_name: name });
            }
            messages.push(...round);
            send({ type: 'trace', messages: round.map(m => m.role === 'tool' && m.content.length > 1500 ? { ...m, content: m.content.slice(0, 1500) + '…' } : m) });
        }
    } finally {
        res.end();
    }
}

// Non-streaming (used for chat titles): the old request/response behaviour.
async function handleChatOnce(res, ollamaBody, messages, ctx) {
    for (let turn = 0; turn < 4; turn++) {
        let result;
        try { result = await ollamaChatCompat({ ...ollamaBody, messages, stream: false }); }
        catch { return json(res, 502, { error: 'Ollama is not reachable on this PC.' }); }
        if (result.status !== 200) return json(res, result.status, result.data || { error: result.error });

        const msg = result.data?.message;
        if (!msg?.tool_calls?.length) return json(res, 200, result.data);

        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
        for (const call of msg.tool_calls) messages.push({ role: 'tool', content: String((await runTool(call, ctx)).content), tool_name: call.function?.name });
    }
    json(res, 500, { error: 'Tool loop limit reached without a final response.' });
}

// ── Breeze TTS 2 ────────────────────────────────────────────────────────────

// Breeze runs one request at a time (it answers 409 to a second), so requests queue here.
// Each holds the lock until its whole response has been read, or until it's hung up on.
let breezeChain = Promise.resolve();
function withBreeze(fn) {
    const run = breezeChain.then(fn, fn);
    breezeChain = run.catch(() => {});
    return run;
}

function multipart(fields, files = {}) {
    const boundary = '----breeze' + crypto.randomBytes(12).toString('hex');
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    for (const [k, { name, data, type }] of Object.entries(files)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`));
        parts.push(data, Buffer.from('\r\n'));
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// POST /v1/audio/speech; resolves with the streaming PCM response. Waits out a 409 (Breeze still
// releasing a request that was just hung up on). Call inside withBreeze().
async function breezeSpeech(fields, files, isCancelled = () => false) {
    const { body, contentType } = multipart(fields, files);
    for (let attempt = 0; ; attempt++) {
        if (isCancelled()) throw new Error('cancelled');
        let res;
        try {
            res = await request(BREEZE_URL, '/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': contentType }, body });
        } catch (err) {
            const e = new Error('Breeze TTS is not reachable on port 7860. Is it running?');
            e.status = 502;
            throw e;
        }
        if (res.statusCode === 200) return res;
        const detail = (await collect(res)).toString().slice(0, 300);
        if (res.statusCode === 409 && attempt < 40) { await sleep(100); continue; }
        const e = new Error(res.statusCode === 503 ? 'Breeze TTS is still warming up.' : `Breeze TTS ${res.statusCode}: ${detail}`);
        e.status = res.statusCode === 503 ? 503 : 502;
        throw e;
    }
}

function wavFromPcm(pcm, rate) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([h, pcm]);
}

function voiceKey(instruction, seed) {
    return crypto.createHash('sha1').update(`${instruction}|${seed}|${VOICE_SAMPLE}`).digest('hex').slice(0, 16);
}

const designing = new Map(); // voice key -> promise of its WAV

// A voice as a WAV clip of VOICE_SAMPLE: designed from its description the first time, then kept.
function designedVoice(instruction, seed) {
    const key = voiceKey(instruction, seed);
    const file = path.join(VOICES_DIR, key + '.wav');
    if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file));
    if (designing.has(key)) return designing.get(key);

    const job = withBreeze(async () => {
        const t0 = Date.now();
        const res = await breezeSpeech({ text: VOICE_SAMPLE, instruction, cfg_scale: 4, seed });
        const rate = Number(res.headers['x-sample-rate']) || BREEZE_RATE;
        const pcm = await collect(res);
        const wav = wavFromPcm(pcm.subarray(0, pcm.length & ~1), rate);
        fs.writeFileSync(file + '.tmp', wav);
        fs.renameSync(file + '.tmp', file);
        fs.writeFileSync(path.join(VOICES_DIR, key + '.json'), JSON.stringify({ instruction, seed, sample: VOICE_SAMPLE }, null, 2));
        console.log(`  [voice] designed a voice in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${instruction.slice(0, 70)}`);
        return wav;
    }).finally(() => designing.delete(key));
    designing.set(key, job);
    return job;
}

// A voice is either designed from a description, or cloned from the user's own audio sample
// (`clone` = the sample's id, `refText` = what is said in it).
function parseVoice(body) {
    const instruction = String(body.instruction || '').trim().slice(0, 600);
    const seed = Math.abs(parseInt(body.seed, 10) || 0) % 1000000;
    const clone = /^[0-9a-f]{16}$/.test(body.clone) ? body.clone : '';
    const refText = clone ? String(body.refText || '').replace(/\s+/g, ' ').trim().slice(0, 600) : '';
    return { instruction, seed, clone, refText };
}

function cloneFile(id) {
    return path.join(VOICES_DIR, `clone-${id}.wav`);
}

// The browser sends the user's voice sample as a short mono 16-bit WAV (it does the decoding and
// trimming); keep it so every sentence can be cloned from it.
async function handleCloneSample(req, res) {
    let wav;
    try { wav = await readBody(req, 8 * 1024 * 1024); }
    catch { return json(res, 413, { error: 'That audio sample is too large.' }); }
    if (wav.length < 1000 || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE') {
        return json(res, 400, { error: 'The sample must be a WAV file.' });
    }
    const id = crypto.createHash('sha1').update(wav).digest('hex').slice(0, 16);
    const file = cloneFile(id);
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file + '.tmp', wav);
        fs.renameSync(file + '.tmp', file);
        console.log(`  [voice] saved a voice sample (${(wav.length / 1024).toFixed(0)} KB)`);
    }
    json(res, 200, { ok: true, id });
}

// Make sure a voice is designed (called when conversation mode opens, or the voice changes).
async function handleVoice(req, res) {
    let body;
    try { body = await readJson(req); }
    catch { return json(res, 400, { error: 'Invalid JSON body' }); }
    const { instruction, seed, clone } = parseVoice(body);
    if (clone) {
        return fs.existsSync(cloneFile(clone)) ? json(res, 200, { ok: true, key: clone })
                                               : json(res, 404, { error: 'The voice sample is missing from this server. Upload it again.' });
    }
    if (!instruction) return json(res, 400, { error: 'No voice description' });
    try {
        await designedVoice(instruction, seed);
        json(res, 200, { ok: true, key: voiceKey(instruction, seed) });
    } catch (err) {
        json(res, err.status || 502, { error: err.message });
    }
}

// One chunk of speech (a sentence or a few), streamed back as raw s16le mono PCM while Breeze
// synthesises it. Hanging up stops synthesis and frees Breeze for the next request.
async function handleTTS(req, res) {
    let body;
    try { body = await readJson(req); }
    catch { return json(res, 400, { error: 'Invalid JSON body' }); }

    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 800);
    if (!text) return json(res, 400, { error: 'No text provided' });
    const { instruction, seed, clone, refText } = parseVoice(body);

    let hungUp = false;
    let upstream = null;
    res.on('close', () => {
        if (!res.writableFinished) hungUp = true;
        upstream?.destroy();
    });

    try {
        let fields = { text, seed, cfg_scale: 1 };
        let files = {};
        if (clone) {
            if (!refText) return json(res, 400, { error: 'The voice sample needs a transcript.' });
            let ref;
            try { ref = fs.readFileSync(cloneFile(clone)); }
            catch { return json(res, 404, { error: 'The voice sample is missing from this server. Upload it again.' }); }
            fields.ref_text = refText;
            files = { ref_audio: { name: 'voice.wav', data: ref, type: 'audio/wav' } };
        } else if (instruction) {
            const ref = await designedVoice(instruction, seed);
            fields.ref_text = VOICE_SAMPLE;
            files = { ref_audio: { name: 'voice.wav', data: ref, type: 'audio/wav' } };
        }
        if (hungUp) return;
        await withBreeze(async () => {
            if (hungUp) return;
            const t0 = Date.now();
            upstream = await breezeSpeech(fields, files, () => hungUp);
            if (hungUp) { upstream.destroy(); return; }
            res.writeHead(200, {
                'Content-Type':  'application/octet-stream',
                'Cache-Control': 'no-cache, no-transform',
                'X-Sample-Rate': upstream.headers['x-sample-rate'] || String(BREEZE_RATE),
                ...CORS_HEADERS
            });
            res.flushHeaders?.();
            let firstAt = 0;
            let bytes = 0;
            await new Promise(resolve => {
                upstream.on('data', c => {
                    if (!firstAt) firstAt = Date.now();
                    bytes += c.length;
                    if (!res.write(c)) { upstream.pause(); res.once('drain', () => upstream.resume()); }
                });
                upstream.on('end', resolve);
                upstream.on('error', resolve);
                upstream.on('close', resolve);
            });
            res.end();
            const secs = bytes / 2 / (Number(upstream.headers['x-sample-rate']) || BREEZE_RATE);
            console.log(`  [tts] ${firstAt ? firstAt - t0 : '-'} ms to first audio, ${secs.toFixed(1)}s of speech in ${((Date.now() - t0) / 1000).toFixed(1)}s${hungUp ? ' (cut off)' : ''}: "${text.slice(0, 50)}"`);
        });
    } catch (err) {
        if (!hungUp) json(res, err.status || 502, { error: err.message });
    }
}

// ── Speech-to-text (local Whisper) ──────────────────────────────────────────

async function handleTranscribe(req, res, search) {
    let audio;
    try { audio = await readBody(req); }
    catch { return json(res, 400, { error: 'Could not read audio' }); }
    if (!audio.length) return json(res, 400, { error: 'No audio data' });
    try {
        const up = await request(STT_URL, '/transcribe' + (search || ''), {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio, timeout: 30000
        });
        const data = (await collect(up)).toString();
        res.writeHead(up.statusCode, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(data);
    } catch {
        json(res, 502, { error: 'Speech recognition (Whisper) is not running on port 8890.' });
    }
}

// ── Links pasted into the chat: fetch the page so the model can read it ─────

const dns = require('dns').promises;
const net = require('net');
const FETCH_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_MAX_CHARS = 12000;

// The server is reachable through the tunnel, so it must not become a way into this PC's own
// network: only public addresses are fetched.
function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
    }
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

async function checkPublicUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { throw new Error("That isn't a valid link."); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https links can be read.');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`Couldn't find ${host}.`);
    if (addrs.some(a => isPrivateAddress(a.address))) throw new Error("Links to private or local addresses aren't fetched.");
    return u;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };
function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            try { return String.fromCodePoint(n); } catch { return m; }
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function htmlToText(html) {
    const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
    const desc = decodeEntities(html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '').trim();
    let body = html.match(/<(main|article)\b[\s\S]*<\/\1>/i)?.[0] || html.match(/<body\b[\s\S]*<\/body>/i)?.[0] || html;
    body = body
        .replace(/<!--[\s\S]*?-->/g, ' ')
        // Empty out quoted attribute values: they can contain '>' (Wikipedia's data-mw JSON does),
        // which would end a tag early for the simple patterns below.
        .replace(/<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (m, tag, attrs) => `<${tag}${attrs.replace(/"[^"]*"|'[^']*'/g, '""')}>`)
        .replace(/<(script|style|noscript|svg|template|iframe|form|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');

    // Readable content first: paragraphs, headings, quotes, code, and list items long enough not
    // to be menus (language lists, nav links). Fall back to all the text if that finds little.
    const strip = s => decodeEntities(s.replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .replace(/\[\s*(?:\d+|[a-z]|citation needed|note \d+)\s*\]/gi, '') // citation markers: [ 4 ]
        .replace(/\s+([.,;:!?)\]])/g, '$1').replace(/([(\[])\s+/g, '$1')
        .trim();
    const blocks = [];
    for (const m of body.matchAll(/<(h[1-4]|p|li|pre|blockquote|dd|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
        const tag = m[1].toLowerCase();
        const t = tag === 'pre' ? decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim() : strip(m[2]);
        if (!t || (tag === 'li' && t.length < 40)) continue;
        blocks.push(tag[0] === 'h' ? `\n## ${t}` : tag === 'li' ? `• ${t}` : t);
    }
    const main = blocks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (main.length > 400) return { title, text: desc && !main.includes(desc) ? `${desc}\n\n${main}` : main };

    body = body
        .replace(/<(br|hr)\b[^>]*>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n• ')
        .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|header|table|ul|ol|dd|dt)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    const text = decodeEntities(body).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { title, text: desc && !text.includes(desc) ? `${desc}\n\n${text}` : text };
}

async function fetchUrl(raw) {
    if (agent.youtube.videoId(raw)) {
        const yt = await agent.youtube.forLink(raw).catch(() => null);
        if (yt) return { kind: 'page', url: String(raw).trim(), title: yt.title, text: yt.text.length > FETCH_MAX_CHARS ? yt.text.slice(0, FETCH_MAX_CHARS) + '…' : yt.text, truncated: yt.text.length > FETCH_MAX_CHARS };
    }
    let url = await checkPublicUrl(raw);
    let res;
    for (let hop = 0; ; hop++) { // follow redirects by hand, checking each address
        res = await fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(10000),
            headers: { 'User-Agent': 'Mozilla/5.0 (DanGPT link reader)', 'Accept': 'text/html,application/xhtml+xml,text/plain,application/json,image/*;q=0.8,*/*;q=0.5' }
        });
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc && hop < 5) { url = await checkPublicUrl(new URL(loc, url).href); continue; }
        break;
    }
    if (!res.ok) throw new Error(`The page answered HTTP ${res.status}.`);
    const type = (res.headers.get('content-type') || '').toLowerCase();

    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > FETCH_MAX_BYTES) break;
    }
    const buf = Buffer.concat(chunks);

    if (type.startsWith('image/')) {
        if (size > FETCH_MAX_BYTES) throw new Error('That image is too large.');
        return { kind: 'image', url: url.href, mime: type.split(';')[0], base64: buf.toString('base64') };
    }
    if (type.includes('pdf')) throw new Error("PDFs can't be read yet; paste the text instead.");
    const str = buf.toString('utf8');
    let { title, text } = /html|xml/.test(type) || /^\s*</.test(str) ? htmlToText(str) : { title: '', text: str.trim() };
    const truncated = text.length > FETCH_MAX_CHARS;
    if (truncated) text = text.slice(0, FETCH_MAX_CHARS) + '…';
    if (!text) throw new Error("Couldn't find any readable text on that page.");
    return { kind: 'page', url: url.href, title: title || url.hostname, text, truncated };
}

async function handleFetchUrl(req, res) {
    let body;
    try { body = await readJson(req); }
    catch { return json(res, 400, { error: 'Invalid JSON body' }); }
    const t0 = Date.now();
    try {
        const page = await fetchUrl(String(body.url || '').trim());
        console.log(`  [link] ${page.kind} in ${Date.now() - t0} ms: ${page.url.slice(0, 80)}${page.text ? ` (${page.text.length} chars)` : ''}`);
        json(res, 200, page);
    } catch (err) {
        const msg = err.name === 'TimeoutError' ? 'The page took too long to answer.' : err.message;
        console.log(`  [link] failed: ${String(body.url).slice(0, 80)}: ${msg}`);
        json(res, 422, { error: msg });
    }
}

// ── Reminders going off: pushed to every open page (Server-Sent Events) ──────

const eventClients = new Set();

function handleEvents(req, res) {
    res.writeHead(200, {
        'Content-Type':      'text/event-stream; charset=utf-8',
        'Cache-Control':     'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        'Connection':        'keep-alive',
        ...CORS_HEADERS
    });
    res.write('retry: 3000\n\n');
    eventClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000); // (keeps the tunnel from closing it)
    req.on('close', () => { clearInterval(ping); eventClients.delete(res); });
    res.write(`data: ${JSON.stringify({ type: 'timers', list: agent.timerList(), now: Date.now() })}

`);
    for (const a of agent.undelivered()) { // went off while no page was open
        res.write(`data: ${JSON.stringify({ type: 'reminder', ...a, late: true })}\n\n`);
        agent.markDelivered(a.id);
    }
}

agent.events.on('reminder', a => {
    if (!eventClients.size) { // nobody's looking: a Windows notification instead (and the page says it later)
        agent.toast(a.kind === 'timer' ? 'Timer' : a.kind === 'transcript' ? 'Transcript ready' : 'Reminder', a.say);
        return;
    }
    for (const res of eventClients) res.write(`data: ${JSON.stringify({ type: 'reminder', ...a })}\n\n`);
    agent.markDelivered(a.id);
});

// Timers and reminders set, cancelled or gone off: every open page shows the current list.
agent.events.on('timers', () => {
    const msg = `data: ${JSON.stringify({ type: 'timers', list: agent.timerList(), now: Date.now() })}

`;
    for (const res of eventClients) res.write(msg);
});

// A YouTube video without captions has finished being transcribed (or couldn't be).
for (const [name, say] of [
    ['ready',  v => `The transcript of “${v.title}” is ready, so you can ask me about it now.`],
    ['failed', v => `I couldn't transcribe “${v.title}”: ${v.error || 'something went wrong'}.`]
]) agent.youtube.events.on(name, v => agent.events.emit('reminder', { id: `yt-${v.id}-${Date.now()}`, kind: 'transcript', text: v.title, say: say(v), due: Date.now(), late: false }));

// Settings → Tools: what's remembered, the lists, upcoming reminders; and deleting them.
async function handleAgentApi(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/api/agent') return json(res, 200, agent.snapshot());
    if (req.method === 'POST' && pathname === '/api/agent/home') {
        if (!isTrustedRequest(req)) return json(res, 403, { error: 'Not from this app' });
        const { place } = await readJson(req);
        try { await agent.setHome(place); }
        catch (err) { return json(res, 400, { error: err.message }); }
        return json(res, 200, agent.snapshot());
    }
    const m = pathname.match(/^\/api\/agent\/(memory|lists|reminders|home)\/(.+)$/);
    if (req.method === 'DELETE' && m) {
        agent.remove(m[1], decodeURIComponent(m[2]));
        return json(res, 200, agent.snapshot());
    }
    json(res, 404, { error: 'Not found' });
}

// Settings → Tools → Calendar: the secret iCal addresses. Only from this PC, from DanGPT's own page;
// the addresses themselves never go back to the browser.
async function handleCalendarApi(req, res, pathname) {
    const cal = agent.cal;
    const reply = async () => json(res, 200, { ...(await cal.status()), local: isLocalRequest(req) });
    if (req.method === 'GET' && pathname === '/api/calendar') return reply();
    if (!isLocalRequest(req) || !isTrustedRequest(req)) return json(res, 403, { error: 'The calendar can only be set up on the PC that runs DanGPT.' });
    try {
        if (req.method === 'POST' && pathname === '/api/calendar/feeds') { await cal.addFeed((await readJson(req)).url); console.log('  [calendar] added a calendar'); }
        else if (req.method === 'POST' && pathname === '/api/calendar/remote') cal.setRemote((await readJson(req)).on);
        else if (req.method === 'DELETE' && pathname.startsWith('/api/calendar/feeds/')) cal.removeFeed(decodeURIComponent(pathname.slice('/api/calendar/feeds/'.length)));
        else return json(res, 404, { error: 'Not found' });
    } catch (err) { return json(res, 400, { error: err.message }); }
    return reply();
}

// Settings → Tools → Google Keep: signing in (only on this PC, from DanGPT's own page).
async function handleKeepApi(req, res, pathname) {
    const keep = agent.keep;
    const reply = async () => json(res, 200, { ...(await keep.status(true)), local: isLocalRequest(req) });
    if (req.method === 'GET' && pathname === '/api/keep') return reply();
    if (!isLocalRequest(req) || !isTrustedRequest(req)) return json(res, 403, { error: 'Google Keep can only be set up on the PC that runs DanGPT.' });
    const body = req.method === 'POST' ? await readJson(req).catch(() => ({})) : {};
    try {
        if (pathname === '/api/keep/connect') { const r = await keep.connect(body.email, body.token); console.log(`  [keep] connected (${r.notes} notes)`); }
        else if (pathname === '/api/keep/disconnect') await keep.disconnect();
        else if (pathname === '/api/keep/remote') keep.setRemote(body.on);
        else return json(res, 404, { error: 'Not found' });
    } catch (err) { return json(res, 400, { error: /fetch failed|ECONNREFUSED/.test(err.message) ? "The speech-recognition server (which also runs Keep) isn't running. Start DanGPT with launch.bat." : err.message }); }
    return reply();
}

// ── Status ──────────────────────────────────────────────────────────────────

async function serviceStatus(base, pathname) {
    try {
        const { status, data } = await getJson(base, pathname);
        if (status === 200) return data?.status && data.status !== 'ok' ? 'loading' : 'ok';
        if (status === 503) return 'loading';
        return 'error';
    } catch { return 'down'; }
}

async function handleStatus(res) {
    const [ollama, breeze, stt] = await Promise.all([
        serviceStatus(OLLAMA_URL, '/api/version'),
        serviceStatus(BREEZE_URL, '/health'),
        serviceStatus(STT_URL, '/health')
    ]);
    json(res, 200, { ollama, breeze, stt });
}

// ── Other /api/* → Ollama (e.g. /api/tags for the model list) ───────────────

function proxyToOllama(req, res) {
    const proxy = http.request({
        hostname: OLLAMA_URL.hostname,
        port:     OLLAMA_URL.port || 11434,
        path:     req.url,
        method:   req.method,
        headers:  { ...req.headers, host: OLLAMA_URL.host }
    }, up => {
        const headers = Object.fromEntries(Object.entries(up.headers).filter(([k]) => !k.toLowerCase().startsWith('access-control-')));
        res.writeHead(up.statusCode, { ...headers, ...CORS_HEADERS });
        up.pipe(res);
    });
    proxy.on('error', () => json(res, 502, { error: 'Ollama is not reachable on this PC.' }));
    req.pipe(proxy);
}

// ── Static files (the app itself) ───────────────────────────────────────────

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json'
};
const STATIC_FILES = new Set(['/index.html', '/app.js', '/style.css']);
const STATIC_DIRS  = ['/js/', '/icons/'];

function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { decoded = ''; }
    const allowed = STATIC_FILES.has(decoded) || STATIC_DIRS.some(d => decoded.startsWith(d));
    const file = path.normalize(path.join(ROOT, decoded));
    if (!allowed || !file.startsWith(ROOT + path.sep) || decoded.includes('..')) {
        res.writeHead(404, CORS_HEADERS);
        return res.end('Not found');
    }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404, CORS_HEADERS); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...CORS_HEADERS });
        res.end(data);
    });
}

// ── Router ──────────────────────────────────────────────────────────────────

function route(req, res) {
    const { pathname, search } = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }

    const route = `${req.method} ${pathname}`;
    const fail = err => { console.error(`  [error] ${route}: ${err.message}`); json(res, 500, { error: err.message }); };

    if (route === 'POST /api/chat')       return handleChat(req, res).catch(fail);
    if (route === 'POST /api/tts')        return handleTTS(req, res).catch(fail);
    if (route === 'POST /api/tts/voice')  return handleVoice(req, res).catch(fail);
    if (route === 'POST /api/tts/sample') return handleCloneSample(req, res).catch(fail);
    if (route === 'POST /api/fetch-url')  return handleFetchUrl(req, res).catch(fail);
    if (route === 'POST /api/transcribe') return handleTranscribe(req, res, search).catch(fail);
    if (route === 'GET /api/status')      return handleStatus(res).catch(fail);
    if (route === 'GET /api/events')      return handleEvents(req, res);
    if (pathname === '/api/agent' || pathname.startsWith('/api/agent/')) return handleAgentApi(req, res, pathname).catch(fail);
    if (pathname === '/api/calendar' || pathname.startsWith('/api/calendar/')) return handleCalendarApi(req, res, pathname).catch(fail);
    if (pathname === '/api/keep' || pathname.startsWith('/api/keep/')) return handleKeepApi(req, res, pathname).catch(fail);
    if (pathname === '/api/chats' || pathname.startsWith('/api/chats/')) return handleChatsApi(req, res, pathname).catch(fail);
    if (pathname.startsWith('/api/'))     return proxyToOllama(req, res);
    if (req.method === 'GET')             return serveStatic(req, res, pathname);

    res.writeHead(404, CORS_HEADERS);
    res.end('Not found');
}

// Loopback only (the tunnel reaches it locally). IPv6 too, or Windows wastes ~200 ms per new
// connection to "localhost" trying ::1 first.
http.createServer(route).listen(PORT, '::1').on('error', () => {});
http.createServer(route).listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  DanGPT server running');
    console.log(`  Open http://localhost:${PORT} (or the Cloudflare tunnel URL)`);
    console.log(`  Ollama ${OLLAMA_URL.origin}  ·  Breeze TTS ${BREEZE_URL.origin}  ·  Whisper ${STT_URL.origin}`);
    console.log('');
});
