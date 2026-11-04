'use strict';

// Google Keep: notes and lists in the user's real Keep, through the Whisper server's Python side
// (stt/keep_bridge.py, using the unofficial gkeepapi: Google's own Keep API is only for business
// Workspace accounts). Signing in, and the token, live there; this file has the model's tools.

const fs   = require('fs');
const path = require('path');

const STT  = process.env.STT_URL || 'http://127.0.0.1:8890';
const FILE = process.env.KEEP_ACCESS_FILE || path.join(__dirname, 'data', 'keep-access.json');

let access = { remote: false };
try { access = { ...access, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
function setRemote(on) {
    access.remote = !!on;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(access));
}

async function call(action, body) {
    const res = await fetch(`${STT}/keep/${action}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    return d;
}

// Whether it's connected, kept fresh in the background (tools are chosen without waiting).
let known = { connected: false, email: null, error: null }, checked = 0;
async function status(force = false) {
    if (force || Date.now() - checked > 30000) {
        checked = Date.now();
        try { known = await call('status'); }
        catch { known = { ...known, error: known.connected ? 'the speech-recognition server (which runs Keep) is not running' : null }; }
    }
    return { ...known, remote: access.remote };
}
status().catch(() => {});
const connected = () => { if (Date.now() - checked > 30000) status().catch(() => {}); return !!known.connected; };

async function connect(email, token) { const r = await call('connect', { email, token }); await status(true); return r; }
async function disconnect() { await call('disconnect', {}); await status(true); }

// ── Tools ───────────────────────────────────────────────────────────────────

const fn = (name, description, properties, required = []) =>
    ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const TOOLS = [
    fn('keep_note', "Save a note in the user's Google Keep. Use for \"make a note that…\", \"note down…\", \"save this to Keep\", or when they want something written down to look at later.", {
        title: { type: 'string', description: 'A short title. Optional.' },
        text:  { type: 'string', description: 'The note itself, written out in full' }
    }, ['text']),
    fn('keep_list_add', "Add items to a list in the user's Google Keep (shopping, to-do, packing, or any name). Adds to the list of that name if it exists, otherwise makes it.", {
        list:  { type: 'string', description: 'The list name, e.g. "Shopping"' },
        items: { type: 'array', items: { type: 'string' }, description: 'The items to add' }
    }, ['list', 'items']),
    fn('keep_list_tick', "Tick items off a list in the user's Google Keep, when they've bought, got or done them (\"I've got the eggs\").", {
        list:  { type: 'string', description: 'The list name' },
        items: { type: 'array', items: { type: 'string' }, description: 'The items to tick off' }
    }, ['list', 'items']),
    fn('keep_search', "Look through the user's Google Keep notes and lists: \"what's on my shopping list?\", \"what did I note about the boiler?\". Leave the query empty to see the most recent.", {
        query: { type: 'string', description: 'Words to look for' }
    })
];

const asItems = v => (Array.isArray(v) ? v : String(v ?? '').replace(/^\s*\[|\]\s*$/g, '').split(/\s*[,;\n]\s*/))
    .map(s => String(s).trim().replace(/^["'`]+|["'`]+$/g, '').trim()).filter(Boolean);
const short = s => (s.length > 40 ? s.slice(0, 40).trim() + '…' : s);

function describe(n) {
    const title = n.title ? `"${n.title}"` : '(untitled)';
    if (n.kind === 'list') {
        const open = n.items.filter(i => !i.checked).map(i => i.text), done = n.items.filter(i => i.checked).map(i => i.text);
        return `List ${title}: still to do: ${open.length ? open.join(', ') : 'nothing'}${done.length ? `; already ticked off: ${done.join(', ')}` : ''}.`;
    }
    return `Note ${title}: ${n.text.replace(/\s+/g, ' ').trim()}`;
}

const RUN = {
    async keep_note({ title, text } = {}) {
        const body = String(text || '').trim();
        if (!body) return { content: 'The note needs some text.' };
        const n = await call('note', { title: String(title || '').trim(), text: body });
        return { content: `Saved to Google Keep: ${describe(n)}`, action: `📒 Keep note: ${short(n.title || body)}` };
    },
    async keep_list_add({ list, items } = {}) {
        const add = asItems(items);
        if (!add.length) return { content: 'No items to add.' };
        const n = await call('list', { list: String(list || 'List').trim(), items: add });
        if (!n.added.length) return { content: `Already on the Keep list "${n.title}": ${add.join(', ')}. ${describe(n)}`, ok: true };
        return {
            content: `${n.created ? `Made a new Keep list "${n.title}" with` : `Added to the Keep list "${n.title}":`} ${n.added.join(', ')}. ${describe(n)}`,
            action: `📒 Keep “${n.title}”: + ${n.added.join(', ')}`
        };
    },
    async keep_list_tick({ list, items } = {}) {
        const n = await call('tick', { list: String(list || '').trim(), items: asItems(items) });
        if (!n.ticked.length && n.already.length && !n.missing.length) return { content: `Already ticked off on the Keep list "${n.title}": ${n.already.join(', ')}. ${describe(n)}`, ok: true };
        if (!n.ticked.length) return { content: `Nothing on the Keep list "${n.title}" matches ${n.missing.join(', ')}. ${describe(n)}` };
        return {
            content: `Ticked off the Keep list "${n.title}": ${n.ticked.join(', ')}.${n.already.length ? ` Already ticked off before: ${n.already.join(', ')}.` : ''}${n.missing.length ? ` Not on it: ${n.missing.join(', ')}.` : ''} ${describe(n)}`,
            action: `📒 Keep “${n.title}”: ✓ ${n.ticked.join(', ')}`
        };
    },
    async keep_search({ query } = {}) {
        const r = await call('find', { query: String(query || '') });
        if (!r.notes.length) return { content: `Nothing in Google Keep matches "${query}".`, ok: true };
        return { content: `From Google Keep (${r.count} match${r.count === 1 ? '' : 'es'}${r.count > r.notes.length ? `, showing ${r.notes.length}` : ''}):\n${r.notes.map(n => `- ${describe(n)}`).join('\n')}`, ok: true };
    }
};

module.exports = { TOOLS, RUN, connected, remoteAllowed: () => !!access.remote, status, connect, disconnect, setRemote };
