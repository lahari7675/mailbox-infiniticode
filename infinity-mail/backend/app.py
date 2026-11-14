"""infiniti Mail backend: a small Flask API between the web UI and a real IMAP/SMTP mail server.
Users sign in with their mailbox address + password (verified by IMAP). No mail is stored here."""
import imaplib, smtplib, ssl, os, re, time, html, secrets, threading, email.utils
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory, Response

E = os.environ.get
CFG = dict(
    IMAP_HOST=E('IMAP_HOST', 'mail.infiniticodetech.com'), IMAP_PORT=int(E('IMAP_PORT', '993')),
    IMAP_SECURITY=E('IMAP_SECURITY', 'ssl'),            # ssl | starttls | none
    SMTP_HOST=E('SMTP_HOST', 'mail.infiniticodetech.com'), SMTP_PORT=int(E('SMTP_PORT', '587')),
    SMTP_SECURITY=E('SMTP_SECURITY', 'starttls'),       # ssl | starttls | none
    ALLOWED_DOMAIN=E('ALLOWED_DOMAIN', 'infiniticodetech.com').lower(),   # '' = any domain
    ADMIN_EMAILS={x.strip().lower() for x in E('ADMIN_EMAILS', '').split(',') if x.strip()},
    SESSION_TTL=int(E('SESSION_TTL', '28800')), COOKIE_SECURE=E('COOKIE_SECURE', '1') == '1',
    VERIFY_TLS=E('VERIFY_TLS', '1') == '1', LIST_LIMIT=int(E('LIST_LIMIT', '150')),
    SAVE_SENT=E('SAVE_SENT', '1') == '1',
)
FRONTEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend')
app = Flask(__name__, static_folder=FRONTEND, static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 2 * 1024 * 1024

# ---------- sessions (in memory; run ONE gunicorn worker, see README) ----------
SESS, LOCK, FAILS = {}, threading.Lock(), {}
COOKIE = 'im_sid'

def new_session(user, pw):
    tok = secrets.token_urlsafe(32)
    with LOCK:
        now = time.time()
        for k in [k for k, v in SESS.items() if v['exp'] < now]: del SESS[k]
        SESS[tok] = dict(user=user, pw=pw, exp=now + CFG['SESSION_TTL'], login=now, fmap=None)
    return tok

def get_session():
    tok = request.cookies.get(COOKIE)
    with LOCK:
        s = SESS.get(tok)
        if s and s['exp'] > time.time():
            s['exp'] = time.time() + CFG['SESSION_TTL']; return s
        SESS.pop(tok, None)
    return None

# ---------- mail server helpers ----------
class AuthFailed(Exception): pass

def tls_ctx():
    c = ssl.create_default_context()
    if not CFG['VERIFY_TLS']: c.check_hostname = False; c.verify_mode = ssl.CERT_NONE
    return c

def imap_open(user, pw):
    h, p, sec = CFG['IMAP_HOST'], CFG['IMAP_PORT'], CFG['IMAP_SECURITY']
    c = imaplib.IMAP4_SSL(h, p, ssl_context=tls_ctx(), timeout=25) if sec == 'ssl' else imaplib.IMAP4(h, p, timeout=25)
    if sec == 'starttls': c.starttls(tls_ctx())
    try: c.login(user, pw)
    except imaplib.IMAP4.error: raise AuthFailed()
    return c

def q(n): return '"%s"' % n.replace('\\', '\\\\').replace('"', '\\"')

SPECIAL = {'\\sent': 'Sent', '\\drafts': 'Drafts', '\\trash': 'Trash', '\\junk': 'Spam', '\\archive': 'Archived'}
GUESS = {'Sent': ['sent', 'sent items', 'sent messages', 'sent mail'], 'Drafts': ['drafts'],
         'Trash': ['trash', 'deleted items', 'deleted messages'], 'Spam': ['spam', 'junk', 'junk e-mail', 'junk email'],
         'Archived': ['archive', 'archives']}
DEFAULT_NAME = {'Sent': 'Sent', 'Drafts': 'Drafts', 'Trash': 'Trash', 'Spam': 'Spam', 'Archived': 'Archive'}
VIEWS = {'Inbox': ('Inbox', 'ALL'), 'Starred': ('Inbox', 'FLAGGED'), 'Important': ('Inbox', 'FLAGGED'),
         'Sent': ('Sent', 'ALL'), 'Drafts': ('Drafts', 'ALL'), 'Spam': ('Spam', 'ALL'),
         'Trash': ('Trash', 'ALL'), 'Archived': ('Archived', 'ALL')}

def folder_map(c, s):
    if s['fmap']: return s['fmap']
    m, names = {'Inbox': 'INBOX'}, []
    for line in c.list()[1] or []:
        if not isinstance(line, bytes): continue
        mm = re.match(r'\((.*?)\)\s+(?:"(?:[^"\\]|\\.)*"|NIL)\s+(.+)$', line.decode('utf-8', 'replace'))
        if not mm: continue
        name = mm.group(2).strip()
        if name.startswith('"'): name = name[1:-1].replace('\\"', '"')
        names.append(name)
        for f in mm.group(1).lower().split():
            if f in SPECIAL: m.setdefault(SPECIAL[f], name)
    for key, alts in GUESS.items():
        if key not in m:
            for n in names:
                if re.split(r'[/.]', n)[-1].lower() in alts: m[key] = n; break
    s['fmap'] = m
    return m

def mailbox_for(c, s, ui_folder, create=False):
    key = VIEWS[ui_folder][0] if ui_folder in VIEWS else ui_folder
    fm = folder_map(c, s)
    if key in fm: return fm[key]
    if not create: return None
    name = DEFAULT_NAME[key]
    c.create(q(name)); c.subscribe(q(name)); fm[key] = name
    return name

def strip_tags(t):
    t = re.sub(r'(?is)<(style|script|head).*?</\1>', ' ', t)
    return html.unescape(re.sub(r'<[^>]+>', ' ', t))

def snippet_of(msg):
    try:
        part = msg.get_body(preferencelist=('plain', 'html'))
        if part is None: return ''
        t = part.get_content()
        if part.get_content_type() == 'text/html': t = strip_tags(t)
        return re.sub(r'\s+', ' ', t).strip()[:140]
    except Exception:
        return ''

def parse_internaldate(raw):
    m = re.search(rb'INTERNALDATE "([^"]+)"', raw)
    if m:
        try: return int(email.utils.parsedate_to_datetime(m.group(1).decode().replace('-', ' ', 2)).timestamp())
        except Exception: pass
    return int(time.time())

def list_messages(c, mailbox, crit, show_to):
    c.select(q(mailbox), readonly=True)
    uids = c.uid('SEARCH', None, crit)[1][0].split()
    total, uids = len(uids), uids[-CFG['LIST_LIMIT']:]
    out = []
    if uids:
        data = c.uid('FETCH', b','.join(uids).decode(), '(UID FLAGS INTERNALDATE BODY.PEEK[]<0.3000>)')[1]
        for i, part in enumerate(data):
            if not isinstance(part, tuple): continue
            tail = data[i + 1] if i + 1 < len(data) and isinstance(data[i + 1], bytes) else b''
            info = part[0] + b' ' + tail
            uid = re.search(rb'UID (\d+)', info)
            if not uid: continue
            fl = re.search(rb'FLAGS \(([^)]*)\)', info)
            flags = (fl.group(1).decode().lower().split() if fl else [])
            msg = BytesParser(policy=policy.default).parsebytes(part[1])
            who = str(msg['to'] or '') if show_to else str(msg['from'] or '')
            name, addr = email.utils.parseaddr(who)
            if show_to and addr: name = 'To: ' + (name or addr)
            out.append(dict(id=int(uid.group(1)), name=name or addr, address=addr,
                            subject=str(msg['subject'] or '(no subject)'), snippet=snippet_of(msg),
                            ts=parse_internaldate(info), unread='\\seen' not in flags, starred='\\flagged' in flags))
    out.sort(key=lambda x: -x['id'])
    return out, total

def uid_list(v):
    if not isinstance(v, list) or not v or len(v) > 500: raise ValueError('bad uids')
    return ','.join(str(int(x)) for x in v)

def move_msgs(c, src, dst, uids):
    c.select(q(src))
    if c.uid('COPY', uids, q(dst))[0] != 'OK': raise RuntimeError('copy failed')
    c.uid('STORE', uids, '+FLAGS', '(\\Deleted)'); c.expunge()

# ---------- request plumbing ----------
def err(msg, code): return jsonify(error=msg), code

def auth(fn):
    @wraps(fn)
    def w(*a, **k):
        s = get_session()
        if not s: return err('Please sign in', 401)
        if request.method == 'POST' and not request.is_json: return err('Bad request', 400)   # CSRF guard
        try: return fn(s, *a, **k)
        except AuthFailed:
            with LOCK: SESS.pop(request.cookies.get(COOKIE), None)
            return err('Please sign in', 401)
        except (ValueError, KeyError): return err('Bad request', 400)
        except (imaplib.IMAP4.error, OSError, smtplib.SMTPException) as e:
            app.logger.error('mail server error: %r', e); return err('Mail server error. Try again.', 502)
    return w

@app.after_request
def headers(r):
    r.headers.update({
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store' if request.path.startswith('/api/') else 'no-cache',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; "
            "frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"})
    return r

@app.get('/')
def index(): return send_from_directory(FRONTEND, 'index.html')

# ---------- auth endpoints ----------
@app.post('/api/login')
def login():
    if not request.is_json: return err('Bad request', 400)
    d = request.get_json(silent=True) or {}
    user, pw = str(d.get('email', '')).strip().lower(), str(d.get('password', ''))
    ip = request.remote_addr or '?'
    n, t0 = FAILS.get(ip, (0, 0))
    if time.time() - t0 > 600: n = 0
    if n >= 8: return err('Too many attempts. Try again in a few minutes.', 429)
    ok = re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', user) and pw and len(pw) < 256 and \
         (not CFG['ALLOWED_DOMAIN'] or user.endswith('@' + CFG['ALLOWED_DOMAIN']))
    if ok:
        try: imap_open(user, pw).logout()
        except AuthFailed: ok = False
        except (OSError, imaplib.IMAP4.error) as e:
            app.logger.error('login: mail server unreachable: %r', e); return err('Mail server unreachable', 502)
    if not ok:
        FAILS[ip] = (n + 1, t0 if n else time.time()); return err('Incorrect email or password', 401)
    FAILS.pop(ip, None)
    resp = jsonify(ok=True)
    resp.set_cookie(COOKIE, new_session(user, pw), httponly=True, samesite='Strict',
                    secure=CFG['COOKIE_SECURE'], max_age=CFG['SESSION_TTL'])
    return resp

@app.post('/api/logout')
def logout():
    with LOCK: SESS.pop(request.cookies.get(COOKIE), None)
    resp = jsonify(ok=True); resp.delete_cookie(COOKIE); return resp

@app.get('/api/me')
@auth
def me(s):
    u = s['user']
    return jsonify(email=u, name=re.sub(r'[._-]+', ' ', u.split('@')[0]).title(),
                   admin=u in CFG['ADMIN_EMAILS'], last_login=int(s['login']))

# ---------- mail endpoints ----------
@app.get('/api/folders')
@auth
def folders(s):
    c = imap_open(s['user'], s['pw'])
    try:
        fm, res = folder_map(c, s), dict(inbox_unread=0, drafts=0, quota=None)
        res['inbox_unread'] = int(re.search(rb'UNSEEN (\d+)', c.status('INBOX', '(UNSEEN)')[1][0]).group(1))
        if 'Drafts' in fm:
            res['drafts'] = int(re.search(rb'MESSAGES (\d+)', c.status(q(fm['Drafts']), '(MESSAGES)')[1][0]).group(1))
        try:
            flat = lambda v: [y for x in v for y in (flat(x) if isinstance(x, list) else [x])]
            m = re.search(rb'STORAGE (\d+) (\d+)', b' '.join(x for x in flat(c.getquotaroot('INBOX')[1]) if isinstance(x, bytes)))
            if m: res['quota'] = dict(used_kb=int(m.group(1)), limit_kb=int(m.group(2)))
        except Exception: pass
        return jsonify(res)
    finally:
        try: c.logout()
        except Exception: pass

@app.get('/api/messages')
@auth
def messages(s):
    ui = request.args.get('folder', 'Inbox')
    if ui == 'Snoozed': return jsonify(messages=[], total=0)
    if ui not in VIEWS: raise ValueError
    c = imap_open(s['user'], s['pw'])
    try:
        mb = mailbox_for(c, s, ui)
        if not mb: return jsonify(messages=[], total=0)
        msgs, total = list_messages(c, mb, VIEWS[ui][1], ui in ('Sent', 'Drafts'))
        return jsonify(messages=msgs, total=total)
    finally:
        try: c.logout()
        except Exception: pass

def fetch_full(c, s, ui, uid):
    mb = mailbox_for(c, s, ui)
    c.select(q(mb))
    data = c.uid('FETCH', str(int(uid)), '(BODY.PEEK[])')[1]
    raw = next((p[1] for p in data if isinstance(p, tuple)), None)
    if raw is None: raise KeyError
    return BytesParser(policy=policy.default).parsebytes(raw)

@app.get('/api/message')
@auth
def message(s):
    ui, uid = request.args['folder'], request.args['uid']
    if ui not in VIEWS: raise ValueError
    c = imap_open(s['user'], s['pw'])
    try:
        msg = fetch_full(c, s, ui, uid)
        c.uid('STORE', str(int(uid)), '+FLAGS', '(\\Seen)')
        body = msg.get_body(preferencelist=('html', 'plain'))
        d = dict(html=None, text='', message_id=str(msg['message-id'] or ''), references=str(msg['references'] or ''),
                 reply_to=email.utils.parseaddr(str(msg['reply-to'] or msg['from'] or ''))[1],
                 to=str(msg['to'] or ''), cc=str(msg['cc'] or ''), subject=str(msg['subject'] or ''),
                 attachments=[dict(idx=i, name=p.get_filename() or 'attachment', type=p.get_content_type(),
                                   size=len(p.get_payload(decode=True) or b''))
                              for i, p in enumerate(msg.iter_attachments())])
        if body is not None:
            content = body.get_content()
            if body.get_content_type() == 'text/html': d['html'], d['text'] = content, re.sub(r'\s+', ' ', strip_tags(content)).strip()
            else: d['text'] = content
        return jsonify(d)
    finally:
        try: c.logout()
        except Exception: pass

@app.get('/api/attachment')
@auth
def attachment(s):
    ui, uid, idx = request.args['folder'], request.args['uid'], int(request.args['idx'])
    if ui not in VIEWS: raise ValueError
    c = imap_open(s['user'], s['pw'])
    try:
        part = list(fetch_full(c, s, ui, uid).iter_attachments())[idx]
        payload = part.get_payload(decode=True) or b''
        name = (part.get_filename() or 'attachment').replace('"', '').replace('\r', '').replace('\n', '')
        return Response(payload, mimetype='application/octet-stream',
                        headers={'Content-Disposition': 'attachment; filename="%s"' % name})
    except IndexError: raise KeyError
    finally:
        try: c.logout()
        except Exception: pass

@app.post('/api/flags')
@auth
def flags(s):
    d = request.get_json()
    op = {'seen': '+FLAGS', 'unseen': '-FLAGS', 'star': '+FLAGS', 'unstar': '-FLAGS'}[d['op']]
    flag = '(\\Seen)' if d['op'] in ('seen', 'unseen') else '(\\Flagged)'
    if d['folder'] not in VIEWS: raise ValueError
    c = imap_open(s['user'], s['pw'])
    try:
        c.select(q(mailbox_for(c, s, d['folder'])))
        c.uid('STORE', uid_list(d['uids']), op, flag)
        return jsonify(ok=True)
    finally:
        try: c.logout()
        except Exception: pass

@app.post('/api/move')
@auth
def move(s):
    d = request.get_json()
    if d['folder'] not in VIEWS or d['to'] not in DEFAULT_NAME and d['to'] != 'Inbox': raise ValueError
    c = imap_open(s['user'], s['pw'])
    try:
        src = mailbox_for(c, s, d['folder']); dst = 'INBOX' if d['to'] == 'Inbox' else mailbox_for(c, s, d['to'], create=True)
        move_msgs(c, src, dst, uid_list(d['uids']))
        return jsonify(ok=True)
    finally:
        try: c.logout()
        except Exception: pass

@app.post('/api/delete')
@auth
def delete(s):
    d = request.get_json()
    if d['folder'] not in VIEWS: raise ValueError
    c = imap_open(s['user'], s['pw'])
    try:
        src, uids = mailbox_for(c, s, d['folder']), uid_list(d['uids'])
        if d['folder'] == 'Trash':                       # already in Trash -> permanent
            c.select(q(src)); c.uid('STORE', uids, '+FLAGS', '(\\Deleted)'); c.expunge()
        else:
            move_msgs(c, src, mailbox_for(c, s, 'Trash', create=True), uids)
        return jsonify(ok=True)
    finally:
        try: c.logout()
        except Exception: pass

def addrs(v):
    out = [a for _, a in email.utils.getaddresses([v]) if a]
    if not out or len(out) > 50 or any(not re.fullmatch(r'[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+', a) for a in out): raise ValueError
    return out

@app.post('/api/send')
@auth
def send(s):
    d = request.get_json()
    to = addrs(str(d['to']).replace(';', ','))
    m = EmailMessage()
    m['From'], m['To'] = s['user'], ', '.join(to)
    m['Subject'] = str(d.get('subject') or '(no subject)')[:300]
    m['Date'] = email.utils.formatdate(localtime=True)
    m['Message-ID'] = email.utils.make_msgid(domain=s['user'].split('@')[1])
    irt = str(d.get('in_reply_to') or '').strip()
    if re.fullmatch(r'<[^<>\s]+>', irt):
        m['In-Reply-To'] = irt
        refs = [r for r in str(d.get('references') or '').split() if re.fullmatch(r'<[^<>\s]+>', r)][-10:]
        m['References'] = ' '.join(refs + [irt])
    body = str(d.get('body') or '')
    if len(body) > 1_000_000: raise ValueError
    m.set_content(body)
    h, p, sec = CFG['SMTP_HOST'], CFG['SMTP_PORT'], CFG['SMTP_SECURITY']
    smtp = smtplib.SMTP_SSL(h, p, context=tls_ctx(), timeout=30) if sec == 'ssl' else smtplib.SMTP(h, p, timeout=30)
    try:
        smtp.ehlo()
        if sec == 'starttls': smtp.starttls(context=tls_ctx()); smtp.ehlo()
        if smtp.has_extn('auth'):
            try: smtp.login(s['user'], s['pw'])
            except smtplib.SMTPAuthenticationError: raise AuthFailed()
        smtp.send_message(m)
    finally:
        try: smtp.quit()
        except Exception: pass
    if CFG['SAVE_SENT']:
        c = imap_open(s['user'], s['pw'])
        try: c.append(q(mailbox_for(c, s, 'Sent', create=True)), '(\\Seen)', imaplib.Time2Internaldate(time.time()), m.as_bytes())
        except Exception as e: app.logger.warning('could not save to Sent: %r', e)
        finally:
            try: c.logout()
            except Exception: pass
    return jsonify(ok=True)

@app.errorhandler(404)
def nf(e): return err('Not found', 404)

@app.errorhandler(413)
def big(e): return err('Request too large', 413)

if __name__ == '__main__':
    app.run(host=E('HOST', '127.0.0.1'), port=int(E('PORT', '8000')), debug=False)
