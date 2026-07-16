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
    return c

def rowdict(r):
    if not r: return {}
    return {"devEui": r[0], "device": r[1], "time": r[2],
            "rssi": r[3], "snr": r[4], "data": json.loads(r[5] or "{}")}

# ---- MQTT consumer ----
def on_connect(client, userdata, flags, rc):
    client.subscribe("application/+/device/+/event/up")
    print("MQTT connected rc=%s, subscribed to uplinks" % rc, flush=True)

def on_message(client, userdata, msg):
    try:
        e = json.loads(msg.payload)
        di = e.get("deviceInfo", {})
        rx = (e.get("rxInfo") or [{}])[0]
        c = db()
        c.execute("INSERT INTO readings(dev_eui,device,ts,f_cnt,rssi,snr,data) VALUES(?,?,?,?,?,?,?)",
                  (di.get("devEui"), di.get("deviceName"), e.get("time"), e.get("fCnt"),
                   rx.get("rssi"), rx.get("snr"), json.dumps(e.get("object") or {})))
        c.commit(); c.close()
        print("stored uplink from", di.get("devEui"), flush=True)
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
    rows = c.execute("SELECT dev_eui,device,ts,rssi,snr,data FROM readings ORDER BY id DESC LIMIT 5000").fetchall()
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

@app.get("/health")
def health():
    return jsonify({"ok": True})

if __name__ == "__main__":
    threading.Thread(target=mqtt_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=8000)
