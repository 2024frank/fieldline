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
    # Hot path: just a connection. Schema/DDL is done ONCE in init_db(), not on
    # every request. (The old code ran 6 DDL statements per call — at scale that's
    # tens of thousands of pointless catalog lookups per second.)
    c = sqlite3.connect(DB, timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")   # WAL-safe, much faster writes
    return c

def init_db():
    c = sqlite3.connect(DB, timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("""CREATE TABLE IF NOT EXISTS readings(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dev_eui TEXT, device TEXT, ts TEXT, f_cnt INTEGER,
        rssi INTEGER, snr REAL, data TEXT)""")
    # Index carries id so latest/history queries are index-only (no table walk).
    c.execute("CREATE INDEX IF NOT EXISTS idx_dev ON readings(dev_eui, id)")
    for stmt in ("ALTER TABLE readings ADD COLUMN gw TEXT",):
        try: c.execute(stmt)
        except sqlite3.OperationalError: pass
    c.execute("""CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dev_eui TEXT, kind TEXT, ts TEXT, code TEXT, detail TEXT)""")
    c.execute("CREATE INDEX IF NOT EXISTS idx_ev ON events(dev_eui, id)")
    # Partial-ish helper index for the per-(device,kind) latest lookup in /state.
    c.execute("CREATE INDEX IF NOT EXISTS idx_ev_kind ON events(dev_eui, kind, id)")
    for stmt in ("ALTER TABLE events ADD COLUMN level TEXT",):
        try: c.execute(stmt)
        except sqlite3.OperationalError: pass
    # "Latest reading per device" is a dashboard staple. Computing it from the
    # firehose is either a full GROUP BY scan (slow) or a bounded LIMIT window
    # (drops quiet devices). Both are wrong at scale. Instead we MAINTAIN it:
    # one row per device, upserted on write. Reads become O(devices), not O(rows).
    c.execute("""CREATE TABLE IF NOT EXISTS latest(
        dev_eui TEXT PRIMARY KEY, device TEXT, ts TEXT,
        rssi INTEGER, snr REAL, data TEXT, gw TEXT, src_id INTEGER)""")
    # Backfill once so existing data appears. Prefer newest-with-data, else newest.
    HAS = "data IS NOT NULL AND data <> '' AND data <> '{}'"
    c.execute(f"""INSERT OR IGNORE INTO latest(dev_eui,device,ts,rssi,snr,data,gw,src_id)
        SELECT r.dev_eui,r.device,r.ts,r.rssi,r.snr,r.data,r.gw,r.id FROM readings r
        JOIN (SELECT dev_eui, MAX(id) mid FROM readings WHERE {HAS} GROUP BY dev_eui) g ON r.id=g.mid""")
    c.execute("""INSERT OR IGNORE INTO latest(dev_eui,device,ts,rssi,snr,data,gw,src_id)
        SELECT r.dev_eui,r.device,r.ts,r.rssi,r.snr,r.data,r.gw,r.id FROM readings r
        JOIN (SELECT dev_eui, MAX(id) mid FROM readings GROUP BY dev_eui) g ON r.id=g.mid""")
    c.commit(); c.close()

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
            data_str = json.dumps(e.get("object") or {})
            gw = (rx.get("gatewayId") or "").lower() or None
            cur = c.execute("INSERT INTO readings(dev_eui,device,ts,f_cnt,rssi,snr,data,gw) VALUES(?,?,?,?,?,?,?,?)",
                            (eui, di.get("deviceName"), e.get("time"), e.get("fCnt"),
                             rx.get("rssi"), rx.get("snr"), data_str, gw))
            # Maintain the latest table. A decoded frame always wins; an empty
            # frame only fills a device we've never heard decoded data from.
            vals = (eui, di.get("deviceName"), e.get("time"), rx.get("rssi"), rx.get("snr"), data_str, gw, cur.lastrowid)
            if data_str not in ("", "{}"):
                c.execute("""INSERT INTO latest(dev_eui,device,ts,rssi,snr,data,gw,src_id) VALUES(?,?,?,?,?,?,?,?)
                    ON CONFLICT(dev_eui) DO UPDATE SET device=excluded.device, ts=excluded.ts,
                      rssi=excluded.rssi, snr=excluded.snr, data=excluded.data, gw=excluded.gw, src_id=excluded.src_id""", vals)
            else:
                c.execute("INSERT OR IGNORE INTO latest(dev_eui,device,ts,rssi,snr,data,gw,src_id) VALUES(?,?,?,?,?,?,?,?)", vals)
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
            c.execute("INSERT INTO events(dev_eui,kind,ts,code,detail,level) VALUES(?,?,?,?,?,?)",
                      (eui, "log", e.get("time"), e.get("code"), e.get("description"), e.get("level")))
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
    COLS = "SELECT dev_eui,device,ts,rssi,snr,data,gw FROM readings"
    HAS_DATA = "data IS NOT NULL AND data <> '' AND data <> '{}'"
    c = db()
    try:
        # ── one device ──────────────────────────────────────────────────────
        # WHERE dev_eui=? hits the (dev_eui,id) index directly: we touch only
        # this device's rows, not the whole table.
        if dev:
            d = dev.lower()
            if history or want_csv:
                rows = c.execute(f"{COLS} WHERE dev_eui=? AND {HAS_DATA} ORDER BY id DESC LIMIT ?",
                                 (d, limit)).fetchall()
                hist = [rowdict(x) for x in rows]
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
            # latest for one device: prefer newest decoded, else newest anything.
            row = c.execute(f"{COLS} WHERE dev_eui=? AND {HAS_DATA} ORDER BY id DESC LIMIT 1", (d,)).fetchone() \
                  or c.execute(f"{COLS} WHERE dev_eui=? ORDER BY id DESC LIMIT 1", (d,)).fetchone()
            return jsonify(rowdict(row) if row else {})

        # ── latest per device ───────────────────────────────────────────────
        # Read the maintained table: one row per device, O(devices). No scan of
        # the firehose regardless of how many billions of rows sit behind it.
        if latest:
            rows = c.execute("SELECT dev_eui,device,ts,rssi,snr,data,gw FROM latest").fetchall()
            return jsonify([rowdict(x) for x in rows])

        # ── recent (debug) ──────────────────────────────────────────────────
        rows = c.execute(f"{COLS} ORDER BY id DESC LIMIT 100").fetchall()
        return jsonify([rowdict(x) for x in rows])
    finally:
        c.close()

@app.get("/events")
def events():
    dev = request.args.get("device")
    kind = request.args.get("kind")
    try:
        limit = min(int(request.args.get("limit") or 50), 500)
    except ValueError:
        limit = 50
    where, params = [], []
    if dev:  where.append("dev_eui=?"); params.append(dev.lower())
    if kind: where.append("kind=?");   params.append(kind)
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    c = db()
    try:
        rows = c.execute(f"SELECT dev_eui,kind,ts,code,detail,level FROM events{clause} ORDER BY id DESC LIMIT ?",
                         (*params, limit)).fetchall()
    finally:
        c.close()
    return jsonify([{"devEui": r[0], "kind": r[1], "time": r[2], "code": r[3], "detail": r[4], "level": r[5]}
                    for r in rows])

@app.get("/state")
def state():
    """Latest join / battery / error per device, folded from the events log.
    One grouped index scan gets the newest id per (device, kind); then one fetch.
    Optional ?device= limits it to a single sensor (used by the detail page)."""
    dev = request.args.get("device")
    dclause, dparams = (" WHERE dev_eui=?", (dev.lower(),)) if dev else ("", ())
    c = db()
    try:
        ids = [r[0] for r in c.execute(
            f"SELECT MAX(id) FROM events{dclause} GROUP BY dev_eui, kind", dparams).fetchall()]
        if not ids:
            return jsonify({})
        ph = ",".join("?" * len(ids))
        rows = c.execute(f"SELECT dev_eui,kind,ts,code,detail,level FROM events WHERE id IN ({ph}) ORDER BY id DESC",
                         ids).fetchall()
    finally:
        c.close()
    out = {}
    for dev_eui, kind, ts, code, detail, level in rows:  # newest first
        s = out.setdefault(dev_eui, {})
        if kind == "join" and "lastJoinAt" not in s:
            s["lastJoinAt"] = ts
        elif kind == "status" and "battery" not in s:
            try: d = json.loads(detail or "{}")
            except ValueError: d = {}
            s.update(battery=d.get("battery"), margin=d.get("margin"), extPower=d.get("extPower"), lastStatusAt=ts)
        elif kind == "log" and "lastError" not in s:
            s["lastError"] = {"code": code, "description": detail, "time": ts, "level": level}
    return jsonify(out)

@app.get("/health")
def health():
    return jsonify({"ok": True})

if __name__ == "__main__":
    init_db()                                   # schema once, not per request
    threading.Thread(target=mqtt_loop, daemon=True).start()
    app.run(host="0.0.0.0", port=8000)
