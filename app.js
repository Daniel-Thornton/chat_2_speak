import { setApiBase, hasApi, apiUrl, streamChat, transcribe, getStatus, prepareVoice, listModels, subscribeEvents, agentData, postSetting, calendarStatus, removeCalendar, keepStatus, audioContext } from './js/api.js';
import { prepareVoiceSample } from './js/voice-sample.js';
import { Conversation } from './js/conversation.js';
import { SpeechPlayer } from './js/speech-player.js';
import { SentenceChunker, cleanForSpeech } from './js/speech-text.js';
import { MicVad } from './js/mic.js';
import { ThinkingPane } from './js/thinking-pane.js';
import { Composer, hostOf } from './js/composer.js';

const SETTINGS_KEY  = 'chat_settings_v1';
const LAST_CHAT_KEY = 'last_chat_id';
const DRAFT_KEY = 'draft_chat_v1'; // an unsaved chat, kept in this browser so a reload doesn't lose it

const DEFAULT_SYSTEM_PROMPT = `You are a helpful, knowledgeable assistant. Answer clearly and concisely. Use markdown formatting where it helps readability — code blocks for code, bullet points for lists, bold for key terms.`;

// Added to the system prompt in conversation mode: the reply will be heard, not read.
const DEFAULT_VOICE_PROMPT = `You are now in a live spoken conversation. Everything you write is read aloud by a text-to-speech voice, and what the user says reaches you through speech recognition. So, for this conversation:
- Talk the way a person talks: warm, natural and to the point. Keep most replies to one to three sentences; go longer only when the user asks for detail or a story.
- Never use markdown, bullet points, numbered lists, headings, tables, emoji or code blocks. If something has steps, say them in a natural sentence ("first..., then...").
- Write things as they should be spoken: say "about twenty minutes" rather than "~20 min", and avoid symbols. Never read out web addresses: to give the user links, show them on screen (they can click those).
- You may occasionally use one of these sounds where it fits naturally: (laugh), (sigh), (clears throat). Use them sparingly.
- The user's words come from speech recognition, so they may contain small mistakes or be cut off. Go with the most sensible reading, and if it really isn't clear, briefly ask.
- Ask a short follow-up question now and then to keep the conversation going, but not every time.
- While talking, the user can also paste text, links (you're given the page's text) or images. Talk about them naturally, as if you'd just looked at them together. Never read long pasted text or page contents out word for word; summarise or pick out what matters.`;

// Pasted text and links travel with the user's message as `attachments`; this is how the model sees them.
function withAttachments(content, attachments) {
    if (!attachments?.length) return content;
    const parts = attachments.map(a => {
        if (a.type === 'text') return `--- ${a.name || 'Pasted text'} ---\n${a.text}`;
        if (a.error) return `--- Link: ${a.url} ---\n(This page couldn't be read: ${a.error}.)`;
        return `--- Link: ${a.url} (${a.title}) ---\n${a.text}${a.truncated ? '\n[…the page goes on; this is the first part]' : ''}`;
    });
    return `${content || ''}\n\n[The user shared the following along with this message.]\n\n${parts.join('\n\n')}`.trim();
}

// Breeze voice design: a voice is created from a written description (and a variation number).
const VOICE_PRESETS = [
    { id: 'warm',     name: 'Warm & friendly (woman, American)', seed: 7,
      instruction: 'A warm, friendly young woman with a clear, natural voice and a relaxed, conversational American accent. Easygoing and expressive, like chatting with a good friend.' },
    { id: 'calm',     name: 'Calm & thoughtful (man, American)', seed: 11,
      instruction: 'A calm, thoughtful man in his thirties with a smooth, mid-range voice and a neutral American accent. Relaxed, natural and conversational, never rushed.' },
    { id: 'bright-uk', name: 'Bright & articulate (woman, English)', seed: 23,
      instruction: 'A bright, articulate woman in her late twenties with a soft, well-spoken southern English accent. Friendly, lively and natural, with a smile in her voice.' },
    { id: 'gentle-uk', name: 'Gentle & warm (man, Northern English)', seed: 5,
      instruction: 'A warm, gentle man in his forties with a rich, slightly deep voice and a soft northern English accent. Unhurried, kind and conversational.' },
    { id: 'upbeat',   name: 'Upbeat & energetic (woman)', seed: 3,
      instruction: 'An upbeat, energetic young woman with a bright, cheerful voice. Quick, playful and enthusiastic, but clear and easy to follow.' },
    { id: 'narrator', name: 'Deep & smooth (man, British)', seed: 19,
      instruction: 'A man in his fifties with a deep, smooth, resonant voice and a refined British accent. Measured, warm and reassuring, like a late-night radio host.' },
    { id: 'custom',   name: 'Custom (write your own below)', seed: 1, instruction: '' }
];

const DEFAULTS = {
    model: 'llama3.2',
    voicePreset: 'warm',
    voiceInstruction: VOICE_PRESETS[0].instruction,
    voiceSeed: VOICE_PRESETS[0].seed,
    voiceMode: 'describe', // 'describe' = Breeze designs the voice from the description; 'clone' = copy the voice sample
    voiceClone: null,   // { id, text, name, seconds }: a voice sample to clone instead of the description
    bargeIn: true,
    headphones: false,
    endSilenceMs: 750,
    micSensitivity: 'medium',
    sttLanguage: 'en',
    speakReplies: false,
    thinkMode: 'on',
    thinkVoice: true,
    voicePrompt: DEFAULT_VOICE_PROMPT,
    summaryEvery: 6, // messages between title/summary updates (0: only the first)
    tools: { reminders: true, memory: true, lists: true, pc: true, places: true, calendar: true, youtube: true, keep: true } // see agent.js
};
const TOOL_GROUPS = ['reminders', 'memory', 'lists', 'pc', 'places', 'calendar', 'youtube', 'keep'];

// ── DOM ──

const $ = id => document.getElementById(id);
const messagesEl       = $('messages');
const welcomeEl        = $('welcome');
const userInputEl      = $('user-input');
const sendBtn          = $('send-btn');
const clearBtn         = $('clear-btn');
const settingsBtn      = $('settings-btn');
const darkModeBtn      = $('dark-mode-btn');
const settingsModal    = $('settings-modal');
const tunnelUrlIn      = $('tunnel-url');
const modelNameIn      = $('model-name');
const modelListEl      = $('model-list');
const systemPromptIn   = $('system-prompt');
const voicePromptIn    = $('voice-prompt');
const saveSettingsBtn  = $('save-settings');
const closeSettingsBtn = $('close-settings');
const modelBadge       = $('model-badge');
const braveApiKeyIn    = $('brave-api-key');
const voicePresetIn    = $('voice-preset');
const voiceInstrIn     = $('voice-instruction');
const voiceSeedIn      = $('voice-seed');
const voiceRerollBtn   = $('voice-reroll');
const voicePreviewBtn  = $('voice-preview');
const voicePreviewStat = $('voice-preview-status');
const modeDescribeIn   = $('voice-mode-describe');
const modeCloneIn      = $('voice-mode-clone');
const cloneFileIn      = $('voice-clone-file');
const cloneRemoveBtn   = $('voice-clone-remove');
const cloneStatus      = $('voice-clone-status');
const cloneTextIn      = $('voice-clone-text');
const cloneTextLabel   = $('voice-clone-text-label');
const bargeInIn        = $('barge-in');
const headphonesIn     = $('headphones');
const endSilenceIn     = $('end-silence');
const micSensIn        = $('mic-sensitivity');
const sttLangIn        = $('stt-language');
const speakRepliesIn   = $('speak-replies');
const thinkModeIn      = $('think-mode');
const thinkVoiceIn     = $('think-voice');
const thinkingPane     = new ThinkingPane($('thinking-pane'), parseMarkdown);
const imageBtn         = $('image-btn');
const imageInput       = $('image-input');
const imagePreviewBar  = $('image-preview-bar');
const micBtn           = $('mic-btn');
const chatsBtn         = $('chats-btn');
const chatsModal       = $('chats-modal');
const newChatBtn       = $('new-chat-btn');
const closeChatsBtn    = $('close-chats');
const chatsListEl      = $('chats-list');
const convModeBtn      = $('conv-mode-btn');
const convModeIcon     = $('conv-mode-icon');
const convPanelEl      = $('conv-panel');
const convStatusEl     = $('conv-status');
const convBannerEl     = $('conv-banner');
const convHintEl       = $('conv-hint');
const convRecordBtn    = $('conv-record-btn');
const convVisualizerEl = $('conv-visualizer');
const convTranscriptEl = $('conv-transcript');
// Sound Recorder-style scope: a scrolling history of the level, drawn mirrored around a centre line.
const WAVE_BARS = 44;
for (let i = 0; i < WAVE_BARS; i++) convVisualizerEl.appendChild(Object.assign(document.createElement('div'), { className: 'conv-wave' }));
const convWaves        = [...convVisualizerEl.querySelectorAll('.conv-wave')];
const waveHistory      = new Array(WAVE_BARS).fill(0);

// ── State ──

let settings = loadSettings();
let messages = [];   // { role, content, images?, imageUrls?, interrupted? }
let messageEls = []; // DOM element for each entry in messages
let busy = false;
let textAbort = null;
let darkMode = localStorage.getItem('darkMode') === 'true';
let pendingImages = []; // { dataUrl, base64 }
let currentChatId = null;
let currentChatCreatedAt = null;
let currentChatTitle = null;
let currentChatSummary = '';
let currentChatSummarisedAt = 0; // how many messages the chat had when the title/summary were written
let currentChatSaved = false;     // in the saved chats (then it keeps saving as it goes); otherwise only a draft
let convMode = false;
let statusTimer = null;
let lastStatus = {};
let previewVoice = null;
let cloneDraft = null;      // the voice sample shown in the settings form (saved with Save)
let cloneBusy = false;

// ── Boot ──

async function init() {
    applySettings();
    applyDarkMode();
    setupEventListeners();
    connectEvents();
    await restoreLastChat();
    userInputEl.focus();
}

// ── Dark mode ──

function applyDarkMode() {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    darkModeBtn.innerHTML = `<img src="icons/${darkMode ? 'mode-light' : 'mode-dark'}.png" alt="" width="16" height="16">`;
    darkModeBtn.title = darkMode ? 'Switch to light mode' : 'Switch to dark mode';
    darkModeBtn.setAttribute('aria-label', darkModeBtn.title);
    const icon = darkMode ? 'new_chat_light' : 'new_chat_dark';
    const a = $('new-chat-icon'); if (a) a.src = `icons/${icon}.png`;
    const b = $('new-chat-modal-icon'); if (b) b.src = `icons/${icon}.png`;
}

function toggleDarkMode() {
    darkMode = !darkMode;
    localStorage.setItem('darkMode', String(darkMode));
    applyDarkMode();
}

// ── Settings ──

function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch {}
    return { ...DEFAULTS, ...s };
}

function currentVoice() {
    if (previewVoice) return previewVoice;
    const c = settings.voiceClone;
    const seed = Number(settings.voiceSeed) || 0;
    if (settings.voiceMode === 'clone' && c?.id && c.text?.trim()) return { clone: c.id, refText: c.text.trim(), seed };
    return { instruction: settings.voiceInstruction || '', seed };
}

function applySettings() {
    setApiBase(settings.tunnelUrl);
    modelBadge.textContent = settings.model || DEFAULTS.model;
    tunnelUrlIn.value    = settings.tunnelUrl    || '';
    $('summary-every').value = String(settings.summaryEvery ?? DEFAULTS.summaryEvery);
    modelNameIn.value    = settings.model        || '';
    braveApiKeyIn.value  = settings.braveApiKey  || '';
    systemPromptIn.value = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    voicePromptIn.value  = settings.voicePrompt ?? DEFAULT_VOICE_PROMPT;
    for (const g of TOOL_GROUPS) $(`tool-${g}`).checked = settings.tools?.[g] !== false;
    showVoicePromptStatus();

    voicePresetIn.innerHTML = VOICE_PRESETS.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    voicePresetIn.value = settings.voicePreset || 'custom';
    voiceInstrIn.value  = settings.voiceInstruction || '';
    voiceSeedIn.value   = settings.voiceSeed ?? 0;
    cloneDraft = settings.voiceClone?.id ? { ...settings.voiceClone } : null;
    cloneFileIn.value = '';
    (settings.voiceMode === 'clone' ? modeCloneIn : modeDescribeIn).checked = true;
    showClone();
    showVoiceMode();
    bargeInIn.checked   = !!settings.bargeIn;
    headphonesIn.checked = !!settings.headphones;
    endSilenceIn.value  = String(settings.endSilenceMs);
    micSensIn.value     = settings.micSensitivity;
    sttLangIn.value     = settings.sttLanguage;
    speakRepliesIn.checked = !!settings.speakReplies;
    thinkModeIn.value   = settings.thinkMode;
    thinkVoiceIn.checked = !!settings.thinkVoice;
    voicePreviewStat.textContent = '';

    conversation.applySettings(settings);
}

function persistSettings() {
    const oldVoice = JSON.stringify(currentVoice());
    settings.tunnelUrl        = tunnelUrlIn.value.trim().replace(/\/+$/, '');
    settings.summaryEvery     = Number($('summary-every').value);
    settings.model            = modelNameIn.value.trim() || DEFAULTS.model;
    settings.braveApiKey      = braveApiKeyIn.value.trim();
    settings.systemPrompt     = systemPromptIn.value.trim() || DEFAULT_SYSTEM_PROMPT;
    settings.voicePrompt      = voicePromptIn.value.trim(); // ('' = add nothing in voice mode)
    settings.voicePreset      = voicePresetIn.value;
    settings.voiceInstruction = voiceInstrIn.value.trim();
    settings.voiceSeed        = Math.max(0, parseInt(voiceSeedIn.value, 10) || 0);
    settings.voiceMode        = modeCloneIn.checked ? 'clone' : 'describe';
    settings.voiceClone       = cloneDraft ? { ...cloneDraft, text: cloneTextIn.value.trim() } : null;
    settings.bargeIn          = bargeInIn.checked;
    settings.headphones       = headphonesIn.checked;
    settings.endSilenceMs     = Number(endSilenceIn.value) || DEFAULTS.endSilenceMs;
    settings.micSensitivity   = micSensIn.value;
    settings.sttLanguage      = sttLangIn.value;
    settings.speakReplies     = speakRepliesIn.checked;
    settings.thinkMode        = thinkModeIn.value;
    settings.thinkVoice       = thinkVoiceIn.checked;
    settings.tools            = Object.fromEntries(TOOL_GROUPS.map(g => [g, $(`tool-${g}`).checked]));
    const stored = { ...settings };
    if (stored.voicePrompt === DEFAULT_VOICE_PROMPT) delete stored.voicePrompt;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
    const oldBase = apiUrl('');
    applySettings();
    if (apiUrl('') !== oldBase) connectEvents(); // (reminders come from the server at the new URL)
    if (JSON.stringify(currentVoice()) !== oldVoice && hasApi()) prepareVoice(currentVoice()); // design it now, not mid-reply
}

function formVoice() {
    const seed = Math.max(0, parseInt(voiceSeedIn.value, 10) || 0);
    const text = cloneTextIn.value.trim();
    if (modeCloneIn.checked && cloneDraft?.id && text) return { clone: cloneDraft.id, refText: text, seed };
    return { instruction: voiceInstrIn.value.trim(), seed };
}

// Show only the half of the Voice tab that the chosen mode uses.
function showVoiceMode() {
    const clone = modeCloneIn.checked;
    $('voice-describe').hidden = clone;
    $('voice-clone').hidden = !clone;
    voicePreviewStat.textContent = '';
}

// Show the voice-sample part of the Voice tab for the current draft.
function showClone(message) {
    cloneRemoveBtn.hidden = !cloneDraft;
    cloneTextLabel.hidden = !cloneDraft;
    cloneTextIn.value = cloneDraft?.text || '';
    cloneStatus.textContent = message || cloneStatusText();
}

function cloneStatusText() {
    if (!cloneDraft) return 'Choose an audio file to clone.';
    if (!cloneDraft.text?.trim()) return `"${cloneDraft.name}": write what is said in it below. Until you do, the described voice is used.`;
    return `Using your sample "${cloneDraft.name}" (${cloneDraft.seconds.toFixed(1)} s).`;
}

async function loadCloneSample(file) {
    if (!file || cloneBusy) return;
    if (!hasApi()) { showClone('Open the app through its server to upload a sample.'); return; }
    cloneBusy = true;
    cloneFileIn.disabled = voicePreviewBtn.disabled = true;
    try {
        const sample = await prepareVoiceSample(file, {
            language: settings.sttLanguage,
            onStep: msg => { cloneStatus.textContent = msg; }
        });
        cloneDraft = sample;
        showClone();
        if (!sample.text) cloneStatus.textContent = `Couldn't transcribe "${sample.name}". Type what is said in it below.`;
    } catch (err) {
        showClone(err.message);
    } finally {
        cloneBusy = false;
        cloneFileIn.disabled = voicePreviewBtn.disabled = false;
        cloneFileIn.value = '';
    }
}

function showVoicePromptStatus() {
    const v = voicePromptIn.value.trim();
    $('voice-prompt-status').textContent = !v ? 'Empty: nothing is added in voice mode.'
        : v === DEFAULT_VOICE_PROMPT ? 'Default instructions.' : 'Customised.';
}

function setupVoiceSettings() {
    voicePromptIn.addEventListener('input', showVoicePromptStatus);
    $('voice-prompt-reset').addEventListener('click', () => { voicePromptIn.value = DEFAULT_VOICE_PROMPT; showVoicePromptStatus(); });
    voicePresetIn.addEventListener('change', () => {
        const p = VOICE_PRESETS.find(v => v.id === voicePresetIn.value);
        if (p && p.id !== 'custom') { voiceInstrIn.value = p.instruction; voiceSeedIn.value = p.seed; }
        else voiceInstrIn.focus();
    });
    voiceInstrIn.addEventListener('input', () => {
        const p = VOICE_PRESETS.find(v => v.id === voicePresetIn.value);
        if (p && p.instruction !== voiceInstrIn.value.trim()) voicePresetIn.value = 'custom';
    });
    voiceRerollBtn.addEventListener('click', () => { voiceSeedIn.value = Math.floor(Math.random() * 100000); });
    modeDescribeIn.addEventListener('change', showVoiceMode);
    modeCloneIn.addEventListener('change', showVoiceMode);
    cloneFileIn.addEventListener('change', () => loadCloneSample(cloneFileIn.files[0]));
    cloneRemoveBtn.addEventListener('click', () => { cloneDraft = null; showClone(); });
    cloneTextIn.addEventListener('input', () => {
        if (!cloneDraft) return;
        cloneDraft.text = cloneTextIn.value;
        cloneStatus.textContent = cloneStatusText();
    });
    voicePreviewBtn.addEventListener('click', async () => {
        const v = formVoice();
        if (modeCloneIn.checked && !v.clone) { voicePreviewStat.textContent = cloneDraft ? 'Write what is said in the sample first.' : 'Choose an audio sample to clone first.'; return; }
        if (!v.clone && !v.instruction) { voicePreviewStat.textContent = 'Write a voice description first.'; return; }
        voicePreviewBtn.disabled = true;
        voicePreviewStat.textContent = v.clone ? 'Checking the voice sample…' : 'Designing the voice (a few seconds the first time)…';
        const r = await prepareVoice(v);
        voicePreviewBtn.disabled = false;
        if (!r.ok) { voicePreviewStat.textContent = r.error || 'Breeze TTS is not available.'; return; }
        voicePreviewStat.textContent = '';
        previewVoice = v;
        readAloud("Hi there! This is how I'll sound when we talk. Pretty nice, right? (laugh)", null, () => { previewVoice = null; });
    });
}

// Settings are split into tabs; the last one used is reopened.
const SETTINGS_TAB_KEY = 'settings_tab';
function showSettingsTab(name, focus = false) {
    const tabs = [...document.querySelectorAll('.settings-tab')];
    if (!tabs.some(t => t.dataset.tab === name)) name = tabs[0].dataset.tab;
    for (const t of tabs) {
        const on = t.dataset.tab === name;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        $(`settings-panel-${t.dataset.tab}`).hidden = !on;
        if (on && focus) t.focus();
    }
    document.querySelector('.settings-body').scrollTop = 0;
    sessionStorage.setItem(SETTINGS_TAB_KEY, name);
}

function setupSettingsTabs() {
    const tabs = [...document.querySelectorAll('.settings-tab')];
    for (const t of tabs) {
        t.addEventListener('click', () => showSettingsTab(t.dataset.tab));
        t.addEventListener('keydown', e => { // arrow keys move between tabs
            const i = tabs.indexOf(t);
            const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
            if (j == null) return;
            e.preventDefault();
            showSettingsTab(tabs[(j + tabs.length) % tabs.length].dataset.tab, true);
        });
    }
    showSettingsTab(sessionStorage.getItem(SETTINGS_TAB_KEY) || 'general');
}

async function openSettings() {
    applySettings();
    showSettingsTab(sessionStorage.getItem(SETTINGS_TAB_KEY) || 'general');
    settingsModal.classList.remove('hidden');
    renderAgentData();
    const models = await listModels();
    modelListEl.innerHTML = models.map(m => `<option value="${escapeHtml(m)}">`).join('');
}
function closeSettings() { settingsModal.classList.add('hidden'); }

// ── Events ──

function setupEventListeners() {
    settingsBtn.addEventListener('click', openSettings);
    saveSettingsBtn.addEventListener('click', () => { persistSettings(); closeSettings(); });
    closeSettingsBtn.addEventListener('click', closeSettings);
    $('home-set').addEventListener('click', setHome);
    $('home-place').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setHome(); } });
    $('close-settings-x').addEventListener('click', closeSettings);
    settingsModal.addEventListener('click', e => { if (e.target === settingsModal) closeSettings(); });
    $('close-chats-x').addEventListener('click', closeChatsPanel);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (!settingsModal.classList.contains('hidden') || !chatsModal.classList.contains('hidden')) { closeSettings(); closeChatsPanel(); }
            else if (convMode) exitConvMode();
            else if (readPlayer.active) readPlayer.stop();
        }
        if (convMode && e.code === 'Space' && e.target === document.body) { e.preventDefault(); conversation.toggle(); }
    });

    darkModeBtn.addEventListener('click', toggleDarkMode);
    clearBtn.addEventListener('click', newChat);
    sendBtn.addEventListener('click', () => (busy ? textAbort?.abort() : handleSend()));
    chatsBtn.addEventListener('click', openChatsPanel);
    newChatBtn.addEventListener('click', newChat);
    closeChatsBtn.addEventListener('click', closeChatsPanel);
    chatsModal.addEventListener('click', e => { if (e.target === chatsModal) closeChatsPanel(); });

    userInputEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
    userInputEl.addEventListener('input', autoGrow);

    imageBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', handleImageSelect);

    micBtn.addEventListener('click', toggleDictation);
    convModeBtn.addEventListener('click', () => (convMode ? exitConvMode() : enterConvMode()));
    convRecordBtn.addEventListener('click', () => conversation.toggle());
    $('conv-links-clear').addEventListener('click', clearConvLinks);
    setupVoiceSettings();
    setupSettingsTabs();
}

function autoGrow() {
    userInputEl.style.height = 'auto';
    userInputEl.style.height = userInputEl.scrollHeight + 'px';
}

// ── Chat requests ──

function chatRequest({ voice = false } = {}) {
    const voicePrompt = voice ? (settings.voicePrompt ?? DEFAULT_VOICE_PROMPT).trim() : '';
    const systemPrompt = (settings.systemPrompt || DEFAULT_SYSTEM_PROMPT) + (voicePrompt ? `\n\n${voicePrompt}` : '');
    const body = {
        model: settings.model || DEFAULTS.model,
        messages: [
            { role: 'system', content: systemPrompt },
            // (a reply that used tools is preceded by its tool calls and their results)
            ...messages.flatMap(({ imageUrls, interrupted, thinking, thinkingMs, attachments, actions, announcement, toolTrace, links, ...rest }) =>
                [...(toolTrace || []), attachments?.length ? { ...rest, content: withAttachments(rest.content, attachments) } : rest])
        ]
    };
    // Ollama's `think`: true/false, or a level ("low"/"medium"/"high") for models that have them.
    // Models that can't think refuse it; the server then retries without.
    const mode = voice && !settings.thinkVoice ? 'off' : settings.thinkMode;
    if (mode === 'on') body.think = true;
    else if (mode === 'off') body.think = false;
    else if (mode !== 'default') body.think = mode;
    if (settings.braveApiKey) body.braveApiKey = settings.braveApiKey;
    body.agentTools = TOOL_GROUPS.filter(g => settings.tools?.[g] !== false);
    return body;
}

// An assistant reply being streamed into the chat. commit() adds it to the history.
function beginReply({ announcement = false } = {}) {
    welcomeEl.classList.add('hidden');
    const typingEl = appendTypingIndicator();
    let el = null;
    let latest = '';
    let raf = 0;
    const actions = [];
    const trace = [];
    const links = [];
    const model = settings.model || DEFAULTS.model;
    const thought = announcement ? { append() {}, done() {}, text: '' } : thinkingPane.start(model);
    const ensure = () => {
        if (!el) { typingEl.remove(); el = appendMessage('assistant', ' ', [], { track: false }); }
        return el;
    };
    return {
        get text() { return latest; },
        think(delta) { thought.append(delta); },
        action(text) { actions.push(text); renderActions(ensure(), actions); scrollToBottom(); },
        trace(msgs) { trace.push(...msgs); },
        links(kind, list) {
            for (const l of list) if (!links.some(x => x.url === l.url && x.kind === kind)) links.push({ ...l, kind });
            renderLinks(ensure(), links);
            scrollToBottom();
        },
        update(full) {
            thought.done(); // the answer has started
            latest = full;
            ensure();
            if (!raf) raf = requestAnimationFrame(() => { raf = 0; setBubble(el, 'assistant', latest); scrollToBottom(); });
        },
        commit(text, interrupted) {
            cancelAnimationFrame(raf);
            thought.done();
            ensure();
            setBubble(el, 'assistant', text);
            el.classList.toggle('interrupted', !!interrupted);
            el.dataset.content = text;
            const msg = { role: 'assistant', content: text };
            if (interrupted) msg.interrupted = true;
            if (actions.length) msg.actions = actions.slice();
            if (trace.length) msg.toolTrace = trace.slice();
            if (links.length) msg.links = links.slice();
            if (announcement) { msg.announcement = true; el.classList.add('announcement'); }
            if (thought.text) {
                msg.thinking = thought.text;
                msg.thinkingMs = thought.ms;
                addThinkButton(el, msg);
            }
            messages.push(msg);
            messageEls.push(el);
            scrollToBottom();
            saveCurrentChat();
        },
        discard() {
            cancelAnimationFrame(raf);
            thought.done();
            typingEl.remove();
            el?.remove();
        }
    };
}

function addUserMessage(text, images = [], attachments = []) {
    welcomeEl.classList.add('hidden');
    const msg = { role: 'user', content: text };
    if (images.length) {
        msg.images = images.map(i => i.base64);
        msg.imageUrls = images.map(i => i.dataUrl);
    }
    if (attachments.length) msg.attachments = attachments;
    appendMessage('user', text, msg.imageUrls || [], { attachments });
    messages.push(msg);
}

// ── Text chat ──

async function handleSend() {
    const text = userInputEl.value.trim();
    if ((!text && pendingImages.length === 0) || busy) return;
    if (!hasApi()) {
        showError('No server URL set. Open Settings and paste your Cloudflare tunnel URL.');
        return;
    }
    const images = [...pendingImages];
    pendingImages = [];
    renderImagePreviews();
    addUserMessage(text, images);
    userInputEl.value = '';
    userInputEl.style.height = 'auto';
    await generateReply();
}

async function generateReply() {
    setBusy(true);
    const handle = beginReply();
    const abort = new AbortController();
    textAbort = abort;
    const speak = settings.speakReplies;
    const chunker = new SentenceChunker();
    if (speak) readPlayer.begin();
    try {
        const full = await streamChat(chatRequest(), {
            signal: abort.signal,
            onToken: (delta, all) => {
                handle.update(all);
                if (speak) for (const p of chunker.push(delta)) readPlayer.enqueue(cleanForSpeech(p));
            },
            onTool: m => setStatus(m.label || 'Using a tool…'),
            onAction: text => handle.action(text),
            onTrace: msgs => handle.trace(msgs),
            onLinks: (kind, list) => handle.links(kind, list),
            onThinking: delta => { handle.think(delta); setStatus('Thinking…'); },
            onNotice: text => showNotice(text)
        });
        if (speak) { for (const p of chunker.flush()) readPlayer.enqueue(cleanForSpeech(p)); readPlayer.end(); }
        handle.commit(full.trim() ? full : '(no reply)', false);
    } catch (err) {
        if (speak) readPlayer.stop();
        if (abort.signal.aborted && handle.text.trim()) handle.commit(handle.text + ' —', true); // stopped: keep what came
        else {
            handle.discard();
            if (!abort.signal.aborted) showError(err.message);
        }
    } finally {
        textAbort = null;
        setBusy(false);
        userInputEl.focus();
    }
}

// ── Reading aloud (text mode, the 🔊 buttons and voice previews) ──

let readDone = null;
const readPlayer = new SpeechPlayer({
    getVoice: currentVoice,
    onIdle: () => { const f = readDone; readDone = null; f?.(); markSpeaking(null); },
    onEngine: name => { if (name === 'browser') setStatus('Breeze TTS not ready: using the browser voice'); }
});

function readAloud(text, el = null, onDone = null) {
    readPlayer.begin();
    readDone = onDone;
    markSpeaking(el);
    const chunker = new SentenceChunker();
    for (const p of [...chunker.push(text), ...chunker.flush()]) readPlayer.enqueue(cleanForSpeech(p));
    readPlayer.end();
}

function markSpeaking(el) {
    for (const b of document.querySelectorAll('.msg-speak-btn.playing')) b.classList.remove('playing');
    el?.querySelector('.msg-speak-btn')?.classList.add('playing');
}

// ── Dictation (the mic button in text mode): one utterance, transcribed by Whisper ──

let dictation = null;

async function toggleDictation() {
    if (dictation) { dictation.mic.inSpeech ? dictation.mic.finish() : stopDictation(); return; }
    if (!hasApi()) { showError('No server URL set. Open Settings first.'); return; }
    const mic = new MicVad({ endSilenceMs: 1400, sensitivity: settings.micSensitivity });
    dictation = { mic };
    micBtn.classList.add('recording');
    micBtn.title = 'Listening… click to stop';
    setStatus('Listening…');
    mic.on('speechend', async audio => {
        stopDictation();
        setStatus('Transcribing…');
        try {
            const text = await transcribe(audio, { language: settings.sttLanguage });
            if (text) {
                const v = userInputEl.value;
                userInputEl.value = v + (v && !v.endsWith(' ') ? ' ' : '') + text;
                autoGrow();
            }
            setStatus(text ? 'Ready' : 'Didn\'t catch that');
        } catch (err) {
            setStatus(err.message);
        }
        userInputEl.focus();
    });
    try { await mic.start(); }
    catch (err) {
        stopDictation();
        setStatus(err?.name === 'NotAllowedError' ? 'Microphone access denied' : err.message);
    }
}

function stopDictation() {
    dictation?.mic.stop();
    dictation = null;
    micBtn.classList.remove('recording');
    micBtn.title = 'Voice input';
    if (!busy) setStatus('Ready');
}

// ── Conversation mode ──

const STATE_TEXT = {
    starting:     'Starting the microphone…',
    listening:    'Listening…',
    hearing:      'Listening…',
    transcribing: 'Got it…',
    thinking:     'Thinking…',
    speaking:     'Speaking',
    muted:        'Microphone muted',
    error:        'Something went wrong',
    off:          ''
};

const conversation = new Conversation({
    voice: currentVoice,
    language: () => settings.sttLanguage,
    chatRequest: () => chatRequest({ voice: true }),
    beginReply: opts => {
        captionAssistant = null;
        return beginReply(opts);
    },
    lastIsUser: () => messages[messages.length - 1]?.role === 'user',
    // A user message: the transcript, plus whatever's waiting in the box (typed text, pasted text,
    // links, images). merge: add it all to the previous user message instead. Returns false if
    // there was nothing to send.
    onUserText: async (text, merge, { typed = true } = {}) => {
        if (composer.loading) renderConvState(conversation.state, 'Reading the link…');
        const extra = await composer.take({ typed });
        const words = [text, extra.typed].filter(Boolean).join('\n\n');
        if (!words && !extra.attachments.length && !extra.images.length) return false;
        const last = messages[messages.length - 1];
        if (merge && last?.role === 'user') {
            last.content = [last.content, words].filter(Boolean).join(' ');
            if (extra.attachments.length) last.attachments = [...(last.attachments || []), ...extra.attachments];
            if (extra.images.length) {
                last.images = [...(last.images || []), ...extra.images.map(i => i.base64)];
                last.imageUrls = [...(last.imageUrls || []), ...extra.images.map(i => i.dataUrl)];
            }
            rerenderMessage(messages.length - 1);
            const caps = convTranscriptEl.querySelectorAll('.conv-entry-user');
            if (caps.length) caps[caps.length - 1].textContent = captionFor(last);
            else caption('user', captionFor(last));
        } else {
            addUserMessage(words, extra.images, extra.attachments);
            caption('user', captionFor(messages[messages.length - 1]));
        }
        saveCurrentChat(); // (don't lose the turn if the page closes mid-reply)
        return true;
    },
    onNotice: text => flashNotice(text),
    onAction: text => flashNotice(text),
    onLinks: (kind, list) => showConvLinks(kind, list),
    onAnnouncementDropped: text => { reminderQueue.push({ say: text, show: `⏰ ${text}` }); setTimeout(deliverReminders, 0); },
    onSpoken: text => {
        if (!captionAssistant) captionAssistant = caption('assistant', text);
        else { captionAssistant.textContent += ' ' + text; convTranscriptEl.scrollTop = convTranscriptEl.scrollHeight; }
    },
    onState: renderConvState,
    onLevels: renderLevels,
    onEngine: () => refreshServiceStatus()
});

let captionAssistant = null;

// ── The conversation-mode text box ──

const composer = new Composer({
    root:      convPanelEl,
    textarea:  $('conv-text'),
    chips:     $('conv-chips'),
    sendBtn:   $('conv-send-btn'),
    imageBtn:  $('conv-image-btn'),
    fileInput: $('conv-file-input')
}, {
    compressImage,
    onAdded: () => conversation.attachmentsAdded(),
    onSubmit: async () => {
        if (!composer.hasContent) return;
        if (!(await conversation.submit())) flashNotice('Got it, that goes with what you\'re saying.');
    },
    onFlash: text => flashNotice(text)
});

// Paste anywhere in conversation mode (not just in the box) lands in the box.
document.addEventListener('paste', e => {
    if (!convMode || e.target.closest?.('input, textarea, .modal')) return;
    composer.handlePaste(e);
});

let noticeTimer = 0;
function flashNotice(text) {
    const el = $('conv-notice');
    if (!convMode) { setStatus(text); return; }
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => el.classList.add('hidden'), 9000);
}

function captionFor(msg) {
    const bits = [];
    for (const a of msg.attachments || []) bits.push(a.type === 'text' ? `📄 ${a.name || 'text'}` : `🔗 ${a.title || hostOf(a.url)}`);
    if (msg.imageUrls?.length) bits.push(`🖼 ${msg.imageUrls.length} image${msg.imageUrls.length > 1 ? 's' : ''}`);
    return [msg.content, bits.join('  ')].filter(Boolean).join('  ');
}

async function enterConvMode() {
    if (!hasApi()) { showError('No server URL set. Open Settings and paste your Cloudflare tunnel URL.'); return; }
    if (busy) textAbort?.abort();
    readPlayer.stop();
    stopDictation();
    convMode = true;
    document.querySelector('.layout').classList.add('conv-mode');
    convPanelEl.classList.remove('hidden');
    convModeIcon.src = 'icons/conversationMode_a.png';
    convModeBtn.title = 'Back to text chat';
    convModeBtn.setAttribute('aria-label', 'Back to text chat');
    convTranscriptEl.innerHTML = '';
    captionAssistant = null;
    clearConvLinks();
    conversation.applySettings(settings);
    refreshServiceStatus(true);
    await conversation.start();
}

function exitConvMode() {
    convMode = false;
    conversation.stop();
    clearTimeout(statusTimer);
    document.querySelector('.layout').classList.remove('conv-mode');
    convPanelEl.classList.add('hidden');
    convModeIcon.src = 'icons/conversationMode_b.png';
    convModeBtn.title = 'Conversation mode';
    convModeBtn.setAttribute('aria-label', 'Conversation mode');
    setStatus('Ready');
    scrollToBottom();
}

function renderConvState(state, detail) {
    const text = detail || STATE_TEXT[state] || '';
    convStatusEl.textContent = text;
    setStatus(state === 'off' ? 'Ready' : text);
    convPanelEl.dataset.state = state;
    convRecordBtn.classList.toggle('recording', state === 'listening' || state === 'hearing');
    convRecordBtn.classList.toggle('speaking', state === 'speaking' || state === 'thinking');
    convRecordBtn.classList.toggle('muted', state === 'muted');
    convVisualizerEl.classList.toggle('active', state === 'hearing');
    convVisualizerEl.classList.toggle('speaking', state === 'speaking');
    const replying = state === 'thinking' || state === 'speaking';
    const label = replying ? 'Interrupt' : state === 'muted' ? 'Unmute microphone' : 'Mute microphone';
    convRecordBtn.title = label;
    convRecordBtn.setAttribute('aria-label', label);
    convHintEl.textContent = replying
        ? (settings.bargeIn ? 'Talk to interrupt, or tap the button.' : 'Tap the button to interrupt.')
        : state === 'muted' ? 'Tap the button to unmute.'
        : state === 'error' ? 'It will start listening again in a moment.'
        : 'Just start talking. Tap the button to mute.';
}

function renderLevels(mic, out) {
    const state = conversation.state;
    const level = state === 'speaking' ? out : state === 'muted' ? 0 : mic;
    const t = performance.now() / 1000;
    // Jitter each sample so it reads as a waveform rather than a smooth envelope.
    const jitter = 0.55 + 0.45 * Math.abs(Math.sin(t * 37) * Math.cos(t * 23));
    const thinking = state === 'thinking' ? 0.12 + 0.08 * Math.sin(t * 4) : 0;
    waveHistory.push(Math.min(1, Math.max(level * jitter, thinking)));
    waveHistory.shift();
    convWaves.forEach((w, i) => {
        w.style.height = `${Math.round(2 + 28 * waveHistory[i])}px`;
    });
}

function caption(role, text) {
    const el = document.createElement('div');
    el.className = role === 'user' ? 'conv-entry-user' : 'conv-entry-assistant';
    el.textContent = text;
    convTranscriptEl.appendChild(el);
    while (convTranscriptEl.children.length > 30) convTranscriptEl.firstChild.remove();
    convTranscriptEl.scrollTop = convTranscriptEl.scrollHeight;
    return el;
}

// Which local services are up, shown as a banner in conversation mode until they all are.
async function refreshServiceStatus(first = false) {
    clearTimeout(statusTimer);
    if (!convMode) return;
    const s = await getStatus();
    if (!convMode) return;
    const notes = [];
    if (s.server === 'down') notes.push('Can\'t reach the DanGPT server. Is it running, and is the URL in Settings right?');
    else {
        if (s.ollama !== 'ok') notes.push('Ollama isn\'t running, so there\'s no one to talk to yet.');
        if (s.stt === 'loading') notes.push('Speech recognition is loading (the first run downloads the Whisper model)…');
        else if (s.stt !== 'ok') notes.push('Speech recognition (Whisper) isn\'t running. Start everything with launch.bat.');
        if (s.breeze === 'loading') notes.push('Breeze voice is warming up (about 1–2 minutes). The browser voice stands in until then.');
        else if (s.breeze !== 'ok') notes.push('Breeze TTS isn\'t running, so the browser voice is used instead.');
    }
    convBannerEl.innerHTML = notes.map(n => `<div>${escapeHtml(n)}</div>`).join('');
    convBannerEl.classList.toggle('hidden', notes.length === 0);
    if (s.breeze === 'ok' && (first || lastStatus.breeze !== 'ok')) prepareVoice(currentVoice());
    lastStatus = s;
    statusTimer = setTimeout(refreshServiceStatus, notes.length ? 3000 : 20000);
}

// ── Chat history ──

function generateChatId() {
    return 'chat_' + Date.now();
}

// Until the model has named it: the start of the first message.
function fallbackTitle() {
    const first = messages.find(m => m.role === 'user');
    if (!first) return 'New Chat';
    const text = (first.content || (first.imageUrls?.length ? 'Image conversation' : 'New Chat')).trim().replace(/\s+/g, ' ');
    return text.length > 45 ? text.slice(0, 42) + '...' : text;
}

// ── Title and summary, rewritten as the chat goes on ──
// First after the opening exchange, then every `summaryEvery` messages, so the title describes the
// whole conversation rather than just how it started. Runs in the background after a save, when
// the model isn't busy answering.

const SUMMARY_PROMPT = `You name and summarise saved chat conversations for a chat history list. Reply in JSON: {"title": "...", "summary": "..."}.
- title: at most 6 words, describing the conversation as a whole (its main topic, or the two main ones), not just how it began. No quotes, no full stop.
- summary: one or two short sentences, under 200 characters, saying what was talked about, done or decided so far. Write it like a note, without "The user" or "The assistant" (e.g. "Planned a dinner party for six; settled on mushroom risotto and a lemon tart.").`;

let summarising = false;
let summaryRetry = 0;

function summaryDue() {
    const n = messages.length;
    if (n < 2 || !hasApi()) return false;
    if (!currentChatSummarisedAt || currentChatSummarisedAt > n) return true; // never done, or messages removed (edited)
    const every = Number(settings.summaryEvery ?? DEFAULTS.summaryEvery);
    return every > 0 && n - currentChatSummarisedAt >= every;
}

function maybeSummarise() {
    clearTimeout(summaryRetry);
    if (summarising || !summaryDue()) return;
    // Don't make a reply wait behind it: only while nothing's being said or written.
    const replying = busy || conversation.reply || conversation.transcribing || conversation.mic.inSpeech;
    if (replying) { summaryRetry = setTimeout(maybeSummarise, 2500); return; }
    summariseChat();
}

function transcriptForSummary() {
    const line = m => {
        const bits = [];
        if (m.content) bits.push(m.content.replace(/\s+/g, ' ').slice(0, 300));
        if (m.imageUrls?.length) bits.push(`[${m.imageUrls.length} image(s)]`);
        for (const a of m.attachments || []) bits.push(a.type === 'text' ? `[pasted text: ${a.name || 'text'}]` : `[link: ${a.title || a.url}]`);
        for (const a of m.actions || []) bits.push(`[did: ${a}]`);
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${bits.join(' ')}`;
    };
    const list = messages.filter(m => !m.announcement);
    // Long chats: the opening, then the most recent part (the earlier summary covers the middle).
    const picked = list.length > 24 ? [...list.slice(0, 2).map(line), '[…]', ...list.slice(-20).map(line)] : list.map(line);
    return picked.join('\n');
}

async function summariseChat() {
    summarising = true;
    const id = currentChatId;
    const count = messages.length;
    try {
        const prev = currentChatSummary ? `Summary so far (from earlier in the chat): ${currentChatSummary}\n\n` : '';
        const r = await fetch(apiUrl('/api/chat'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: settings.model || DEFAULTS.model,
                messages: [
                    { role: 'system', content: SUMMARY_PROMPT },
                    { role: 'user', content: `${prev}The conversation:\n${transcriptForSummary()}` }
                ],
                format: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title', 'summary'] },
                options: { temperature: 0.3, num_predict: 200 },
                think: false,
                stream: false
            })
        });
        if (!r.ok) return;
        const data = await r.json();
        let out = {};
        try { out = JSON.parse(data?.message?.content || '{}'); } catch {}
        const title = String(out.title || '').trim().replace(/^["'“]+|["'”.]+$/g, '').slice(0, 80);
        const summary = String(out.summary || '').trim().replace(/\s+/g, ' ').slice(0, 300);
        if (!title || currentChatId !== id) return; // (they've moved to another chat: it's redone next time)
        currentChatTitle = title;
        if (summary) currentChatSummary = summary;
        currentChatSummarisedAt = count;
        await saveCurrentChat({ summarise: false });
        if (!chatsModal.classList.contains('hidden')) renderChatsList();
    } catch {} finally {
        summarising = false;
    }
}

let saving = Promise.resolve();
function saveCurrentChat({ summarise = true } = {}) {
    saving = saving.then(doSave, doSave);
    if (summarise) saving.then(() => setTimeout(maybeSummarise, 800));
    return saving;
}

async function doSave() {
    if (messages.length === 0) return;
    if (!currentChatId) {
        currentChatId = generateChatId();
        currentChatCreatedAt = Date.now();
    }
    if (!currentChatSaved) { saveDraft(); return; }
    if (!hasApi()) return;
    const id = currentChatId;
    try {
        await fetch(apiUrl(`/api/chats/${id}`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id, title: currentChatTitle || fallbackTitle(), summary: currentChatSummary, summarisedAt: currentChatSummarisedAt,
                createdAt: currentChatCreatedAt, updatedAt: Date.now(), messageCount: messages.length, messages: messages.slice()
            })
        });
        localStorage.setItem(LAST_CHAT_KEY, id);
    } catch {}
}

function renderAll() {
    messagesEl.innerHTML = '';
    messagesEl.appendChild(welcomeEl);
    messageEls = [];
    if (messages.length === 0) welcomeEl.classList.remove('hidden');
    else {
        welcomeEl.classList.add('hidden');
        messages.forEach(m => {
            const el = appendMessage(m.role, m.content, m.imageUrls || [], { attachments: m.attachments });
            if (m.interrupted) el.classList.add('interrupted');
            if (m.announcement) el.classList.add('announcement');
            if (m.thinking) addThinkButton(el, m);
            if (m.actions?.length) renderActions(el, m.actions);
            if (m.links?.length) renderLinks(el, m.links);
        });
    }
}

async function loadChat(id) {
    if (!hasApi() || id === currentChatId) { closeChatsPanel(); return; }
    if (!(await offerToSave('Do you want to save this chat before opening the other one?'))) return;
    try {
        const r = await fetch(apiUrl(`/api/chats/${id}`));
        if (!r.ok) return;
        const chat = await r.json();
        clearDraft();
        currentChatId = chat.id;
        currentChatCreatedAt = chat.createdAt;
        currentChatSaved = true;
        setChatMeta(chat);
        messages = chat.messages.slice();
        localStorage.setItem(LAST_CHAT_KEY, currentChatId);
        thinkingPane.clear();
        renderAll();
        closeChatsPanel();
        userInputEl.focus();
    } catch {}
}

async function deleteChat(id) {
    if (hasApi()) {
        try { await fetch(apiUrl(`/api/chats/${id}`), { method: 'DELETE' }); } catch {}
    }
    if (currentChatId === id) startBlankChat({ keepPanel: true }); // (deleted the one that's open: a fresh one)
    renderChatsList();
}

// Title and summary of the chat being opened. (Chats saved before summaries existed get one
// the next time they're added to.)
function setChatMeta(chat) {
    currentChatTitle = chat?.title || null;
    currentChatSummary = chat?.summary || '';
    currentChatSummarisedAt = chat?.summarisedAt || 0;
}

async function restoreLastChat() {
    // An unsaved chat that was open when the page closed comes back as it was.
    const draft = readDraft();
    if (draft?.messages?.length) {
        currentChatId = draft.id;
        currentChatCreatedAt = draft.createdAt;
        currentChatSaved = false;
        setChatMeta(draft);
        messages = draft.messages.slice();
        renderAll();
        return;
    }
    if (!hasApi()) return;
    const lastId = localStorage.getItem(LAST_CHAT_KEY);
    if (!lastId) return;
    try {
        const r = await fetch(apiUrl(`/api/chats/${lastId}`));
        if (!r.ok) return;
        const chat = await r.json();
        if (!chat.messages?.length) return;
        currentChatId = chat.id;
        currentChatCreatedAt = chat.createdAt;
        currentChatSaved = true;
        setChatMeta(chat);
        messages = chat.messages.slice();
        renderAll();
    } catch {}
}

// ── Unsaved chats: a draft in this browser, and "Save this chat?" before it's put away ──

function saveDraft() {
    const draft = { id: currentChatId, createdAt: currentChatCreatedAt, title: currentChatTitle, summary: currentChatSummary, summarisedAt: currentChatSummarisedAt, messages };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }
    catch { // (too big for localStorage, usually images: keep the words at least)
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, messages: messages.map(({ imageUrls, ...m }) => m) })); } catch {}
    }
}
function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } }
function clearDraft() { localStorage.removeItem(DRAFT_KEY); }

// Resolves true to carry on (saved, or not wanted), false if they cancelled.
async function offerToSave(question = 'Do you want to save this chat?') {
    if (currentChatSaved || !messages.some(m => !m.announcement)) return true;
    const choice = await askToSave(question, currentChatTitle || fallbackTitle());
    if (choice === null) return false;
    if (choice !== false) {
        currentChatTitle = choice || currentChatTitle || fallbackTitle();
        currentChatSaved = true;
        await saveCurrentChat({ summarise: false });
        clearDraft();
    }
    return true;
}

// The message box: resolves with the title to save under, false for "Don't Save", null for Cancel.
function askToSave(question, title) {
    const modal = $('save-modal'), name = $('save-modal-name');
    $('save-modal-text').textContent = question;
    name.value = title;
    modal.classList.remove('hidden');
    $('save-modal-save').focus();
    return new Promise(resolve => {
        const done = v => {
            modal.classList.add('hidden');
            for (const [el, ev, f] of handlers) el.removeEventListener(ev, f);
            resolve(v);
        };
        const save = () => done(name.value.trim() || title);
        const handlers = [
            [$('save-modal-save'), 'click', save],
            [$('save-modal-discard'), 'click', () => done(false)],
            [$('save-modal-cancel'), 'click', () => done(null)],
            [$('save-modal-x'), 'click', () => done(null)],
            [name, 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }],
            [modal, 'keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); } }],
            [modal, 'click', e => { if (e.target === modal) done(null); }]
        ];
        for (const [el, ev, f] of handlers) el.addEventListener(ev, f);
    });
}

function formatChatDate(ts) {
    const d = new Date(ts);
    const diffDays = Math.floor((Date.now() - ts) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

async function renderChatsList() {
    chatsListEl.innerHTML = '<div class="chats-empty">Loading…</div>';
    let chats = [];
    if (hasApi()) {
        try {
            const r = await fetch(apiUrl('/api/chats'));
            if (r.ok) chats = await r.json();
        } catch {}
    }
    chatsListEl.innerHTML = '';
    if (chats.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chats-empty';
        empty.textContent = hasApi() ? 'No saved chats yet.' : 'Set a server URL in Settings to use chat history.';
        chatsListEl.appendChild(empty);
        return;
    }
    chats.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');

        const info = document.createElement('div');
        info.className = 'chat-item-info';
        const title = document.createElement('div');
        title.className = 'chat-item-title';
        title.textContent = chat.title;
        const meta = document.createElement('div');
        meta.className = 'chat-item-meta';
        const count = chat.messageCount ? ` · ${chat.messageCount} messages` : '';
        meta.textContent = formatChatDate(chat.updatedAt) + count;
        info.append(title);
        if (chat.summary) {
            const sum = document.createElement('div');
            sum.className = 'chat-item-summary';
            sum.textContent = chat.summary;
            sum.title = chat.summary;
            info.append(sum);
        }
        info.append(meta);

        const del = document.createElement('button');
        del.className = 'chat-item-delete';
        del.setAttribute('aria-label', 'Delete chat');
        del.innerHTML = `<img src="icons/delete.png" alt="Delete" width="13" height="13">`;
        del.addEventListener('click', e => { e.stopPropagation(); deleteChat(chat.id); });

        item.append(info, del);
        item.addEventListener('click', () => loadChat(chat.id));
        chatsListEl.appendChild(item);
    });
}

function openChatsPanel()  { chatsModal.classList.remove('hidden'); renderChatsList(); }
function closeChatsPanel() { chatsModal.classList.add('hidden'); }

async function newChat() {
    if (!(await offerToSave())) return;
    if (currentChatSaved) await saveCurrentChat({ summarise: false });
    startBlankChat();
}

function startBlankChat({ keepPanel = false } = {}) {
    if (convMode) conversation.interrupt();
    readPlayer.stop();
    clearDraft();
    currentChatId = null;
    currentChatCreatedAt = null;
    currentChatSaved = false;
    setChatMeta(null);
    localStorage.removeItem(LAST_CHAT_KEY);
    messages = [];
    thinkingPane.clear();
    composer.clear();
    pendingImages = [];
    renderImagePreviews();
    renderAll();
    convTranscriptEl.innerHTML = '';
    clearConvLinks();
    if (!keepPanel) closeChatsPanel();
    if (!convMode && !keepPanel) userInputEl.focus();
}

// ── Image handling ──

const IMAGE_MAX_PX  = 1024;
const IMAGE_QUALITY = 0.82;

function compressImage(dataUrl) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, IMAGE_MAX_PX / Math.max(img.width, img.height));
            const w = Math.round(img.width * scale);
            const h = Math.round(img.height * scale);
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const compressed = canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
            resolve({ dataUrl: compressed, base64: compressed.split(',')[1] });
        };
        img.src = dataUrl;
    });
}

function handleImageSelect() {
    const files = Array.from(imageInput.files);
    const readers = files.map(file => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = e => compressImage(e.target.result).then(resolve);
        reader.readAsDataURL(file);
    }));
    Promise.all(readers).then(imgs => {
        pendingImages.push(...imgs);
        imageInput.value = '';
        renderImagePreviews();
    });
}

function renderImagePreviews() {
    imagePreviewBar.innerHTML = '';
    imagePreviewBar.classList.toggle('hidden', pendingImages.length === 0);
    pendingImages.forEach((img, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'preview-thumb';
        const imgEl = document.createElement('img');
        imgEl.src = img.dataUrl;
        imgEl.alt = '';
        const removeBtn = document.createElement('button');
        removeBtn.className = 'preview-remove';
        removeBtn.setAttribute('aria-label', 'Remove image');
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => { pendingImages.splice(i, 1); renderImagePreviews(); });
        wrap.append(imgEl, removeBtn);
        imagePreviewBar.appendChild(wrap);
    });
}

// ── Rendering ──

function setBubble(msgEl, role, content) {
    let bubble = msgEl.querySelector('.bubble');
    if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'bubble';
        msgEl.insertBefore(bubble, msgEl.querySelector('.msg-links')); // (links that came first stay below)
    }
    bubble.innerHTML = role === 'assistant' ? parseMarkdown(content) : escapeHtml(content).replace(/\n/g, '<br>');
}

// The 💭 button on a reply that came with thinking: shows it in the Thinking window.
function addThinkButton(msgEl, msg) {
    if (msgEl.querySelector('.msg-think-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'msg-edit-btn msg-think-btn';
    btn.title = 'Show its thinking';
    btn.setAttribute('aria-label', 'Show its thinking');
    btn.textContent = '💭';
    btn.addEventListener('click', () => thinkingPane.showSaved(msg.thinking, msg.thinkingMs, msgEl.querySelector('.msg-label')?.textContent || ''));
    msgEl.querySelector('.msg-header').appendChild(btn);
}

// Redraw a message in place (after more was added to it).
function rerenderMessage(i) {
    const m = messages[i];
    const old = messageEls[i];
    const el = appendMessage(m.role, m.content, m.imageUrls || [], { track: false, attachments: m.attachments });
    if (m.interrupted) el.classList.add('interrupted');
    if (m.thinking) addThinkButton(el, m);
    if (m.actions?.length) renderActions(el, m.actions);
    if (m.links?.length) renderLinks(el, m.links);
    old.replaceWith(el);
    messageEls[i] = el;
}

// ── Links ──
// Links it shared (show_links) under its reply; the web search results it used, folded away below.

function linkEl(l) {
    const li = document.createElement('li');
    const a = Object.assign(document.createElement('a'), { href: l.url, target: '_blank', rel: 'noopener noreferrer', textContent: l.title || hostOf(l.url) });
    li.append(a, Object.assign(document.createElement('span'), { className: 'link-host', textContent: ` ${hostOf(l.url)}` }));
    return li;
}

function linkBlock(links, kind) {
    const shared = links.filter(l => l.kind !== 'sources');
    const sources = links.filter(l => l.kind === 'sources' && !shared.some(s => s.url === l.url));
    const frag = document.createDocumentFragment();
    if (shared.length) {
        const ul = Object.assign(document.createElement('ul'), { className: 'link-list' });
        ul.append(...shared.map(linkEl));
        frag.append(ul);
    }
    if (sources.length) {
        const d = Object.assign(document.createElement('details'), { className: 'link-sources', open: !shared.length && kind === 'open-if-alone' });
        d.append(Object.assign(document.createElement('summary'), { textContent: `Web search results (${sources.length})` }));
        const ul = Object.assign(document.createElement('ul'), { className: 'link-list' });
        ul.append(...sources.map(linkEl));
        d.append(ul);
        frag.append(d);
    }
    return frag;
}

function renderLinks(msgEl, links) {
    let box = msgEl.querySelector('.msg-links');
    if (!box) {
        box = Object.assign(document.createElement('div'), { className: 'msg-links' });
        msgEl.appendChild(box);
    }
    box.replaceChildren(linkBlock(links));
}

// Conversation mode: the links from this conversation stay on screen to click while talking.
let convLinks = [];
function showConvLinks(kind, list) {
    if (kind === 'sources') convLinks = convLinks.filter(l => l.kind !== 'sources'); // (just the latest search)
    for (const l of list) {
        convLinks = convLinks.filter(x => !(x.url === l.url && x.kind === kind));
        convLinks.unshift({ ...l, kind });
    }
    convLinks = [...convLinks.filter(l => l.kind !== 'sources').slice(0, 12), ...convLinks.filter(l => l.kind === 'sources')];
    renderConvLinks();
}
function renderConvLinks() {
    const box = $('conv-links');
    box.classList.toggle('hidden', !convLinks.length);
    $('conv-links-list').replaceChildren(linkBlock(convLinks, 'open-if-alone'));
}
function clearConvLinks() { convLinks = []; renderConvLinks(); }

// What the assistant actually did (tools), shown above its reply: "⏰ Timer: 20 minutes, at 2:25 pm".
function renderActions(msgEl, actions) {
    let row = msgEl.querySelector('.msg-actions');
    if (!row) {
        row = document.createElement('div');
        row.className = 'msg-actions';
        msgEl.querySelector('.msg-header').after(row);
    }
    row.replaceChildren(...actions.map(t => Object.assign(document.createElement('div'), { className: 'msg-action', textContent: t })));
}

// Pasted text and links under a user message, each expandable to show what the model got.
function renderAttachments(msgEl, attachments) {
    const row = document.createElement('div');
    row.className = 'msg-attachments';
    for (const a of attachments) {
        const d = document.createElement('details');
        d.className = `att att-${a.type}${a.error ? ' att-error' : ''}`;
        const sum = document.createElement('summary');
        sum.textContent = a.type === 'text'
            ? `📄 ${a.name || 'Pasted text'} · ${a.text.length.toLocaleString()} chars`
            : a.error ? `🔗 ${hostOf(a.url)} (couldn't read: ${a.error})` : `🔗 ${a.title} · ${hostOf(a.url)}`;
        d.appendChild(sum);
        if (a.type === 'link') {
            const link = document.createElement('a');
            link.href = a.url;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = a.url;
            d.appendChild(link);
        }
        if (a.text) {
            const pre = document.createElement('pre');
            pre.textContent = a.text.length > 4000 ? a.text.slice(0, 4000) + '…' : a.text;
            d.appendChild(pre);
        }
        row.appendChild(d);
    }
    msgEl.appendChild(row);
}

function appendMessage(role, content, imageUrls = [], { track = true, attachments = [] } = {}) {
    const msg = document.createElement('div');
    msg.className = `msg ${role}`;

    const header = document.createElement('div');
    header.className = 'msg-header';
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? 'You' : (settings.model || 'Assistant');
    header.appendChild(label);

    if (role === 'user') {
        const editBtn = document.createElement('button');
        editBtn.className = 'msg-edit-btn';
        editBtn.title = 'Edit message';
        editBtn.setAttribute('aria-label', 'Edit message');
        editBtn.textContent = '✏';
        editBtn.addEventListener('click', () => enterEditMode(msg, messageEls.indexOf(msg)));
        header.appendChild(editBtn);
    } else {
        const speakBtn = document.createElement('button');
        speakBtn.className = 'msg-edit-btn msg-speak-btn';
        speakBtn.title = 'Read aloud';
        speakBtn.setAttribute('aria-label', 'Read aloud');
        speakBtn.textContent = '🔊';
        speakBtn.addEventListener('click', () => {
            if (speakBtn.classList.contains('playing')) { readPlayer.stop(); markSpeaking(null); return; }
            const text = msg.dataset.content ?? messages[messageEls.indexOf(msg)]?.content ?? '';
            if (text) readAloud(text, msg);
        });
        header.appendChild(speakBtn);
    }
    msg.appendChild(header);

    if (imageUrls.length > 0) {
        const imgRow = document.createElement('div');
        imgRow.className = 'bubble-images';
        imageUrls.forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            img.className = 'bubble-image';
            img.alt = 'Attached image';
            imgRow.appendChild(img);
        });
        msg.appendChild(imgRow);
    }

    if (content) setBubble(msg, role, content);
    if (attachments?.length) renderAttachments(msg, attachments);
    if (role === 'assistant') msg.dataset.content = content;

    messagesEl.appendChild(msg);
    if (track) messageEls.push(msg);
    scrollToBottom();
    return msg;
}

function enterEditMode(msgEl, msgIndex) {
    if (busy || convMode || msgIndex < 0) return;
    const bubble = msgEl.querySelector('.bubble');
    if (!bubble) return;

    const originalContent = messages[msgIndex].content;
    bubble.remove();

    const editArea = document.createElement('div');
    editArea.className = 'edit-area';
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = originalContent;
    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
    });

    const actions = document.createElement('div');
    actions.className = 'edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn primary';
    saveBtn.textContent = 'Save & Send';
    saveBtn.addEventListener('click', () => {
        const newText = textarea.value.trim();
        if (newText) submitEdit(msgIndex, newText);
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => cancelEdit(msgEl, originalContent, editArea));

    actions.append(saveBtn, cancelBtn);
    editArea.append(textarea, actions);
    msgEl.appendChild(editArea);

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const newText = textarea.value.trim();
            if (newText) submitEdit(msgIndex, newText);
        }
        if (e.key === 'Escape') { e.stopPropagation(); cancelEdit(msgEl, originalContent, editArea); }
    });
}

function cancelEdit(msgEl, originalContent, editArea) {
    editArea.remove();
    setBubble(msgEl, 'user', originalContent);
}

async function submitEdit(msgIndex, newText) {
    if (!hasApi()) { showError('No server URL set. Open Settings and paste your Cloudflare tunnel URL.'); return; }
    const orig = messages[msgIndex];
    // Drop this message and everything after it (and any stray error/typing bubbles), then resend.
    const lastKept = msgIndex > 0 ? messageEls[msgIndex - 1] : welcomeEl;
    while (lastKept.nextSibling) lastKept.nextSibling.remove();
    messageEls.length = msgIndex;
    messages.length = msgIndex;

    const userMsg = { role: 'user', content: newText };
    if (orig.images?.length) { userMsg.images = orig.images; userMsg.imageUrls = orig.imageUrls; }
    if (orig.attachments?.length) userMsg.attachments = orig.attachments;
    appendMessage('user', newText, userMsg.imageUrls || [], { attachments: userMsg.attachments });
    messages.push(userMsg);
    await generateReply();
}

function appendTypingIndicator() {
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    el.innerHTML = '<span></span><span></span><span></span>';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
}

function showNotice(msg) {
    const el = document.createElement('div');
    el.className = 'notice-bubble';
    el.textContent = msg;
    messagesEl.appendChild(el);
    scrollToBottom();
}

function showError(msg) {
    const el = document.createElement('div');
    el.className = 'error-bubble';
    el.textContent = msg;
    messagesEl.appendChild(el);
    scrollToBottom();
}

function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(text) {
    const statusEl = $('status-text');
    if (statusEl) statusEl.textContent = text;
}

function setBusy(on) {
    busy = on;
    userInputEl.disabled = on;
    imageBtn.disabled = on;
    sendBtn.classList.toggle('stop', on);
    sendBtn.lastChild.textContent = on ? ' Stop' : ' Send';
    sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
    setStatus(on ? 'Thinking...' : 'Ready');
}

// ── Markdown parser ──

function parseMarkdown(text) {
    const blocks = [];
    text = escapeHtml(text);
    text = text.replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, _lang, code) => {
        const i = blocks.length;
        blocks.push(`<pre><code>${code.trim()}</code></pre>`);
        return `\x00BLOCK${i}\x00`;
    });

    text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm,   '<h1>$1</h1>');

    text = text.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, match => {
        const items = match.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*+] /, '')}</li>`).join('');
        return `<ul>${items}</ul>`;
    });
    text = text.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, match => {
        const items = match.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*\d+\. /, '')}</li>`).join('');
        return `<ol>${items}</ol>`;
    });

    text = text.split(/\n{2,}/).map(part => {
        part = part.trim();
        if (!part) return '';
        if (/^\x00BLOCK|^<(h[1-3]|ul|ol|pre)/.test(part)) return part;
        return `<p>${part.replace(/\n/g, '<br>')}</p>`;
    }).join('');

    return text.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[Number(i)]);
}

// ── Utils ──

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Start ──

// ── Reminders going off (pushed by the server) ──

// A two-note chime, so a reminder is noticed before the voice starts.
function chime() {
    try {
        const ctx = audioContext();
        ctx.resume?.();
        const t = ctx.currentTime + 0.02;
        for (const [i, f] of [880, 1318.5].entries()) {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = f;
            g.gain.setValueAtTime(0, t + i * 0.18);
            g.gain.linearRampToValueAtTime(0.18, t + i * 0.18 + 0.02);
            g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.9);
            o.connect(g).connect(ctx.destination);
            o.start(t + i * 0.18);
            o.stop(t + i * 0.18 + 1);
        }
    } catch {}
}

const reminderQueue = [];
function onReminder(r) {
    // Several tabs open in this browser: only one of them announces it.
    const key = `reminder_said_${r.id}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, String(Date.now()));
    for (const k of Object.keys(localStorage)) if (k.startsWith('reminder_said_') && Date.now() - Number(localStorage.getItem(k)) > 86400000) localStorage.removeItem(k);

    const when = r.late ? ` (this went off at ${new Date(r.due).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, while DanGPT was closed)` : '';
    reminderQueue.push({ say: r.late ? `While you were away: ${r.say}` : r.say, show: `${r.kind === 'transcript' ? '🎬' : '⏰'} ${r.say}${when}` });
    chime();
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification(r.kind === 'timer' ? 'Timer' : r.kind === 'transcript' ? 'Transcript ready' : 'Reminder', { body: r.say }); } catch {}
    }
    deliverReminders();
}

// Into the chat as a message from the assistant (so it knows it went off), and said aloud. Waits
// for a reply that's being written to finish first.
function deliverReminders() {
    if (!reminderQueue.length) return;
    if (convMode) {
        while (reminderQueue.length) {
            const r = reminderQueue.shift();
            conversation.announce(r.say);
        }
        return;
    }
    if (busy) { setTimeout(deliverReminders, 500); return; }
    while (reminderQueue.length) {
        const r = reminderQueue.shift();
        const handle = beginReply({ announcement: true });
        handle.commit(r.show, false);
        readAloud(r.say, messageEls[messageEls.length - 1]);
    }
    renderAgentData();
}

let stopEvents = null;
function connectEvents() {
    stopEvents?.();
    stopEvents = subscribeEvents(e => {
        if (e.type === 'reminder') onReminder(e);
        else if (e.type === 'timers') setTimers(e);
    });
}

// ── Timers on screen: a strip under the header, counting down ──

const REMINDER_SHOW_MS = 12 * 3600000; // reminders show once they're less than 12 hours off
let timerList = [], clockSkew = 0, timerTick = null;
const doneTimers = new Map(); // id → { item, until }: just gone off, shown as "Done" for a moment

function setTimers({ list, now }) {
    if (now) clockSkew = now - Date.now(); // (the server's clock, in case this is another device)
    const ids = new Set(list.map(t => t.id));
    for (const t of timerList) {
        if (!ids.has(t.id) && t.due - (Date.now() + clockSkew) < 2000) doneTimers.set(t.id, { item: t, until: Date.now() + 6000 });
    }
    timerList = list;
    renderTimers();
}

function fmtLeft(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function renderTimers() {
    const bar = $('timer-bar');
    const now = Date.now() + clockSkew;
    for (const [id, d] of doneTimers) if (Date.now() > d.until) doneTimers.delete(id);
    const shown = timerList.filter(t => t.kind === 'timer' || t.due - now < REMINDER_SHOW_MS);
    const items = [...[...doneTimers.values()].map(d => ({ ...d.item, done: true })), ...shown];
    bar.classList.toggle('hidden', !items.length);
    clearTimeout(timerTick);
    if (!items.length) { bar.replaceChildren(); return; }

    // Rebuilt only when the set changes; the numbers update in place every second.
    const key = items.map(t => t.id + (t.done ? '!' : '')).join(',');
    if (bar.dataset.key !== key) {
        bar.dataset.key = key;
        bar.replaceChildren(...items.map(t => {
            const chip = Object.assign(document.createElement('div'), { className: `timer-chip ${t.kind}${t.done ? ' done' : ''}` });
            chip.dataset.id = t.id;
            const label = t.text && t.text !== 'Timer' ? t.text : (t.kind === 'timer' ? 'Timer' : 'Reminder');
            chip.title = t.kind === 'timer' ? `${label}: goes off at ${new Date(t.due - clockSkew).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `Reminder: ${label}`;
            chip.append(
                Object.assign(document.createElement('span'), { className: 'timer-icon', textContent: t.kind === 'timer' ? '⏰' : '🔔' }),
                Object.assign(document.createElement('span'), { className: 'timer-label', textContent: label }),
                Object.assign(document.createElement('span'), { className: 'timer-time' })
            );
            if (!t.done) {
                const x = Object.assign(document.createElement('button'), { type: 'button', className: 'timer-cancel', textContent: '✕', title: 'Cancel' });
                x.setAttribute('aria-label', `Cancel ${label}`);
                x.addEventListener('click', async () => { x.disabled = true; await agentData('reminders', t.id).catch(() => {}); renderAgentData(); });
                chip.appendChild(x);
            }
            if (t.kind === 'timer' && t.duration) chip.appendChild(Object.assign(document.createElement('span'), { className: 'timer-progress' }));
            return chip;
        }));
    }
    for (const chip of bar.children) {
        const t = items.find(x => x.id === chip.dataset.id);
        if (!t) continue;
        const left = t.due - now;
        chip.querySelector('.timer-time').textContent = t.done ? 'Done!' : t.kind === 'timer' ? fmtLeft(left)
            : new Date(t.due - clockSkew).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        chip.classList.toggle('soon', !t.done && t.kind === 'timer' && left < 10000);
        const bar2 = chip.querySelector('.timer-progress');
        if (bar2) bar2.style.width = `${t.done ? 0 : Math.max(0, Math.min(100, 100 * left / t.duration))}%`;
    }
    // Every second while a timer is running (or a "Done" is showing); otherwise once a minute.
    const fast = items.some(t => t.kind === 'timer' || t.done);
    timerTick = setTimeout(renderTimers, fast ? 1000 - (Date.now() % 1000) + 20 : 60000);
}

// ── Settings → Tools: what's remembered, lists, upcoming reminders ──

async function renderAgentData() {
    const box = $('agent-data');
    if (!box || settingsModal.classList.contains('hidden')) return;
    let d;
    try { d = await agentData(); }
    catch { box.textContent = "Couldn't reach the server."; return; }
    box.replaceChildren();
    const section = (title, items, empty, extra) => {
        const h = Object.assign(document.createElement('div'), { className: 'agent-head', textContent: title });
        if (extra) h.appendChild(extra);
        box.appendChild(h);
        if (!items.length) { box.appendChild(Object.assign(document.createElement('div'), { className: 'agent-empty label-hint', textContent: empty })); return; }
        const ul = Object.assign(document.createElement('ul'), { className: 'agent-list' });
        for (const { text, sub, kind, id } of items) {
            const li = document.createElement('li');
            const t = Object.assign(document.createElement('span'), { className: 'agent-text', textContent: text });
            if (sub) t.appendChild(Object.assign(document.createElement('span'), { className: 'label-hint', textContent: ` ${sub}` }));
            const x = Object.assign(document.createElement('button'), { type: 'button', className: 'agent-del', textContent: '✕', title: 'Delete' });
            x.setAttribute('aria-label', `Delete: ${text}`);
            x.addEventListener('click', async () => { x.disabled = true; await agentData(kind, id).catch(() => {}); renderAgentData(); });
            li.append(t, x);
            ul.appendChild(li);
        }
        box.appendChild(ul);
    };
    section('Timers and reminders', d.reminders.map(r => ({ text: r.kind === 'timer' && r.text === 'Timer' ? 'Timer' : r.text, sub: r.when, kind: 'reminders', id: r.id })), 'None set.');
    let forgetAll = null;
    if (d.memory.length > 1) {
        forgetAll = Object.assign(document.createElement('button'), { type: 'button', className: 'agent-forget-all', textContent: 'Forget everything' });
        forgetAll.addEventListener('click', async () => {
            if (!confirm('Forget everything it remembers about you?')) return;
            await agentData('memory', 'all').catch(() => {});
            renderAgentData();
        });
    }
    section('Memory', d.memory.map(m => ({ text: m.text, kind: 'memory', id: m.id })), 'Nothing yet. Try “remember that…”.', forgetAll);
    section('Lists', d.lists.map(l => ({ text: l.name, sub: l.items.join(', '), kind: 'lists', id: l.name })), 'No lists yet.');
    renderHome(d.home);
    renderCalendar();
    renderKeep();
}

// ── Settings → Tools: home, and the calendar (both saved on the server straight away) ──

function renderHome(home) {
    const st = $('home-status');
    st.textContent = home ? `Set to ${home.name}.` : 'Not set yet.';
    if (home && document.activeElement !== $('home-place')) $('home-place').value = home.query || home.name;
}

async function setHome() {
    const place = $('home-place').value.trim();
    const st = $('home-status');
    const btn = $('home-set');
    if (!place) {
        btn.disabled = true;
        await agentData('home', 'x').catch(() => {});
        btn.disabled = false;
        return renderAgentData();
    }
    btn.disabled = true;
    st.textContent = 'Looking it up…';
    try { renderHome((await postSetting('/api/agent/home', { place })).home); }
    catch (err) { st.textContent = err.message; }
    btn.disabled = false;
}

// Google Keep: signed in once with the one-time cookie Google sets after signing in; the lasting
// token it's swapped for stays on the server.
async function renderKeep(st) {
    const box = $('keep-box');
    if (!st) { try { st = await keepStatus(); } catch { box.textContent = "Couldn't reach the server."; return; } }
    const esc = escapeHtml;
    if (st.connected) {
        box.innerHTML = `
            <div class="gcal-state ok">✓ Connected to ${esc(st.email || 'Google Keep')}.</div>
            ${st.error ? `<div class="gcal-state err">${esc(st.error)}</div>` : ''}
            ${st.local ? `<label class="settings-check"><input type="checkbox" id="keep-remote"${st.remote ? ' checked' : ''}> Also from my phone (through the tunnel)
                <span class="label-hint">Off: only DanGPT on this PC can use Keep. On: anyone with your tunnel link could read and add notes.</span></label>
            <div class="settings-row"><button type="button" class="btn" id="keep-disconnect">Disconnect</button></div>`
            : `<span class="label-hint">${st.remote ? 'It works from here too.' : 'It only works on the PC itself (you can change that in Settings there).'}</span>`}`;
    } else if (!st.local) {
        box.innerHTML = `<span class="label-hint">Not connected. Set it up in Settings on the PC that runs DanGPT.</span>`;
    } else {
        box.innerHTML = `
            ${st.error ? `<div class="gcal-state err">${esc(st.error)}</div>` : ''}
            <details class="gcal-help" open><summary>How to connect (about 2 minutes, once)</summary>
                <ol class="gcal-steps">
                    <li>Open <a href="https://accounts.google.com/EmbeddedSetup" target="_blank" rel="noopener">accounts.google.com/EmbeddedSetup</a> and sign in with the Google account you use for Keep. Afterwards the page may sit there loading: that's fine.</li>
                    <li>Press <b>F12</b>, then <b>Application</b> (in Firefox: Storage) → <b>Cookies</b> → <b>accounts.google.com</b>.</li>
                    <li>Copy the value of <b>oauth_token</b> (it starts with <code>oauth2_4/</code>) into the box below and press Connect. It only works for a few minutes, so do it straight away.</li>
                </ol>
            </details>
            <label for="keep-email">Google account<input type="email" id="keep-email" placeholder="you@gmail.com" autocomplete="off" spellcheck="false"></label>
            <label for="keep-token">oauth_token<input type="password" id="keep-token" placeholder="oauth2_4/…" autocomplete="off" spellcheck="false"></label>
            <div class="settings-row"><button type="button" class="btn" id="keep-connect">Connect</button></div>
            <span id="keep-msg" class="label-hint">This uses an unofficial way into Keep (Google's own Keep API only works for business accounts), so it may stop working when Google changes Keep. DanGPT keeps the sign-in on this PC; it gives access to your Google account, so don't share the data folder.</span>`;
    }
    $('keep-connect')?.addEventListener('click', async () => {
        const msg = $('keep-msg'), btn = $('keep-connect');
        btn.disabled = true; msg.textContent = 'Signing in to Google…';
        try { renderKeep(await postSetting('/api/keep/connect', { email: $('keep-email').value, token: $('keep-token').value })); }
        catch (err) { msg.textContent = err.message; btn.disabled = false; }
    });
    $('keep-disconnect')?.addEventListener('click', async () => {
        if (!confirm('Disconnect Google Keep? DanGPT forgets the sign-in.')) return;
        renderKeep(await postSetting('/api/keep/disconnect').catch(() => null));
    });
    $('keep-remote')?.addEventListener('change', async e => renderKeep(await postSetting('/api/keep/remote', { on: e.target.checked }).catch(() => null)));
}

// Calendars come from their secret iCal addresses, kept on the server (never shown again here).
async function renderCalendar(st) {
    const box = $('gcal-box');
    if (!st) { try { st = await calendarStatus(); } catch { box.textContent = "Couldn't reach the server."; return; } }
    const esc = escapeHtml;
    const feeds = st.feeds.map(f => `
        <li><span class="agent-text">${esc(f.name)} <span class="label-hint">${f.error ? `⚠ ${esc(f.error)}` : `${f.nextWeek} event${f.nextWeek === 1 ? '' : 's'} in the next 7 days`}</span></span>
        ${st.local ? `<button type="button" class="agent-del" data-feed="${esc(f.id)}" title="Remove" aria-label="Remove ${esc(f.name)}">✕</button>` : ''}</li>`).join('');
    box.innerHTML = `
        ${feeds ? `<ul class="agent-list">${feeds}</ul>` : ''}
        ${st.local ? `
        <details class="gcal-help"${st.feeds.length ? '' : ' open'}><summary>${st.feeds.length ? 'Add another calendar' : 'How to add your calendar'}</summary>
            <ol class="gcal-steps">
                <li>In <a href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noopener">Google Calendar's settings</a>, click your calendar on the left (under “Settings for my calendars”).</li>
                <li>Under <b>Integrate calendar</b>, copy the <b>Secret address in iCal format</b> and paste it below.</li>
            </ol>
            <div class="settings-row"><input type="password" id="cal-url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocomplete="off" spellcheck="false"><button type="button" class="btn" id="cal-add">Add</button></div>
            <span id="cal-msg" class="label-hint">It can read the calendar, not change it: to add something it shows a link that opens Google Calendar with it filled in. Treat the address like a password: anyone who has it can see your calendar.</span>
        </details>
        ${st.feeds.length ? `<label class="settings-check"><input type="checkbox" id="cal-remote"${st.remote ? ' checked' : ''}> Also from my phone (through the tunnel)
            <span class="label-hint">Off: only DanGPT on this PC can read your calendar. On: anyone with your tunnel link could ask what's on it.</span></label>` : ''}`
        : `<span class="label-hint">${st.feeds.length ? (st.remote ? 'It works from here too.' : 'It only works on the PC itself (you can change that in Settings there).') : 'Not set up. Add it in Settings on the PC that runs DanGPT.'}</span>`}`;
    const add = async () => {
        const msg = $('cal-msg'), btn = $('cal-add');
        btn.disabled = true; msg.textContent = 'Reading the calendar…';
        try { renderCalendar(await postSetting('/api/calendar/feeds', { url: $('cal-url').value })); }
        catch (err) { msg.textContent = err.message; btn.disabled = false; }
    };
    $('cal-add')?.addEventListener('click', add);
    $('cal-url')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    $('cal-remote')?.addEventListener('change', async e => renderCalendar(await postSetting('/api/calendar/remote', { on: e.target.checked }).catch(() => null)));
    for (const x of box.querySelectorAll('[data-feed]')) x.addEventListener('click', async () => {
        if (!confirm('Remove this calendar from DanGPT?')) return;
        renderCalendar(await removeCalendar(x.dataset.feed).catch(() => null));
    });
}

window.dangpt = { conversation, readPlayer, settings: () => settings, onReminder }; // for poking at from the devtools console
init();
