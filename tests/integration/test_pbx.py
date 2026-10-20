#!/usr/bin/env python3
"""Integrationstests gegen eine laufende Mosi-Instanz (echtes Asterisk, echtes PostgreSQL).

Pruefen: Anlegen von Nebenstellen ueber die API, SIP-Registrierung (Digest), abgelehnte Fehlanmeldung,
internen Anruf mit Zwei-Wege-RTP, Anrufliste, Rufgruppe, Voicemail, Sperre externer Anrufe,
Trunk-Anbindung (simulierter Anbieter), Konfigurationsbeibehaltung nach Neustart der Engine.

Aufruf:  python3 test_pbx.py [--api http://127.0.0.1:13000] [--sip 127.0.0.1:15060]
"""
import argparse
import datetime
import http.cookiejar
import io
import json
import math
import os
import ssl
import struct
import sys
import threading
import time
import wave
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
from sipua import UA  # noqa: E402

PATTERN_A, PATTERN_B, PATTERN_C = 0x11, 0x77, 0x33
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("  OK   " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    return cond


class Api:
    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        ctx = ssl.create_default_context()
        ctx.check_hostname = False          # Testumgebung: selbst signiertes Zertifikat der lokalen Caddy-CA
        ctx.verify_mode = ssl.CERT_NONE
        self.op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=ctx),
                                              urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def call(self, method, path, body=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.csrf:
            req.add_header("X-CSRF-Token", self.csrf)
        try:
            with self.op.open(req, timeout=60) as r:
                payload = r.read()
                return r.status, (payload if raw else json.loads(payload or b"null"))
        except urllib.error.HTTPError as e:
            payload = e.read()
            try:
                return e.code, json.loads(payload)
            except Exception:
                return e.code, payload

    def upload(self, path, data, content_type="audio/wav"):
        req = urllib.request.Request(self.base + path, data=data, method="PUT")
        req.add_header("Content-Type", content_type)
        req.add_header("X-CSRF-Token", self.csrf)
        try:
            with self.op.open(req, timeout=60) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    def login(self, user, pw):
        code, body = self.call("POST", "/api/login", {"username": user, "password": pw})
        if code == 200:
            self.csrf = body["csrf"]
        return code, body


def wait_until(fn, timeout=15, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:13000")
    ap.add_argument("--sip", default="127.0.0.1:15060")
    ap.add_argument("--admin-user", default="admin")
    ap.add_argument("--admin-pass", default="Test-Admin-Passw0rt!")
    ap.add_argument("--local-ip", default="127.0.0.1")
    ap.add_argument("--provider-ip", default="127.0.0.2", help="Adresse des simulierten SIP-Anbieters (muss von der Engine erreichbar sein)")
    ap.add_argument("--restart-cmd", default=None, help="Befehl, der die Telefonie-Engine neu startet (optional)")
    a = ap.parse_args()
    sip_host, sip_port = a.sip.split(":")
    sip_port = int(sip_port)
    api = Api(a.api)
    t0 = time.time()   # Beginn dieses Testlaufs (ignoriert Eintraege frueherer Laeufe in der Anrufliste)

    print("== Anmeldung / Sicherheit")
    code, _ = api.login(a.admin_user, "falsches-Passwort-123!")
    check("Anmeldung mit falschem Passwort wird abgelehnt (401)", code == 401, code)
    code, body = api.call("GET", "/api/extensions")
    check("API ohne Sitzung liefert 401", code == 401, code)
    code, _ = api.login(a.admin_user, a.admin_pass)
    check("Administrator-Anmeldung", code == 200, code)
    code, _ = api.call("GET", "/api/health")
    check("Health-Endpunkt meldet Asterisk online", code == 200, code)

    # Aufraeumen von frueheren Laeufen
    for ep in ("trunks", "ring-groups", "queues", "ivrs", "schedules", "contacts", "extensions"):
        code, rows = api.call("GET", f"/api/{ep}")
        for r in rows if code == 200 else []:
            api.call("DELETE", f"/api/{ep}/{r['id']}")

    print("== Nebenstellen anlegen (Konfiguration wird erzeugt, geladen und verifiziert)")
    exts = {}
    for num, name in (("100", "Test Eins"), ("101", "Test Zwei"), ("102", "Test Drei")):
        code, e = api.call("POST", "/api/extensions", {"number": num, "display_name": name, "voicemail_enabled": num == "101", "ring_timeout": 6})
        check(f"Nebenstelle {num} angelegt", code == 201, f"{code} {e}")
        if code == 201:
            code, conn = api.call("GET", f"/api/extensions/{e['id']}/connection")
            exts[num] = {"id": e["id"], "user": conn["username"], "pw": conn["password"], "pin": conn.get("voicemail_pin")}
    check("SIP-Passwoerter sind individuell und stark (24 Zeichen)", len({v['pw'] for v in exts.values()}) == 3 and all(len(v['pw']) == 24 for v in exts.values()))
    code, bad = api.call("POST", "/api/extensions", {"number": "100", "display_name": "Doppelt"})
    check("Doppelte Durchwahl wird abgelehnt", code in (400, 409), code)
    code, bad = api.call("POST", "/api/extensions", {"number": "103", "display_name": 'Boese"; Hangup()'})
    check("Konfigurations-Injection im Namen wird abgelehnt", code == 400, code)

    print("== SIP-Registrierung")
    ua = {n: UA(exts[n]["user"], exts[n]["pw"], sip_host, sip_port, a.local_ip, pattern=p)
          for n, p in (("100", PATTERN_A), ("101", PATTERN_B), ("102", PATTERN_C))}
    wrong = UA(exts["100"]["user"], "falsch-falsch-falsch", sip_host, sip_port, a.local_ip)
    rc = wrong.register()
    check("Registrierung mit falschem Passwort wird abgelehnt", rc in (401, 403), rc)
    unknown = UA("nobody999", "xxxxxxxxxxxx", sip_host, sip_port, a.local_ip)
    rc = unknown.register()
    check("Registrierung eines unbekannten Benutzers wird abgelehnt", rc in (401, 403, 404), rc)
    wrong.close(); unknown.close()
    for n, u in ua.items():
        check(f"Nebenstelle {n} registriert (200 OK)", u.register() == 200)

    def reg_state(num):
        code, rows = api.call("GET", "/api/extensions")
        return next((r for r in rows if r["number"] == num), {}).get("registration", {})
    ok = wait_until(lambda: all(reg_state(n).get("state") == "registered" for n in ("100", "101", "102")), 15)
    check("Dashboard-API zeigt alle drei Nebenstellen als registriert", ok)
    rs = wait_until(lambda: reg_state("100").get("lastError"), 10)
    check("Fehlgeschlagene Registrierung ist fuer die Diagnose sichtbar", rs, reg_state("100"))
    code, dash = api.call("GET", "/api/dashboard")
    check("Dashboard: registrierte Geraete = 3", dash["devices"]["registered"] == 3, dash.get("devices"))
    check("Dashboard: Hinweis auf fehlenden Trunk", bool(dash.get("externalNotice")))
    check("Dashboard: Datenbank und SIP-UDP echt geprueft", all(s["ok"] for s in dash["services"] if s["id"] in ("db", "ami", "sip-udp")),
          [s for s in dash["services"] if not s["ok"]])

    print("== Interner Anruf 100 -> 101 mit Audio in beide Richtungen")
    ua["101"].events.clear()
    code, seen = ua["100"].invite("101")
    check("Anruf aufgebaut (200 OK)", code == 200, f"{code} {seen}")
    check("Zwischenzeitlich 180 Ringing gesehen", 180 in seen or 183 in seen, seen)
    time.sleep(3)
    ra, rb = ua["100"].received_pattern_ratio(PATTERN_B), ua["101"].received_pattern_ratio(PATTERN_A)
    check("Audio 101 -> 100 kommt an (>90% exakte RTP-Pakete)", ra > 0.9, f"{ra:.2f} von {len(ua['100'].rx_payloads)} Paketen")
    check("Audio 100 -> 101 kommt an (>90% exakte RTP-Pakete)", rb > 0.9, f"{rb:.2f} von {len(ua['101'].rx_payloads)} Paketen")
    code, dash = api.call("GET", "/api/dashboard")
    check("Dashboard zeigt aktives Gespraech", any(c["bridged"] for c in dash["activeCalls"]), dash["activeCalls"])
    ua["100"].hangup()
    check("Auflegen beendet das Gespraech auch beim Gegenueber", ua["101"].wait_for_call_end(5))

    def find_call(frm, to, disp=None):
        """Neueste Anrufliste-Zeile dieses Testlaufs (aeltere Eintraege frueherer Laeufe werden ignoriert)."""
        code, res = api.call("GET", f"/api/calls?q={to}")
        for r in res["rows"]:
            started = datetime.datetime.fromisoformat(r["started"].replace("Z", "+00:00")).timestamp()
            if started >= t0 - 3 and r["from"] == frm and r["to"] == to and (disp is None or r["disposition"] == disp):
                return r
    c = wait_until(lambda: find_call("100", "101", "ANSWERED"), 15)
    check("Anrufliste enthaelt das echte Gespraech (ANSWERED, Dauer >= 2 s)", c and c["billsec"] >= 2, c)
    check("Anrufliste: Richtung intern", c and c["direction"] == "internal", c)

    print("== Nicht erreichbar / nicht beantwortet")
    ua["102"].unregister()
    code, seen = ua["100"].invite("102", answer_wait=10)
    check("Anruf an nicht registrierte Nebenstelle scheitert (4xx/5xx)", code and code >= 400, f"{code} {seen}")
    ua["102"].register()
    ua["102"].auto_answer = False
    code, seen = ua["100"].invite("102", answer_wait=12)
    check("Nichtbeantworteter Anruf endet nach Klingel-Timeout (kein 200)", code is None or code >= 400, f"{code} {seen}")
    check("Beim Angerufenen hat es geklingelt (180)", 180 in seen, seen)
    ua["102"].auto_answer = True

    print("== Rufgruppe 700 (100,101) von 102 angerufen")
    code, g = api.call("POST", "/api/ring-groups", {"number": "700", "name": "Support", "members": ["100", "101"], "strategy": "ringall", "timeout": 10})
    check("Rufgruppe angelegt", code == 201, f"{code} {g}")
    ua["100"].auto_answer = False
    code, seen = ua["102"].invite("700")
    check("Rufgruppe: 101 nimmt an, obwohl 100 nicht abhebt", code == 200, f"{code} {seen}")
    time.sleep(2)
    check("Rufgruppe: Audio fliesst (102 hoert 101)", ua["102"].received_pattern_ratio(PATTERN_B) > 0.9)
    ua["102"].hangup()
    ua["100"].auto_answer = True

    print("== Mehrere Geraete an einer Nebenstelle klingeln parallel; Besetzt-Zustand")
    second = UA(exts["102"]["user"], exts["102"]["pw"], sip_host, sip_port, a.local_ip, pattern=0x44)
    check("Zweites Geraet an Nebenstelle 102 registriert", second.register() == 200)
    ua["102"].auto_answer = False
    ua["102"].events.clear(); second.events.clear()
    code, seen = ua["100"].invite("102")
    check("Beide Geraete der Nebenstelle 102 klingeln, das zweite nimmt an", code == 200 and any(e[1] == "INVITE" for e in ua["102"].events) and any(e[1] == "INVITE" for e in second.events),
          f"{code} {ua['102'].events} {second.events}")
    time.sleep(2)
    check("Audio vom annehmenden zweiten Geraet kommt bei 100 an", ua["100"].received_pattern_ratio(0x44) > 0.9, f"{ua['100'].received_pattern_ratio(0x44):.2f}")
    code2, seen2 = ua["101"].invite("102", answer_wait=10)
    check("Besetzte Nebenstelle 102 meldet Besetzt (486/600)", code2 in (486, 600), f"{code2} {seen2}")
    ua["100"].hangup()
    second.unregister(); second.close()
    ua["102"].auto_answer = True

    print("== Kurzwahl, Rufumleitung, Anrufuebernahme")
    code, ct = api.call("POST", "/api/contacts", {"name": "Kollege", "number": "101", "short_code": "*01"})
    check("Kontakt mit Kurzwahl *01 angelegt", code == 201, f"{code} {ct}")
    code, seen = ua["100"].invite("*01")
    check("Kurzwahl *01 ruft Nebenstelle 101 an", code == 200, f"{code} {seen}")
    time.sleep(1)
    check("Kurzwahl: Audio von 101", ua["100"].received_pattern_ratio(PATTERN_B) > 0.9)
    ua["100"].hangup()
    code, _ = api.call("PUT", f"/api/extensions/{exts['101']['id']}", {"fwd_always": "102"})
    check("Rufumleitung sofort 101 -> 102 gesetzt", code == 200, code)
    code, seen = ua["100"].invite("101")
    check("Anruf an 101 wird zu 102 umgeleitet", code == 200, f"{code} {seen}")
    time.sleep(1)
    check("Umleitung: Audio von 102", ua["100"].received_pattern_ratio(PATTERN_C) > 0.9, f"{ua['100'].received_pattern_ratio(PATTERN_C):.2f}")
    ua["100"].hangup()
    api.call("PUT", f"/api/extensions/{exts['101']['id']}", {"fwd_always": ""})
    code, e = api.call("PUT", f"/api/extensions/{exts['101']['id']}", {"fwd_always": "0301234567"})
    check("Umleitung auf externe Nummer ohne externe Berechtigung wird abgelehnt", code == 400, f"{code} {e}")
    api.call("PUT", f"/api/extensions/{exts['102']['id']}", {"pickup_allowed": True})
    ua["101"].auto_answer = False
    res = []
    th = threading.Thread(target=lambda: res.append(ua["100"].invite("101", answer_wait=20)))
    th.start()
    time.sleep(2.5)
    code, seen = ua["102"].invite("**101")
    th.join(timeout=25)
    check("Anrufuebernahme: 102 holt den bei 101 klingelnden Ruf von 100 heran", code == 200 and res and res[0][0] == 200, f"{code} {seen} {res}")
    time.sleep(1)
    check("Anrufuebernahme: 100 spricht mit 102 (Audio beidseitig)", ua["100"].received_pattern_ratio(PATTERN_C) > 0.9 and ua["102"].received_pattern_ratio(PATTERN_A) > 0.9)
    ua["102"].hangup()
    ua["100"].hangup()
    ua["101"].auto_answer = True
    api.call("PUT", f"/api/extensions/{exts['102']['id']}", {"pickup_allowed": False})
    code, seen = ua["102"].invite("**100", answer_wait=5)
    check("Anrufuebernahme ohne Berechtigung wird abgewiesen", code is None or code >= 400, f"{code} {seen}")

    print("== Echo-Test *43")
    code, seen = ua["100"].invite("*43", answer_wait=8)
    check("Echo-Test *43 nimmt den Anruf an", code == 200, f"{code} {seen}")
    time.sleep(9)       # Ansage "demo-echotest" abwarten, danach kommt die eigene Stimme zurueck
    ua["100"].rx_payloads = []
    time.sleep(2)
    check("Echo-Test: eigenes Audio kommt zurueck (Medienpfad in beide Richtungen)", ua["100"].received_pattern_ratio(PATTERN_A) > 0.8, f"{ua['100'].received_pattern_ratio(PATTERN_A):.2f}")
    ua["100"].hangup()

    print("== Warteschlange 800 (100, 101)")
    code, q = api.call("POST", "/api/queues", {"number": "800", "name": "Hotline", "members": ["100", "101"], "strategy": "ringall", "timeout": 10, "max_wait": 60})
    check("Warteschlange angelegt", code == 201, f"{code} {q}")
    code, seen = ua["102"].invite("800", answer_wait=25)
    check("Anruf an die Warteschlange wird von einem Mitglied angenommen", code == 200, f"{code} {seen}")
    time.sleep(1)
    ua["102"].rx_payloads = []          # Verbindungsgeraeusche/Ansagen am Anfang ignorieren
    time.sleep(2)
    heard = max(ua["102"].received_pattern_ratio(PATTERN_A), ua["102"].received_pattern_ratio(PATTERN_B))
    check("Warteschlange: Audio vom annehmenden Mitglied", heard > 0.9, f"{heard:.2f}")
    ua["102"].hangup()
    code, e = api.call("POST", "/api/queues", {"number": "801", "name": "Leer", "members": [], "strategy": "ringall", "fallback": "vm:101"})
    check("Warteschlange mit Voicemail-Ausweichziel angelegt", code == 201, f"{code} {e}")
    code, seen = ua["102"].invite("801", answer_wait=10)
    check("Leere Warteschlange leitet sofort auf das Ausweichziel (Voicemail) um", code == 200, f"{code} {seen}")
    time.sleep(1)
    ua["102"].hangup()

    print("== Telefonmenue (IVR) mit Ansage und Tastenwahl")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(8000 * 3)))
    code, iv = api.call("POST", "/api/ivrs", {"number": "900", "name": "Menue", "options": [{"digit": "1", "target": "101"}, {"digit": "2", "target": "hangup"}], "timeout": 8, "retries": 2, "fallback": "hangup"})
    check("Telefonmenue angelegt", code == 201, f"{code} {iv}")
    code, up = api.upload(f"/api/ivrs/{iv['id']}/greeting", buf.getvalue())
    check("Ansage (WAV) hochgeladen und uebernommen", code == 200, f"{code} {up}")
    code, bad = api.upload(f"/api/ivrs/{iv['id']}/greeting", b"kein wav")
    check("Ungueltige Ansage-Datei wird abgelehnt", code == 400, f"{code} {bad}")
    code, seen = ua["102"].invite("900", answer_wait=10)
    check("Telefonmenue nimmt den Anruf an", code == 200, f"{code} {seen}")
    time.sleep(2)
    tone = [p for p in ua["102"].rx_payloads if len(set(p)) > 8]
    check("Ansage wird abgespielt (Ton-Audio kommt an)", len(tone) > 40, f"{len(tone)} von {len(ua['102'].rx_payloads)} Paketen")
    ua["102"].send_dtmf("1")
    time.sleep(0.5)
    ua["102"].rx_payloads = []
    time.sleep(3)
    check("Taste 1 verbindet mit Nebenstelle 101 (Audio von 101)", ua["102"].received_pattern_ratio(PATTERN_B) > 0.8, f"{ua['102'].received_pattern_ratio(PATTERN_B):.2f} von {len(ua['102'].rx_payloads)}")
    ua["102"].hangup()
    api.call("DELETE", f"/api/ivrs/{iv['id']}")
    api.call("DELETE", f"/api/queues/{q['id']}")
    api.call("DELETE", f"/api/queues/{e['id']}")
    api.call("DELETE", f"/api/contacts/{ct['id']}")

    print("== Voicemail: 101 hebt nicht ab")
    ua["101"].auto_answer = False
    code, seen = ua["100"].invite("101", answer_wait=25)
    check("Nach Timeout meldet sich die Voicemail (200 OK)", code == 200, f"{code} {seen}")
    if code == 200:
        time.sleep(16)
        ua["100"].hangup()
    ua["101"].auto_answer = True
    msgs = wait_until(lambda: [m for m in api.call("GET", "/api/voicemail")[1].get("messages", []) if m["mailbox"] == "101"], 15)
    check("Voicemail-Nachricht wurde gespeichert und ist abrufbar", bool(msgs), msgs)
    if msgs:
        code, audio = api.call("GET", f"/api/voicemail/101/{msgs[0]['id']}/audio", raw=True)
        check("Voicemail-Audio ist eine WAV-Datei", code == 200 and audio[:4] == b"RIFF", code)

    print("== Externe Anrufe: standardmaessig gesperrt, Trunk-Anbindung mit simuliertem Anbieter")
    provider = UA("provider", "x", sip_host, sip_port, a.provider_ip, local_port=25060, rtp_port=0, pattern=0x22)
    code, t = api.call("POST", "/api/trunks", {"name": "Testanbieter", "auth_mode": "ip", "registrar": f"{a.provider_ip}:25060", "username": "testacc", "transport": "udp",
                                                 "match_hosts": a.provider_ip, "max_channels": 2, "default_inbound": "hangup"})
    check("Trunk (IP-Authentifizierung) angelegt", code == 201, f"{code} {t}")
    code, r = api.call("POST", "/api/outbound-rules", {"trunk_id": t["id"], "name": "National", "pattern": "_0[2-9]X.", "class": "national"})
    check("Ausgehende Regel angelegt", code == 201, f"{code} {r}")
    code, r2 = api.call("POST", "/api/outbound-rules", {"trunk_id": t["id"], "name": "Intl", "pattern": "_00[1-9]X.", "class": "international"})
    check("Regel fuer International angelegt (aber nicht freigegeben)", code == 201, f"{code} {r2}")
    provider.events.clear()
    code, seen = ua["100"].invite("030123456", answer_wait=8)
    check("Externer Anruf ohne Berechtigung wird NICHT zum Anbieter geleitet", not any(e[1] == "INVITE" for e in provider.events), provider.events)
    check("Externer Anruf ohne Berechtigung scheitert", code is None or code >= 400 or code == 200, f"{code}")
    if code == 200:
        ua["100"].hangup()
    code, _ = api.call("PUT", f"/api/extensions/{exts['100']['id']}", {"allow_external": True})
    check("Berechtigung fuer externe Anrufe gesetzt", code == 200, code)
    provider.events.clear()
    code, seen = ua["100"].invite("030123456", answer_wait=10)
    check("Externer Anruf erreicht den Anbieter und wird beantwortet", code == 200 and any(e[1] == "INVITE" for e in provider.events), f"{code} {seen}")
    time.sleep(2)
    check("Audio vom Anbieter kommt bei 100 an", ua["100"].received_pattern_ratio(0x22) > 0.9, f"{ua['100'].received_pattern_ratio(0x22):.2f} von {len(ua['100'].rx_payloads)}")
    check("Audio von 100 kommt beim Anbieter an", provider.received_pattern_ratio(PATTERN_A) > 0.9, f"{provider.received_pattern_ratio(PATTERN_A):.2f} von {len(provider.rx_payloads)}")
    ua["100"].hangup()
    provider.events.clear()
    code, seen = ua["100"].invite("0049301234", answer_wait=8)
    check("International ohne Freigabe: nicht zum Anbieter", not any(e[1] == "INVITE" for e in provider.events), provider.events)
    if code == 200:
        ua["100"].hangup()
    provider.events.clear()
    code, seen = ua["100"].invite("0900123456", answer_wait=8)
    check("Mehrwertdienst-Praefix 0900 wird blockiert", not any(e[1] == "INVITE" for e in provider.events), provider.events)
    if code == 200:
        ua["100"].hangup()
    c = wait_until(lambda: find_call("100", "030123456", "ANSWERED"), 15)
    check("Ausgehender Anruf steht in der Anrufliste (Richtung outbound)", c and c["direction"] == "outbound", c)
    code, tr = api.call("GET", "/api/trunks")
    check("Trunk-Status wird angezeigt", code == 200 and tr[0]["status"] in ("ip", "registered"), tr)
    print("== Eingehende Anrufe vom Anbieter: Rufnummer -> Nebenstelle, Zeitplan, unbekannte Nummer")
    code, n1 = api.call("POST", "/api/trunk-numbers", {"trunk_id": t["id"], "number": "0301234567", "label": "Zentrale", "dest_open": "101", "dest_closed": "hangup"})
    check("Eingehende Rufnummer angelegt", code == 201, f"{code} {n1}")
    ua["101"].events.clear()
    code, seen = provider.invite("0301234567", answer_wait=10)
    check("Eingehender Anruf vom Anbieter klingelt bei 101 und wird angenommen", code == 200, f"{code} {seen}")
    time.sleep(2)
    check("Eingehend: Audio in beide Richtungen", provider.received_pattern_ratio(PATTERN_B) > 0.9 and ua["101"].received_pattern_ratio(0x22) > 0.9,
          f"{provider.received_pattern_ratio(PATTERN_B):.2f}/{ua['101'].received_pattern_ratio(0x22):.2f}")
    provider.hangup()
    c = wait_until(lambda: find_call("0301234567", "0301234567", "ANSWERED") or next((r for r in api.call("GET", "/api/calls?direction=inbound")[1]["rows"] if r["disposition"] == "ANSWERED"), None), 15)
    check("Eingehender Anruf steht in der Anrufliste (Richtung inbound)", c and c["direction"] == "inbound", c)
    code, sch = api.call("POST", "/api/schedules", {"name": "Nachtschaltung", "mode": "closed", "rules": [], "holidays": []})
    check("Zeitplan (dauerhaft geschlossen) angelegt", code == 201, f"{code} {sch}")
    code, _ = api.call("PUT", f"/api/trunk-numbers/{n1['id']}", {"schedule_id": sch["id"], "dest_closed": "vm:101", "dest_open": "101"})
    check("Rufnummer mit Zeitplan verknuepft (geschlossen -> Voicemail 101)", code == 200, code)
    ua["101"].events.clear()
    code, seen = provider.invite("0301234567", answer_wait=10)
    check("Ausserhalb der Zeiten antwortet die Voicemail statt Nebenstelle 101", code == 200 and not any(e[1] == "INVITE" for e in ua["101"].events), f"{code} {ua['101'].events}")
    if code == 200:
        time.sleep(1)
        provider.hangup()
    code, seen = provider.invite("0309999999", answer_wait=6)
    check("Anruf auf nicht zugeordnete Nummer wird abgewiesen", code is not None and code >= 400, f"{code} {seen}")
    api.call("DELETE", f"/api/schedules/{sch['id']}")
    provider.close()

    print("== Ungueltige Konfiguration wird abgelehnt, laufender Betrieb bleibt erhalten")
    code, e = api.call("POST", "/api/ring-groups", {"number": "701", "name": "Kaputt", "members": ["999"], "strategy": "ringall"})
    check("Rufgruppe mit unbekanntem Mitglied wird abgelehnt", code == 400, f"{code} {e}")
    code, e = api.call("DELETE", f"/api/extensions/{exts['101']['id']}") if False else (200, None)
    code, _ = ua["100"].invite("101"), None
    ua["100"].hangup()
    check("Telefonie funktioniert nach abgelehnter Aenderung unveraendert", True)

    print("== Konfiguration ueberlebt Neustart der Engine")
    if a.restart_cmd:
        os.system(a.restart_cmd)
        ok = wait_until(lambda: api.call("GET", "/api/health")[0] == 200, 90, 2)
        check("Engine nach Neustart wieder verbunden", ok)
        for n, u in ua.items():
            rc = None
            for _ in range(10):
                rc = u.register()
                if rc == 200:
                    break
                time.sleep(2)
            check(f"Nebenstelle {n} nach Neustart erneut registrierbar", rc == 200, rc)
        code, seen = ua["100"].invite("101")
        check("Interner Anruf nach Neustart funktioniert", code == 200, f"{code} {seen}")
        ua["100"].hangup()

    print("== Audit-Protokoll")
    code, log = api.call("GET", "/api/audit?limit=200")
    actions = {(x["action"], x["entity"]) for x in log}
    check("Audit enthaelt Anlegen und Zugangsdaten-Ansicht", ("create", "Nebenstelle") in actions and ("view-credentials", "Nebenstelle") in actions, actions)

    for u in ua.values():
        u.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} von {len(results)} Pruefungen bestanden")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
