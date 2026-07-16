"""
Data Hub pusher: the moment a mapped sensor reports, format the reading and
POST it to Community Hub's Data Hub endpoint with that sensor's token.

- Subscribes to ChirpStack uplinks over MQTT (same bus as the datastore).
- Only pushes devices listed in DEVICE_TOKENS.
- Formats rows Data Hub CSV style: Timestamp + one column per measurement,
  column names = "<measurement>" (Data Hub maps them to Variables by name,
  registered on their side per sensor).
- Store-and-forward: if the endpoint is unset or down, readings queue in
  /data/pending.jsonl and are retried, so nothing is lost.

Config (env):
  DATAHUB_URL      the push endpoint (leave empty until Pratyush provides it)
  DEVICE_TOKENS    JSON: {"<devEui>": "<token>", ...}
  MQTT_HOST/USER/PASS  broker credentials
"""
import os, json, time, threading
import urllib.request
import paho.mqtt.client as mqtt

DATAHUB_URL = os.environ.get("DATAHUB_URL", "").strip()
DEVICE_TOKENS = json.loads(os.environ.get("DEVICE_TOKENS", "{}"))
MQTT_HOST = os.environ.get("MQTT_HOST", "mosquitto")
MQTT_USER = os.environ.get("MQTT_USER", "chirpstack")
MQTT_PASS = os.environ.get("MQTT_PASS", "")
PENDING = "/data/pending.jsonl"

def log(*a): print(*a, flush=True)

def push(reading: dict) -> bool:
    """POST one reading to Data Hub as a per-sensor CSV. True on success."""
    if not DATAHUB_URL:
        return False
    eui = reading["devEui"]
    token = DEVICE_TOKENS.get(eui)
    if not token:
        return True  # not a mapped device
    meas = reading.get("data") or {}
    if not meas:
        return True  # nothing decoded yet (no codec) -> nothing to push
    cols = sorted(meas.keys())
    csv_body = "Timestamp," + ",".join(cols) + "\n" + \
               str(reading["time"]) + "," + ",".join(str(meas[c]) for c in cols) + "\n"

    def attempt(body: bytes, ctype: str) -> tuple[bool, str]:
        req = urllib.request.Request(DATAHUB_URL, data=body, method="POST",
            headers={"Content-Type": ctype, "user-token": token})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return (200 <= r.status < 300), f"HTTP {r.status}: {r.read()[:200].decode(errors='replace')}"
        except urllib.error.HTTPError as e:
            return False, f"HTTP {e.code}: {e.read()[:200].decode(errors='replace')}"
        except Exception as ex:
            return False, str(ex)

    # style 1: multipart file upload (field name "file"), the common "upload csv" shape
    boundary = "----fieldline" + str(int(time.time()))
    part = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{eui}.csv"\r\n'
            f"Content-Type: text/csv\r\n\r\n{csv_body}\r\n--{boundary}--\r\n").encode()
    ok, info = attempt(part, f"multipart/form-data; boundary={boundary}")
    log(f"push {eui} multipart -> {info}")
    if ok:
        return True
    # style 2: raw CSV body
    ok, info = attempt(csv_body.encode(), "text/csv")
    log(f"push {eui} raw-csv -> {info}")
    return ok

def queue_pending(reading: dict):
    with open(PENDING, "a") as f:
        f.write(json.dumps(reading) + "\n")

def retry_loop():
    while True:
        time.sleep(60)
        if not DATAHUB_URL or not os.path.exists(PENDING):
            continue
        lines = open(PENDING).read().splitlines()
        if not lines:
            continue
        remaining = []
        for ln in lines:
            try:
                r = json.loads(ln)
            except Exception:
                continue
            if not push(r):
                remaining.append(ln)
        open(PENDING, "w").write("\n".join(remaining) + ("\n" if remaining else ""))
        log(f"retry pass: {len(lines)-len(remaining)} sent, {len(remaining)} still pending")

def on_connect(client, userdata, flags, rc):
    client.subscribe("application/+/device/+/event/up")
    log(f"MQTT connected rc={rc}; watching {list(DEVICE_TOKENS)}; endpoint={'SET' if DATAHUB_URL else 'NOT SET (queueing)'}")

def on_message(client, userdata, msg):
    try:
        e = json.loads(msg.payload)
        di = e.get("deviceInfo", {})
        eui = (di.get("devEui") or "").lower()
        if eui not in DEVICE_TOKENS:
            return
        reading = {"devEui": eui, "device": di.get("deviceName"),
                   "time": e.get("time"), "data": e.get("object") or {}}
        if not push(reading):
            queue_pending(reading)
            log(f"queued reading from {eui} (pending: endpoint unset or down)")
    except Exception as ex:
        log("handler error:", ex)

if __name__ == "__main__":
    threading.Thread(target=retry_loop, daemon=True).start()
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
            log("mqtt reconnect in 5s:", ex)
            time.sleep(5)
