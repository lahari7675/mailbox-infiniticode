"""Tiny in-memory IMAP + SMTP server for trying the UI WITHOUT a real mail server. NOT for production.
  python dev_mail_server.py        ->  IMAP :1143, SMTP :1025, login demo@infiniticodetech.com / demo
Run the app with:  IMAP_SECURITY=none IMAP_HOST=127.0.0.1 IMAP_PORT=1143 SMTP_SECURITY=none SMTP_HOST=127.0.0.1 SMTP_PORT=1025 COOKIE_SECURE=0 python app.py"""
import re, socketserver, threading, time, email.utils
from email.message import EmailMessage

USERS = {'demo@infiniticodetech.com': 'demo'}
STORE = {}   # user -> {folder: [ {uid, flags:set, date, raw} ]}
LOCK = threading.RLock()

def mk(frm, to, subj, body, ago=0):
    m = EmailMessage(); m['From'], m['To'], m['Subject'] = frm, to, subj
    m['Date'] = email.utils.formatdate(time.time() - ago); m['Message-ID'] = email.utils.make_msgid(domain='dev.local'); m.set_content(body)
    return m.as_bytes()

def box(user):
    with LOCK:
        if user not in STORE:
            f = {n: [] for n in ('INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive')}
            for i, (fr, su, bo, ago) in enumerate([
                ('Infiniti Team <hello@infiniticodetech.com>', 'Welcome to Infiniti Mail', 'Your mailbox is now live.\n\nBest regards,\nInfiniti Code Technologies', 60),
                ('HR Department <hr@infiniticodetech.com>', 'Onboarding documents', 'Please complete the attached onboarding documents.', 90000),
                ('Client Support <support@infiniticodetech.com>', 'Re: Project inquiry', 'Thank you for reaching out. We will get back to you shortly.', 4000000)], 1):
                f['INBOX'].append(dict(uid=i, flags=set() if i == 1 else {'\\Seen'}, date=time.time() - ago, raw=mk(fr, user, su, bo, ago)))
            STORE[user] = f
        return STORE[user]

def add(user, folder, raw, flags=()):
    b = box(user)
    with LOCK:
        b.setdefault(folder, []).append(dict(uid=max([x['uid'] for x in b[folder]] or [0]) + 1, flags=set(flags), date=time.time(), raw=raw))

def uidset(spec, items):
    out = set()
    for part in spec.split(','):
        a, _, z = part.partition(':')
        lo, hi = int(a), (int(z) if z and z != '*' else (10**9 if z else int(a)))
        out |= {x['uid'] for x in items if lo <= x['uid'] <= hi}
    return out

class IMAP(socketserver.StreamRequestHandler):
    def w(self, s): self.wfile.write(s if isinstance(s, bytes) else s.encode()); self.wfile.flush()
    def handle(self):
        self.user = self.sel = None; self.w('* OK dev IMAP ready\r\n')
        for line in self.rfile:
            line = line.decode('utf-8', 'replace').rstrip('\r\n')
            if not line: continue
            tag, _, rest = line.partition(' '); cmd, _, arg = rest.partition(' ')
            try:
                if not self.cmd(tag, cmd.upper(), arg): return
            except Exception as e: self.w(f'{tag} BAD {e}\r\n')
    def cmd(self, tag, cmd, arg):
        ok = lambda t='completed': self.w(f'{tag} OK {t}\r\n')
        if cmd == 'CAPABILITY': self.w('* CAPABILITY IMAP4rev1\r\n'); ok()
        elif cmd == 'LOGIN':
            u, p = [x.strip('"') for x in re.findall(r'"[^"]*"|\S+', arg)[:2]]
            if USERS.get(u) == p: self.user = u; box(u); ok('logged in')
            else: self.w(f'{tag} NO [AUTHENTICATIONFAILED] bad credentials\r\n')
        elif cmd == 'LOGOUT': self.w('* BYE\r\n'); ok(); return False
        elif not self.user: self.w(f'{tag} NO login first\r\n')
        elif cmd == 'LIST':
            sp = {'Sent': '\\Sent', 'Drafts': '\\Drafts', 'Trash': '\\Trash', 'Spam': '\\Junk', 'Archive': '\\Archive'}
            for n in box(self.user): self.w(f'* LIST (\\HasNoChildren {sp.get(n, "")}) "/" "{n}"\r\n')
            ok()
        elif cmd in ('SELECT', 'EXAMINE'):
            self.sel = arg.strip('"'); n = len(box(self.user).get(self.sel, [])); self.w(f'* {n} EXISTS\r\n'); ok('[READ-WRITE] done')
        elif cmd == 'STATUS':
            name = re.match(r'"([^"]+)"|(\S+)', arg).group(1) or re.match(r'"([^"]+)"|(\S+)', arg).group(2); it = box(self.user).get(name, [])
            self.w(f'* STATUS "{name}" (MESSAGES {len(it)} UNSEEN {sum("\\Seen" not in x["flags"] for x in it)})\r\n'); ok()
        elif cmd == 'GETQUOTAROOT': self.w('* QUOTAROOT INBOX ""\r\n* QUOTA "" (STORAGE 1843 10240)\r\n'); ok()
        elif cmd in ('CREATE', 'SUBSCRIBE'): box(self.user).setdefault(arg.strip('"'), []); ok()
        elif cmd == 'EXPUNGE':
            b = box(self.user)
            with LOCK: b[self.sel] = [x for x in b[self.sel] if '\\Deleted' not in x['flags']]
            ok()
        elif cmd == 'APPEND':
            m = re.match(r'"?([^"]+)"? (?:\(([^)]*)\) )?(?:"[^"]*" )?\{(\d+)\}', arg)
            self.w('+ go\r\n'); raw = self.rfile.read(int(m.group(3))); self.rfile.readline()
            add(self.user, m.group(1), raw, (m.group(2) or '').split()); ok('APPEND completed')
        elif cmd == 'UID':
            sub, _, a2 = arg.partition(' '); sub = sub.upper(); items = box(self.user).get(self.sel, [])
            if sub == 'SEARCH':
                crit = a2.strip().upper(); ids = [x['uid'] for x in items if crit == 'ALL' or ('FLAGGED' in crit and '\\Flagged' in x['flags'])]
                self.w('* SEARCH ' + ' '.join(map(str, ids)) + '\r\n'); ok()
            elif sub == 'FETCH':
                spec, _, what = a2.partition(' '); ids = uidset(spec, items)
                for n, x in enumerate(items, 1):
                    if x['uid'] not in ids: continue
                    raw = x['raw']; m = re.search(r'<0\.(\d+)>', what)
                    if m: raw = raw[:int(m.group(1))]
                    meta = f'UID {x["uid"]} FLAGS ({" ".join(sorted(x["flags"]))})'
                    if 'INTERNALDATE' in what: meta += ' INTERNALDATE "' + time.strftime('%d-%b-%Y %H:%M:%S +0000', time.gmtime(x['date'])) + '"'
                    self.w(f'* {n} FETCH ({meta} BODY[]{"<0>" if m else ""} {{{len(raw)}}}\r\n'.encode() + raw + b')\r\n')
                ok()
            elif sub == 'STORE':
                spec, op, fl = a2.split(' ', 2); fl = set(re.findall(r'\\\w+', fl))
                for x in items:
                    if x['uid'] in uidset(spec, items): x['flags'] |= fl if op.startswith('+') else set(); x['flags'] -= fl if op.startswith('-') else set()
                ok()
            elif sub == 'COPY':
                spec, dst = a2.split(' ', 1)
                for x in [x for x in items if x['uid'] in uidset(spec, items)]: add(self.user, dst.strip('"'), x['raw'], x['flags'] - {'\\Deleted'})
                ok()
            else: self.w(f'{tag} BAD unsupported\r\n')
        else: self.w(f'{tag} BAD unsupported\r\n')
        return True

class SMTP(socketserver.StreamRequestHandler):
    def w(self, s): self.wfile.write(s.encode()); self.wfile.flush()
    def handle(self):
        self.w('220 dev SMTP\r\n'); to = []
        for line in self.rfile:
            l = line.decode().strip(); u = l.upper()
            if u.startswith(('EHLO', 'HELO')): self.w('250 dev\r\n')
            elif u.startswith('MAIL FROM'): to = []; self.w('250 ok\r\n')
            elif u.startswith('RCPT TO'): to.append(re.search(r'<([^>]+)>', l).group(1).lower()); self.w('250 ok\r\n')
            elif u == 'DATA':
                self.w('354 go\r\n'); buf = []
                for d in self.rfile:
                    if d == b'.\r\n': break
                    buf.append(d[1:] if d.startswith(b'..') else d)
                raw = b''.join(buf)
                for r in to:
                    if r in USERS: add(r, 'INBOX', raw)
                print('SMTP accepted mail for', to); self.w('250 queued\r\n')
            elif u == 'QUIT': self.w('221 bye\r\n'); return
            else: self.w('250 ok\r\n')

class Srv(socketserver.ThreadingTCPServer): allow_reuse_address = True; daemon_threads = True

if __name__ == '__main__':
    for h, port in ((IMAP, 1143), (SMTP, 1025)): threading.Thread(target=Srv(('127.0.0.1', port), h).serve_forever, daemon=True).start()
    print('Dev mail server: IMAP 127.0.0.1:1143, SMTP 127.0.0.1:1025  (demo@infiniticodetech.com / demo)')
    while True: time.sleep(3600)
