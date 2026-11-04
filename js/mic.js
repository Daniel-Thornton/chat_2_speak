// Hands-free microphone: captures 16 kHz mono audio and finds where speech starts and stops.
//
// Voice activity detection is energy based, against a noise floor that's tracked continuously, so
// it adapts to the room. The browser's echo cancellation and noise suppression are switched on;
// while the assistant is talking, detection is made stricter (`strict`) so its own voice coming
// back through the speakers is less likely to count as the user interrupting. (Whisper on the
// server also runs Silero VAD, so a false start that isn't speech comes back as no text.)
//
// Events: speechstart(), progress(speechMs), speechend(Float32Array @16 kHz), discard(), level(0..1)

import { audioContext } from './api.js';

export const SAMPLE_RATE = 16000;
const FRAME = 512;                      // samples per analysis frame (32 ms)
const FRAME_MS = FRAME / SAMPLE_RATE * 1000;

const WORKLET = `
class MicCapture extends AudioWorkletProcessor {
    constructor() {
        super();
        this.ratio = sampleRate / ${SAMPLE_RATE};
        this.out = new Float32Array(${FRAME});
        this.n = 0; this.pos = 0; this.acc = 0; this.cnt = 0;
    }
    process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (!ch) return true;
        for (let i = 0; i < ch.length; i++) {
            this.acc += ch[i]; this.cnt++; this.pos += 1;
            if (this.pos >= this.ratio) {           // average down to 16 kHz
                this.pos -= this.ratio;
                this.out[this.n++] = this.acc / this.cnt;
                this.acc = 0; this.cnt = 0;
                if (this.n === ${FRAME}) { this.port.postMessage(this.out.slice()); this.n = 0; }
            }
        }
        return true;
    }
}
registerProcessor('mic-capture', MicCapture);
`;

const loaded = new WeakSet();

// Quietest level (dBFS) that counts as speech, by sensitivity setting.
const MIN_DB = { low: -38, medium: -46, high: -54 };

export class MicVad {
    constructor(opts = {}) {
        this.opts = { endSilenceMs: 750, minSpeechMs: 220, preRollMs: 350, maxMs: 30000, sensitivity: 'medium', echoCancellation: true, ...opts };
        this.handlers = {};
        this.running = false;
        this.muted = false;
        this.strict = false;
        this.reset();
    }

    on(event, fn) { this.handlers[event] = fn; return this; }
    emit(event, ...args) { this.handlers[event]?.(...args); }

    configure(opts) { Object.assign(this.opts, opts); }

    async start() {
        const ctx = audioContext();
        await ctx.resume();
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('This browser can\'t use the microphone here (it needs https or localhost).');
        }
        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: this.opts.echoCancellation, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        if (!loaded.has(ctx)) {
            const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            loaded.add(ctx);
        }
        this.source = ctx.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(ctx, 'mic-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        this.sink = ctx.createGain();
        this.sink.gain.value = 0; // keeps the node pulled by the graph without playing the mic back
        this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
        this.node.port.onmessage = e => this.frame(e.data);
        this.reset();
        this.floor = -60;
        this.running = true;
    }

    stop() {
        this.running = false;
        this.stream?.getTracks().forEach(t => t.stop());
        try { this.source?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch {}
        if (this.node) this.node.port.onmessage = null;
        this.stream = this.source = this.node = this.sink = null;
        this.reset();
    }

    reset() {
        this.inSpeech = false;
        this.onset = 0;
        this.recent = [];
        this.pre = [];
        this.seg = [];
        this.speechMs = 0;
        this.silenceMs = 0;
        this.segMs = 0;
        this.lastLevel = 0;
    }

    setMuted(on) {
        if (on === this.muted) return;
        this.muted = on;
        if (on && this.inSpeech) this.emit('discard');
        this.reset();
    }

    setStrict(on) { this.strict = on; }

    get level() { return this.lastLevel; }

    // The current utterance so far (for an early look at what's being said).
    snapshot() {
        const audio = new Float32Array(this.seg.length * FRAME);
        this.seg.forEach((fr, i) => audio.set(fr, i * FRAME));
        return audio;
    }

    frame(f) {
        if (!this.running) return;
        let sum = 0;
        for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
        const db = 10 * Math.log10(sum / f.length + 1e-12);

        if (this.muted) { this.lastLevel = 0; return; }

        // Track the background level: quickly down, slowly up, and not while someone's talking.
        if (!this.inSpeech) {
            const k = db < this.floor ? 0.15 : 0.008;
            this.floor = Math.min(-30, Math.max(-90, this.floor + (db - this.floor) * k));
        }
        const strict = this.strict;
        const threshold = Math.max(this.floor + (strict ? 18 : 11), (MIN_DB[this.opts.sensitivity] ?? MIN_DB.medium) + (strict ? 8 : 0));
        const voiced = db > threshold;
        this.debug = { db: Math.round(db), threshold: Math.round(threshold), onset: this.onset, strict };
        this.lastLevel = Math.max(0, Math.min(1, (db - threshold + 15) / 30));

        if (!this.inSpeech) {
            this.pre.push(f);
            // While the assistant talks, keep more: echo cancellation can hide the first words.
            const preFrames = Math.ceil((strict ? Math.max(900, this.opts.preRollMs) : this.opts.preRollMs) / FRAME_MS);
            if (this.pre.length > preFrames) this.pre.shift();
            // Speech starts once enough of the recent frames are voiced: 3 of the last 5 (~100 ms), or
            // when strict 6 of the last 14 (~200 ms within ~450 ms). A window rather than a run of
            // consecutive frames, because echo cancellation chops up the user's voice while the
            // assistant is talking (double-talk), and syllables dip anyway.
            const [need, of] = strict ? [6, 14] : [3, 5];
            this.recent.push(voiced);
            if (this.recent.length > of) this.recent.shift();
            this.onset = this.recent.reduce((n, v) => n + v, 0);
            if (this.onset >= need) {
                this.inSpeech = true;
                this.seg = this.pre.slice();
                this.segMs = this.seg.length * FRAME_MS;
                this.speechMs = this.onset * FRAME_MS;
                this.silenceMs = 0;
                this.pre = [];
                this.emit('speechstart');
            }
            return;
        }

        this.seg.push(f);
        this.segMs += FRAME_MS;
        if (voiced) { this.speechMs += FRAME_MS; this.silenceMs = 0; }
        else this.silenceMs += FRAME_MS;
        this.emit('progress', this.speechMs);

        if (this.silenceMs >= this.opts.endSilenceMs || this.segMs >= this.opts.maxMs) this.finish();
    }

    finish() {
        // Keep ~250 ms of the trailing silence; Whisper doesn't need the rest.
        const trailing = Math.max(0, Math.floor((this.silenceMs - 250) / FRAME_MS));
        const frames = this.seg.slice(0, this.seg.length - trailing);
        const speechMs = this.speechMs;
        this.reset();
        if (speechMs < this.opts.minSpeechMs) { this.emit('discard'); return; }
        const audio = new Float32Array(frames.length * FRAME);
        frames.forEach((fr, i) => audio.set(fr, i * FRAME));
        this.emit('speechend', audio);
    }
}
