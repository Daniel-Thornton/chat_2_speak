// Turns an audio file the user picked into a voice sample for Breeze to clone.
//
// Breeze takes a short reference clip plus a transcript of it. Long clips cost speed and context,
// so the sample is cut to about 10 s (ending in a quiet moment, not mid-word), mono, at Breeze's
// own 24 kHz. The same cut is resampled to 16 kHz for Whisper, which writes the transcript.

import { apiUrl, transcribe } from './api.js';

const MAX_SECONDS = 10;
const MIN_SECONDS = 3;
const OUT_RATE = 24000;
const STT_RATE = 16000;

async function decode(file) {
    const bytes = await file.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try {
        return await ctx.decodeAudioData(bytes);
    } catch {
        throw new Error("Couldn't read that audio file. Try a WAV, MP3, M4A or OGG.");
    } finally {
        ctx.close().catch(() => {});
    }
}

function mono(buf) {
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
    }
    return out;
}

async function resample(samples, from, to) {
    if (from === to) return samples;
    const length = Math.max(1, Math.round(samples.length * to / from));
    const off = new OfflineAudioContext(1, length, to);
    const buf = off.createBuffer(1, samples.length, from);
    buf.copyToChannel(samples, 0);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0);
}

// Index of the first sample that isn't near-silence (so the clip doesn't start with dead air).
function firstSound(x, rate) {
    const win = Math.round(rate * 0.02);
    for (let i = 0; i + win < x.length; i += win) {
        let sum = 0;
        for (let j = i; j < i + win; j++) sum += x[j] * x[j];
        if (Math.sqrt(sum / win) > 0.01) return Math.max(0, i - win * 5);
    }
    return 0;
}

// The quietest 40 ms point in the last two seconds of the allowed length: a good place to cut.
function quietCut(x, start, rate) {
    const end = start + MAX_SECONDS * rate;
    const win = Math.round(rate * 0.04);
    let best = end, bestRms = Infinity;
    for (let i = end - 2 * rate; i + win <= end; i += win >> 1) {
        let sum = 0;
        for (let j = i; j < i + win; j++) sum += x[j] * x[j];
        const rms = Math.sqrt(sum / win);
        if (rms < bestRms) { bestRms = rms; best = i + (win >> 1); }
    }
    return best;
}

function wavBytes(samples, rate) {
    const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); data.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
    data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
    str(36, 'data'); data.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        data.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return data.buffer;
}

// Prepare a picked file: decode, cut, upload to the server, and transcribe.
// Resolves { id, text, seconds, name }. `onStep(message)` reports progress.
export async function prepareVoiceSample(file, { language, onStep = () => {} } = {}) {
    onStep('Reading the audio…');
    const buf = await decode(file);
    const full = mono(buf);

    let start = firstSound(full, buf.sampleRate);
    let end = Math.min(full.length, start + MAX_SECONDS * buf.sampleRate);
    if (start + MAX_SECONDS * buf.sampleRate < full.length) end = quietCut(full, start, buf.sampleRate);
    const clip = full.subarray(start, end);
    const seconds = clip.length / buf.sampleRate;
    if (seconds < MIN_SECONDS) throw new Error(`That clip is only ${seconds.toFixed(1)} s of sound. Use at least ${MIN_SECONDS} s of clear speech.`);

    const [wav, stt] = await Promise.all([resample(clip, buf.sampleRate, OUT_RATE), resample(clip, buf.sampleRate, STT_RATE)]);

    onStep('Uploading the sample…');
    let res;
    try {
        res = await fetch(apiUrl('/api/tts/sample'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: wavBytes(wav, OUT_RATE)
        });
    } catch {
        throw new Error('Could not reach the server.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);

    onStep('Transcribing the sample…');
    let text = '';
    try { text = await transcribe(stt, { language }); }
    catch (err) { onStep(`Couldn't transcribe it automatically (${err.message}). Type what is said in the sample.`); }
    return { id: data.id, text, seconds, name: file.name };
}
