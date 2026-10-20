"""Minimaler SIP-User-Agent (nur Python-Standardbibliothek) fuer die Integrationstests.

Kann sich mit Digest-Authentifizierung registrieren, Anrufe aufbauen/annehmen/beenden und
RTP (G.711 u-law) senden und empfangen, um echte Zwei-Wege-Audioübertragung nachzuweisen.
"""
import hashlib
import queue
import random
import re
import socket
import struct
import threading
import time


def md5(s):
    return hashlib.md5(s.encode()).hexdigest()


def parse(data):
    head, _, body = data.partition("\r\n\r\n")
    lines = head.split("\r\n")
    msg = {"start": lines[0], "headers": {}, "body": body, "raw": data}
    for ln in lines[1:]:
        if ":" in ln:
            k, v = ln.split(":", 1)
            msg["headers"].setdefault(k.strip().lower(), []).append(v.strip())
    return msg


def hdr(msg, name, default=""):
    v = msg["headers"].get(name.lower())
    return v[0] if v else default


class UA:
    def __init__(self, user, password, server, sip_port, local_ip="127.0.0.1", local_port=0, rtp_port=0,
                 pattern=0x55, auth_user=None, answer=True, ring=True):
        self.user, self.password, self.auth_user = user, password, auth_user or user
        self.server, self.sip_port, self.local_ip = server, sip_port, local_ip
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((local_ip, local_port))
        self.lport = self.sock.getsockname()[1]
        self.rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rtp.bind((local_ip, rtp_port))
        self.rtp_port = self.rtp.getsockname()[1]
        self.pattern = pattern
        self.auto_answer, self.auto_ring = answer, ring
        self.call_id_reg = f"{random.getrandbits(48):x}@{local_ip}"
        self.cseq = 1
        self.inbox = queue.Queue()
        self.running = True
        self.dialog = None          # aktueller Anruf
        self.events = []            # protokollierte Ereignisse
        self.rx_payloads = []       # empfangene RTP-Nutzdaten
        self.tx_stop = threading.Event()
        threading.Thread(target=self._recv_loop, daemon=True).start()
        threading.Thread(target=self._rtp_loop, daemon=True).start()

    # ------------------------------------------------------------ Transport
    def _send(self, text):
        self.sock.sendto(text.encode(), (self.server, self.sip_port))

    def _recv_loop(self):
        self.sock.settimeout(0.5)
        while self.running:
            try:
                data, _ = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                return
            msg = parse(data.decode(errors="replace"))
            if msg["start"].startswith("SIP/2.0"):
                self.inbox.put(msg)
            else:
                self._on_request(msg)

    def _rtp_loop(self):
        self.rtp.settimeout(0.5)
        while self.running:
            try:
                data, _ = self.rtp.recvfrom(2048)
            except socket.timeout:
                continue
            except OSError:
                return
            if len(data) > 12:
                self.rx_payloads.append(data[12:])

    def close(self):
        self.running = False
        self.tx_stop.set()
        self.sock.close()
        self.rtp.close()

    # ------------------------------------------------------------ Digest
    def _digest(self, challenge, method, uri):
        p = dict(re.findall(r'(\w+)="?([^",]+)"?', challenge))
        ha1 = md5(f"{self.auth_user}:{p['realm']}:{self.password}")
        ha2 = md5(f"{method}:{uri}")
        if "qop" in p:
            nc, cnonce = "00000001", f"{random.getrandbits(32):x}"
            resp = md5(f"{ha1}:{p['nonce']}:{nc}:{cnonce}:auth:{ha2}")
            extra = f', qop=auth, nc={nc}, cnonce="{cnonce}"'
        else:
            resp = md5(f"{ha1}:{p['nonce']}:{ha2}")
            extra = ""
        return (f'Digest username="{self.auth_user}", realm="{p["realm"]}", nonce="{p["nonce"]}", uri="{uri}", '
                f'response="{resp}", algorithm=MD5{extra}')

    def _wait_response(self, call_id, timeout=5, final=True):
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = self.inbox.get(timeout=0.3)
            except queue.Empty:
                continue
            if hdr(m, "call-id") != call_id:
                continue
            code = int(m["start"].split()[1])
            self.events.append((time.time(), code))
            if not final or code >= 200:
                return m
        return None

    # ------------------------------------------------------------ Registrierung
    def register(self, expires=600, auth=True):
        """Gibt den finalen Statuscode zurueck (200 = ok, 401/403 = abgelehnt, None = keine Antwort)."""
        uri = f"sip:{self.server}"
        auth_header = ""
        for _ in range(2):
            self.cseq += 1
            branch = f"z9hG4bK{random.getrandbits(40):x}"
            self._send(
                f"REGISTER {uri} SIP/2.0\r\nVia: SIP/2.0/UDP {self.local_ip}:{self.lport};branch={branch};rport\r\n"
                f"Max-Forwards: 70\r\nFrom: <sip:{self.user}@{self.server}>;tag=r{self.cseq}\r\nTo: <sip:{self.user}@{self.server}>\r\n"
                f"Call-ID: {self.call_id_reg}\r\nCSeq: {self.cseq} REGISTER\r\nContact: <sip:{self.user}@{self.local_ip}:{self.lport}>\r\n"
                f"Expires: {expires}\r\n{auth_header}User-Agent: MosiTestUA\r\nContent-Length: 0\r\n\r\n")
            m = self._wait_response(self.call_id_reg)
            if m is None:
                return None
            code = int(m["start"].split()[1])
            if code == 401 and auth:
                auth_header = "Authorization: " + self._digest(hdr(m, "www-authenticate"), "REGISTER", uri) + "\r\n"
                continue
            return code
        return 401

    def unregister(self):
        return self.register(expires=0)

    # ------------------------------------------------------------ SDP / RTP
    def _sdp(self):
        return ("v=0\r\no=mosi 1 1 IN IP4 {ip}\r\ns=test\r\nc=IN IP4 {ip}\r\nt=0 0\r\n"
                "m=audio {port} RTP/AVP 0 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:101 telephone-event/8000\r\na=sendrecv\r\n"
                ).format(ip=self.local_ip, port=self.rtp_port)

    @staticmethod
    def _remote_media(sdp):
        ip = re.search(r"c=IN IP4 (\S+)", sdp)
        port = re.search(r"m=audio (\d+)", sdp)
        return (ip.group(1), int(port.group(1))) if ip and port else None

    def start_media(self, remote):
        self.tx_stop.clear()

        def run():
            seq, ts, ssrc = 0, 0, random.getrandbits(32)
            payload = bytes([self.pattern]) * 160
            while not self.tx_stop.is_set() and self.running:
                pkt = struct.pack("!BBHII", 0x80, 0, seq & 0xFFFF, ts & 0xFFFFFFFF, ssrc) + payload
                try:
                    self.rtp.sendto(pkt, remote)
                except OSError:
                    return
                seq += 1
                ts += 160
                time.sleep(0.02)
        threading.Thread(target=run, daemon=True).start()

    def received_pattern_ratio(self, pattern):
        """Anteil der empfangenen RTP-Pakete, die exakt das Muster des Gegenuebers enthalten."""
        if not self.rx_payloads:
            return 0.0
        good = sum(1 for p in self.rx_payloads if p == bytes([pattern]) * 160)
        return good / len(self.rx_payloads)

    # ------------------------------------------------------------ Anruf (ausgehend)
    def invite(self, target, timeout=15, answer_wait=20):
        """Baut einen Anruf auf. Rueckgabe: (finaler Statuscode, gesehene Codes)."""
        self.rx_payloads = []
        uri = f"sip:{target}@{self.server}"
        call_id = f"{random.getrandbits(48):x}@{self.local_ip}"
        from_tag = f"f{random.getrandbits(24):x}"
        seen = []
        auth_header = ""
        for attempt in range(2):
            self.cseq += 1
            branch = f"z9hG4bK{random.getrandbits(40):x}"
            body = self._sdp()
            self._send(
                f"INVITE {uri} SIP/2.0\r\nVia: SIP/2.0/UDP {self.local_ip}:{self.lport};branch={branch};rport\r\nMax-Forwards: 70\r\n"
                f"From: <sip:{self.user}@{self.server}>;tag={from_tag}\r\nTo: <{uri}>\r\nCall-ID: {call_id}\r\nCSeq: {self.cseq} INVITE\r\n"
                f"Contact: <sip:{self.user}@{self.local_ip}:{self.lport}>\r\nContent-Type: application/sdp\r\n{auth_header}"
                f"User-Agent: MosiTestUA\r\nContent-Length: {len(body)}\r\n\r\n{body}")
            end = time.time() + answer_wait
            final = None
            while time.time() < end:
                m = self._wait_response(call_id, timeout=1, final=False)
                if m is None:
                    continue
                code = int(m["start"].split()[1])
                seen.append(code)
                if code >= 200:
                    final = m
                    break
            if final is None:
                return None, seen
            code = int(final["start"].split()[1])
            to_hdr = hdr(final, "to")
            if code == 401 or code == 407:
                self._send(f"ACK {uri} SIP/2.0\r\nVia: SIP/2.0/UDP {self.local_ip}:{self.lport};branch={branch}\r\nMax-Forwards: 70\r\n"
                           f"From: <sip:{self.user}@{self.server}>;tag={from_tag}\r\nTo: {to_hdr}\r\nCall-ID: {call_id}\r\nCSeq: {self.cseq} ACK\r\nContent-Length: 0\r\n\r\n")
                auth_header = "Authorization: " + self._digest(hdr(final, "www-authenticate") or hdr(final, "proxy-authenticate"), "INVITE", uri) + "\r\n"
                continue
            if code == 200:
                contact = re.search(r"<([^>]+)>", hdr(final, "contact"))
                remote_uri = contact.group(1) if contact else uri
                self._send(f"ACK {remote_uri} SIP/2.0\r\nVia: SIP/2.0/UDP {self.local_ip}:{self.lport};branch=z9hG4bK{random.getrandbits(40):x}\r\nMax-Forwards: 70\r\n"
                           f"From: <sip:{self.user}@{self.server}>;tag={from_tag}\r\nTo: {to_hdr}\r\nCall-ID: {call_id}\r\nCSeq: {self.cseq} ACK\r\nContent-Length: 0\r\n\r\n")
                media = self._remote_media(final["body"])
                self.dialog = {"call_id": call_id, "remote_uri": remote_uri, "from_tag": from_tag, "to": to_hdr, "role": "caller", "media": media}
                if media:
                    self.start_media(media)
            else:
                self._send(f"ACK {uri} SIP/2.0\r\nVia: SIP/2.0/UDP {self.local_ip}:{self.lport};branch={branch}\r\nMax-Forwards: 70\r\n"
                           f"From: <sip:{self.user}@{self.server}>;tag={from_tag}\r\nTo: {to_hdr}\r\nCall-ID: {call_id}\r\nCSeq: {self.cseq} ACK\r\nContent-Length: 0\r\n\r\n")
            return code, seen
        return 401, seen

    def hangup(self):
        d = self.dialog
        if not d:
            return
        self.tx_stop.set()
        self.cseq += 1
        if d["role"] == "caller":
            frm, to = f"<sip:{self.user}@{self.server}>;tag={d['from_tag']}", d["to"]
        else:
            frm, to = d["to_local"], d["from_remote"]
        self._send(f"BYE {d['remote_uri']} SIP/2.0\r\nVia: SIP/2.0/UDP {self.local_ip}:{self.lport};branch=z9hG4bK{random.getrandbits(40):x};rport\r\n"
                   f"Max-Forwards: 70\r\nFrom: {frm}\r\nTo: {to}\r\nCall-ID: {d['call_id']}\r\nCSeq: {self.cseq} BYE\r\nContent-Length: 0\r\n\r\n")
        self._wait_response(d["call_id"], timeout=3)
        self.dialog = None

    def wait_for_call_end(self, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            if self.dialog is None:
                return True
            time.sleep(0.1)
        return False

    # ------------------------------------------------------------ Eingehende Requests
    def _on_request(self, msg):
        method = msg["start"].split()[0]
        if method == "OPTIONS":
            self._reply(msg, "200 OK")
        elif method == "INVITE":
            threading.Thread(target=self._handle_invite, args=(msg,), daemon=True).start()
        elif method == "BYE":
            self._reply(msg, "200 OK")
            self.tx_stop.set()
            self.dialog = None
            self.events.append((time.time(), "BYE"))
        elif method == "ACK":
            self.events.append((time.time(), "ACK"))
        elif method == "CANCEL":
            self._reply(msg, "200 OK")
            self.events.append((time.time(), "CANCEL"))
            self.cancelled = True

    def _reply(self, req, status, extra="", body="", to_tag=None):
        vias = "".join(f"Via: {v}\r\n" for v in req["headers"].get("via", []))
        to = hdr(req, "to")
        if to_tag and "tag=" not in to:
            to += f";tag={to_tag}"
        ct = "Content-Type: application/sdp\r\n" if body else ""
        self._send(f"SIP/2.0 {status}\r\n{vias}From: {hdr(req, 'from')}\r\nTo: {to}\r\nCall-ID: {hdr(req, 'call-id')}\r\n"
                   f"CSeq: {hdr(req, 'cseq')}\r\n{extra}{ct}Content-Length: {len(body)}\r\n\r\n{body}")

    def _handle_invite(self, req):
        self.cancelled = False
        self.rx_payloads = []
        tag = f"t{random.getrandbits(24):x}"
        self.incoming_from = hdr(req, "from")
        self.incoming_uri = req["start"].split()[1]
        self.events.append((time.time(), "INVITE"))
        self._reply(req, "100 Trying")
        if self.auto_ring:
            self._reply(req, "180 Ringing", to_tag=tag, extra=f"Contact: <sip:{self.user}@{self.local_ip}:{self.lport}>\r\n")
        if not self.auto_answer:
            return
        time.sleep(0.5)
        if self.cancelled:
            return
        contact = re.search(r"<([^>]+)>", hdr(req, "contact"))
        self.dialog = {"call_id": hdr(req, "call-id"), "remote_uri": contact.group(1) if contact else "", "role": "callee",
                       "to_local": hdr(req, "to") + f";tag={tag}", "from_remote": hdr(req, "from"), "media": self._remote_media(req["body"])}
        self._reply(req, "200 OK", to_tag=tag, body=self._sdp(), extra=f"Contact: <sip:{self.user}@{self.local_ip}:{self.lport}>\r\n")
        if self.dialog["media"]:
            self.start_media(self.dialog["media"])
