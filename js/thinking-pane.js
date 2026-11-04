// The "Thinking" window under the chat: shows a reasoning model's thinking (Ollama's
// message.thinking) live as it streams, and the saved thinking of any earlier reply on request.
// It can be collapsed, closed (it reopens on the next reply that thinks) and resized by dragging
// its top edge.

const HEIGHT_KEY = 'thinking_pane_height';
const COLLAPSED_KEY = 'thinking_pane_collapsed';

export class ThinkingPane {
    constructor(root, render = null) {
        this.root = root;
        this.render = render; // markdown -> safe HTML
        this.raf = 0;
        this.body = root.querySelector('.thinking-body');
        this.meta = root.querySelector('.thinking-meta');
        this.label = root.querySelector('.thinking-label');
        this.collapseBtn = root.querySelector('.thinking-collapse');
        this.closeBtn = root.querySelector('.thinking-close');
        this.resizer = root.querySelector('.thinking-resize');
        this.timer = 0;

        const h = Number(localStorage.getItem(HEIGHT_KEY));
        if (h) this.root.style.setProperty('--thinking-h', `${h}px`);
        this.setCollapsed(localStorage.getItem(COLLAPSED_KEY) === 'true');

        this.collapseBtn.addEventListener('click', () => this.setCollapsed(!this.collapsed));
        this.root.querySelector('.thinking-titlebar').addEventListener('dblclick', e => {
            if (e.target.closest('button')) return;
            this.setCollapsed(!this.collapsed);
        });
        this.closeBtn.addEventListener('click', () => this.hide());
        this.setupResize();
    }

    show() { this.root.classList.remove('hidden'); }
    hide() { this.root.classList.add('hidden'); }

    setCollapsed(on) {
        this.collapsed = on;
        this.root.classList.toggle('collapsed', on);
        this.collapseBtn.textContent = on ? '▴' : '▾';
        this.collapseBtn.title = on ? 'Expand' : 'Collapse';
        localStorage.setItem(COLLAPSED_KEY, String(on));
    }

    setupResize() {
        let startY = 0, startH = 0;
        const move = e => {
            const h = Math.max(60, Math.min(window.innerHeight * 0.7, startH + (startY - e.clientY)));
            this.root.style.setProperty('--thinking-h', `${Math.round(h)}px`);
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            document.body.classList.remove('resizing');
            localStorage.setItem(HEIGHT_KEY, String(this.body.getBoundingClientRect().height));
        };
        this.resizer.addEventListener('pointerdown', e => {
            if (this.collapsed) this.setCollapsed(false);
            startY = e.clientY;
            startH = this.body.getBoundingClientRect().height;
            document.body.classList.add('resizing');
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
            e.preventDefault();
        });
    }

    setText(text) {
        if (this.render) this.body.innerHTML = this.render(text);
        else this.body.textContent = text;
    }

    nearBottom() {
        return this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 40;
    }

    // A reply is starting. Returns a session: append(delta) as thinking streams in, done() when the
    // answer starts (or the reply ends). The pane opens with the first thinking that arrives.
    start(model) {
        clearInterval(this.timer);
        const session = { text: '', ms: 0, started: 0, finished: false };
        if (!this.root.classList.contains('hidden')) this.meta.textContent = 'waiting…';
        session.append = delta => {
            if (!delta) return;
            if (session.finished && session.started) {
                // More thinking after the answer began (e.g. after a web search): carry on below.
                session.finished = false;
                this.root.classList.add('live');
                const resumed = performance.now() - session.ms;
                session.started = resumed;
                this.timer = setInterval(() => { this.meta.textContent = `thinking… ${((performance.now() - resumed) / 1000).toFixed(1)}s`; }, 100);
                delta = '\n\n' + delta;
            }
            session.finished = false;
            if (!session.started) {
                session.started = performance.now();
                this.label.textContent = `Thinking · ${model}`;
                this.body.textContent = '';
                this.root.classList.add('live');
                this.show();
                const tick = () => { this.meta.textContent = `thinking… ${((performance.now() - session.started) / 1000).toFixed(1)}s`; };
                tick();
                this.timer = setInterval(tick, 100);
            }
            const stick = this.nearBottom();
            session.text += delta;
            // Re-render the whole text (markdown can change meaning as it grows), at most once a frame.
            if (!this.raf) this.raf = requestAnimationFrame(() => {
                this.raf = 0;
                this.setText(session.text);
                if (stick) this.body.scrollTop = this.body.scrollHeight;
            });
        };
        session.done = () => {
            if (session.finished) return;
            session.finished = true;
            clearInterval(this.timer);
            this.root.classList.remove('live');
            if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
            if (session.started) this.setText(session.text);
            if (session.started) {
                session.ms = Math.round(performance.now() - session.started);
                this.meta.textContent = `thought for ${(session.ms / 1000).toFixed(1)}s`;
            } else if (!this.root.classList.contains('hidden')) {
                this.meta.textContent = 'no thinking for the latest reply';
            }
        };
        return session;
    }

    // Show a saved reply's thinking (the 💭 button on a message).
    showSaved(text, ms, model) {
        clearInterval(this.timer);
        this.root.classList.remove('live');
        this.label.textContent = `Thinking · ${model}`;
        this.meta.textContent = ms ? `thought for ${(ms / 1000).toFixed(1)}s` : '';
        this.setText(text);
        this.body.scrollTop = 0;
        if (this.collapsed) this.setCollapsed(false);
        this.show();
    }

    clear() {
        clearInterval(this.timer);
        if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
        this.body.textContent = '';
        this.meta.textContent = '';
        this.root.classList.remove('live');
        this.hide();
    }
}
