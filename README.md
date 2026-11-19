# homebridge-w215-kb

[Homebridge](https://homebridge.io) plugin for the **D-Link DSP-W215** smart plug.

| Feature | HomeKit |
| --- | --- |
| On / off | Outlet (including the "in use" indicator) |
| Temperature | Temperature sensor |
| Power draw (W) | Shown in [Eve](https://www.evehome.com/en/eve-app) via the Eve "Consumption" characteristic |
| Device info | Model, MAC address (serial number), firmware and hardware revision, read from the plug |

Changes made with the plug's physical button are picked up by background polling.

## Installation

```sh
npm install -g homebridge-w215-kb
```

Requires Node.js 22.12 or newer and Homebridge 1.6 or newer.

## Configuration

Use the Homebridge UI, or add one entry per plug to the `accessories` array in `config.json`:

```json
{
  "accessories": [
    {
      "accessory": "DSP-W215",
      "name": "Desk Lamp",
      "host": "192.168.1.50",
      "password": "123456"
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `name` | `DSP-W215` | Name shown in HomeKit. |
| `host` | – | IP address or hostname of the plug. Give it a reserved IP address in your router. |
| `password` | – | The PIN printed on the back of the plug, or the password you set in its web interface. Keep it in quotes so leading zeros survive. |
| `username` | `admin` | Only change this if you changed it in the plug's web interface. |
| `pollingInterval` | `15` | Seconds between polls (minimum 5). |
| `timeout` | `5` | Seconds to wait for the plug before giving up. |
| `disableTemperature` | `false` | Don't create the temperature sensor. |
| `disablePowerMeter` | `false` | Don't read power consumption. |

## Troubleshooting

* **"No Response" in the Home app** – the plug can't be reached or rejected the login. The Homebridge log says which
  (`timed out`, `ECONNREFUSED`, `Login rejected by the plug - check the username and PIN`, ...). The plug is a very small
  device: if it keeps dropping out, give it a better Wi-Fi signal and don't poll more often than you need to.
* **Run with `homebridge -D`** to log every request and response.
* **The DSP-W215 only supports the 2.4 GHz band** and is cloud-less once the mydlink service is disabled; this plugin talks
  to it directly over your LAN (HNAP over HTTP, port 80), so keep it on a trusted network.

## Development

```sh
npm install
npm run lint       # Biome: formatting, import order and lint rules
npm run lint:fix   # ...and apply the safe fixes
npm run build
npm test
```

`npm test` runs against an in-process mock plug that reproduces the real firmware's quirks (module numbering, `ERROR`
responses with a bogus `0`, malformed XML in `GetModuleSOAPActions`, `401` for unknown sessions).

To also run the read-only integration tests against a real plug:

```sh
W215_HOST=192.168.1.50 W215_PIN=123456 npm test
```

Add `W215_ALLOW_SWITCH=1` to include a test that briefly switches the plug off/on and restores its original state.
**This toggles whatever is plugged in.**

## Credits

The HNAP protocol details come from the community work in
[bikerp/dsp-w215-hnap](https://github.com/bikerp/dsp-w215-hnap) and [pyW215](https://github.com/LinuxChristian/pyW215).
