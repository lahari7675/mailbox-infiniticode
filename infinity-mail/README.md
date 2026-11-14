# infiniti Mail (web UI + Python backend)

```
Browser -> infiniti Mail UI (frontend/) -> Flask API (backend/app.py) -> IMAP + SMTP of your mail server
```
The backend stores no mail and no passwords on disk. Users sign in with their real mailbox address and
password, the API checks them against IMAP, and every action (read, star, delete, send) happens on the mail server.

## 1. Try it now (no mail server needed)
```bash
cd backend
pip install -r requirements.txt
python dev_mail_server.py &          # fake IMAP/SMTP with demo data (never use in production)
IMAP_SECURITY=none IMAP_HOST=127.0.0.1 IMAP_PORT=1143 SMTP_SECURITY=none SMTP_HOST=127.0.0.1 \
SMTP_PORT=1025 COOKIE_SECURE=0 python app.py
```
Open http://127.0.0.1:8000 and sign in as `demo@infiniticodetech.com` / `demo`.

## 2. Real deployment
**a) Mail server first.** The UI needs a real server to talk to. Install Mailcow, Mailu or iRedMail (Docker, Ubuntu 22.04/24.04),
create the mailboxes, and make sure these are in place for infiniticodetech.com: A record for `mail.`, SPF, DKIM, DMARC, PTR (reverse DNS),
a TLS certificate, and outbound port 25 open at your host. Keep MX on Zoho until section 4.

**b) Run the API** (on the same server, or one that can reach IMAP 993 and SMTP 587):
```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
cp .env.example .env && nano .env
set -a; . ./.env; set +a
gunicorn -w 1 --threads 8 -b 127.0.0.1:8000 app:app
```
Use **one worker** (`-w 1`): sign-in sessions live in memory, so a restart signs everyone out. That is fine for a team.
For more than one worker, move sessions to Redis.

**c) HTTPS reverse proxy** (the session cookie is Secure, so HTTPS is required). nginx example for `webmail.infiniticodetech.com`:
```nginx
server {
  listen 443 ssl http2;  server_name webmail.infiniticodetech.com;
  ssl_certificate     /etc/letsencrypt/live/webmail.infiniticodetech.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/webmail.infiniticodetech.com/privkey.pem;
  client_max_body_size 3m;
  location / { proxy_pass http://127.0.0.1:8000; proxy_set_header Host $host;
               proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto https; }
}
```
DNS: `A webmail.infiniticodetech.com -> server IP`. If Mailcow already owns port 443 on that server, host the UI on another IP or server.

**d) systemd** (`/etc/systemd/system/infiniti-mail.service`):
```ini
[Service]
WorkingDirectory=/opt/infiniti-mail/backend
EnvironmentFile=/opt/infiniti-mail/backend/.env
ExecStart=/opt/infiniti-mail/backend/.venv/bin/gunicorn -w 1 --threads 8 -b 127.0.0.1:8000 app:app
Restart=always
User=www-data
[Install]
WantedBy=multi-user.target
```

## 3. Test before touching MX
Sign in as a new mailbox, send to Gmail and to yourself, reply, and check the message headers for SPF, DKIM and DMARC = pass.

## 4. Migrate from Zoho, then cut over
1. Per user, enable IMAP in Zoho (use an app password if MFA is on). Host is `imap.zoho.com`; accounts on the Indian data centre use `imap.zoho.in`.
2. Copy mail: `imapsync --host1 imap.zoho.in --user1 U --password1 '***' --ssl1 --host2 mail.infiniticodetech.com --user2 U --password2 '***' --ssl2`
3. Lower MX TTL to 300 a day before, switch MX to `mail.infiniticodetech.com`, update SPF (remove the Zoho include), then run imapsync once more for new mail.
4. Keep Zoho active for 1-2 weeks as a fallback.

## What works and what is still demo
Works with real mail: sign-in/out, Inbox, Sent, Drafts, Spam, Trash and Archive (auto-detected, created if missing), reading (HTML mail is sandboxed,
remote images blocked), attachment download, star, mark read, archive, delete (to Trash, permanent from Trash), reply, forward, send (copy saved to Sent),
unread and storage counters.

Still demo data: the Apps dock (Events, Contacts, Meetings, Calendar, Tasks), Labels, Snoozed.
Not built yet: compose attachments, Cc/Bcc, saving drafts, search across the whole mailbox (search filters the 150 newest loaded messages),
live push (the list refreshes every 2 minutes). Contacts and Calendar are natural next steps via CardDAV/CalDAV (Mailcow includes SOGo).

## Security notes
Passwords live only in server memory for the session. Login is rate-limited (8 failures per 10 minutes per IP). Cookies are HttpOnly and SameSite=Strict,
state-changing calls require JSON (CSRF guard), a strict CSP is sent, and email HTML is rendered in a script-less sandboxed iframe.
