"""
On-AWS reading store for the Oberlin LoRaWAN network.
- Subscribes to ChirpStack's MQTT uplinks, stores each reading in SQLite.
- Serves a read API so any app can fetch the data over HTTPS (via Caddy /store/*).

Routes:
  GET /readings                 -> last 100 readings (newest first)
  GET /readings?latest=1        -> latest reading per device
  GET /readings?device=<devEui> -> latest for one device
  GET /health
"""
import os, json, sqlite3, threading, time
import paho.mqtt.client as mqtt
from flask import Flask, request, jsonify

DB        = os.environ.get("DB_PATH", "/data/readings.db")
MQTT_HOST = os.environ.get("MQTT_HOST", "mosquitto")
MQTT_USER = os.environ.get("MQTT_USER", "chirpstack")
MQTT_PASS = os.environ.get("MQTT_PASS", "")

def db():
    c = sqlite3.connect(DB, timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("""CREATE TABLE IF NOT EXISTS readings(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dev_eui TEXT, device TEXT, ts TEXT, f_cnt INTEGER,
        rssi INTEGER, snr REAL, data TEXT)""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_dev ON readings(dev_eui, id)")
    try:
        c.execute("ALTER TABLE readings ADD COLUMN gw TEXT")  # which gateway heard it
    except sqlite3.OperationalError:
        pass  # column already there
    # network events beyond data uplinks: joins, device status, errors
    c.execute("""CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dev_eui TEXT, kind TEXT, ts TEXT, code TEXT, detail TEXT)""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_ev ON events(dev_eui, id)")
    return c

def rowdict(r):
    if not r: return {}
    return {"devEui": r[0], "device": r[1], "time": r[2],
            "rssi": r[3], "snr": r[4], "data": json.loads(r[5] or "{}"),
            "gw": r[6] if len(r) > 6 else None}

# ---- MQTT consumer ----
def on_connect(client, userdata, flags, rc):
    for kind in ("up", "join", "status", "log"):
        client.subscribe("application/+/device/+/event/%s" % kind)
    print("MQTT connected rc=%s, subscribed to up/join/status/log" % rc, flush=True)

def on_message(client, userdata, msg):
    try:
        kind = msg.topic.rsplit("/", 1)[-1]
        e = json.loads(msg.payload)
        di = e.get("deviceInfo", {})
        eui = di.get("devEui")
        c = db()
        if kind == "up":
            rx = (e.get("rxInfo") or [{}])[0]
            c.execute("INSERT INTO readings(dev_eui,device,ts,f_cnt,rssi,snr,data,gw) VALUES(?,?,?,?,?,?,?,?)",
                      (eui, di.get("deviceName"), e.get("time"), e.get("fCnt"),
                       rx.get("rssi"), rx.get("snr"), json.dumps(e.get("object") or {}),
                       (rx.get("gatewayId") or "").lower() or None))
        elif kind == "join":
            c.execute("INSERT INTO events(dev_eui,kind,ts,code,detail) VALUES(?,?,?,?,?)",
                      (eui, "join", e.get("time"), "JOIN", json.dumps({"devAddr": e.get("devAddr")})))
        elif kind == "status":
            detail = {"battery": e.get("batteryLevel"), "margin": e.get("margin"),
                      "extPower": e.get("externalPowerSource"),
                      "batteryUnavailable": e.get("batteryLevelUnavailable")}
            c.execute("INSERT INTO events(dev_eui,kind,ts,code,detail) VALUES(?,?,?,?,?)",
                      (eui, "status", e.get("time"), "STATUS", json.dumps(detail)))
        elif kind == "log":
            c.execute("INSERT INTO events(dev_eui,kind,ts,code,detail) VALUES(?,?,?,?,?)",
                      (eui, "log", e.get("time"), e.get("code"), e.get("description")))
        c.commit(); c.close()
        print("stored %s from %s" % (kind, eui), flush=True)
    except Exception as ex:
        print("store error:", ex, flush=True)

def mqtt_loop():
    cl = mqtt.Client()
    if MQTT_USER:
        cl.username_pw_set(MQTT_USER, MQTT_PASS)
    cl.on_connect = on_connect
    cl.on_message = on_message
    while True:
        try:
            cl.connect(MQTT_HOST, 1883, 60)
            cl.loop_forever()
        except Exception as ex:
            print("mqtt reconnect in 5s:", ex, flush=True)
            time.sleep(5)

# ---- HTTP read API ----
app = Flask(__name__)

@app.after_request
def cors(r):
    r.headers["Access-Control-Allow-Origin"] = "*"
    return r

@app.get("/readings")
def readings():
    dev = request.args.get("device")
    latest = request.args.get("latest")
    history = request.args.get("history")
    want_csv = request.args.get("csv")
    try:
        limit = min(int(request.args.get("limit") or 500), 2000)
    except ValueError:
        limit = 500
    c = db()
    rows = c.execute("SELECT dev_eui,device,ts,rssi,snr,data,gw FROM readings ORDER BY id DESC LIMIT 5000").fetchall()
    c.close()
    allr = [rowdict(x) for x in rows]  # newest first

    if dev:
        d = dev.lower()
        drows = [r for r in allr if r["devEui"] == d]

        # full history for one device (list), newest first
        if history or want_csv:
            hist = [r for r in drows if r["data"]][:limit]
            if want_csv:
                cols = sorted({k for r in hist for k in r["data"].keys()})
                lines = ["time,rssi,snr," + ",".join(cols)]
                for r in hist:
                    lines.append(",".join([str(r["time"]), str(r["rssi"] or ""), str(r["snr"] or "")] +
                                          [str(r["data"].get(k, "")) for k in cols]))
                from flask import Response
                return Response("\n".join(lines) + "\n", mimetype="text/csv",
                                headers={"Content-Disposition": f"attachment; filename={d}.csv"})
            return jsonify(hist)

        # prefer the newest reading that actually has decoded values;
        # some sensors send occasional empty "event" frames
        chosen = next((r for r in drows if r["data"]), (drows[0] if drows else None))
        return jsonify(chosen or {})

    if latest:
        newest, withdata = {}, {}
        for r in allr:  # newest first
            e = r["devEui"]
            newest.setdefault(e, r)
            if r["data"]:
                withdata.setdefault(e, r)
        result = [withdata.get(e, newest[e]) for e in newest]
        return jsonify(result)

    return jsonify(allr[:100])

@app.get("/events")
def events():
    dev = request.args.get("device")
    kind = request.args.get("kind")
    try:
        limit = min(int(request.args.get("limit") or 50), 500)
    except ValueError:
        limit = 50
    c = db()
    rows = c.execute("SELECT dev_eui,kind,ts,code,detail FROM events ORDER BY id DESC LIMIT 2000").fetchall()
    c.close()
    out = []
    for r in rows:
        if dev and r[0] != dev.lower():
            continue
        if kind and r[1] != kind:
            continue
        out.append({"devEui": r[0], "kind": r[1], "time": r[2], "code": r[3], "detail": r[4]})
        if len(out) >= limit:
            break
    return jsonify(out)

@app.get("/state")
def state():
    """Latest join / battery / error per device, folded from the events log."""
    c = db()
    rows = c.execute("SELECT dev_eui,kind,ts,code,detail FROM events ORDER BY id DESC LIMIT 3000").fetchall()
    c.close()
    out = {}
    for dev_eui, kind, ts, code, detail in rows:  # newest first
        s = out.setdefault(dev_eui, {})
        if kind == "join" and "lastJoinAt" not in s:
            s["lastJoinAt"] = ts
        elif kind == "status" and "battery" not in s:
            try:
                d = json.loads(detail or "{}")
            except ValueError:
                d = {}
            s["battery"] = d.get("battery")
            s["margin"] = d.get("margin")
            s["extPower"] = d.get("extPower")
            s["lastStatusAt"] = ts
        elif kind == "log" and "lastError" not in s:
            s["lastError"] = {"code": code, "description": detail, "time": ts}
    return jsonify(out)

@app.get("/health")
def health():
    return jsonify({"ok": True})

if __name__ == "__main__":
    threading.Thread(target=mqtt_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=8000)
