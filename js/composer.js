// The box in conversation mode for things that are easier pasted than said: links, text, images.
//
// Short typed text stays in the box. Pasted links, long pasted text, dropped text files and
// images become "chips" waiting above it. take() hands everything over (waiting for links to
// finish being read) when the user's next message goes out: when they finish speaking, or
// press Enter/Send.

import { fetchLink } from './api.js';

const LONG_PASTE = 280;         // chars: a paste longer than this becomes a chip, not box text
const MAX_TEXT = 40000;         // chars kept from one pasted text / file
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|cc|cpp|h|hpp|cs|php|sh|ps1|bat|ya?ml|toml|ini|log|sql|srt|vtt)$/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/gi;

let nextId = 1;

export class Composer {
    // els: { root (drop zone), textarea, chips, sendBtn, imageBtn, fileInput }
    // compressImage(dataUrl) -> Promise<{ dataUrl, base64 }>; onAdded() when chips are added;
    // onSubmit() on Enter/Send; onFlash(text) for a short message.
    constructor(els, { compressImage, onAdded, onSubmit, onFlash }) {
        Object.assign(this, els);
        this.compressImage = compressImage;
        this.onAdded = onAdded || (() => {});
        this.onSubmit = onSubmit || (() => {});
        this.onFlash = onFlash || (() => {});
        this.items = [];

        this.textarea.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.onSubmit(); }
            e.stopPropagation(); // (Space etc. mustn't reach the conversation's shortcuts)
        });
        this.textarea.addEventListener('input', () => this.grow());
        this.textarea.addEventListener('paste', e => this.handlePaste(e));
        this.sendBtn.addEventListener('click', () => this.onSubmit());
        this.imageBtn.addEventListener('click', () => this.fileInput.click());
        this.fileInput.addEventListener('change', () => { this.addFiles([...this.fileInput.files]); this.fileInput.value = ''; });

        this.root.addEventListener('dragover', e => { e.preventDefault(); this.root.classList.add('dragging'); });
        this.root.addEventListener('dragleave', e => { if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('dragging'); });
        this.root.addEventListener('drop', e => {
            e.preventDefault();
            this.root.classList.remove('dragging');
            const files = [...(e.dataTransfer?.files || [])];
            if (files.length) return this.addFiles(files);
            const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
            this.addPastedText(text, true);
        });
    }

    get hasContent() {
        return this.items.length > 0 || this.textarea.value.trim().length > 0;
    }

    grow() {
        this.textarea.style.height = 'auto';
        this.textarea.style.height = Math.min(this.textarea.scrollHeight, 120) + 'px';
    }

    // Paste: images and links (and long text) become chips; a short bit of text goes in the box.
    handlePaste(e) {
        const cd = e.clipboardData;
        if (!cd) return;
        const files = [...cd.files].filter(f => f.type.startsWith('image/'));
        if (files.length) {
            e.preventDefault();
            this.addFiles(files);
            return;
        }
        const text = cd.getData('text/plain');
        if (this.addPastedText(text, false)) e.preventDefault();
        else if (e.target !== this.textarea) { // pasted elsewhere on the panel: put it in the box
            e.preventDefault();
            this.textarea.value += (this.textarea.value && !/\s$/.test(this.textarea.value) ? ' ' : '') + text;
            this.grow();
            this.textarea.focus();
        }
    }

    // Returns true if `text` became chips (so it shouldn't also be pasted into the box).
    addPastedText(text, dropped) {
        const t = String(text || '').trim();
        if (!t) return false;
        const urls = t.match(URL_RE) || [];
        const onlyUrls = urls.length && t.replace(URL_RE, '').trim() === '';
        if (onlyUrls) {
            for (const u of new Set(urls)) this.addLink(u);
            this.added();
            return true;
        }
        if (dropped || t.length > LONG_PASTE || t.split('\n').length > 4) {
            this.add({ kind: 'text', name: 'Pasted text', text: t.slice(0, MAX_TEXT) });
            this.added();
            return true;
        }
        return false;
    }

    addFiles(files) {
        const jobs = files.map(async f => {
            if (f.type.startsWith('image/')) {
                const dataUrl = await readAs(f, 'dataURL');
                const img = await this.compressImage(dataUrl);
                this.add({ kind: 'image', name: f.name || 'Image', ...img });
            } else if (f.type.startsWith('text/') || TEXT_FILE.test(f.name) || f.type === 'application/json') {
                if (f.size > 2 * 1024 * 1024) { this.onFlash(`${f.name} is too big to paste in.`); return; }
                const text = await readAs(f, 'text');
                this.add({ kind: 'text', name: f.name, text: text.slice(0, MAX_TEXT) });
            } else {
                this.onFlash(`Can't read ${f.name || 'that file'}: images and text files only.`);
            }
        });
        Promise.all(jobs).then(() => this.added());
    }

    addLink(url) {
        if (this.items.some(i => i.kind === 'link' && i.url === url)) return;
        const item = this.add({ kind: 'link', url, state: 'loading', title: hostOf(url) });
        item.promise = fetchLink(url).then(async page => {
            if (page.kind === 'image') {
                const img = await this.compressImage(`data:${page.mime};base64,${page.base64}`);
                Object.assign(item, { kind: 'image', name: hostOf(url), ...img, state: 'ok' });
            } else {
                Object.assign(item, { state: 'ok', title: page.title, text: page.text, truncated: page.truncated });
            }
        }, err => Object.assign(item, { state: 'error', error: err.message }))
            .finally(() => this.render());
        return item;
    }

    add(item) {
        item.id = nextId++;
        this.items.push(item);
        this.render();
        return item;
    }

    added() {
        if (this.items.length) this.onAdded();
    }

    remove(id) {
        this.items = this.items.filter(i => i.id !== id);
        this.render();
    }

    // Hand over what's waiting: { typed, attachments, images }, links read first. `typed: false`
    // leaves the text being typed in the box (it may be half-written).
    async take({ typed = true } = {}) {
        let text = '';
        if (typed) {
            text = this.textarea.value.trim();
            for (const u of new Set(text.match(URL_RE) || [])) this.addLink(u); // links typed in are read too
            this.textarea.value = '';
            this.grow();
        }
        const items = this.items;
        this.items = [];
        this.render();
        await Promise.allSettled(items.map(i => i.promise).filter(Boolean));
        const attachments = [];
        const images = [];
        for (const i of items) {
            if (i.kind === 'image') images.push({ dataUrl: i.dataUrl, base64: i.base64 });
            else if (i.kind === 'text') attachments.push({ type: 'text', name: i.name, text: i.text });
            else if (i.kind === 'link') attachments.push(i.state === 'ok'
                ? { type: 'link', url: i.url, title: i.title, text: i.text, truncated: !!i.truncated }
                : { type: 'link', url: i.url, title: hostOf(i.url), error: i.error || 'could not be read' });
        }
        return { typed: text, attachments, images };
    }

    get loading() {
        return this.items.some(i => i.state === 'loading');
    }

    clear() {
        this.items = [];
        this.textarea.value = '';
        this.grow();
        this.render();
    }

    render() {
        this.chips.innerHTML = '';
        this.chips.classList.toggle('hidden', this.items.length === 0);
        for (const i of this.items) {
            const chip = document.createElement('div');
            chip.className = `chip chip-${i.kind}${i.state ? ' chip-' + i.state : ''}`;
            if (i.kind === 'image') {
                const img = document.createElement('img');
                img.src = i.dataUrl;
                img.alt = '';
                chip.appendChild(img);
            }
            const label = document.createElement('span');
            label.className = 'chip-label';
            label.textContent = i.kind === 'image' ? i.name
                : i.kind === 'text' ? `📄 ${i.name} · ${i.text.length.toLocaleString()} chars`
                : i.state === 'loading' ? `🔗 Reading ${hostOf(i.url)}…`
                : i.state === 'error' ? `🔗 ${hostOf(i.url)}: ${i.error}`
                : `🔗 ${i.title}`;
            label.title = i.kind === 'link' ? i.url : i.kind === 'text' ? i.text.slice(0, 400) : i.name;
            chip.appendChild(label);
            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'chip-remove';
            x.setAttribute('aria-label', 'Remove');
            x.textContent = '×';
            x.addEventListener('click', () => this.remove(i.id));
            chip.appendChild(x);
            this.chips.appendChild(chip);
        }
    }
}

export function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function readAs(file, how) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        how === 'text' ? r.readAsText(file) : r.readAsDataURL(file);
    });
}
