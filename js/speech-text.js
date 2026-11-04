// Turning an LLM reply (streamed token by token) into speakable chunks for Breeze TTS.
//
// SentenceChunker cuts the stream at sentence ends so the first sentence can be voiced while the
// rest is still being written. cleanForSpeech strips what a TTS would read out literally
// (markdown, emoji, URLs) and keeps the sounds Breeze can perform: (laugh), (sigh), (cough),
// (clears throat).

// Variants LLMs write, mapped onto the four sounds Breeze knows.
const VOCAL_EVENTS = {
    laugh: 'laugh', laughs: 'laugh', laughing: 'laugh', chuckle: 'laugh', chuckles: 'laugh', giggle: 'laugh', giggles: 'laugh',
    sigh: 'sigh', sighs: 'sigh', sighing: 'sigh',
    cough: 'cough', coughs: 'cough', coughing: 'cough',
    'clear throat': 'clears throat', 'clears throat': 'clears throat', 'clearing throat': 'clears throat'
};

function vocalEvent(inner) {
    const k = String(inner).toLowerCase().replace(/\b(his|her|their|my|the|softly|lightly|quietly)\s+/g, '').replace(/\s+/g, ' ').trim();
    return VOCAL_EVENTS[k] || null;
}

// Breeze stumbles when a clip *starts* with a sound, so "(laugh) Oh, you!" becomes "Oh, you! (laugh)".
function leadingSoundLater(text) {
    const m = text.match(/^\s*(\((?:laugh|sigh|cough|clears throat)\))\s*(.*)$/s);
    if (!m) return text;
    const rest = m[2].trim();
    if (!rest) return '';
    const first = rest.match(/^.*?[.!?…]+["')\]]*(?=\s|$)/s);
    return first && first[0].length < rest.length
        ? `${first[0]} ${m[1]} ${rest.slice(first[0].length).trim()}`
        : `${rest} ${m[1]}`;
}

export function cleanForSpeech(text) {
    let s = String(text || '');
    s = s.replace(/```[\s\S]*?(```|$)/g, ' ');                    // code blocks
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                    // images
    s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');                 // [text](url) -> text
    s = s.replace(/https?:\/\/(?:www\.)?([^\s/)]+)[^\s)]*/g, '$1'); // bare URLs -> their domain
    s = s.replace(/`([^`]*)`/g, '$1');
    s = s.replace(/\*([a-z ]{3,24})\*/gi, (m, inner) => vocalEvent(inner) ? `(${vocalEvent(inner)})` : inner); // *laughs*
    s = s.replace(/\(([^()]{1,30})\)/g, (m, inner) => {
        const e = vocalEvent(inner);
        return e ? `(${e})` : m;
    });
    s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');       // headings
    s = s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, ''); // list markers
    s = s.replace(/^\s*>\s?/gm, '');                 // quotes
    s = s.replace(/\|/g, ', ');                      // table cells
    s = s.replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2');
    s = s.replace(/[*_~#<>{}\[\]^]/g, '');
    s = s.replace(/\p{Extended_Pictographic}|️|‍/gu, '');
    s = s.replace(/(\d)\s*–\s*(?=[-−]?\d)/g, '$1 to ');            // 9–10°C, 3:00–4:00 pm
    s = s.replace(/\s*—\s*/g, ', ').replace(/\s+–\s+/g, ', ');
    // Units, as said aloud (weather and travel replies)
    s = s.replace(/(^|[\s(])[-−](\d)/g, '$1minus $2');
    s = s.replace(/(\d)\s*°\s*C\b/g, '$1 degrees').replace(/(\d)\s*°\s*F\b/g, '$1 degrees Fahrenheit').replace(/(\d)\s*°/g, '$1 degrees');
    s = s.replace(/(\d)\s*mph\b/gi, '$1 miles an hour').replace(/(\d)\s*km\/h\b/gi, '$1 kilometres an hour');
    s = s.replace(/(\d)\s*km\b/g, '$1 kilometres').replace(/(\d)\s*mm\b/g, '$1 millimetres');
    s = s.replace(/\s+/g, ' ').trim();
    s = leadingSoundLater(s);
    return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

// Words that end in a full stop without ending the sentence.
const ABBREV = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|no|vol|fig|inc|ltd|co|mt|ft|in|lb|oz|a\.m|p\.m|u\.s|u\.k)\.$/i;
const FIRST_MIN = 12;   // chars: a first sentence shorter than this waits for the next ("Sure! ...")
const LATER_MIN = 30;   // later short sentences are merged with what follows (smoother prosody)
const SOFT_MAX  = 180;  // with no sentence end in sight, cut at a comma/semicolon past this many chars
const HARD_MAX  = 260;

export class SentenceChunker {
    constructor() {
        this.buf = '';
        this.inCode = false;
        this.count = 0;
        this.codeNoted = false;
    }

    push(text) {
        this.buf += text;
        return this.drain(false);
    }

    flush() {
        return this.drain(true);
    }

    drain(final) {
        const out = [];
        for (;;) {
            if (this.inCode) {
                const end = this.buf.indexOf('```');
                if (end < 0) {
                    this.buf = final ? '' : this.buf.slice(-2); // keep a fence that may be half-arrived
                    return out;
                }
                this.inCode = false;
                this.buf = this.buf.slice(end + 3);
                continue;
            }
            const fence = this.buf.indexOf('```');
            if (fence >= 0) {
                this.emitAll(this.buf.slice(0, fence), out);
                if (!this.codeNoted) { out.push("I've put the code in the chat."); this.codeNoted = true; }
                this.inCode = true;
                this.buf = this.buf.slice(fence + 3);
                continue;
            }
            break;
        }

        // Hold back a trailing backtick or two: they may be the start of a code fence.
        let hold = '';
        if (!final) {
            const m = this.buf.match(/`{1,2}$/);
            if (m) { hold = m[0]; this.buf = this.buf.slice(0, -hold.length); }
        }
        if (final) this.emitAll(this.buf, out), this.buf = '';
        else this.buf = this.emitReady(this.buf, out);
        this.buf += hold;
        return out;
    }

    // Emit every complete sentence in `s`; return the unfinished remainder.
    emitReady(s, out) {
        let start = 0;
        const re = /([.!?…]+)(["'”’)\]]*)(?=\s)|\n+/g;
        let m;
        while ((m = re.exec(s))) {
            const end = m.index + m[0].length;
            const piece = s.slice(start, end);
            if (m[1] === '.' && (ABBREV.test(piece.trimEnd()) || /(?:^|\s)[A-Z]\.$/.test(piece.trimEnd()) || /\d\.$/.test(piece.trimEnd()) && /^\s*\d/.test(s.slice(end)))) continue;
            const min = this.count === 0 ? FIRST_MIN : LATER_MIN;
            if (piece.trim().length < min && !m[0].startsWith('\n')) continue; // merge with what follows
            this.add(piece, out);
            start = end;
        }
        let rest = s.slice(start);
        // A very long sentence: cut at a clause boundary so speech can start.
        while (rest.length > SOFT_MAX) {
            const window = rest.slice(0, HARD_MAX);
            let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' - '));
            if (cut < 60) {
                if (rest.length < HARD_MAX) break;
                cut = window.lastIndexOf(' ');
                if (cut < 60) cut = HARD_MAX;
            }
            this.add(rest.slice(0, cut + 1), out);
            rest = rest.slice(cut + 1);
        }
        return rest;
    }

    emitAll(s, out) {
        const rest = this.emitReady(s, out);
        if (rest.trim()) this.add(rest, out);
    }

    add(piece, out) {
        const t = piece.replace(/\s+/g, ' ').trim();
        if (!t) return;
        out.push(t);
        this.count++;
    }
}
