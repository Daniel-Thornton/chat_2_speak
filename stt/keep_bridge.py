"""Google Keep for DanGPT, through gkeepapi (unofficial: it talks to Keep the way the Android app
does, because Google's official Keep API is only for business Workspace accounts).

Signing in: the user copies the one-time `oauth_token` cookie that Google sets after signing in at
https://accounts.google.com/EmbeddedSetup; gpsoauth swaps it for a lasting "master token". That
token can reach the whole Google account, so it's kept only in ../data/keep.json on this PC and is
never sent anywhere except Google. A copy of the notes (gkeepapi's state) is cached alongside it so
each sync only fetches what changed.
"""

import json
import os
import secrets
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("KEEP_DATA_DIR") or os.path.join(ROOT, "data")
CREDS = os.path.join(DATA_DIR, "keep.json")
STATE = os.path.join(DATA_DIR, "keep_state.json")

_lock = threading.Lock()
_keep = None
_synced = 0.0
_error = None


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write(path, data):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _explain(exc):
    msg = str(exc) or exc.__class__.__name__
    if "BadAuthentication" in msg or "NeedsBrowser" in msg:
        return "Google turned the sign-in down. The token only works once and for a few minutes: get a fresh one and try again."
    if "DeviceManagementRequiredOrSyncDisabled" in msg:
        return "Google said this account is managed by an organisation that blocks it."
    return msg


def status():
    c = _read(CREDS)
    return {"connected": bool(c and c.get("master_token")), "email": (c or {}).get("email"), "error": _error}


def _client():
    """A signed-in, recently synced gkeepapi client."""
    global _keep, _synced, _error
    import gkeepapi

    c = _read(CREDS)
    if not c or not c.get("master_token"):
        raise RuntimeError("Google Keep isn't connected (Settings → Tools)")
    if _keep is None:
        k = gkeepapi.Keep()
        try:
            k.authenticate(c["email"], c["master_token"], state=_read(STATE), sync=True, device_id=c.get("android_id"))
        except Exception as exc:
            try:  # (a stale cached state can upset it: start clean)
                k = gkeepapi.Keep()
                k.authenticate(c["email"], c["master_token"], state=None, sync=True, device_id=c.get("android_id"))
            except Exception as exc2:
                _error = _explain(exc2)
                raise RuntimeError(f"couldn't sign in to Google Keep: {_error}") from exc
        _keep, _synced, _error = k, time.time(), None
        _write(STATE, k.dump())
    elif time.time() - _synced > 30:
        _keep.sync()
        _synced = time.time()
    return _keep


def _save(k):
    global _synced
    k.sync()
    _synced = time.time()
    _write(STATE, k.dump())


def connect(email, token):
    """Swap the browser's one-time oauth_token (or an existing master token) for a lasting sign-in."""
    global _keep, _error
    import gkeepapi
    import gpsoauth

    email = (email or "").strip()
    token = (token or "").strip().strip('"')
    if "@" not in email:
        raise ValueError("Enter the email address of the Google account.")
    if not token:
        raise ValueError("Paste the oauth_token value.")
    with _lock:
        android_id = secrets.token_hex(8)
        if token.startswith("aas_et/"):
            master = token
        else:
            res = gpsoauth.exchange_token(email, token, android_id)
            master = res.get("Token")
            if not master:
                raise ValueError(_explain(res.get("Error") or json.dumps(res)[:200]))
        k = gkeepapi.Keep()
        try:
            k.authenticate(email, master, sync=True, device_id=android_id)
        except Exception as exc:
            raise ValueError(f"Signed in, but Keep didn't open: {_explain(exc)}")
        _write(CREDS, {"email": email, "master_token": master, "android_id": android_id, "connected": time.time()})
        _write(STATE, k.dump())
        _keep, _error = k, None
        return {"email": email, "notes": len([n for n in k.all() if not n.trashed])}


def disconnect():
    global _keep, _error
    with _lock:
        _keep, _error = None, None
        for p in (CREDS, STATE):
            try:
                os.remove(p)
            except OSError:
                pass


def _kind(n):
    import gkeepapi

    return "list" if isinstance(n, gkeepapi.node.List) else "note"


def _view(n, full=False):
    out = {"id": n.id, "title": n.title or "", "kind": _kind(n), "pinned": bool(n.pinned),
           "labels": [l.name for l in n.labels.all()], "updated": n.timestamps.updated.timestamp() if n.timestamps.updated else None}
    if out["kind"] == "list":
        items = [{"text": i.text, "checked": i.checked} for i in n.items]
        out["items"] = items if full else items[:40]
    else:
        out["text"] = n.text if full else (n.text or "")[:1500]
    return out


def _find_list(k, name):
    want = (name or "").strip().lower()
    lists = [n for n in k.all() if not n.trashed and not n.archived and _kind(n) == "list"]
    for n in lists:
        if (n.title or "").strip().lower() == want:
            return n
    for n in lists:  # "shopping" finds "Shopping list"
        t = (n.title or "").strip().lower()
        if want and (want in t or t in want) and t:
            return n
    return None


def add_note(title, text):
    with _lock:
        k = _client()
        n = k.createNote(title or "", text or "")
        _save(k)
        return _view(n)


def add_to_list(name, items):
    """Adds to the list of that name if there is one (ticking nothing off), otherwise makes it."""
    items = [str(i).strip() for i in (items or []) if str(i).strip()]
    with _lock:
        k = _client()
        n = _find_list(k, name)
        created = n is None
        if created:
            n = k.createList(name or "List", [(i, False) for i in items])
            added = items
        else:
            have = {i.text.strip().lower() for i in n.items if not i.checked}
            added = [i for i in items if i.lower() not in have]
            for i in added:
                n.add(i, False, gkeepapi_bottom())
        _save(k)
        return {**_view(n), "created": created, "added": added}


def gkeepapi_bottom():
    import gkeepapi

    return gkeepapi.node.NewListItemPlacementValue.Bottom


def tick(name, items):
    """Ticks items off a list (as Keep does when you've got them)."""
    with _lock:
        k = _client()
        n = _find_list(k, name)
        if n is None:
            raise RuntimeError(f'there\'s no list called "{name}" in Keep')
        done, already, missing = [], [], []
        for want in items or []:
            w = str(want).strip().lower()
            match = lambda i: i.text.strip().lower() == w or w in i.text.strip().lower()
            hit = next((i for i in n.items if not i.checked and match(i)), None)
            if hit:
                hit.checked = True
                done.append(hit.text)
            elif any(i.checked and match(i) for i in n.items):
                already.append(str(want))
            else:
                missing.append(str(want))
        _save(k)
        return {**_view(n), "ticked": done, "already": already, "missing": missing}


def find(query, limit=8):
    with _lock:
        k = _client()
        q = (query or "").strip().lower()
        words = [w for w in q.split() if len(w) > 1]
        hits = []
        for n in k.all():
            if n.trashed:
                continue
            hay = " ".join([n.title or "", n.text or ""] + ([i.text for i in n.items] if _kind(n) == "list" else [])).lower()
            if not words or all(w.rstrip("s") in hay for w in words):
                hits.append(n)
        hits.sort(key=lambda n: (not n.pinned, -(n.timestamps.updated.timestamp() if n.timestamps.updated else 0)))
        return {"count": len(hits), "notes": [_view(n) for n in hits[:limit]]}
