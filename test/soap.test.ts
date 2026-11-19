import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {type HnapError, SoapClient} from '../src/lib/soap.js';
import {MockPlug} from './mock-plug.js';

describe('SoapClient (against a mock plug)', () => {
  let plug: MockPlug;
  let url: string;

  const client = (password = plug.pin, timeoutMs = 2000) => new SoapClient({url, password, timeoutMs});

  beforeEach(async () => {
    plug = new MockPlug('123456');
    url = await plug.start();
  });

  afterEach(async () => {
    await plug.stop();
  });

  it('logs in lazily and reads the switch state', async () => {
    const soap = client();
    assert.equal(await soap.getState(), true);
    assert.equal(plug.logins, 1);

    plug.isOn = false;
    assert.equal(await soap.getState(), false);
    assert.equal(plug.logins, 1, 'the session is reused');
  });

  it('switches the plug on and off', async () => {
    const soap = client();
    await soap.setState(false);
    assert.equal(plug.isOn, false);
    await soap.setState(true);
    assert.equal(plug.isOn, true);
  });

  it('rejects a wrong PIN with an auth error', async () => {
    await assert.rejects(client('000000').getState(), (error: HnapError) => {
      assert.equal(error.kind, 'auth');
      return true;
    });
  });

  it('discovers which module is which, tolerating the malformed XML', async () => {
    assert.deepEqual(await client().discoverModules(), {socket: 1, temperature: 2, power: 3});
  });

  it('reads temperature and power from the discovered modules', async () => {
    const soap = client();
    assert.equal(await soap.getTemperature(2), 37);
    assert.equal(await soap.getPowerConsumption(3), 7);
  });

  it('treats an ERROR result as a failure instead of returning the bogus 0', async () => {
    const soap = client();
    await assert.rejects(soap.getTemperature(3), (error: HnapError) => error.kind === 'protocol');
    await assert.rejects(soap.getPowerConsumption(2), (error: HnapError) => error.kind === 'protocol');
  });

  it('reads device information', async () => {
    assert.deepEqual(await client().getDeviceInfo(), {
      name: 'DSP-W215',
      vendor: 'D-Link',
      model: 'DSP-W215',
      macAddress: 'E8:CC:18:83:22:FF',
      firmwareVersion: '1.11',
      hardwareVersion: 'A1',
    });
  });

  it('logs in again once when the plug forgets the session', async () => {
    const soap = client();
    await soap.getState();
    plug.dropSessions();

    assert.equal(await soap.getState(), true);
    assert.equal(plug.logins, 2);
  });

  it('does not retry forever when the plug keeps rejecting the session', async () => {
    const soap = client();
    await soap.getState();
    plug.requests = [];

    plug.rejectSessions = true;
    await assert.rejects(soap.getState(), (error: HnapError) => error.kind === 'auth');

    // 1st attempt, login (2 requests), 2nd attempt - and then it gives up.
    assert.deepEqual(plug.requests, ['GetSocketSettings', 'Login', 'Login', 'GetSocketSettings']);
  });

  it('times out instead of hanging when the plug does not answer', async () => {
    plug.hang = true;
    const started = Date.now();

    await assert.rejects(client(plug.pin, 300).getState(), (error: HnapError) => error.kind === 'network');
    assert.ok(Date.now() - started < 2000);
  });

  it('reports a network error when nothing is listening', async () => {
    await plug.stop();
    await assert.rejects(client().getState(), (error: HnapError) => error.kind === 'network');
    plug = new MockPlug();
    url = await plug.start();
  });

  it('sends one request at a time', async () => {
    const soap = client();
    const results = await Promise.all([soap.getState(), soap.getTemperature(2), soap.getPowerConsumption(3), soap.getState()]);
    assert.deepEqual(results, [true, 37, 7, true]);
    assert.equal(plug.logins, 1, 'concurrent calls share a single login');
  });

  it('escapes the username in the login request', async () => {
    const soap = new SoapClient({url, password: plug.pin, username: 'a<b>&"c', timeoutMs: 2000});
    assert.equal(await soap.getState(), true);
  });
});
