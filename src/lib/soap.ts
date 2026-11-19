import {createHmac} from 'node:crypto';
import {HNAPMethod} from '../enum/index.js';
import type {DeviceInfo} from '../type/device-info.type.js';
import {escapeXml, readBlocks, readTag} from './xml.js';

const HNAP1_XMLNS = 'http://purenetworks.com/HNAP1/';
const SOCKET_MODULE_ID = 1;
const MAX_LOGGED_BODY = 500;

export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * network  - the plug could not be reached, or did not answer in time
 * auth     - the plug rejected the username/PIN
 * protocol - the plug answered, but not with something we understand (or reported an error)
 */
export type HnapErrorKind = 'network' | 'auth' | 'protocol';

export class HnapError extends Error {
  constructor(
    message: string,
    public readonly kind: HnapErrorKind,
  ) {
    super(message);
    this.name = 'HnapError';
  }
}

export interface SoapLogger {
  debug(message: string): void;
}

export interface SoapClientOptions {
  url: string;
  password: string;
  username?: string;
  timeoutMs?: number;
  logger?: SoapLogger;
}

/**
 * Module IDs differ between models and firmware revisions (a DSP-W215 on firmware 1.11 exposes the
 * temperature sensor as module 2 and the power meter as module 3), so they are discovered from the device.
 */
export interface ModuleIds {
  socket?: number;
  temperature?: number;
  power?: number;
}

interface Session {
  privateKey: string;
  cookie: string;
}

interface HttpResult {
  status: number;
  text: string;
}

function hmacMd5(key: string, data: string): string {
  return createHmac('md5', key).update(data, 'utf8').digest('hex').toUpperCase();
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return 'timed out';
    }

    const cause = (error as {cause?: {code?: string; message?: string}}).cause;
    return cause?.code ?? cause?.message ?? error.message;
  }

  return String(error);
}

export class SoapClient {
  private readonly url: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly logger?: SoapLogger;

  private session?: Session;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: SoapClientOptions) {
    this.url = options.url;
    this.password = options.password;
    this.username = options.username || 'admin';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger;
  }

  /** Forces a fresh login. Other calls log in automatically when they need to. */
  public login(): Promise<void> {
    return this.enqueue(async () => {
      this.session = undefined;
      this.session = await this.performLogin();
    });
  }

  public async getState(): Promise<boolean> {
    const text = await this.call(HNAPMethod.GetState, SoapClient.moduleParameters(SOCKET_MODULE_ID));
    const status = readTag(text, 'OPStatus')?.toLowerCase();

    if (status !== 'true' && status !== 'false') {
      throw new HnapError(`Unexpected socket state: ${status}`, 'protocol');
    }

    return status === 'true';
  }

  public async setState(isOn: boolean): Promise<void> {
    await this.call(
      HNAPMethod.SetState,
      SoapClient.moduleParameters(SOCKET_MODULE_ID) +
        '<NickName>Socket 1</NickName><Description>Socket 1</Description>' +
        `<OPStatus>${isOn}</OPStatus><Controller>1</Controller>`,
    );
  }

  /** Current temperature in degrees Celsius. */
  public async getTemperature(moduleId: number): Promise<number> {
    const text = await this.call(HNAPMethod.GetTemperature, SoapClient.moduleParameters(moduleId));
    return SoapClient.readNumber(text, 'CurrentTemperature');
  }

  /** Current power draw in watts. */
  public async getPowerConsumption(moduleId: number): Promise<number> {
    const text = await this.call(HNAPMethod.GetPowerConsumption, SoapClient.moduleParameters(moduleId));
    return SoapClient.readNumber(text, 'CurrentConsumption');
  }

  public async getDeviceInfo(): Promise<DeviceInfo> {
    const text = await this.call(HNAPMethod.GetDeviceSettings);

    return {
      name: readTag(text, 'DeviceName') || undefined,
      vendor: readTag(text, 'VendorName') || undefined,
      model: readTag(text, 'ModelName') || undefined,
      macAddress: readTag(text, 'DeviceMacId') || undefined,
      firmwareVersion: readTag(text, 'FirmwareVersion') || undefined,
      hardwareVersion: readTag(text, 'HardwareVersion') || undefined,
    };
  }

  /** Finds which module provides the socket, temperature sensor and power meter. */
  public async discoverModules(): Promise<ModuleIds> {
    const text = await this.call(HNAPMethod.GetModuleSOAPActions, SoapClient.moduleParameters(0));
    const modules: ModuleIds = {};

    for (const block of readBlocks(text, 'SOAPActions')) {
      const id = parseInt(readTag(block, 'ModuleID') ?? '', 10);

      if (Number.isNaN(id)) {
        continue;
      }

      if (block.includes(`>${HNAPMethod.GetState}<`)) {
        modules.socket ??= id;
      }

      if (block.includes(`>${HNAPMethod.GetTemperature}<`)) {
        modules.temperature ??= id;
      }

      if (block.includes(`>${HNAPMethod.GetPowerConsumption}<`)) {
        modules.power ??= id;
      }
    }

    return modules;
  }

  /**
   * The plug is a tiny embedded web server, so requests are sent strictly one at a time.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private call(method: HNAPMethod, parameters = ''): Promise<string> {
    return this.enqueue(async () => {
      for (let attempt = 0; ; attempt++) {
        if (!this.session) {
          this.session = await this.performLogin();
        }

        const response = await this.post(method, parameters, this.session);

        if (response.status === 401) {
          // The plug forgot our session (reboot, timeout, ...). Log in again, but only once per call.
          this.session = undefined;

          if (attempt === 0) {
            this.logger?.debug(`${method}: session rejected, logging in again`);
            continue;
          }

          throw new HnapError(`${method}: still unauthorized after logging in again`, 'auth');
        }

        if (response.status !== 200) {
          throw new HnapError(`${method} failed with HTTP ${response.status}`, 'protocol');
        }

        this.logger?.debug(`${method} <- ${response.text.slice(0, MAX_LOGGED_BODY)}`);

        const result = readTag(response.text, `${method}Result`);
        if (result !== undefined && result !== 'OK') {
          throw new HnapError(`${method} was not accepted by the plug (result: ${result})`, 'protocol');
        }

        return response.text;
      }
    });
  }

  private async performLogin(): Promise<Session> {
    this.logger?.debug('Logging in');
    const username = escapeXml(this.username);

    const first = await this.post(
      HNAPMethod.Login,
      `<Action>request</Action><Username>${username}</Username><LoginPassword></LoginPassword><Captcha></Captcha>`,
    );

    if (first.status !== 200) {
      throw new HnapError(`Login request failed with HTTP ${first.status}`, 'protocol');
    }

    const challenge = readTag(first.text, 'Challenge');
    const cookie = readTag(first.text, 'Cookie');
    const publicKey = readTag(first.text, 'PublicKey');

    if (!challenge || !cookie || !publicKey) {
      throw new HnapError('The plug did not send a login challenge', 'protocol');
    }

    const privateKey = hmacMd5(publicKey + this.password, challenge);
    const session: Session = {privateKey, cookie};

    const second = await this.post(
      HNAPMethod.Login,
      '<Action>login</Action>' +
        `<Username>${username}</Username>` +
        `<LoginPassword>${hmacMd5(privateKey, challenge)}</LoginPassword>` +
        '<Captcha></Captcha>',
      session,
    );

    if (second.status === 200 && readTag(second.text, 'LoginResult')?.toLowerCase() === 'success') {
      return session;
    }

    if (second.status === 200 || second.status === 401) {
      throw new HnapError('Login rejected by the plug - check the username and PIN', 'auth');
    }

    throw new HnapError(`Login failed with HTTP ${second.status}`, 'protocol');
  }

  private async post(method: HNAPMethod, parameters: string, session?: Session): Promise<HttpResult> {
    const action = `"${HNAP1_XMLNS}${method}"`;
    const headers: Record<string, string> = {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: action,
    };

    if (session) {
      const timestamp = Math.round(Date.now() / 1000);
      headers.HNAP_AUTH = `${hmacMd5(session.privateKey, `${timestamp}${action}`)} ${timestamp}`;
      headers.Cookie = `uid=${session.cookie}`;
    }

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers,
        body: SoapClient.buildRequestBody(method, parameters),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      return {status: response.status, text: await response.text()};
    } catch (error) {
      throw new HnapError(`${method} request failed: ${describeFetchError(error)}`, 'network');
    }
  }

  private static readNumber(text: string, tag: string): number {
    const raw = readTag(text, tag);
    const value = raw === undefined || raw === '' ? NaN : parseFloat(raw);

    if (Number.isNaN(value)) {
      throw new HnapError(`Missing or invalid <${tag}> in response`, 'protocol');
    }

    return value;
  }

  private static buildRequestBody(method: HNAPMethod, parameters: string): string {
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
      'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap:Body>' +
      `<${method} xmlns="${HNAP1_XMLNS}">${parameters}</${method}>` +
      '</soap:Body></soap:Envelope>'
    );
  }

  private static moduleParameters(moduleId: number): string {
    return `<ModuleID>${moduleId}</ModuleID>`;
  }
}
