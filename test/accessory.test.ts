import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, it} from 'node:test';
import * as hapNodejs from '@homebridge/hap-nodejs';
import type {AccessoryPlugin, API, Characteristic, HAP, Logging, Service} from 'homebridge';
import register from '../src/accessory.js';
import {MockPlug} from './mock-plug.js';

type Constructor = new (log: Logging, config: Record<string, unknown>, api: API) => AccessoryPlugin;

/** Just enough of Homebridge's API for the plugin: the real HAP library, shutdown events and accessory registration. */
class TestApi extends EventEmitter {
  readonly hap = hapNodejs as unknown as HAP;
  accessory?: Constructor;

  registerAccessory(_name: string, accessoryClass: Constructor): void {
    this.accessory = accessoryClass;
  }
}

/** HAP rejects reads with the bare status code, and sets with the HapStatusError - accept both. */
const statusOf = (error: unknown): unknown => (typeof error === 'number' ? error : (error as {hapStatus?: number}).hapStatus);

function silentLog(messages: string[] = []): Logging {
  const log = ((message: string) => messages.push(message)) as unknown as Logging;
  for (const level of ['info', 'warn', 'error', 'debug', 'success'] as const) {
    (log as unknown as Record<string, unknown>)[level] = (message: string) => messages.push(`${level}: ${message}`);
  }
  return log;
}

describe('accessory (HomeKit characteristics against a mock plug)', () => {
  let plug: MockPlug;
  let url: string;
  let api: TestApi;

  const create = (overrides: Record<string, unknown> = {}, messages: string[] = []) => {
    register(api as unknown as API);
    assert.ok(api.accessory, 'the plugin registers an accessory');

    return new api.accessory(
      silentLog(messages),
      {
        name: 'Test Plug',
        host: new URL(url).host,
        password: plug.pin,
        timeout: 1,
        ...overrides,
      },
      api as unknown as API,
    );
  };

  const servicesOf = (accessory: AccessoryPlugin): Service[] => accessory.getServices?.() ?? [];

  const findCharacteristic = (accessory: AccessoryPlugin, serviceIndex: number, name: string): Characteristic | undefined =>
    servicesOf(accessory)[serviceIndex]?.characteristics.find((c) => c.displayName === name);

  const characteristic = (accessory: AccessoryPlugin, serviceIndex: number, name: string): Characteristic => {
    const found = findCharacteristic(accessory, serviceIndex, name);
    assert.ok(found, `no "${name}" characteristic on service ${serviceIndex}`);
    return found;
  };

  beforeEach(async () => {
    plug = new MockPlug('123456');
    url = await plug.start();
    api = new TestApi();
  });

  afterEach(async () => {
    api.emit('shutdown');
    await plug.stop();
  });

  it('exposes an outlet and a temperature sensor, and fills in the device information', async () => {
    const accessory = create();
    const [info, outlet, temperature] = servicesOf(accessory);

    assert.equal(outlet.UUID, api.hap.Service.Outlet.UUID);
    assert.equal(temperature.UUID, api.hap.Service.TemperatureSensor.UUID);

    await characteristic(accessory, 1, 'On').handleGetRequest();
    assert.equal(info.getCharacteristic(api.hap.Characteristic.SerialNumber).value, 'E8:CC:18:83:22:FF');
    assert.equal(info.getCharacteristic(api.hap.Characteristic.Model).value, 'DSP-W215');
    assert.equal(info.getCharacteristic(api.hap.Characteristic.FirmwareRevision).value, '1.11');
  });

  it('never leaks the PIN into the accessory information', async () => {
    const accessory = create();
    await characteristic(accessory, 1, 'On').handleGetRequest();

    for (const c of servicesOf(accessory)[0].characteristics) {
      assert.notEqual(String(c.value), plug.pin);
    }
  });

  it('answers reads with state, temperature and power from the right modules', async () => {
    const accessory = create();

    assert.equal(await characteristic(accessory, 1, 'On').handleGetRequest(), true);
    assert.equal(await characteristic(accessory, 1, 'Outlet In Use').handleGetRequest(), true);
    assert.equal(await characteristic(accessory, 1, 'Consumption').handleGetRequest(), 7);
    assert.equal(await characteristic(accessory, 2, 'Current Temperature').handleGetRequest(), 37);
  });

  it('switches the plug from HomeKit', async () => {
    const accessory = create();
    const on = characteristic(accessory, 1, 'On');
    await on.handleGetRequest();

    await on.handleSetRequest(false);
    assert.equal(plug.isOn, false);
    assert.equal(await on.handleGetRequest(), false);
    assert.equal(await characteristic(accessory, 1, 'Outlet In Use').handleGetRequest(), false);
  });

  it('reports a communication failure to HomeKit when switching fails, instead of pretending it worked', async () => {
    const accessory = create({timeout: 1});
    const on = characteristic(accessory, 1, 'On');
    await on.handleGetRequest();

    plug.hang = true;
    await assert.rejects(on.handleSetRequest(false), (error: unknown) => {
      assert.equal(statusOf(error), api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      return true;
    });
  });

  it('reports "No Response" rather than Off when the plug cannot be reached', async () => {
    plug.hang = true;
    const accessory = create({timeout: 1});

    await assert.rejects(characteristic(accessory, 1, 'On').handleGetRequest(), (error: unknown) => {
      assert.equal(statusOf(error), api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      return true;
    });
  });

  it('rejects a wrong PIN with a communication failure and keeps running', async () => {
    const messages: string[] = [];
    const accessory = create({password: '000000'}, messages);

    await assert.rejects(characteristic(accessory, 1, 'On').handleGetRequest());
    assert.ok(
      messages.some((m) => /PIN/.test(m)),
      messages.join('\n'),
    );
  });

  it('can leave out the temperature sensor and the power meter', async () => {
    const accessory = create({disableTemperature: true, disablePowerMeter: true});

    assert.equal(servicesOf(accessory).length, 2);
    assert.equal(findCharacteristic(accessory, 1, 'Consumption'), undefined);
    assert.equal(await characteristic(accessory, 1, 'On').handleGetRequest(), true);
    assert.ok(!plug.requests.includes('GetCurrentTemperature'));
    assert.ok(!plug.requests.includes('GetCurrentPowerConsumption'));
  });

  it('logs a clear error for a missing host or PIN instead of crashing', async () => {
    const messages: string[] = [];
    const noHost = create({host: ''}, messages);
    const noPin = create({password: undefined}, messages);

    assert.ok(messages.some((m) => /host/.test(m)));
    assert.ok(messages.some((m) => /password/.test(m)));
    await assert.rejects(characteristic(noHost, 1, 'On').handleGetRequest());
    await assert.rejects(characteristic(noPin, 1, 'On').handleGetRequest());
  });

  it('accepts a numeric PIN and a host with a scheme', async () => {
    const accessory = create({host: `http://${new URL(url).host}/`, password: 123456});
    assert.equal(await characteristic(accessory, 1, 'On').handleGetRequest(), true);
  });
});
