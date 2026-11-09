// Talking to the DanGPT server (server.js), either on this page's own origin or through the
// Cloudflare tunnel URL set in Settings.

let base = '';

export function setApiBase(url) {
    base = String(url || '').trim().replace(/\/+$/, '');
}

export function apiBase() {
    if (base) return base;
    return location.protocol.startsWith('http') ? location.origin : '';
}

export const apiUrl = p => apiBase() + p;
export const hasApi = () => !!apiBase();

// The shared Web Audio context (microphone capture and speech playback use the same one, which
// helps the browser's echo cancellation). Must be resumed from a user gesture.
let ctx = null;
export function audioContext() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    return ctx;
}

// Stream a chat reply. Calls onToken(delta, fullText) as answer tokens arrive and
// onThinking(delta, fullThinking) as a reasoning model's thinking does; resolves with the full text.
export async function streamChat(body, { onToken, onTool, onAction, onTrace, onLinks, onThinking, onNotice, signal } = {}) {
    let res;
    try {
        res = await fetch(apiUrl('/api/chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, stream: true }),
            signal
        });
    } catch (err) {
        if (signal?.aborted) throw err;
        throw new Error('Could not reach your home PC. Check that the server/tunnel is running and the URL in Settings is up to date.');
    }
    if (!res.ok) {
        const why = (await res.json().catch(() => ({}))).error;
        throw new Error(why || `Chat failed (HTTP ${res.status}). Check the model name in Settings.`);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    let text = '';
    let thinking = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
            const event = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = event.split('\n').find(l => l.startsWith('data:'));
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line.slice(5)); } catch { continue; }
            if (msg.type === 'token') { text += msg.text; onToken?.(msg.text, text); }
            else if (msg.type === 'tool') onTool?.(msg);
            else if (msg.type === 'action') onAction?.(msg.text);
            else if (msg.type === 'trace') onTrace?.(msg.messages || []);
            else if (msg.type === 'links') onLinks?.(msg.kind, msg.links || []);
            else if (msg.type === 'notice') onNotice?.(msg.text);
            else if (msg.type === 'thinking') { thinking += msg.text || ''; onThinking?.(msg.text || '', thinking); }
            else if (msg.type === 'error') throw new Error(msg.error);
            else if (msg.type === 'done') { reader.cancel().catch(() => {}); return text; }
        }
    }
    return text;
}

// Speech-to-text on the server's Whisper. `samples`: Float32Array of 16 kHz mono audio.
export async function transcribe(samples, { signal, language } = {}) {
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const q = language ? `?language=${encodeURIComponent(language)}` : '';
    let res;
    try {
        res = await fetch(apiUrl('/api/transcribe' + q), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: pcm.buffer,
            signal
        });
    } catch (err) {
        if (signal?.aborted) throw err;
        throw new Error('Could not reach the server for speech recognition.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Speech recognition failed (HTTP ${res.status})`);
    return (data.text || '').trim();
}

export async function getStatus() {
    try {
        const r = await fetch(apiUrl('/api/status'), { cache: 'no-store' });
        if (r.ok) return await r.json();
    } catch {}
    return { ollama: 'down', breeze: 'down', stt: 'down', server: 'down' };
}

// Ask the server to design (and cache) a Breeze voice ahead of the first sentence.
// (A cloned voice needs no design step; this just checks the server still has its sample.)
export async function prepareVoice(voice) {
    if (!voice?.instruction && !voice?.clone) return { ok: true };
    try {
        const r = await fetch(apiUrl('/api/tts/voice'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(voice)
        });
        const data = await r.json().catch(() => ({}));
        return r.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${r.status}`, status: r.status };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// Read a link on the server: { kind: 'page', url, title, text } or { kind: 'image', mime, base64 }.
export async function fetchLink(url) {
    let r;
    try {
        r = await fetch(apiUrl('/api/fetch-url'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
    } catch {
        throw new Error('Could not reach the server to read the link.');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

// Things pushed from the server, like reminders going off. Reconnects by itself.
export function subscribeEvents(onEvent) {
    if (!hasApi() || typeof EventSource === 'undefined') return () => {};
    const es = new EventSource(apiUrl('/api/events'));
    es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch {} };
    return () => es.close();
}

// What the assistant's tools are keeping (memory, lists, reminders), and deleting from it.
export async function agentData(kind = null, id = null) {
    const r = await fetch(apiUrl(kind ? `/api/agent/${kind}/${encodeURIComponent(id)}` : '/api/agent'), { method: kind ? 'DELETE' : 'GET', cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

// POST to the server's settings endpoints (/api/agent/home, /api/calendar/...). Throws its error text.
export async function postSetting(pathname, body = {}) {
    const r = await fetch(apiUrl(pathname), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

// The calendars it reads: { feeds: [{ id, name, error, nextWeek }], remote, local }.
export async function calendarStatus() {
    const r = await fetch(apiUrl('/api/calendar'), { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

// Google Keep's connection state: { connected, email, error, remote, local }.
export async function keepStatus() {
    const r = await fetch(apiUrl('/api/keep'), { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

export async function removeCalendar(id) {
    const r = await fetch(apiUrl(`/api/calendar/feeds/${encodeURIComponent(id)}`), { method: 'DELETE' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
}

export async function listModels() {
    try {
        const r = await fetch(apiUrl('/api/tags'));
        if (r.ok) return ((await r.json()).models || []).map(m => m.name);
    } catch {}
    return [];
}
