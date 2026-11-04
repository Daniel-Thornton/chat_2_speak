'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const CHATS_DIR = path.join(__dirname, 'chats');
if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });

const PORT       = 8788;
const OLLAMA_URL = 'http://localhost:11434';
const KOKORO_URL = 'http://localhost:8880';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400'
};

const SEARCH_TOOL = {
    type: 'function',
    function: {
        name: 'web_search',
        description: 'Search the web for current information, recent news, or facts you are uncertain about. Use this whenever the user asks about something that may have changed recently or that you don\'t know with confidence.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The search query' }
            },
            required: ['query']
        }
    }
};

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(data));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

function ollamaChat(body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const opts = {
            hostname: 'localhost',
            port: 11434,
            path: '/api/chat',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        const req = http.request(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
                } catch {
                    reject(new Error('Invalid JSON from Ollama'));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function braveSearch(query, apiKey) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.search.brave.com',
            path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'identity',
                'X-Subscription-Token': apiKey
            }
        };
        const req = https.request(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString()));
                } catch {
                    reject(new Error('Invalid JSON from Brave'));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function safeChatPath(id) {
    if (!/^chat_\d+$/.test(id)) return null;
    return path.join(CHATS_DIR, id + '.json');
}

function listChats() {
    try {
        return fs.readdirSync(CHATS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                try {
                    const { messages, ...meta } = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
                    return meta;
                } catch { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch { return []; }
}

async function handleChatsApi(req, res, pathname) {
    const id = pathname.length > '/api/chats'.length ? pathname.slice('/api/chats/'.length) : null;

    if (!id) {
        if (req.method === 'GET') return json(res, 200, listChats());
        return json(res, 405, { error: 'Method not allowed' });
    }

    const chatPath = safeChatPath(id);
    if (!chatPath) return json(res, 400, { error: 'Invalid chat ID' });

    if (req.method === 'GET') {
        try {
            return json(res, 200, JSON.parse(fs.readFileSync(chatPath, 'utf8')));
        } catch {
            return json(res, 404, { error: 'Chat not found' });
        }
    }

    if (req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return json(res, 400, { error: 'Invalid JSON' }); }
        fs.writeFileSync(chatPath, JSON.stringify(body, null, 2));
        console.log(`  [chats] saved ${id}`);
        return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
        try { fs.unlinkSync(chatPath); console.log(`  [chats] deleted ${id}`); } catch {}
        return json(res, 200, { ok: true });
    }

    json(res, 405, { error: 'Method not allowed' });
}

function formatSearchResults(data) {
    const results = data?.web?.results ?? [];
    if (results.length === 0) return 'No search results found.';
    return results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.description || ''}`)
        .join('\n\n');
}

async function handleChat(req, res) {
    let body;
    try {
        body = JSON.parse(await readBody(req));
    } catch {
        return json(res, 400, { error: 'Invalid JSON body' });
    }

    const { braveApiKey, ...ollamaBody } = body;

    if (braveApiKey) {
        ollamaBody.tools = [SEARCH_TOOL];
    }

    // Agentic loop — cap at 3 tool calls to prevent runaway
    const messages = [...ollamaBody.messages];
    for (let turn = 0; turn < 4; turn++) {
        let result;
        try {
            result = await ollamaChat({ ...ollamaBody, messages });
        } catch {
            return json(res, 502, { error: 'Ollama is not reachable on this PC.' });
        }

        if (result.status !== 200) {
            return json(res, result.status, result.data);
        }

        const msg = result.data?.message;

        // No tool calls — this is the final response
        if (!msg?.tool_calls?.length) {
            return json(res, 200, result.data);
        }

        // Append the assistant's tool-call turn to history
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

        // Execute each requested tool
        for (const call of msg.tool_calls) {
            const { name, arguments: args } = call.function;
            let toolResult;

            if (name === 'web_search' && braveApiKey) {
                try {
                    console.log(`  [search] "${args.query}"`);
                    const data = await braveSearch(args.query, braveApiKey);
                    toolResult = formatSearchResults(data);
                } catch (err) {
                    toolResult = `Search failed: ${err.message}`;
                }
            } else {
                toolResult = 'Unknown tool.';
            }

            messages.push({ role: 'tool', content: toolResult });
        }
    }

    json(res, 500, { error: 'Tool loop limit reached without a final response.' });
}

async function handleTTS(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid JSON body' }); }

    const { text, voice = 'af_heart', speed = 1.0 } = body;
    if (!text || !text.trim()) return json(res, 400, { error: 'No text provided' });

    const payload = JSON.stringify({
        model: 'kokoro',
        input: text.trim(),
        voice,
        speed,
        response_format: 'wav'
    });

    const kokoroUrl = new URL('/v1/audio/speech', KOKORO_URL);

    return new Promise(resolve => {
        const opts = {
            hostname: kokoroUrl.hostname,
            port:     Number(kokoroUrl.port) || 8880,
            path:     kokoroUrl.pathname,
            method:   'POST',
            headers:  {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req2 = http.request(opts, kokoroRes => {
            if (kokoroRes.statusCode !== 200) {
                kokoroRes.resume();
                json(res, 502, { error: `Kokoro returned HTTP ${kokoroRes.statusCode}` });
                resolve();
                return;
            }

            const contentType = kokoroRes.headers['content-type'] || 'audio/wav';
            res.writeHead(200, { 'Content-Type': contentType, ...CORS_HEADERS });
            kokoroRes.pipe(res);
            kokoroRes.on('end', resolve);
            kokoroRes.on('error', resolve);
        });

        req2.on('error', () => {
            json(res, 502, { error: 'Kokoro not reachable on port 8880. Is it running?' });
            resolve();
        });

        req2.write(payload);
        req2.end();
        console.log(`  [tts] "${text.trim().slice(0, 60)}"`);
    });
}

async function handleTranscribe(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid JSON body' }); }

    const { audio, mimeType } = body;
    if (!audio) return json(res, 400, { error: 'No audio data' });

    const audioBuffer = Buffer.from(audio, 'base64');
    const ext = (mimeType || 'audio/webm').includes('ogg') ? 'ogg' : 'webm';
    const boundary = 'boundary' + Date.now();

    const formBody = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: ${mimeType || 'audio/webm'}\r\n\r\n`),
        audioBuffer,
        Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper\r\n--${boundary}--\r\n`)
    ]);

    return new Promise(resolve => {
        const opts = {
            hostname: 'localhost',
            port: 11434,
            path: '/v1/audio/transcriptions',
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': formBody.length
            }
        };

        const req2 = http.request(opts, r => {
            const chunks = [];
            r.on('data', c => chunks.push(c));
            r.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString());
                    if (data.text) {
                        console.log(`  [transcribe] "${data.text.slice(0, 60)}"`);
                        json(res, 200, { text: data.text });
                    } else {
                        json(res, 502, { error: 'No transcription returned' });
                    }
                } catch {
                    json(res, 502, { error: 'Invalid response from Whisper' });
                }
                resolve();
            });
        });
        req2.on('error', () => {
            json(res, 502, { error: 'Whisper not available. Install with: ollama pull whisper' });
            resolve();
        });
        req2.write(formBody);
        req2.end();
    });
}

function proxyToOllama(req, res) {
    const ollamaUrl = new URL(req.url, OLLAMA_URL);
    const options = {
        hostname: ollamaUrl.hostname,
        port:     Number(ollamaUrl.port) || 11434,
        path:     ollamaUrl.pathname + (ollamaUrl.search || ''),
        method:   req.method,
        headers:  { ...req.headers, host: ollamaUrl.host }
    };

    const proxy = http.request(options, ollamaRes => {
        const headers = Object.fromEntries(
            Object.entries(ollamaRes.headers).filter(([k]) => !k.toLowerCase().startsWith('access-control-'))
        );
        res.writeHead(ollamaRes.statusCode, { ...headers, ...CORS_HEADERS });
        ollamaRes.pipe(res);
    });

    proxy.on('error', () => json(res, 502, { error: 'Ollama is not reachable on this PC.' }));
    req.pipe(proxy);
}

const server = http.createServer((req, res) => {
    const { pathname } = url.parse(req.url);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    // Intercept chat to handle tool-use loop
    if (pathname === '/api/chat' && req.method === 'POST') {
        handleChat(req, res);
        return;
    }

    if (pathname === '/api/tts' && req.method === 'POST') {
        handleTTS(req, res);
        return;
    }

    if (pathname === '/api/transcribe' && req.method === 'POST') {
        handleTranscribe(req, res);
        return;
    }

    if (pathname === '/api/chats' || pathname.startsWith('/api/chats/')) {
        handleChatsApi(req, res, pathname);
        return;
    }

    if (pathname.startsWith('/api/')) {
        proxyToOllama(req, res);
        return;
    }

    res.writeHead(404, CORS_HEADERS);
    res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  Chat server running');
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log('');
    console.log('  Point your Cloudflare tunnel at:');
    console.log(`  http://localhost:${PORT}`);
    console.log('');
});
