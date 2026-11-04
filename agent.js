'use strict';

// The assistant's tools (Ollama tool calling): reminders and timers, a memory of the user that
// carries between chats, named lists, opening apps / websites / folders on this PC, weather and
// travel times (places.js), and the user's calendar, read from its iCal address (calendar.js).
//
// The model asks for a tool; server.js calls run() and hands the result back to the model.
// Everything is kept in ./data/agent.json. Reminders keep running while the server does, and when
// one is due it's sent to the open pages (or shown as a Windows notification if none is open).

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { fmtTime, fmtWhen, fmtDuration, nowLine, parseWhen, norm, bestMatch } = require('./agent-util');
const places = require('./places');
const cal    = require('./calendar');
const youtube = require('./youtube');
const keep    = require('./keep');

const DATA_FILE = process.env.AGENT_DATA_FILE || path.join(__dirname, 'data', 'agent.json');
const DATA_DIR  = path.dirname(DATA_FILE);
const MAX_TIMER_MS = 400 * 24 * 3600 * 1000; // setTimeout's limit is ~24.8 days; longer ones re-arm

const events = new EventEmitter();

// ── Storage ─────────────────────────────────────────────────────────────────

let data = { memory: [], lists: {}, reminders: [], home: null };
try { data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}

function save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── Reminders ───────────────────────────────────────────────────────────────

const timers = new Map();

function schedule(r) {
    clearTimeout(timers.get(r.id));
    if (r.fired) return;
    const wait = r.due - Date.now();
    if (wait > MAX_TIMER_MS) { timers.set(r.id, setTimeout(() => schedule(r), MAX_TIMER_MS)); return; }
    timers.set(r.id, setTimeout(() => fire(r), Math.max(0, Math.min(wait, 2147483000))));
}

function fire(r) {
    timers.delete(r.id);
    r.fired = Date.now();
    save();
    console.log(`  [reminder] ${r.kind}: ${r.text}`);
    events.emit('reminder', announcement(r));
    events.emit('timers');
}

// What the page shows on screen (the timers counting down, and reminders coming up).
const timerList = () => upcoming().map(r => ({ id: r.id, kind: r.kind, text: r.text, due: r.due, duration: r.duration || null, created: r.created }));

// What the page says and shows when it goes off.
function announcement(r) {
    const label = r.text && r.text !== 'Timer' ? r.text : '';
    const say = r.kind === 'timer'
        ? `Your ${fmtDuration(r.duration, true)} timer is up${label ? `: ${label}` : ''}.`
        : `Here's your reminder: ${r.text}.`.replace(/([.!?])\.$/, '$1');
    return { id: r.id, kind: r.kind, text: r.text, say, due: r.due, late: Date.now() - r.due > 60000 };
}

// Reminders that went off while no page was open, for the next page that connects.
function undelivered() {
    const since = Date.now() - 24 * 3600000;
    return data.reminders.filter(r => r.fired && !r.delivered && r.fired > since).map(announcement);
}

function markDelivered(id) {
    const r = data.reminders.find(x => x.id === id);
    if (r && !r.delivered) { r.delivered = Date.now(); save(); }
}

function prune() {
    const old = Date.now() - 2 * 24 * 3600000;
    const before = data.reminders.length;
    data.reminders = data.reminders.filter(r => !r.fired || r.fired > old);
    if (data.reminders.length !== before) save();
}

for (const r of data.reminders) schedule(r);
prune();
setInterval(prune, 6 * 3600000).unref();

function addReminder({ kind, text, due, duration }) {
    const r = { id: newId(), kind, text, due: due.getTime(), created: Date.now() };
    if (duration) r.duration = duration;
    data.reminders.push(r);
    save();
    schedule(r);
    events.emit('timers');
    return r;
}

const upcoming = () => data.reminders.filter(r => !r.fired).sort((a, b) => a.due - b.due);

function cancelReminder(id) {
    const r = data.reminders.find(x => x.id === id && !x.fired);
    if (!r) return null;
    clearTimeout(timers.get(id));
    timers.delete(id);
    data.reminders = data.reminders.filter(x => x !== r);
    save();
    events.emit('timers');
    return r;
}

// Windows notification, for a reminder that goes off with no page open. Text goes in through the
// environment, so nothing in it is ever run as PowerShell.
function toast(title, body) {
    if (process.platform !== 'win32') return;
    const script = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:DANGPT_TITLE)) > $null
$t.Item(1).AppendChild($x.CreateTextNode($env:DANGPT_BODY)) > $null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, DANGPT_TITLE: title, DANGPT_BODY: body }, windowsHide: true },
        err => { if (err) console.log(`  [reminder] Windows notification failed: ${err.message.split('\n')[0]}`); });
}

// ── Memory ──────────────────────────────────────────────────────────────────

function memoryPrompt() {
    if (!data.memory.length) return '';
    return `Things the user asked you to remember (from earlier conversations; use them naturally, without announcing that you remembered):\n${data.memory.map(m => `- ${m.text}`).join('\n')}`;
}

// ── Lists ───────────────────────────────────────────────────────────────────

function listKey(name) {
    const n = norm(name).replace(/\b(list|my|the)\b/g, '').trim() || 'to-do';
    if (/^(todo|to do|tasks?)$/.test(n)) return 'to-do';
    if (/^(shop|shopping|groceries|grocery)$/.test(n)) return 'shopping';
    return n;
}

// Items arrive as an array, or (from some models) as text: "milk, eggs" or even "['milk', 'eggs']".
const asItems = v => (Array.isArray(v) ? v : String(v ?? '').replace(/^\s*\[|\]\s*$/g, '').split(/\s*[,;\n]\s*/))
    .map(s => String(s).trim().replace(/^["'`]+|["'`]+$/g, '').trim()).filter(Boolean);

// ── Opening things on this PC ───────────────────────────────────────────────

let appsCache = null, appsAt = 0, appsLoading = null;
function loadApps() {
    if (appsCache && Date.now() - appsAt < 10 * 60000) return Promise.resolve(appsCache);
    if (appsLoading) return appsLoading;
    appsLoading = new Promise(resolve => {
        if (process.platform !== 'win32') return resolve([]);
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'],
            { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
                let apps = [];
                try { apps = [].concat(JSON.parse(out)).filter(a => a?.Name && a?.AppID); } catch {}
                if (apps.length) { appsCache = apps; appsAt = Date.now(); }
                appsLoading = null;
                resolve(apps.length ? apps : appsCache || []);
            });
    });
    return appsLoading;
}
setTimeout(loadApps, 2000).unref?.(); // warm the list so the first "open ..." is quick

const APP_ALIASES = {
    'vs code': 'visual studio code', vscode: 'visual studio code', code: 'visual studio code',
    chrome: 'google chrome', explorer: 'file explorer', files: 'file explorer', 'file manager': 'file explorer',
    calc: 'calculator', 'control panel': 'control panel', terminal: 'terminal', cmd: 'command prompt',
    word: 'word', excel: 'excel', powerpoint: 'powerpoint', edge: 'microsoft edge', store: 'microsoft store',
    paint: 'paint', photos: 'photos', mail: 'outlook', 'task manager': 'task manager'
};
const JUNK_APP = /\b(uninstall|uninstaller|support|help|readme|read me|order form|website|manual|documentation|license|release notes)\b/;

function findApp(apps, query) {
    let q = norm(query).replace(/\b(the|app|application|program)\b/g, '').trim();
    q = APP_ALIASES[q] || q;
    if (!q) return { best: null, others: [] };
    const qWords = q.split(' ');
    const scored = apps.map(a => {
        const n = norm(a.Name);
        let s = 0;
        if (n === q) s = 100;
        else if (n.startsWith(q + ' ') || n.endsWith(' ' + q)) s = 80;
        else if ((' ' + n + ' ').includes(' ' + q + ' ')) s = 70;
        else if (n.startsWith(q)) s = 60;
        else if (qWords.every(w => n.includes(w))) s = 50;
        else if (n.replace(/ /g, '').includes(q.replace(/ /g, ''))) s = 40;
        if (s && JUNK_APP.test(n) && !JUNK_APP.test(q)) s -= 45;
        return { a, s: s - n.length / 100 };
    }).filter(x => x.s > 0).sort((x, y) => y.s - x.s);
    return { best: scored[0]?.a || null, others: scored.slice(1, 4).map(x => x.a.Name) };
}

// explorer.exe opens the target the way double-clicking it would; nothing goes through a shell.
function shellOpen(target) {
    if (process.env.AGENT_DRY_RUN) { console.log(`  [open] (dry run) ${target}`); return; }
    const p = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false });
    p.on('error', () => {});
    p.unref();
}

const FOLDERS = {
    desktop: 'Desktop', documents: 'Documents', downloads: 'Downloads', pictures: 'Pictures',
    photos: 'Pictures', music: 'Music', videos: 'Videos', home: ''
};

// ── Tool definitions ────────────────────────────────────────────────────────

const fn = (name, description, properties, required = []) =>
    ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const TOOLS = {
    reminders: [
        fn('set_timer', 'Start a countdown timer. Use for "set a timer for 10 minutes" or "remind me in 20 minutes to ..." (anything relative to now). Give the length in hours, minutes and/or seconds, as said.', {
            hours:   { type: 'number', description: 'Hours. Optional.' },
            minutes: { type: 'number', description: 'Minutes. Optional.' },
            seconds: { type: 'number', description: 'Seconds. Optional.' },
            label:   { type: 'string', description: 'What it is for, e.g. "take the pizza out". Optional.' }
        }),
        fn('set_reminder', 'Set a reminder for a specific clock time or date, e.g. "remind me at 3pm to call mum" or "tomorrow at 9 remind me about the dentist". For "in N minutes" use set_timer instead.', {
            message: { type: 'string', description: 'What to remind the user about, phrased as the reminder itself, e.g. "call mum"' },
            at:      { type: 'string', description: 'When. Just a time like "18:00" means the next time it comes round (today, or tomorrow if that has passed). For another day use "YYYY-MM-DD HH:MM", worked out from the current date.' }
        }, ['message', 'at']),
        fn('list_reminders', 'List the timers and reminders that are still to come.', {}),
        fn('cancel_reminder', 'Cancel a timer or reminder.', {
            which: { type: 'string', description: 'Which one: words from its message, e.g. "pizza", or "timer" / "all"' }
        }, ['which'])
    ],
    memory: [
        fn('remember', 'Save a lasting fact about the user so you remember it in future conversations (their preferences, people and pets in their life, important details). Use when the user asks you to remember something, or tells you something about themselves clearly worth keeping. Never for small talk, or for anything about yourself or this conversation. Write it as a short note, e.g. "Is vegetarian".', {
            fact: { type: 'string', description: 'The fact, short and self-contained' }
        }, ['fact']),
        fn('forget', 'Remove something you were asked to remember.', {
            fact: { type: 'string', description: 'Which remembered fact to remove (words from it)' }
        }, ['fact'])
    ],
    lists: [
        fn('add_to_list', 'Add items to one of the user\'s lists (shopping, to-do, packing, ideas, or any name). The list is created if it doesn\'t exist.', {
            list:  { type: 'string', description: 'The list name, e.g. "shopping" or "to-do"' },
            items: { type: 'array', items: { type: 'string' }, description: 'The items to add' }
        }, ['list', 'items']),
        fn('remove_from_list', 'Remove items from a list, or clear the whole list. Use it when the user says they\'ve bought, got or done something on a list (e.g. "I\'ve got the eggs").', {
            list:  { type: 'string', description: 'The list name' },
            items: { type: 'array', items: { type: 'string' }, description: 'The items to remove. Leave empty to clear the whole list.' }
        }, ['list']),
        fn('read_list', 'Read what\'s on a list. Without a name, says which lists exist.', {
            list: { type: 'string', description: 'The list name. Optional.' }
        })
    ],
    pc: [
        fn('open_app', 'Open an application installed on the user\'s PC, e.g. Spotify, Notepad, Calculator, Steam, Visual Studio Code, Settings.', {
            name: { type: 'string', description: 'The app\'s name' }
        }, ['name']),
        fn('open_website', 'Open a website in the user\'s web browser on their PC.', {
            url: { type: 'string', description: 'The address, e.g. "https://www.bbc.co.uk/weather" or "youtube.com"' }
        }, ['url']),
        fn('open_folder', 'Open one of the user\'s folders in File Explorer on their PC.', {
            folder: { type: 'string', enum: Object.keys(FOLDERS), description: 'Which folder' }
        }, ['folder'])
    ],
    places: [
        fn('get_weather', 'Get the real weather forecast: now, today, or a day up to 16 days ahead, for the user\'s home or anywhere. Always use this for weather questions ("will it rain tomorrow?", "do I need a coat?", "what\'s it like in Paris this weekend?"); never guess.', {
            place: { type: 'string', description: 'A town or city, e.g. "Paris" or "Perth, Australia". Leave out for the user\'s home.' },
            day:   { type: 'string', description: '"today", "tomorrow", a weekday, "this weekend", or YYYY-MM-DD. Leave out for now and the next couple of days.' }
        }),
        fn('travel_time', 'Work out how long it takes to get somewhere and how far it is, by car, bike or on foot, and put a Google Maps directions link on the user\'s screen. For trains and buses use mode "transit": that gives the directions link (with times and routes) without working the time out here. Use for "how long to drive to Glasgow?", "how far is the castle from the station?", "how do I get to ... by train?", "directions to ...". Never guess travel times.', {
            to:   { type: 'string', description: 'Where to: a place, address, postcode or landmark' },
            from: { type: 'string', description: 'Where from, whenever the user names a starting point ("from the station" → "Waverley station"). Leave it out only to start from their home.' },
            mode: { type: 'string', enum: places.MODES, description: 'How. Default driving.' }
        }, ['to']),
        fn('set_home', 'Save where the user lives, for weather and travel times when they don\'t name a place. Use when they tell you their town, address or postcode.', {
            place: { type: 'string', description: 'Their town, or address or postcode' }
        }, ['place'])
    ],
    calendar: cal.TOOLS,
    youtube: youtube.TOOLS,
    keep: keep.TOOLS
};

const GROUP_OF = Object.fromEntries(Object.entries(TOOLS).flatMap(([g, list]) => list.map(t => [t.function.name, g])));

// Can this request use a group? `local`: it came from this PC (not the tunnel), so opening things
// here makes sense; from a phone it would open them on an empty desk. The calendar needs an iCal
// address added, the page to be DanGPT's own (`trusted`: not some other website calling the
// server), and either this PC or the user's say-so for the tunnel.
function usable(g, { local, trusted, groups } = {}) {
    if (!TOOLS[g]) return false;
    if (g === 'pc') return !!local;
    if (g === 'calendar') return cal.connected() && !!trusted && (local || cal.remoteAllowed());
    if (g === 'keep') return keep.connected() && !!trusted && (local || keep.remoteAllowed());
    // With Google Keep on, lists go there: two sets of "add to a list" tools muddle small models.
    if (g === 'lists') return !((groups || []).includes('keep') && keep.connected());
    return true;
}

function toolsFor(groups, ctx) {
    return (groups || []).filter(g => usable(g, { ...ctx, groups })).flatMap(g => TOOLS[g]);
}

function promptFor(groups, ctx) {
    const asked = new Set(groups || []);
    const g = new Set([...asked].filter(x => usable(x, { ...ctx, groups })));
    const lines = [nowLine()];
    if (g.size) {
        lines.push('You can take actions with your tools when the user asks: ' + [
            g.has('reminders') && 'set timers and reminders',
            g.has('memory') && 'remember things about them between conversations',
            g.has('lists') && 'keep lists',
            g.has('pc') && 'open apps, websites and folders on their PC',
            g.has('places') && 'check the weather forecast and travel times',
            g.has('calendar') && 'read their calendar',
            g.has('youtube') && "search YouTube and read what's said in videos",
            g.has('keep') && 'make notes and lists in their Google Keep'
        ].filter(Boolean).join(', ') + '. Whenever the user asks for one of these, call the tool: you can only do it by calling the tool, every time, even if you did something similar earlier. Then confirm briefly in plain words. Never say you did something unless a tool result in this turn says it worked, and never make up weather, travel times or calendar entries: get them from the tools. Don\'t ask for details you can sensibly assume (e.g. "at 6pm" means the next 6pm).');
    }
    if (asked.has('pc') && !ctx.local) lines.push("Opening apps, websites or folders on the user's PC isn't possible right now, because they're using DanGPT from another device. If they ask, say so briefly.");
    if (g.has('places')) lines.push(data.home ? `The user's home is ${data.home.name}.` : "You don't know where the user lives yet; if they ask about the weather or travel without saying where, ask (then save it with set_home).");
    if (asked.has('calendar') && !g.has('calendar')) {
        lines.push(!cal.connected()
            ? "You can't see the user's calendar: it isn't set up. If they ask about their calendar, say they can add it in Settings → Tools (with its secret iCal address); never make up what's on it."
            : "You can't see the user's calendar from this device (it's only allowed on their PC; Settings → Tools there can change that). If they ask, say so; never make up what's on it.");
    }
    if (g.has('calendar')) lines.push("You can read the user's calendar, but not change it. To add an event, add_event puts a link on their screen that opens Google Calendar with it filled in, for them to save. Moving, changing or deleting events: tell them to do it in Google Calendar; you can't.");
    if (asked.has('keep') && keep.connected() && !g.has('keep')) lines.push("The user's notes and lists are in Google Keep, which can't be used from this device (only on their PC; Settings → Tools there can change that). If they ask for a note or a list, say so briefly.");
    if (g.has('keep')) lines.push("Notes and lists go in the user's Google Keep: keep_note for a note, keep_list_add and keep_list_tick for lists (shopping, to-do and so on), keep_search to read them.");
    if (g.has('youtube')) lines.push("For anything about what's in a YouTube video or stream (what someone said or did, a summary, finding the moment), use youtube_search to find it and youtube_video to read its transcript; never guess what a video says.");
    if (g.has('memory')) { const m = memoryPrompt(); if (m) lines.push(m); }
    return lines.join('\n\n');
}

// ── Running a tool ──────────────────────────────────────────────────────────
// Returns { content } for the model and, when something was done, { action } for the user to see.

async function run(name, args = {}, ctx = {}) {
    const g = GROUP_OF[name];
    if (!g || !(ctx.groups || []).includes(g) || !usable(g, ctx)) return { content: g === 'pc' ? 'Opening things on the PC only works when the user is at the PC itself.' : `The tool ${name} isn't available.` };
    let r;
    try { r = await RUN[name](args || {}, ctx); }
    catch (err) { r = { content: `That didn't work: ${err.message}` }; }
    // An action that didn't happen says so up front: small models otherwise skim past it and
    // tell the user it's done.
    if (!r.action && !r.ok && !READ_ONLY.has(name)) r = { ...r, failed: true, content: `Not done. ${r.content}` };
    return r;
}

const READ_ONLY = new Set(['list_reminders', 'read_list', 'get_weather', 'travel_time', 'calendar_events', 'youtube_search', 'youtube_video', 'keep_search']);

const RUN = {
    set_timer({ hours, minutes, seconds, label }) {
        const ms = ((Number(hours) || 0) * 3600 + (Number(minutes) || 0) * 60 + (Number(seconds) || 0)) * 1000;
        if (!(ms >= 1000) || ms > 366 * 24 * 3600000) return { content: 'The timer needs a length between a second and a year.' };
        const r = addReminder({ kind: 'timer', text: String(label || '').trim() || 'Timer', due: new Date(Date.now() + ms), duration: ms });
        const what = r.text !== 'Timer' ? ` for "${r.text}"` : '';
        return {
            content: `Timer set: ${fmtDuration(ms)}${what}, going off at ${fmtTime(new Date(r.due))}.`,
            action: `⏰ Timer: ${fmtDuration(ms)}${r.text !== 'Timer' ? ` (${r.text})` : ''}, at ${fmtTime(new Date(r.due))}`
        };
    },

    set_reminder({ message, at }) {
        const text = String(message || '').trim();
        if (!text) return { content: 'The reminder needs a message.' };
        const due = parseWhen(at);
        if (!due) return { content: `Couldn't understand the time "${at}". Give it as "YYYY-MM-DD HH:MM".` };
        if (due <= new Date()) return { content: `${fmtWhen(due)} has already passed. Ask the user when they meant.` };
        addReminder({ kind: 'reminder', text, due });
        return { content: `Reminder set for ${fmtWhen(due)}: "${text}".`, action: `⏰ Reminder ${fmtWhen(due)}: ${text}` };
    },

    list_reminders() {
        const list = upcoming();
        if (!list.length) return { content: 'There are no timers or reminders set.' };
        return { content: list.map(r => r.kind === 'timer'
            ? `- Timer${r.text !== 'Timer' ? ` (${r.text})` : ''}: ${fmtDuration(r.due - Date.now())} left, goes off at ${fmtTime(new Date(r.due))}`
            : `- Reminder ${fmtWhen(new Date(r.due))}: ${r.text}`).join('\n') };
    },

    cancel_reminder({ which }) {
        const list = upcoming();
        if (!list.length) return { content: 'There are no timers or reminders to cancel.' };
        const q = norm(which);
        let hits;
        if (/^(all|everything|all of them)$/.test(q)) hits = list;
        else if (/^(the )?timers?$/.test(q)) hits = list.filter(r => r.kind === 'timer');
        else if (/^(the )?reminders?$/.test(q)) hits = list.filter(r => r.kind === 'reminder');
        else { const m = bestMatch(list, which, r => r.text); hits = m ? [m] : []; }
        if (!hits.length) return { content: `No timer or reminder matches "${which}". Set: ${list.map(r => r.text).join('; ')}` };
        if (hits.length > 1 && !/all|everything/.test(q)) return { content: `Several match: ${hits.map(r => `${r.text} (${fmtWhen(new Date(r.due))})`).join('; ')}. Ask which one, or cancel "all".` };
        for (const r of hits) cancelReminder(r.id);
        const names = hits.map(r => r.kind === 'timer' && r.text === 'Timer' ? `the ${fmtDuration(r.duration)} timer` : `"${r.text}"`).join(', ');
        return { content: `Cancelled ${names}.`, action: `⏰ Cancelled ${names}` };
    },

    remember({ fact }) {
        const text = String(fact || '').trim().replace(/\s+/g, ' ');
        if (!text) return { content: 'Nothing to remember.' };
        if (/^(the )?(assistant|ai|you|i am|i'm|this conversation|the conversation)\b/i.test(text)) return { content: 'Not saved: memory is only for facts about the user.' };
        // (Small models sometimes "remember" the question itself: "User has a calendar", "User asked about the weather".)
        if (/^i\b|\b(asked|asking|wants to know|is asking|told a joke|has a calendar|calendar (is|isn't) connected|settings|dangpt)\b/i.test(text)) return { content: 'Not saved: that isn\'t a lasting fact about the user, so there was nothing to remember. Just answer them.', ok: true };
        if (data.memory.some(m => norm(m.text) === norm(text))) return { content: 'That was already remembered.', ok: true };
        data.memory.push({ id: newId(), text, at: Date.now() });
        save();
        return { content: `Remembered: "${text}".`, action: `🧠 Remembered: ${text}` };
    },

    forget({ fact }) {
        const m = bestMatch(data.memory, fact, x => x.text);
        if (!m) return { content: data.memory.length ? `Nothing remembered matches "${fact}". Remembered: ${data.memory.map(x => x.text).join('; ')}` : 'Nothing is remembered yet.' };
        data.memory = data.memory.filter(x => x !== m);
        save();
        return { content: `Forgot: "${m.text}".`, action: `🧠 Forgot: ${m.text}` };
    },

    add_to_list({ list, items }) {
        const key = listKey(list);
        const add = asItems(items);
        if (!add.length) return { content: 'No items to add.' };
        const l = data.lists[key] ||= { items: [] };
        const fresh = add.filter(i => !l.items.some(x => norm(x) === norm(i)));
        l.items.push(...fresh);
        l.updated = Date.now();
        save();
        const already = add.length - fresh.length;
        return {
            content: `Added to the ${key} list: ${fresh.join(', ') || '(nothing new)'}${already ? ` (${already} already on it)` : ''}. It now has ${l.items.length} item${l.items.length === 1 ? '' : 's'}.`,
            action: fresh.length ? `📝 ${key}: + ${fresh.join(', ')}` : undefined,
            ok: true
        };
    },

    remove_from_list({ list, items }) {
        const key = listKey(list);
        const l = data.lists[key];
        if (!l) return { content: `There's no ${key} list. Lists: ${Object.keys(data.lists).join(', ') || 'none'}.` };
        const remove = asItems(items);
        if (!remove.length) {
            delete data.lists[key];
            save();
            return { content: `Cleared the ${key} list.`, action: `📝 Cleared the ${key} list` };
        }
        const gone = [], missing = [];
        for (const r of remove) {
            const m = bestMatch(l.items, r);
            if (m) { l.items = l.items.filter(x => x !== m); gone.push(m); } else missing.push(r);
        }
        if (!l.items.length) delete data.lists[key]; else l.updated = Date.now();
        save();
        return {
            content: `Removed from the ${key} list: ${gone.join(', ') || 'nothing'}.${missing.length ? ` Not on it: ${missing.join(', ')}.` : ''} ${l.items.length ? `Left: ${l.items.join(', ')}.` : 'The list is now empty.'}`,
            action: gone.length ? `📝 ${key}: − ${gone.join(', ')}` : undefined
        };
    },

    read_list({ list } = {}) {
        const names = Object.keys(data.lists);
        if (!list || !norm(list)) return { content: names.length ? `Lists: ${names.map(n => `${n} (${data.lists[n].items.length})`).join(', ')}.` : 'There are no lists yet.' };
        const key = listKey(list);
        const l = data.lists[key];
        if (!l) return { content: `There's no ${key} list.${names.length ? ` Lists: ${names.join(', ')}.` : ''}` };
        return { content: `The ${key} list:\n${l.items.map(i => `- ${i}`).join('\n')}` };
    },

    async open_app({ name }) {
        const apps = await loadApps();
        if (!apps.length) return { content: "Couldn't read the list of installed apps." };
        const { best, others } = findApp(apps, name);
        if (!best) return { content: `No installed app matches "${name}".` };
        shellOpen(`shell:AppsFolder\\${best.AppID}`);
        console.log(`  [open] app ${best.Name}`);
        return { content: `Opened ${best.Name}.${others.length ? ` (Other close matches: ${others.join(', ')}.)` : ''}`, action: `🖥 Opened ${best.Name}` };
    },

    open_website({ url }) {
        let raw = String(url || '').trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw;
        let u;
        try { u = new URL(raw); } catch { return { content: `"${url}" isn't a web address.` }; }
        if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.') && u.hostname !== 'localhost') return { content: `"${url}" isn't a web address.` };
        shellOpen(u.href);
        console.log(`  [open] ${u.href}`);
        return { content: `Opened ${u.href} in the browser.`, action: `🌐 Opened ${u.hostname.replace(/^www\./, '')}` };
    },

    open_folder({ folder }) {
        const key = norm(folder);
        if (!(key in FOLDERS)) return { content: `Can only open these folders: ${Object.keys(FOLDERS).join(', ')}.` };
        const dir = path.join(os.homedir(), FOLDERS[key]);
        if (!fs.existsSync(dir)) return { content: `The ${key} folder doesn't exist.` };
        shellOpen(dir);
        console.log(`  [open] folder ${dir}`);
        return { content: `Opened the ${key} folder.`, action: `📁 Opened ${FOLDERS[key] || 'your home folder'}` };
    },

    get_weather(args) { return places.weather(args, data.home); },
    travel_time(args) { return places.travel(args, data.home); },

    async set_home({ place }) {
        const home = await places.lookupHome(place, data.home);
        if (!home) return { content: `Couldn't find "${place}". Ask the user for their town, or a postcode.` };
        if (data.home && data.home.name === home.name) return { content: `Home is already set to ${home.name}.`, ok: true };
        data.home = home;
        save();
        return { content: `Home set to ${home.name}.`, action: `🏠 Home: ${home.name}` };
    },

    ...cal.RUN,
    ...youtube.RUN,
    ...keep.RUN
};

// ── For the Settings → Tools tab ────────────────────────────────────────────

function snapshot() {
    return {
        home: data.home ? { name: data.home.name, query: data.home.query } : null,
        memory: data.memory,
        lists: Object.entries(data.lists).map(([name, l]) => ({ name, items: l.items, updated: l.updated })),
        reminders: upcoming().map(r => ({ id: r.id, kind: r.kind, text: r.text, due: r.due, when: fmtWhen(new Date(r.due)) }))
    };
}

function remove(kind, id) {
    if (kind === 'memory') {
        const before = data.memory.length;
        data.memory = id === 'all' ? [] : data.memory.filter(m => m.id !== id);
        if (data.memory.length !== before) save();
        return true;
    }
    if (kind === 'lists') { if (data.lists[id]) { delete data.lists[id]; save(); } return true; }
    if (kind === 'reminders') { cancelReminder(id); return true; }
    if (kind === 'home') { data.home = null; save(); return true; }
    return false;
}

// Settings → Tools: home typed in by the user.
async function setHome(query) {
    const home = await places.lookupHome(query, data.home);
    if (!home) throw new Error(`Couldn't find "${query}"`);
    data.home = home;
    save();
    return home;
}

module.exports = {
    events, toolsFor, promptFor, run, undelivered, markDelivered, toast, snapshot, remove, setHome, cal, youtube, keep, timerList,
    TOOL_GROUPS: Object.keys(TOOLS), _test: { parseWhen, findApp, loadApps }
};
