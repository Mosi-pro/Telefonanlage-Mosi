#!/usr/bin/env python3
"""WebRTC-End-to-End-Test: Chromium (Browsertelefon) ruft ein SIP-Endgeraet an. Voraussetzung: HTTPS-Zugang,
Nebenstellen 100/101 existieren (test_pbx.py legt sie an). Pruefen: WSS-Registrierung, DTLS-SRTP, Audio beidseitig."""
import argparse, json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(__file__))
from sipua import UA
from test_pbx import Api, check, results, wait_until


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="https://127.0.0.1")
    ap.add_argument("--sip", default="127.0.0.1:5060")
    ap.add_argument("--local-ip", default="127.0.0.1")
    ap.add_argument("--admin-user", default="admin")
    ap.add_argument("--admin-pass", default="Test-Admin-Passw0rt!")
    a = ap.parse_args()
    host, port = a.sip.split(":")
    api = Api(a.api)
    assert api.login(a.admin_user, a.admin_pass)[0] == 200
    code, exts = api.call("GET", "/api/extensions")
    e101 = next(e for e in exts if e["number"] == "101")
    conn = api.call("GET", f"/api/extensions/{e101['id']}/connection")[1]
    ua = UA(conn["username"], conn["password"], host, int(port), a.local_ip, pattern=0x42)
    check("SIP-Endgeraet 101 registriert", ua.register() == 200)
    here = os.path.dirname(os.path.abspath(__file__))
    env = dict(os.environ, NODE_PATH=os.environ.get("NODE_PATH", ""))
    p = subprocess.run(["node", os.path.join(here, "webrtc_browser.js"), a.api, a.admin_user, a.admin_pass, "101", "6"],
                       capture_output=True, text=True, timeout=120, env=env)
    print(p.stdout.strip()[-800:], p.stderr.strip()[-400:])
    out = json.loads(p.stdout.strip().splitlines()[-1])
    check("Browser registriert sich per WSS am Server", out.get("registered"), out)
    check("Browser baut Anruf zu 101 auf und ist im Gespraech", out.get("inCall"), out)
    st = out.get("stats") or {}
    check("DTLS-SRTP-Verbindung steht (dtlsState=connected)", st.get("dtls") == "connected", st)
    check("Browser empfaengt Audio vom SIP-Geraet (>100 RTP-Pakete)", st.get("inboundPackets", 0) > 100, st)
    check("Browser sendet Audio (>100 RTP-Pakete)", st.get("outboundPackets", 0) > 100, st)
    # Das SIP-Geraet muss Audio vom Browser (Fake-Mikrofon, nicht konstant) erhalten
    rx = ua.rx_payloads
    varied = len({bytes(x) for x in rx}) > 5 if rx else False
    check("SIP-Geraet 101 empfaengt Audio vom Browser (>100 Pakete, nicht konstant)", len(rx) > 100 and varied, f"{len(rx)} Pakete")
    check("Stummschaltung im Browser bedienbar", "aus" in (out.get("muteLabel") or ""), out.get("muteLabel"))
    check("Browser beendet Gespraech", ua.wait_for_call_end(5) or out.get("endState"), out.get("endState"))
    ua.close()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} von {len(results)} Pruefungen bestanden")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
