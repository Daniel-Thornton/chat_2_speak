// Hands-free voice conversation: listen → transcribe → stream the reply → speak it → listen again.
//
// Turn-taking:
//  • The user's turn ends after a short pause (MicVad endpointing).
//  • The reply is spoken sentence by sentence while the LLM is still writing it.
//  • Barge-in: if the user starts talking over the reply, it keeps playing at full volume and is stopped
//    once it's clear they're really speaking. While nothing is playing yet that's just ≈0.6 s of
//    speech; while the assistant is talking, an early transcript must also show words that aren't
//    simply its own voice leaking back from the speakers. What had actually been said aloud is
//    what's kept in the chat history.
//  • If the user carries on talking before any of the reply was heard (they'd only paused), the
//    half-made reply is dropped and the new words are added to their previous message instead.
//  • Things typed, pasted or dropped into the box (text, links, images) go with what the user says
//    next, or straight away with Send. Pasted just after speaking, before the reply is audible,
//    they're added to that message and the reply starts again with them.
//  • Announcements (a reminder going off) wait until nobody's talking (or 8 s at most, in case the
//    room is just noisy), then are spoken like a reply, so they can be interrupted too.
//
// The host (app.js) owns the chat history and the UI; see the `host` methods used below.

import { MicVad } from './mic.js';
import { SpeechPlayer } from './speech-player.js';
import { SentenceChunker, cleanForSpeech } from './speech-text.js';
import { streamChat, transcribe } from './api.js';

const INTERRUPT_AFTER_MS = 600; // speech over a reply that isn't audible yet
const PEEK_AFTER_MS = 450;      // speech over audible reply: transcribe this much to check it's not echo

const words = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);

export class Conversation {
    constructor(host) {
        this.host = host;
        this.state = 'off';
        this.active = false;
        this.userMuted = false;
        this.reply = null;       // the reply being written/spoken: { abort, handle, full, textDone }
        this.mergeNext = false;  // add the next transcript to the previous user message
        this.transcribing = 0;
        this.announcements = [];
        this.mic = new MicVad();
        this.player = new SpeechPlayer({
            getVoice: () => host.voice(),
            onChunkStart: (text, first) => this.onChunkStart(text, first),
            onIdle: () => this.onReplyIdle(),
            onEngine: name => host.onEngine?.(name)
        });
        this.mic
            .on('speechstart', () => this.onSpeechStart())
            .on('progress', ms => this.onSpeechProgress(ms))
            .on('speechend', audio => this.onSpeechEnd(audio))
            .on('discard', () => this.onDiscard());
    }

    applySettings(s) {
        const echoCancellation = !s.headphones;
        const restart = this.mic.running && this.mic.opts.echoCancellation !== echoCancellation;
        this.mic.configure({ endSilenceMs: s.endSilenceMs, sensitivity: s.micSensitivity, echoCancellation });
        this.headphones = !!s.headphones;
        this.bargeIn = s.bargeIn;
        this.updateMute();
        if (restart) this.mic.stop(), this.mic.start().catch(err => this.setState('error', err.message));
    }

    // Stricter speech detection while the assistant is audible, unless there's no echo to fear.
    strict(on) {
        this.mic.setStrict(on && !this.headphones);
    }

    setState(state, detail = '') {
        this.state = state;
        this.host.onState(state, detail);
    }

    async start() {
        if (this.active) return true;
        this.active = true;
        this.setState('starting');
        try {
            await this.mic.start();
        } catch (err) {
            this.active = false;
            const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
            this.setState('error', denied ? 'Microphone access was denied.' : (err.message || 'Could not start the microphone.'));
            return false;
        }
        this.userMuted = false;
        this.updateMute();
        this.listen();
        this.tick();
        return true;
    }

    stop() {
        if (!this.active) return;
        clearTimeout(this.announceTimer);
        for (const a of this.announcements.splice(0)) this.host.onAnnouncementDropped?.(a.text); // not said yet
        this.interrupt();
        this.active = false;
        cancelAnimationFrame(this.raf);
        this.mic.stop();
        this.setState('off');
    }

    tick() {
        if (!this.active) return;
        this.host.onLevels?.(this.mic.level, this.player.level());
        this.raf = requestAnimationFrame(() => this.tick());
    }

    listen() {
        this.strict(false);
        this.updateMute();
        this.setState(this.userMuted ? 'muted' : 'listening');
        if (this.announcements.length) setTimeout(() => this.announceNext(), 300);
    }

    // ── Announcements: something to say unprompted, e.g. a reminder going off ──

    announce(text, tries = 0) {
        this.announcements.push({ text, at: Date.now(), tries });
        this.announceNext();
    }

    get idle() {
        return this.active && !this.reply && !this.mergeNext && !this.transcribing && !this.mic.inSpeech;
    }

    announceNext() {
        clearTimeout(this.announceTimer);
        if (!this.announcements.length || !this.active) return;
        const waited = Date.now() - this.announcements[0].at;
        if (!this.idle && (this.reply || this.transcribing || waited < 8000)) {
            this.announceTimer = setTimeout(() => this.announceNext(), 1000); // (and listen() tries too)
            return;
        }
        const { text, tries } = this.announcements.shift();
        const reply = { abort: new AbortController(), handle: this.host.beginReply({ announcement: true }), full: text, textDone: true, announcement: { tries } };
        this.reply = reply;
        this.updateMute();
        this.player.begin();
        reply.handle.update(text);
        const chunker = new SentenceChunker();
        for (const p of [...chunker.push(text), ...chunker.flush()]) this.player.enqueue(cleanForSpeech(p));
        this.player.end();
    }

    // The mic is off when the user muted it, or (with barge-in off) while the assistant has the floor.
    updateMute() {
        this.mic.setMuted(this.userMuted || (!this.bargeIn && !!this.reply));
    }

    // The big button: interrupt the assistant if it's talking/thinking, else mute/unmute.
    toggle() {
        if (!this.active) return;
        if (this.reply) {
            this.interrupt();
            this.listen();
            return;
        }
        this.userMuted = !this.userMuted;
        this.listen();
    }

    // ── The user's speech ──

    onSpeechStart() {
        this.peeked = false;
        if (!this.reply && this.state === 'listening') this.setState('hearing');
    }

    onSpeechProgress(ms) {
        const reply = this.reply;
        if (!reply) return;
        if (!this.player.spoken.length) {               // nothing audible yet, so it can't be echo
            if (ms >= INTERRUPT_AFTER_MS) this.interrupt({ byVoice: true });
        } else if (ms >= PEEK_AFTER_MS && !this.peeked) {
            this.peeked = true;
            this.peek(reply);
        }
    }

    // Transcribe the speech so far; stop the reply if it's the user, not the assistant's own echo.
    async peek(reply) {
        let text = '';
        try { text = await transcribe(this.mic.snapshot(), { language: this.host.language?.() }); } catch {}
        if (this.reply === reply && text && !this.isEcho(text)) this.interrupt({ byVoice: true });
    }

    // Mostly the words the assistant has just been saying? Then it's the speakers, not the user.
    isEcho(text) {
        const heard = words(text);
        if (!heard.length) return true;
        const said = new Set(words(this.player.spokenText()));
        if (!said.size) return false;
        return heard.filter(w => said.has(w)).length / heard.length >= 0.6;
    }

    onDiscard() {
        if (!this.reply && !this.answerPending() && this.state === 'hearing') this.listen();
    }

    // The user's last message is still waiting for a reply (we held off because they seemed to be
    // carrying on), but what followed wasn't words after all: answer it now.
    answerPending() {
        if (!this.mergeNext || this.reply || this.transcribing || this.mic.inSpeech) return false;
        this.mergeNext = false;
        this.respond();
        return true;
    }

    async onSpeechEnd(audio) {
        if (!this.active) return;
        if (!this.reply) this.setState('transcribing');
        this.transcribing++;
        let text = '';
        try {
            text = await transcribe(audio, { language: this.host.language?.() });
        } catch (err) {
            this.transcribing--;
            if (!this.reply) { this.setState('error', err.message); setTimeout(() => this.active && !this.reply && this.listen(), 3500); }
            return;
        }
        this.transcribing--;
        if (!this.active) return;

        if (!text || (this.reply && this.isEcho(text))) { // noise, a cough, the assistant's own echo...
            if (!this.reply && !this.answerPending() && !this.transcribing) this.listen();
            return;
        }

        if (this.reply) this.interrupt({ byVoice: true }); // real words over the reply: it stops
        const merge = this.mergeNext;
        this.mergeNext = false;
        await this.host.onUserText(text, merge); // (also takes whatever's waiting in the box)
        if (!this.active || this.reply) return;

        // Already talking again (or another bit is still being transcribed)? Wait for the rest.
        if (this.mic.inSpeech || this.transcribing) { this.mergeNext = true; return; }
        this.respond();
    }

    // ── The text box ──

    // Send what's in the box now. Returns false if it should wait for the words being spoken.
    async submit() {
        if (!this.active) return false;
        if (this.mic.inSpeech || this.transcribing) return false; // goes with what's being said
        let merge = false;
        if (this.reply) {
            const audible = this.player.spoken.length > 0;
            this.interrupt();
            merge = !audible && this.host.lastIsUser(); // adding to the question it hadn't answered yet
        }
        const sent = await this.host.onUserText('', merge);
        if (sent && this.active && !this.reply) this.respond();
        else if (!this.reply) this.listen();
        return true;
    }

    // Something was pasted or dropped into the box. Just after the user spoke, before the reply is
    // audible, it belongs with what they said: redo the reply with it. Otherwise it waits.
    async attachmentsAdded() {
        if (!this.active || !this.reply || this.player.spoken.length || !this.host.lastIsUser()) return;
        this.interrupt();
        await this.host.onUserText('', true, { typed: false });
        if (this.active && !this.reply) this.respond(); // (answers again even if nothing could be added)
    }

    // ── The reply ──

    async respond() {
        const abort = new AbortController();
        const reply = { abort, handle: this.host.beginReply(), full: '', textDone: false };
        this.reply = reply;
        this.updateMute();
        this.player.begin();
        this.setState('thinking');
        const chunker = new SentenceChunker();
        const speak = pieces => { for (const p of pieces) this.player.enqueue(cleanForSpeech(p)); };
        try {
            await streamChat(this.host.chatRequest(), {
                signal: abort.signal,
                onToken: (delta, full) => {
                    if (this.reply !== reply) return;
                    reply.full = full;
                    reply.handle.update(full);
                    speak(chunker.push(delta));
                },
                onNotice: text => this.host.onNotice?.(text),
                onTool: m => { if (this.reply === reply && this.state === 'thinking') this.setState('thinking', m.label || 'Using a tool…'); },
                onAction: text => { if (this.reply === reply) { reply.handle.action?.(text); this.host.onAction?.(text); } },
                onTrace: msgs => { if (this.reply === reply) reply.handle.trace?.(msgs); },
                onLinks: (kind, links) => { if (this.reply === reply) { reply.handle.links?.(kind, links); this.host.onLinks?.(kind, links); } },
                onThinking: delta => {
                    if (this.reply !== reply) return;
                    reply.handle.think?.(delta);
                    if (this.state === 'thinking') this.setState('thinking', 'Thinking it over…');
                }
            });
        } catch (err) {
            if (abort.signal.aborted || this.reply !== reply) return;
            this.reply = null;
            this.player.stop();
            reply.handle.discard();
            this.setState('error', err.message);
            setTimeout(() => this.active && !this.reply && this.listen(), 4000);
            return;
        }
        if (this.reply !== reply) return;
        speak(chunker.flush());
        reply.textDone = true;
        this.player.end(); // → onReplyIdle once it's all been said
    }

    onChunkStart(text, first) {
        if (!this.reply) return;
        if (first) {
            this.strict(true);
            this.setState('speaking');
        }
        this.host.onSpoken?.(text);
    }

    onReplyIdle() {
        const reply = this.reply;
        if (!reply || !reply.textDone) return;
        this.reply = null;
        if (reply.full.trim()) reply.handle.commit(reply.full, false);
        else reply.handle.discard();
        // Let the room's echo of the last word die away before relaxing detection.
        setTimeout(() => { if (!this.reply) this.strict(false); }, 350);
        this.listen();
    }

    // Stop the reply now. Keep what was actually heard; if nothing was heard yet and the user cut
    // in by talking, they were mid-thought, so their next words join their last message.
    interrupt({ byVoice = false } = {}) {
        const reply = this.reply;
        if (!reply) return;
        this.reply = null;
        reply.abort.abort();
        const spoken = this.player.spokenText();
        this.player.stop();
        if (reply.announcement && !spoken) {
            // Cut off before a word of the reminder was heard: say it again at the next gap, or,
            // after a few goes (a noisy room), just put it in the chat.
            if (reply.announcement.tries < 2) { reply.handle.discard(); this.announcements.unshift({ text: reply.full, at: Date.now(), tries: reply.announcement.tries + 1 }); this.announceTimer = setTimeout(() => this.announceNext(), 1000); }
            else { reply.handle.commit(reply.full, false); this.host.onNotice?.(reply.full); }
        } else if (spoken) reply.handle.commit(spoken + ' —', true);
        else {
            reply.handle.discard();
            if (byVoice) this.mergeNext = true;
        }
        this.updateMute();
        if (byVoice) this.setState('hearing');
    }
}
