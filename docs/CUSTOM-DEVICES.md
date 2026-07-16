# Connecting custom / DIY LoRaWAN devices

Fieldline supports any LoRaWAN device, not just the built-in catalog. This is
how to bring your own hardware (EnviroDIY Mayfly dataloggers, Arduino builds,
any vendor's sensor) onto the network.

## What every LoRaWAN device needs

Three values make a device joinable (OTAA):

| Value | What it is | Where it comes from |
|---|---|---|
| **DevEUI** | 64-bit unique device ID | Factory-set on most radio modules (readable over AT commands); or pick your own for DIY builds |
| **JoinEUI** (AppEUI) | Application identifier | All zeros is fine for private networks; it just has to be set on the device |
| **AppKey** | AES-128 secret | Fieldline generates it when you register the sensor; you write the same value into the device |

Plus two radio settings:

- **Region / channels**: US915, **sub-band 2 (channels 8–15)** for Fieldline's default gateway config.
- **Activation**: OTAA (over-the-air), LoRaWAN 1.0.x, Class A.

## The flow in Fieldline

1. **Device types → Add type.** Name it, pick the LoRaWAN version your radio
   speaks, and paste a payload decoder (a `decodeUplink(input)` JavaScript
   function). A starter decoder is prefilled that passes raw bytes through, so
   you can see data arrive before writing the real one.
2. **Sensors → Add sensor.** Pick your new type, enter the DevEUI, and get the
   generated AppKey plus DIY setup steps.
3. Program the device (see module cheat sheet below), power it, and watch it
   turn online.

## Radio module cheat sheet

**Seeed Wio-E5 / LoRa-E5** (UART AT commands):
```
AT+ID                        # read factory DevEUI
AT+KEY=APPKEY,"<32-hex-key>" # write the Fieldline-generated key
AT+DR=US915
AT+CH=NUM,8-15               # sub-band 2
AT+MODE=LWOTAA
AT+JOIN
AT+MSGHEX="0102"             # test uplink
```

**Digi XBee LR** (Bee socket, LoRaWAN 1.0.4): configure with Digi's XBee
Studio — read the factory DevEUI, set Join EUI (zeros ok) and Application Key,
region US915 with a sub-band 2 channel mask, then join and transmit from your
sketch via the XBee API/AT interface.

**Raw RFM95 + LMIC** (Arduino): put DevEUI/JoinEUI/AppKey in the sketch,
`LMIC_selectSubBand(1)` for US915 sub-band 2 (LMIC counts from 0).

## Example: EnviroDIY Mayfly dissolved-oxygen logger

The Mayfly has a Bee socket that takes a LoRaWAN radio (Digi XBee LR drops in;
a Wio-E5 wires to the Grove UART). A compact payload for a dissolved-oxygen
build (big-endian):

| Bytes | Field | Encoding |
|---|---|---|
| 0 | payload version | `0x01` |
| 1–2 | dissolved oxygen | uint16, ppm × 100 |
| 3–4 | probe raw voltage | uint16, mV × 10 |
| 5–6 | water temperature | int16, °C × 100 |
| 7–8 | logger battery | uint16, mV |

Matching decoder:

```js
function decodeUplink(input) {
  var b = input.bytes;
  if (b.length < 9 || b[0] !== 0x01) {
    return { data: { raw_length: b.length }, warnings: ["unknown payload version"] };
  }
  var u16 = function (i) { return (b[i] << 8) | b[i + 1]; };
  var i16 = function (i) { var v = u16(i); return v > 32767 ? v - 65536 : v; };
  return { data: {
    do_ppm: u16(1) / 100,
    do_mv: u16(3) / 10,
    water_temperature: i16(5) / 100,
    battery_mv: u16(7),
  } };
}
```

Tips for battery devices: send every 5–15 minutes, keep payloads under ~11
bytes for the most robust data rates, and remember Class A devices only receive
(e.g. config downlinks) right after they transmit.
