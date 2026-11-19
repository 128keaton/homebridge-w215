/*
 * Integration tests against a real plug. Skipped unless W215_HOST and W215_PIN are set:
 *
 *   W215_HOST=10.0.1.102 W215_PIN=123456 npm test
 *
 * These only read from the plug. The switching test additionally needs W215_ALLOW_SWITCH=1, because it
 * briefly toggles whatever is plugged in (the original state is restored afterwards).
 */
import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {SoapClient} from '../src/lib/soap.js';

const host = process.env.W215_HOST;
const pin = process.env.W215_PIN ?? '';
const enabled = !!host && !!pin;
const allowSwitch = process.env.W215_ALLOW_SWITCH === '1';

describe('live plug', {skip: enabled ? false : 'set W215_HOST and W215_PIN to run'}, () => {
  const client = () => new SoapClient({url: `http://${host}/HNAP1`, password: pin, timeoutMs: 8000});

  it('logs in and reads device info', async (t) => {
    const info = await client().getDeviceInfo();
    t.diagnostic(`device: ${JSON.stringify(info)}`);
    assert.ok(info.model, 'model name');
    assert.ok(info.macAddress, 'mac address');
  });

  it('rejects a wrong PIN', async () => {
    const wrong = new SoapClient({url: `http://${host}/HNAP1`, password: pin === '000000' ? '111111' : '000000', timeoutMs: 8000});
    await assert.rejects(wrong.getState(), /PIN|rejected|unauthorized/i);
  });

  it('discovers modules, then reads state, temperature and power from them', async (t) => {
    const soap = client();
    const modules = await soap.discoverModules();
    t.diagnostic(`modules: ${JSON.stringify(modules)}`);

    const {socket, temperature: temperatureModule, power: powerModule} = modules;
    assert.ok(socket !== undefined && temperatureModule !== undefined && powerModule !== undefined);

    const [state, temperature, watts] = [
      await soap.getState(),
      await soap.getTemperature(temperatureModule),
      await soap.getPowerConsumption(powerModule),
    ];
    t.diagnostic(`state=${state} temperature=${temperature}C power=${watts}W`);

    assert.equal(typeof state, 'boolean');
    assert.ok(temperature > 0 && temperature < 100, `plausible temperature, got ${temperature}`);
    assert.ok(watts >= 0 && watts < 4000, `plausible wattage, got ${watts}`);
  });

  it('reuses one session for several calls', async () => {
    const soap = client();
    for (let i = 0; i < 5; i++) {
      await soap.getState();
    }
  });

  it('switches the plug and restores it', {skip: allowSwitch ? false : 'set W215_ALLOW_SWITCH=1 to run'}, async () => {
    const soap = client();
    const original = await soap.getState();

    try {
      await soap.setState(!original);
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(await soap.getState(), !original);
    } finally {
      await soap.setState(original);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await soap.getState(), original);
  });
});
