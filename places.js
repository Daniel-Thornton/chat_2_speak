'use strict';

// Weather, travel times and finding places: free services that need no account or key.
//   Weather:      Open-Meteo (api.open-meteo.com), with its place-name search
//   Places:       Photon (photon.komoot.io), then Nominatim: addresses, postcodes, landmarks
//   Travel times: OSRM on routing.openstreetmap.de (driving, cycling, walking)
// Public transport has no free routing service, so for that it gives a Google Maps link instead.

const { parseDay, fmtDay, fmtDate, isoDate, dayDiff } = require('./agent-util');

const UA = 'DanGPT/1.0 (personal voice assistant)';

async function getJson(url, ms = 8000) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(ms) });
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered HTTP ${res.status}`);
    return res.json();
}

// Nominatim allows one request a second.
let nominatimChain = Promise.resolve();
function nominatim(params) {
    const run = nominatimChain.then(async () => {
        const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '5', 'accept-language': 'en', ...params });
        try { return await getJson(url); }
        finally { await new Promise(r => setTimeout(r, 1100)); }
    });
    nominatimChain = run.catch(() => {});
    return run;
}

// ── Finding places ──────────────────────────────────────────────────────────

const isHome = q => /^\s*(my )?(home|house|here|my place|where i live|current location|my location)\s*$/i.test(String(q || ''));

// A short, speakable name: "Perth, Scotland", "Edinburgh Castle, Edinburgh".
function shortName(r) {
    if (r.source === 'om') return [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : null, r.country_code !== r.homeCountry ? r.country : null].filter(Boolean).join(', ');
    const a = r.address || {};
    const town = a.city || a.town || a.village || a.suburb || a.county;
    const first = r.name || String(r.display_name).split(',')[0];
    return [first, town && town !== first ? town : null, a.country_code && a.country_code.toUpperCase() !== r.homeCountry ? a.country : null].filter(Boolean).join(', ');
}

// A town or city (for the weather). Open-Meteo's search ranks by population, which suits plain
// names ("Paris"); for a big place abroad vs a small one at home ("Perth") it prefers home unless
// the other is far bigger. Anything else (a postcode, a landmark) goes to Nominatim.
async function findTown(query, home) {
    const [name, ...hint] = String(query).split(',').map(s => s.trim()).filter(Boolean);
    if (name && !/\d/.test(name)) {
        const d = await getJson('https://geocoding-api.open-meteo.com/v1/search?' + new URLSearchParams({ name, count: '10', language: 'en', format: 'json' })).catch(() => null);
        let list = d?.results || [];
        if (hint.length) {
            const h = hint.join(' ').toLowerCase();
            const matching = list.filter(r => [r.admin1, r.admin2, r.country, r.country_code].some(x => x && (h.includes(x.toLowerCase()) || x.toLowerCase().includes(h))));
            if (matching.length) list = matching;
        }
        if (list.length) {
            let best = list[0];
            const local = home && list.find(r => r.country_code === home.country);
            if (local && !hint.length && (best.population || 0) < 100 * Math.max(local.population || 0, 5000)) best = local;
            return { name: shortName({ ...best, source: 'om', homeCountry: home?.country }), lat: best.latitude, lon: best.longitude, country: best.country_code, countryName: best.country };
        }
    }
    return findPlace(query, home);
}

// Any place: an address, postcode, landmark, shop or town. Nearer home is preferred.
// Photon (OpenStreetMap data, by Komoot) matches loose names well ("Waverley station"), where
// Nominatim gives the café whose address mentions it; Nominatim is the fallback.
async function findPlace(query, home) {
    const q = String(query);
    try {
        const params = { q, limit: '5', lang: 'en', ...(home?.lat != null ? { lat: String(home.lat), lon: String(home.lon), zoom: '9', location_bias_scale: '0.6' } : {}) };
        const d = await getJson('https://photon.komoot.io/api/?' + new URLSearchParams(params));
        const streety = /\b(street|st|road|rd|lane|avenue|ave|drive|way|place|crescent|terrace|row|close|gardens)\b/i.test(q);
        const f = (d.features || []).find(f => streety || !['highway'].includes(f.properties.osm_key)) || d.features?.[0];
        if (f) {
            const p = f.properties;
            const town = p.city || p.town || p.village || p.district || p.county;
            const first = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.postcode || q;
            const foreign = home && p.countrycode && p.countrycode.toUpperCase() !== home.country;
            return {
                name: [first, town && town !== first ? town : null, foreign || !home ? p.country : null].filter(Boolean).join(', '),
                lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], country: (p.countrycode || '').toUpperCase(), countryName: p.country
            };
        }
    } catch {}
    return findPlaceNominatim(q, home);
}

async function findPlaceNominatim(query, home) {
    const params = { q: String(query) };
    if (home?.lat != null) Object.assign(params, { viewbox: [home.lon - 1, home.lat + 0.7, home.lon + 1, home.lat - 0.7].join(','), bounded: '0' });
    let list = await nominatim(params);
    if (!list.length && home) list = await nominatim({ q: String(query) }); // (just in case the hint hurt)
    const r = list[0];
    if (!r) return null;
    return { name: shortName({ ...r, homeCountry: home?.country }), lat: +r.lat, lon: +r.lon, country: (r.address?.country_code || '').toUpperCase(), countryName: r.address?.country };
}

async function placeOrHome(query, home, find) {
    if (!query || isHome(query)) {
        if (!home) return { error: "The user's home location isn't set. Ask where they are (and they can set it in Settings → Tools, or tell you and you call set_home)." };
        return { place: { ...home, name: home.name, isHome: true } };
    }
    try {
        const place = await find(query, home);
        return place ? { place } : { error: `Couldn't find a place called "${query}".` };
    } catch (err) {
        return { error: `Couldn't look up "${query}": ${err.message}` };
    }
}

// ── Weather ─────────────────────────────────────────────────────────────────

const WMO = {
    0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
    51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
    61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
    71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
    80: 'light showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers',
    95: 'thunderstorms', 96: 'thunderstorms with hail', 99: 'thunderstorms with hail'
};
const sky = c => WMO[c] ?? 'unknown conditions';
const deg = t => `${Math.round(t)}°C`;

async function weather({ place, day } = {}, home) {
    const found = await placeOrHome(place, home, findTown);
    if (found.error) return { content: found.error };
    const p = found.place;
    const now = new Date();
    const want = day ? parseDay(day, now) : null;
    if (day && !want && !/\b(now|current|currently|right now|week|next few days)\b/i.test(day)) return { content: `Couldn't tell which day "${day}" means. Give a date as YYYY-MM-DD.` };
    const ahead = want ? dayDiff(want.day, now) : 0;
    if (ahead < 0) return { content: "That's in the past: this only has forecasts." };
    if (ahead > 15) return { content: `The forecast only goes 16 days ahead, and ${fmtDate(want.day)} is further off than that.` };

    const q = new URLSearchParams({
        latitude: p.lat, longitude: p.lon, timezone: 'auto', wind_speed_unit: 'mph', forecast_days: String(Math.min(16, Math.max(3, ahead + (want?.days || 1) + 1))),
        current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,is_day',
        hourly: 'temperature_2m,precipitation_probability,weather_code',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset'
    });
    let w;
    try { w = await getJson('https://api.open-meteo.com/v1/forecast?' + q); }
    catch (err) { return { content: `Couldn't get the weather: ${err.message}` }; }

    // Days and hours come back in the place's own time zone, as "YYYY-MM-DD" / "YYYY-MM-DDTHH:00".
    const ymd = key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
    const localToday = w.current.time.slice(0, 10);
    const dayKey = n => { const d = ymd(localToday); d.setDate(d.getDate() + n); return isoDate(d); };
    const dayLine = key => {
        const i = w.daily.time.indexOf(key);
        if (i < 0) return null;
        const D = w.daily;
        const label = fmtDay(ymd(key), ymd(localToday));
        const rain = D.precipitation_probability_max[i];
        const gusts = D.wind_gusts_10m_max[i];
        return `${label[0].toUpperCase() + label.slice(1)} (${fmtDate(ymd(key))}): ${sky(D.weather_code[i])}, high ${deg(D.temperature_2m_max[i])}, low ${deg(D.temperature_2m_min[i])}, ${rain ?? 0}% chance of rain${D.precipitation_sum[i] >= 1 ? ` (about ${Math.round(D.precipitation_sum[i])} mm)` : ''}, wind up to ${Math.round(D.wind_speed_10m_max[i])} mph${gusts >= 35 ? `, gusts ${Math.round(gusts)} mph` : ''}. Sunrise ${D.sunrise[i].slice(11)}, sunset ${D.sunset[i].slice(11)}.`;
    };
    const hoursLine = key => {
        const H = w.hourly, out = [];
        for (const hh of ['09', '12', '15', '18', '21']) {
            const i = H.time.indexOf(`${key}T${hh}:00`);
            if (i < 0 || (key === localToday && H.time[i] < w.current.time)) continue;
            const h = +hh;
            out.push(`${h > 12 ? h - 12 : h}${h >= 12 ? 'pm' : 'am'} ${deg(H.temperature_2m[i])} ${sky(H.weather_code[i])}${H.precipitation_probability[i] >= 20 ? ` (${H.precipitation_probability[i]}% rain)` : ''}`);
        }
        return out.length ? `  Through the day: ${out.join('; ')}.` : '';
    };

    const lines = [`Weather for ${p.name}${p.isHome ? ' (home)' : ''}, from Open-Meteo:`];
    if (!want || ahead === 0) {
        const c = w.current;
        lines.push(`Right now (${c.time.slice(11)} local): ${deg(c.temperature_2m)}${Math.abs(c.apparent_temperature - c.temperature_2m) >= 2 ? `, feels like ${deg(c.apparent_temperature)}` : ''}, ${sky(c.weather_code)}, wind ${Math.round(c.wind_speed_10m)} mph${c.precipitation > 0 ? `, ${c.precipitation} mm of rain in the last 15 minutes` : ''}.`);
    }
    const days = want ? Array.from({ length: want.days }, (_, k) => { const d = new Date(want.day); d.setDate(d.getDate() + k); return isoDate(d); }) : [dayKey(0), dayKey(1), dayKey(2)];
    for (const [k, key] of days.entries()) {
        const l = dayLine(key);
        if (!l) continue;
        lines.push(l);
        if (k === 0 && (want ? want.days === 1 : true)) lines.push(hoursLine(key));
    }
    if (ahead > 7) lines.push('(More than a week ahead, so this is only a rough guide.)');
    lines.push('Say it in a sentence or two, the way a person would; round numbers; no need to mention the source.');
    return { content: lines.filter(Boolean).join('\n'), ok: true };
}

// ── Travel times ────────────────────────────────────────────────────────────

const MODES = {
    driving: { osrm: 'routed-car', google: 'driving', word: 'by car' },
    cycling: { osrm: 'routed-bike', google: 'bicycling', word: 'by bike' },
    walking: { osrm: 'routed-foot', google: 'walking', word: 'on foot' },
    transit: { google: 'transit', word: 'by public transport' }
};
const MODE_ALIASES = { car: 'driving', drive: 'driving', bike: 'cycling', bicycle: 'cycling', cycle: 'cycling', walk: 'walking', foot: 'walking', bus: 'transit', train: 'transit', public: 'transit', 'public transport': 'transit', tram: 'transit' };

const km = m => m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
const miles = m => { const mi = m / 1609.34; return mi < 0.6 ? null : `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} miles`; };
function mins(s) {
    const m = Math.max(1, Math.round(s / 60));
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.floor(m / 60), r = m % 60;
    return `${h} hour${h > 1 ? 's' : ''}${r ? ` ${r} minute${r === 1 ? '' : 's'}` : ''}`;
}
function crowKm(a, b) {
    const R = 6371e3, rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

async function travel({ to, from, mode } = {}, home) {
    if (!to) return { content: 'Where to?' };
    let m = String(mode || 'driving').toLowerCase().trim();
    m = MODES[m] ? m : MODE_ALIASES[m] || 'driving';
    const [a, b] = await Promise.all([placeOrHome(from, home, findPlace), placeOrHome(to, home, findPlace)]);
    if (a.error || b.error) return { content: [a.error, b.error].filter(Boolean).join(' ') };
    const A = a.place, B = b.place;
    const gmaps = `https://www.google.com/maps/dir/?${new URLSearchParams({ api: '1', origin: `${A.lat},${A.lon}`, destination: `${B.lat},${B.lon}`, travelmode: MODES[m].google })}`;
    const links = [{ title: `Directions ${MODES[m].word}: ${A.isHome ? 'home' : A.name.split(',')[0]} → ${B.name.split(',')[0]} (Google Maps)`, url: gmaps }];
    const fromText = A.isHome ? `home (${A.name})` : A.name;
    const straight = crowKm(A, B);

    if (m === 'transit') {
        return {
            content: `From ${fromText} to ${B.name}: ${km(straight)}${miles(straight) ? ` (${miles(straight)})` : ''} as the crow flies. Public transport times can't be worked out here, but Google Maps directions by public transport are now on the user's screen as a link. Tell them that.`,
            links, ok: true
        };
    }
    if (straight > 3000e3) return { content: `${B.name} is ${Math.round(straight / 1000)} km away as the crow flies, too far to route ${MODES[m].word}.`, ok: true };
    let r;
    try {
        const d = await getJson(`https://routing.openstreetmap.de/${MODES[m].osrm}/route/v1/driving/${A.lon},${A.lat};${B.lon},${B.lat}?overview=false`, 12000);
        r = d.code === 'Ok' && d.routes?.[0];
    } catch (err) { return { content: `Couldn't work out the route: ${err.message}`, links }; }
    if (!r) return { content: `There's no route ${MODES[m].word} from ${fromText} to ${B.name}.`, links };
    const extra = m === 'driving' ? ' That is without traffic: allow longer at busy times.' : '';
    // (The facts go last: the smallest models tend to repeat whatever the result ends with.)
    return {
        content: `(A Google Maps directions link is on the user's screen; don't call show_links for it.${A.isHome && !/\d/.test(home?.query || '') ? " Home is set to a town, not an address, so this is from the town centre." : ''}) Tell the user: from ${fromText} to ${B.name} ${MODES[m].word} takes about ${mins(r.duration)}, ${km(r.distance)}${miles(r.distance) ? ` (${miles(r.distance)})` : ''}.${extra}`,
        links, ok: true
    };
}

// ── Home ────────────────────────────────────────────────────────────────────

// Where the user lives (a town, or an address or postcode for travel times from the door).
// Near the old home if there was one, otherwise in this PC's country (en-GB → GB): "Leith" is the
// one in Edinburgh, not Tasmania.
async function lookupHome(query, previous) {
    const q = String(query || '').trim();
    if (!q) return null;
    const region = (Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] || '').toUpperCase();
    const near = previous?.lat != null ? previous : region ? { country: region } : null;
    const place = /\d/.test(q) ? await findPlace(q, near) : await findTown(q, near);
    if (!place) return null;
    const name = place.countryName ? place.name.replace(`, ${place.countryName}`, '') : place.name; // (home needs no country)
    return { ...place, name, query: q, set: Date.now() };
}

module.exports = { weather, travel, lookupHome, MODES: Object.keys(MODES) };
