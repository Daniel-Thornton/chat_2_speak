# DanGPT: text and voice chat with your local LLM

Chat with an Ollama model by typing, or hold a hands-free spoken conversation with it. In voice mode you just talk. It works out when you've finished, answers in a natural Breeze TTS 2 voice, and you can talk over it to interrupt.

## Running it

Double-click **`launch.bat`**. It starts whatever isn't already running:

| Service | Port | What it does |
| --- | --- | --- |
| Ollama | 11434 | The LLM |
| Breeze TTS 2 (`--fast-all`) | 7860 | The voice. Uses about 16 GB of VRAM and takes 1.5–2.5 min to warm up. If it's already running it's reused. |
| Whisper STT (`stt/stt_server.py`) | 8890 | Speech recognition: faster-whisper `large-v3-turbo` on the GPU, about 2 GB |
| DanGPT server (`server.js`) | 8788 | Serves the app and connects it to the services above |
| Cloudflare tunnel | – | Gives you a public https URL for use on your phone |

Open **http://localhost:8788** on this PC, or the `trycloudflare.com` URL from anywhere else. When you open the page from either of those addresses, leave Settings → Server URL blank. Use `start-tunnel.ps1 -NoTunnel` to skip the tunnel, and `-Model qwen3.5:4b` to choose which model gets pulled on first run.

On first run the launcher builds `stt/.venv` and downloads the Whisper model (about 1.6 GB). Whisper borrows its CUDA libraries (cuBLAS and cuDNN) from Breeze's PyTorch install. If Breeze isn't there, it installs NVIDIA's pip wheels instead (`stt/requirements-cuda.txt`, about 1 GB). Breeze is expected at `..\..\breeze-tts` with its own `.venv`. Set `BREEZE_DIR` to use a different folder.

## Voice mode

Tap the conversation button in the header.

- **Talk naturally.** After a short pause (Settings → *Pause before it replies*) your speech goes to Whisper and the reply streams back. The first sentence is spoken while the rest is still being written.
- **Interrupt by talking.** The reply ducks as soon as you start speaking and stops once you've clearly said something. Only the part you actually heard is kept in the history. If you carry on talking before it has said anything, it treats that as you finishing your thought and merges it into your last message. While it's speaking, a quick check stops its own voice coming back through the speakers from counting as an interruption.
- **Wearing headphones? Turn on Settings → *I'm using headphones*.** On speakers, the browser's echo cancellation has to filter the assistant's voice out of your mic, and while it's talking that can muffle you too, so interruptions get missed or lose their first words. Headphones mode turns echo cancellation off, and interrupting becomes reliable.
- **The big button** mutes the mic, or interrupts the reply while it's talking. **Space** does the same, and **Esc** goes back to text chat.
- Text and voice share the same chat history, so you can switch between them mid-conversation.
- **Voice-mode instructions** (Settings → Conversation) are added after your System Prompt, but only in conversation mode. They ask for short spoken replies with no markdown, a few sound effects, and the occasional follow-up question. You can edit or delete any line, clear the box to add nothing, or use *Restore default*.
- **Show it things while you talk.** The box at the bottom of the voice panel takes links, text and images:
  - **Links:** paste a link and the server reads the page, so the model gets its text. An image link becomes an image. For safety it only fetches public addresses, never your own PC or network.
  - **Text and files:** a long paste becomes a 📄 chip, and short text stays in the box. You can also drop text files or images onto the panel, or use the 🖼 button.
  - **Images:** paste or drop them.
  - **When it goes out:** everything waiting goes with what you say next. Press Enter to send it straight away. If you paste just after speaking, before the reply has started talking, the reply starts over with it included, so "have a look at this…" plus a paste just works.
  - **In the chat:** pasted text and links appear under your message, and you can click them to see exactly what the model got.
  - **Vision models only:** images need a model that can see, such as qwen3.5:4b, gemma4:e4b, gemma4:31b or qwen3-vl:30b. (An old copy of gemma4:e4b saw garbled images; `ollama pull gemma4:e4b` fixed it.) With other models you're told it can't see them.

## Tools: things it can do for you

Just ask, in text or voice. It uses Ollama's tool calling, and every model you have supports it. Settings → **Tools** turns each group on or off. It also shows what it's keeping, so you can delete any of it.

- **Timers and reminders:** "set a timer for ten minutes", "remind me at 6 to call Mum", "what reminders have I got?", "cancel the pasta timer". Running timers show in a strip under the header, in text and voice mode, counting down. Reminders due in the next 12 hours show there too. ✕ cancels one. When one goes off you hear a chime and it speaks up, in voice mode at the next pause. With no DanGPT page open you get a Windows notification instead, and it tells you when you next open it. Reminders run on the server, so they work while it's running (`launch.bat`), even with the page closed.
- **Memory:** "remember that I'm vegetarian." What it remembers goes into every chat, so it knows next time too.
- **Lists:** "put milk and eggs on the shopping list", "I've got the eggs", "what's on my to-do list?"
- **Opening things on this PC:** "open Steam", "pull up the BBC weather", "open my downloads". It finds any app in your Start menu. This only works when you're using DanGPT on the PC itself. It's never offered through the tunnel, so nobody else with the link can launch things on your PC.
- **Weather:** "will it rain tomorrow?", "what's Paris like this weekend?". It uses real forecasts from [Open-Meteo](https://open-meteo.com), up to 16 days ahead. It's free and needs no key.
- **Travel times and directions:** "how long to drive to Glasgow?", "how far is the castle from the station on foot?". Routes come from OpenStreetMap (OSRM), by car, bike or on foot, and driving times assume no traffic. A Google Maps directions link appears on screen. For trains and buses ("how do I get to Glasgow by train?") you just get that link, because there's no free public-transport routing to work the time out. Places are looked up with Photon, then Nominatim.
- **Home:** weather and journeys use your home when you don't say where. Set it in the Tools tab, or just tell it ("I live in Leith"). A postcode or address makes journeys start from your door; a town means its centre.
- **Calendar:** "what's on tomorrow?", "when's my dentist?", "am I free on Friday afternoon?", "what does next week look like?". It reads your calendar from its secret iCal address, repeating events included. It can't change the calendar: for "add lunch with Sarah on Friday at 1" it shows a link that opens Google Calendar with the event filled in, and you press Save. Moving or deleting events you do in Google Calendar itself. See [Adding your calendar](#adding-your-calendar) below.
- **Google Keep:** "make a note that the boiler code is 4417", "add milk and eggs to my shopping list", "I've got the eggs", "what did I note about the boiler?". Notes and lists go into your real Keep, so they're on your phone too. While Keep is connected, lists go there instead of DanGPT's own lists. See [Connecting Google Keep](#connecting-google-keep) below.
- **YouTube:** "find YungFika's rage room stream and tell me if he talked about the H3 drama", "what are the highlights of this video?", or paste a video link. It searches YouTube and reads the video's captions (its own, or YouTube's automatic ones), all free with no key. For a question about a long video, it picks out the parts that best match and puts links on screen that jump to those moments. **Videos with no captions** (often long livestreams) are transcribed on this PC by Whisper, in the background. The audio comes via yt-dlp, which the launcher installs and keeps up to date. On the 5090 a 5½-hour stream took under 3 minutes, and voice mode keeps working meanwhile. It tells you when the transcript is ready, with a Windows notification if no DanGPT page is open. Transcripts are kept in `data/transcripts/`, so each video is only read once. Whisper skips singing, so music videos without captions come out empty.
- **Web search:** with a Brave key (Tools tab).
- **Links:** "give me a few links for…". Links it shares appear under its reply, and in voice mode in a **Links** box in the voice panel, so you can click them while you talk. Each one is checked first: addresses from a web search are trusted, and anything else is test-loaded, so made-up or dead links are left out. The search results it looked at are folded away under the reply too.

Everything it does shows as a line above its reply, like *⏰ Timer: 10 minutes, at 2:25 pm*. These lines come from the tool itself, not the model, so if there's no line, nothing happened. Small models sometimes say "done" without actually calling the tool, so the server watches for that. It holds back the first few words of a reply to an action request. If they claim something was done when no tool was called, it quietly asks the model again before you see or hear anything. Calls and results are also kept in the chat history, which helps a lot: models copy what they did earlier.

The same check covers facts. A reply that starts giving temperatures, journey times or calendar entries before any tool has looked them up is dropped and asked again.

Everything is stored in `data/agent.json`, the calendar addresses in `data/calendar.json`, and the Keep sign-in in `data/keep.json`. None of these is ever served to the browser.

### Connecting Google Keep

Google's official Keep API only works for business (Workspace) accounts. So DanGPT uses [gkeepapi](https://github.com/kiwiz/gkeepapi), an unofficial library that talks to Keep the way the Android app does. It can stop working when Google changes Keep, until gkeepapi catches up, and the launcher keeps it up to date.

To connect, do this once (the steps are in Settings → Tools too):

1. Open [accounts.google.com/EmbeddedSetup](https://accounts.google.com/EmbeddedSetup) and sign in. Afterwards the page may just sit there loading, and that's fine.
2. Press F12, then go to Application → Cookies → accounts.google.com, and copy the value of **oauth_token** (it starts `oauth2_4/`).
3. Paste it into Settings → Tools → Google Keep with your email address, and press Connect. The cookie only works once and for a few minutes, so do it straight away.

DanGPT swaps the cookie for a lasting sign-in token, kept in `data/keep.json` along with a copy of your notes (`data/keep_state.json`). **That token can reach your whole Google account.** It never leaves the PC except to talk to Google, but don't share the `data` folder. *Disconnect* deletes both files. The Keep side runs in the speech-recognition server (`stt/keep_bridge.py`), so Keep needs that running, which `launch.bat` does. As with the calendar, it only works on this PC unless you tick *Also from my phone*.

### Adding your calendar

1. Open [Google Calendar's settings](https://calendar.google.com/calendar/r/settings) and click your calendar on the left, under "Settings for my calendars".
2. Under **Integrate calendar**, copy the **Secret address in iCal format**, paste it into Settings → Tools → Calendar and press Add.

Add more calendars the same way, one at a time. It checks the calendar again at most every 5 minutes. Google can take a while to update the address after you change something, sometimes longer than that.

**Treat the address like a password:** anyone who has it can read that calendar. DanGPT keeps it on the PC and never shows it again. If it gets out, use *Reset* next to it in Google Calendar, then add the new one.

**Who can use it:** by default, only DanGPT opened on this PC. *Also from my phone* lets it work through the tunnel too, but then anyone who has your tunnel link could ask what's on your calendar. Calendars can only be added and removed on the PC. Other websites you have open can't use it either, even though they can reach the DanGPT server.

Email isn't included (yet).

## Chat history

A new chat isn't saved until you say so. When you start another chat, or open a saved one, a box asks *Do you want to save this chat?* and offers a title you can edit. Until then it's kept in the browser, so reloading the page doesn't lose it. A saved chat, or one you open from the list, keeps saving as you go, in `chats/`. Deleting the chat you're in starts a blank one. In the Chats list, each one shows a title and a short summary. The model writes them after the first reply and rewrites them every few messages (Settings → General), so they describe the whole conversation rather than how it started. They're written in the background while nothing else is happening, so a reply never waits for them. Older chats get a summary the next time you add to them.

## Thinking (reasoning models)

Ollama's [thinking](https://docs.ollama.com/capabilities/thinking) option is on by default (Settings → *Thinking*). Reasoning models like qwen3.5, deepseek-r1 and gpt-oss stream their reasoning into the **Thinking** window under the chat, or under the voice panel in conversation mode. Drag its top edge to resize it; ▾ collapses it and ✕ closes it until the next reply that thinks. Each reply keeps its thinking, and the 💭 button on a message shows it again.

The server adapts the setting to what each model supports, using `/api/show`. Models that can't think just answer. gpt-oss uses levels and can't be switched off, so *On* means its default level and *Off* means `low`. *Think in voice mode too* can be turned off if the pause before it speaks is too long.

## The voice

Breeze *designs* a voice from a written description (Settings → Voice). It speaks one sample sentence in that voice, saves it as `voices/<hash>.wav`, and then *clones* that clip for every sentence after, so the voice stays consistent. Change the description or the *Variation* number (🎲) to get a different voice, and use ▶ Preview to hear it. Each new voice takes about 4 s to design the first time.

**Cloning a real voice.** Under *Clone a voice from an audio sample* (Settings → Voice) you can upload a recording instead (WAV, MP3, M4A, OGG, anything your browser can play). The browser cuts it to about 10 s of the first clear speech, Whisper writes a transcript (you can correct it), and Breeze clones that clip for every sentence, replacing the description. Use clean speech from one person, with no music or background noise. The clip is stored as `voices/clone-<hash>.wav`; *Remove sample* goes back to the described voice. Only clone voices you have permission to use.

The model can also use `(laugh)`, `(sigh)`, `(cough)` and `(clears throat)`, which Breeze performs as sounds.

If Breeze isn't running yet, the browser's built-in voice is used until it is.

## Files

```
index.html, app.js, style.css   the app
js/api.js                       server calls (streamed chat, STT, status)
js/conversation.js              voice-mode turn-taking and barge-in
js/mic.js                       mic capture (AudioWorklet, 16 kHz) and voice-activity detection
js/speech-player.js             streamed Breeze PCM → gapless Web Audio playback
js/speech-text.js               splits replies into sentences and cleans text for speech
server.js                       static files, chats/, Ollama SSE relay and tool loop, Breeze relay and voice cache, STT proxy
agent.js                        the tools: reminders, memory, lists, opening things (data in data/agent.json)
places.js                       weather (Open-Meteo), places (Photon / Nominatim), travel times (OSRM)
youtube.js                      YouTube: search, captions, Whisper transcription jobs, picking out the passages that answer a question
keep.js                         Google Keep tools (the Keep side itself is stt/keep_bridge.py, using gkeepapi)
calendar.js                     the calendar: reads iCal addresses (data/calendar.json), repeating events, time zones
agent-util.js                   reading and saying dates and times, fuzzy matching
stt/stt_server.py               faster-whisper server (also transcribes whole YouTube videos, and runs Google Keep)
start-tunnel.ps1 / launch.bat   launcher
```

`tts/` (Kokoro) is no longer used. The previous version of the app is kept in `.backup-kokoro-version/`.
