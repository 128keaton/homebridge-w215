import type {AccessoryConfig, AccessoryPlugin, API, CharacteristicValue, HAP, Logging, Service} from 'homebridge';
import {type CharacteristicConstructor, createEveCharacteristics} from './eve-characteristics.js';
import {HnapError, type ModuleIds, SoapClient} from './lib/soap.js';

const DEFAULT_POLLING_SECONDS = 15;
const MIN_POLLING_SECONDS = 5;
const DEFAULT_TIMEOUT_SECONDS = 5;
const RETRY_DELAY_MS = 30_000;

interface PlugConfig extends AccessoryConfig {
  host?: string;
  username?: string;
  password?: string | number;
  pollingInterval?: number;
  timeout?: number;
  disableTemperature?: boolean;
  disablePowerMeter?: boolean;
}

let hap: HAP;

export default (api: API) => {
  hap = api.hap;
  api.registerAccessory('DSP-W215', PlugAccessory);
};

class PlugAccessory implements AccessoryPlugin {
  private readonly outletService: Service;
  private readonly temperatureService?: Service;
  private readonly informationService: Service;

  private readonly soapClient?: SoapClient;
  private readonly pollingMs: number;
  private readonly watts?: CharacteristicConstructor;

  private modules: ModuleIds = {};
  private discovered = false;

  private isOn?: boolean;
  private temperature?: number;
  private power?: number;

  /** Incremented on every successful set, so an older in-flight poll can't overwrite a newer state. */
  private stateVersion = 0;
  private reachable = false;
  private lastError?: string;
  private pollTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  private firstPoll: Promise<void>;

  constructor(
    private readonly log: Logging,
    private readonly config: PlugConfig,
    private readonly api: API,
  ) {
    const name = this.config.name || 'DSP-W215';
    const host = PlugAccessory.cleanHost(this.config.host);
    const password = this.config.password === undefined ? '' : String(this.config.password);

    const seconds = Number(this.config.pollingInterval) || DEFAULT_POLLING_SECONDS;
    this.pollingMs = Math.max(seconds, MIN_POLLING_SECONDS) * 1000;

    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'D-Link')
      .setCharacteristic(hap.Characteristic.Model, 'DSP-W215')
      .setCharacteristic(hap.Characteristic.SerialNumber, 'Unknown');

    this.outletService = new hap.Service.Outlet(name);
    this.outletService
      .getCharacteristic(hap.Characteristic.On)
      .onGet(() => this.read(() => this.isOn))
      .onSet((value) => this.setPower(value));
    this.outletService
      .getCharacteristic(hap.Characteristic.OutletInUse)
      .onGet(() => this.read(() => (this.isOn === undefined ? undefined : this.isInUse())));

    if (!this.config.disablePowerMeter) {
      const {Watts} = createEveCharacteristics(hap);
      this.watts = Watts;
      this.outletService.addOptionalCharacteristic(Watts);
      this.outletService.getCharacteristic(Watts).onGet(() => this.read(() => this.power));
    }

    if (!this.config.disableTemperature) {
      this.temperatureService = new hap.Service.TemperatureSensor(`${name} Temperature`);
      this.temperatureService
        .getCharacteristic(hap.Characteristic.CurrentTemperature)
        .setProps({minValue: -40, maxValue: 125})
        .onGet(() => this.read(() => this.temperature));
    }

    this.firstPoll = Promise.resolve();

    if (!host) {
      this.lastError = 'No "host" configured';
      this.log.error('No "host" configured. Set the plug\'s IP address in the accessory config.');
      return;
    }

    if (!password) {
      this.lastError = 'No "password" configured';
      this.log.error('No "password" configured. Set the plug\'s PIN (printed on the back of the device).');
      return;
    }

    this.soapClient = new SoapClient({
      url: `http://${host}/HNAP1`,
      username: this.config.username || 'admin',
      password,
      timeoutMs: Math.max(Number(this.config.timeout) || DEFAULT_TIMEOUT_SECONDS, 1) * 1000,
      logger: {debug: (message) => this.log.debug(message)},
    });

    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
      }
    });

    this.firstPoll = this.poll();
  }

  identify(): void {
    this.log.info('DSP-W215 identified');
  }

  getServices(): Service[] {
    return [this.informationService, this.outletService, ...(this.temperatureService ? [this.temperatureService] : [])];
  }

  /**
   * Answers a HomeKit read from the cache. Until the first poll has finished the request waits for it,
   * and while the plug is unreachable HomeKit is told so ("No Response") instead of being given stale data.
   */
  private async read<T>(getValue: () => T | undefined): Promise<T> {
    await this.firstPoll;

    const value = getValue();
    if (!this.reachable || value === undefined) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    return value;
  }

  private async setPower(value: CharacteristicValue): Promise<void> {
    if (!this.soapClient) {
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const target = value as boolean;
    this.log.debug(`Setting state: ${target ? 'ON' : 'OFF'}`);

    try {
      await this.soapClient.setState(target);
    } catch (error) {
      this.log.error(`Could not switch ${target ? 'on' : 'off'}: ${PlugAccessory.message(error)}`);
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.stateVersion++;
    this.isOn = target;
    this.markReachable();

    if (!target) {
      this.power = 0;
    }

    this.publish();
  }

  private async poll(): Promise<void> {
    const client = this.soapClient;
    if (!client || this.shuttingDown) {
      return;
    }

    let retryEarly = false;

    try {
      if (!this.discovered) {
        await this.discover(client);
      }

      await this.refresh(client);
    } catch (error) {
      this.markUnreachable(error);
      // Back off while setup hasn't completed or the PIN is being rejected (don't hammer the plug's login).
      retryEarly = !this.discovered || (error instanceof HnapError && error.kind === 'auth');
    }

    if (!this.shuttingDown) {
      this.pollTimer = setTimeout(() => void this.poll(), retryEarly ? Math.max(RETRY_DELAY_MS, this.pollingMs) : this.pollingMs);
    }
  }

  private async discover(client: SoapClient): Promise<void> {
    const info = await client.getDeviceInfo();
    this.log.debug(`Device info: ${JSON.stringify(info)}`);

    if (info.model) {
      this.informationService.updateCharacteristic(hap.Characteristic.Model, info.model);
    }

    if (info.macAddress) {
      this.informationService.updateCharacteristic(hap.Characteristic.SerialNumber, info.macAddress);
    }

    if (info.firmwareVersion) {
      this.informationService.updateCharacteristic(hap.Characteristic.FirmwareRevision, info.firmwareVersion);
    }

    if (info.hardwareVersion) {
      this.informationService.updateCharacteristic(hap.Characteristic.HardwareRevision, info.hardwareVersion);
    }

    this.modules = await client.discoverModules();
    this.log.debug(`Modules: ${JSON.stringify(this.modules)}`);

    if (!this.config.disableTemperature && this.modules.temperature === undefined) {
      this.log.warn('This plug does not report a temperature module; the temperature sensor will show "No Response".');
    }

    if (!this.config.disablePowerMeter && this.modules.power === undefined) {
      this.log.warn('This plug does not report a power meter module; power readings are unavailable.');
    }

    this.discovered = true;
  }

  /** Reads everything from the plug. The switch state is required; the sensors are best-effort. */
  private async refresh(client: SoapClient): Promise<void> {
    const version = this.stateVersion;
    const isOn = await client.getState();

    let temperature = this.temperature;
    if (this.temperatureService && this.modules.temperature !== undefined) {
      try {
        temperature = await client.getTemperature(this.modules.temperature);
      } catch (error) {
        this.log.debug(`Could not read temperature: ${PlugAccessory.message(error)}`);
      }
    }

    let power = this.power;
    if (this.watts && this.modules.power !== undefined) {
      try {
        power = await client.getPowerConsumption(this.modules.power);
      } catch (error) {
        this.log.debug(`Could not read power consumption: ${PlugAccessory.message(error)}`);
      }
    }

    if (version === this.stateVersion) {
      this.isOn = isOn;
    }

    this.temperature = temperature;
    this.power = power;
    this.markReachable();
    this.publish();
  }

  private publish(): void {
    const {Characteristic} = hap;

    if (this.isOn !== undefined) {
      this.outletService.updateCharacteristic(Characteristic.On, this.isOn);
      this.outletService.updateCharacteristic(Characteristic.OutletInUse, this.isInUse());
    }

    if (this.watts && this.power !== undefined) {
      this.outletService.updateCharacteristic(this.watts, this.power);
    }

    if (this.temperatureService && this.temperature !== undefined) {
      this.temperatureService.updateCharacteristic(Characteristic.CurrentTemperature, this.temperature);
    }
  }

  private isInUse(): boolean {
    return !!this.isOn && (this.power === undefined || this.power > 0);
  }

  private markReachable(): void {
    if (!this.reachable) {
      this.log.info(this.lastError ? 'Plug is reachable again' : 'Plug is reachable');
    }

    this.reachable = true;
    this.lastError = undefined;
  }

  private markUnreachable(error: unknown): void {
    const message = PlugAccessory.message(error);

    // Only log when something changes so a plug that is unplugged doesn't flood the log.
    if (message !== this.lastError) {
      this.log.warn(`Plug is not responding: ${message}`);
    }

    this.lastError = message;
    this.reachable = false;

    const failure = new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    this.outletService.updateCharacteristic(hap.Characteristic.On, failure);
    this.temperatureService?.updateCharacteristic(hap.Characteristic.CurrentTemperature, failure);
  }

  private static message(error: unknown): string {
    if (error instanceof HnapError || error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private static cleanHost(host?: string): string {
    return (host || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '');
  }
}
