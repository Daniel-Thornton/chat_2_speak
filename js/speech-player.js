// Speaks a reply chunk by chunk with Breeze TTS, playing each chunk while it's still being
// synthesised.
//
// Chunks go to the server one at a time (Breeze runs a single request at a time). The next
// request is sent once the previous chunk has fully arrived, which on a fast GPU is well before it
// finishes playing, so the chunks play back to back with no gaps. Sentences that are waiting when a
// request goes out are sent together, which gives smoother prosody than one request per sentence.
//
// If Breeze isn't running (or is still warming up) the browser's built-in voice stands in.

import { apiUrl, audioContext } from './api.js';

const LEAD = 0.16;        // s of audio buffered before a chunk starts playing (doubles if it runs dry)
const MAX_MERGE = 240;    // chars: queued sentences merged into one request up to this
const RETRY_MS = 15000;   // after Breeze fails, use the browser voice for this long before trying again

export class SpeechPlayer {
    // getVoice() -> { instruction, seed } for Breeze.
    // onChunkStart(text, isFirst) as each chunk becomes audible; onIdle() once everything has played
    // after end(); onEngine(name) when it switches between 'breeze' and 'browser'.
    constructor({ getVoice, onChunkStart, onIdle, onEngine } = {}) {
        this.getVoice = getVoice || (() => ({}));
        this.onChunkStart = onChunkStart || (() => {});
        this.onIdle = onIdle || (() => {});
        this.onEngine = onEngine || (() => {});
        this.gen = 0;
        this.out = null;
        this.analyser = null;
        this.breezeDownUntil = 0;
        this.engine = 'breeze';
        this.reset();
    }

    reset() {
        this.gen++;
        this.texts = [];          // chunks waiting to be requested
        this.fetching = null;     // the chunk at the server now
        this.jobs = 0;            // chunks requested for this reply
        this.t = 0;               // audio-clock time the scheduled audio runs until
        this.sources = new Set();
        this.timers = [];
        this.spoken = [];         // chunks that have started playing
        this.closed = false;
        this.idle = false;
        this.browserBusy = false;
    }

    graph() {
        const ctx = audioContext();
        if (!this.out) {
            this.out = ctx.createGain();
            this.analyser = ctx.createAnalyser();
            this.analyser.fftSize = 512;
            this.levelBuf = new Float32Array(this.analyser.fftSize);
            this.out.connect(this.analyser);
            this.analyser.connect(ctx.destination);
        }
        return ctx;
    }

    // Start a new reply (stopping anything still playing).
    begin() {
        this.stop();
        this.graph();
    }

    enqueue(text) {
        if (!text || this.closed) return;
        this.texts.push(text);
        this.pump();
    }

    // No more chunks for this reply: onIdle fires once the last one has played.
    end() {
        this.closed = true;
        this.checkIdle();
    }

    // Stop at once: drop what's queued, hang up on the server, silence what's playing.
    stop() {
        this.fetching?.abort.abort();
        for (const s of this.sources) { s.onended = null; try { s.stop(); } catch {} }
        for (const t of this.timers) clearTimeout(t);
        if (this.browserBusy && 'speechSynthesis' in window) speechSynthesis.cancel();
        if (this.out) this.out.gain.cancelScheduledValues(0), this.out.gain.value = 1;
        this.reset();
    }

    get active() {
        return !!(this.texts.length || this.fetching || this.sources.size || this.browserBusy);
    }

    // Quieten (or restore) playback, e.g. while the user starts to talk over it.
    duck(on) {
        if (!this.out) return;
        const ctx = audioContext();
        this.out.gain.setTargetAtTime(on ? 0.2 : 1, ctx.currentTime, 0.04);
        if ('speechSynthesis' in window && this.browserBusy) on ? speechSynthesis.pause() : speechSynthesis.resume();
    }

    // Output loudness right now, 0..1 (for the visualiser).
    level() {
        if (!this.analyser || !this.sources.size) return 0;
        this.analyser.getFloatTimeDomainData(this.levelBuf);
        let sum = 0;
        for (const v of this.levelBuf) sum += v * v;
        return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
    }

    spokenText() {
        return this.spoken.join(' ');
    }

    // ── Requests ──

    pump() {
        if (this.fetching || !this.texts.length) return;
        let text = this.texts.shift();
        if (this.jobs > 0) {
            while (this.texts.length && text.length + 1 + this.texts[0].length <= MAX_MERGE) text += ' ' + this.texts.shift();
        }
        this.jobs++;
        const job = { text, gen: this.gen, abort: new AbortController(), pending: [], queued: 0, done: false, scheduled: false, lead: LEAD, rate: 24000 };
        this.fetching = job;
        const useBrowser = Date.now() < this.breezeDownUntil;
        (useBrowser ? this.speakBrowser(job) : this.fetchBreeze(job))
            .catch(() => {})
            .finally(() => {
                if (this.fetching === job) this.fetching = null;
                if (job.gen === this.gen) { this.pump(); this.checkIdle(); }
            });
    }

    setEngine(name) {
        if (name !== this.engine) { this.engine = name; this.onEngine(name); }
    }

    async fetchBreeze(job) {
        let res;
        try {
            res = await fetch(apiUrl('/api/tts'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: job.text, ...this.getVoice() }),
                signal: job.abort.signal
            });
        } catch {
            if (job.abort.signal.aborted) return;
            return this.fallback(job);
        }
        if (!res.ok) {
            if (job.gen !== this.gen) return;
            return this.fallback(job);
        }
        this.setEngine('breeze');
        job.rate = Number(res.headers.get('X-Sample-Rate')) || 24000;
        const reader = res.body.getReader();
        let odd = null; // a byte left over when a sample is split between network chunks
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done || job.gen !== this.gen) break;
                let bytes = value;
                if (odd !== null) {
                    bytes = new Uint8Array(value.length + 1);
                    bytes[0] = odd;
                    bytes.set(value, 1);
                }
                const n = bytes.length >> 1;
                odd = bytes.length & 1 ? bytes[bytes.length - 1] : null;
                if (!n) continue;
                const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
                const f = new Float32Array(n);
                for (let i = 0; i < n; i++) f[i] = view.getInt16(i * 2, true) / 32768;
                job.pending.push(f);
                job.queued += n;
                this.feed(job);
            }
        } catch {} // hung up, or the connection dropped: play what came
        job.done = true;
        this.feed(job);
    }

    fallback(job) {
        this.breezeDownUntil = Date.now() + RETRY_MS;
        return this.speakBrowser(job);
    }

    // Schedule whatever has arrived of a chunk, straight after what's already scheduled.
    feed(job) {
        if (job.gen !== this.gen || !job.queued) return;
        const ctx = audioContext();
        const now = ctx.currentTime;
        const continuing = this.t > now + 0.01;
        if (!continuing) {
            if (job.scheduled && !job.dry) { job.dry = true; job.lead = Math.min(job.lead * 2, 2); } // ran dry: buffer more
            if (!job.done && job.queued / job.rate < job.lead) return;
        }
        job.dry = false;

        let samples = job.pending[0];
        if (job.pending.length > 1) {
            samples = new Float32Array(job.queued);
            let o = 0;
            for (const p of job.pending) { samples.set(p, o); o += p.length; }
        }
        job.pending = [];
        job.queued = 0;

        const buf = ctx.createBuffer(1, samples.length, job.rate);
        buf.copyToChannel(samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.out);
        const at = Math.max(this.t, now + 0.02);
        src.start(at);
        this.t = at + buf.duration;
        this.sources.add(src);
        src.onended = () => { this.sources.delete(src); this.checkIdle(); };

        if (!job.scheduled) {
            job.scheduled = true;
            const first = this.spoken.length === 0;
            this.timers.push(setTimeout(() => {
                if (job.gen !== this.gen) return;
                this.spoken.push(job.text);
                this.onChunkStart(job.text, first);
            }, Math.max(0, (at - now) * 1000)));
        }
    }

    // ── Browser voice (fallback) ──

    speakBrowser(job) {
        if (!('speechSynthesis' in window)) return Promise.resolve();
        this.setEngine('browser');
        return new Promise(resolve => {
            const u = new SpeechSynthesisUtterance(job.text.replace(/\((laugh|sigh|cough|clears throat)\)/g, ''));
            u.lang = 'en-US';
            this.browserBusy = true;
            u.onstart = () => {
                if (job.gen !== this.gen) return;
                const first = this.spoken.length === 0;
                this.spoken.push(job.text);
                this.onChunkStart(job.text, first);
            };
            const done = () => {
                if (job.gen === this.gen) this.browserBusy = false;
                resolve();
            };
            u.onend = done;
            u.onerror = done;
            speechSynthesis.speak(u);
        });
    }

    checkIdle() {
        if (this.idle || !this.closed || this.active) return;
        this.idle = true;
        this.onIdle();
    }
}
