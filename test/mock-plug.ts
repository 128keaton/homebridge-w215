import {createHmac, randomBytes} from 'node:crypto';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

const NS = 'http://purenetworks.com/HNAP1/';

const hmac = (key: string, data: string) => createHmac('md5', key).update(data, 'utf8').digest('hex').toUpperCase();
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

/**
 * A fake DSP-W215 that speaks HNAP the way the real firmware 1.11 does, including its quirks:
 *  - the socket, temperature sensor and power meter live in modules 1, 2 and 3
 *  - asking the wrong module for a reading answers `ERROR` together with a bogus `0`
 *  - GetModuleSOAPActions returns malformed XML (every action is opened as `Acton`)
 *  - requests without a valid session get HTTP 401
 */
export class MockPlug {
  public isOn = true;
  public temperature = 37;
  public watts = 7;
  public requests: string[] = [];
  public logins = 0;
  /** When set, requests are dropped without an answer. */
  public hang = false;
  /** When set, every authenticated request is answered with 401 even right after a successful login. */
  public rejectSessions = false;

  private server: Server;
  private sessions = new Map<string, string>();

  constructor(public readonly pin = '123456') {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  public async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/HNAP1`;
  }

  public async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Forget every session, like a plug that rebooted. */
  public dropSessions(): void {
    this.sessions.clear();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (this.hang) {
        return;
      }

      const body = Buffer.concat(chunks).toString('utf8');
      const action = (req.headers.soapaction as string).replace(/"/g, '').replace(NS, '');
      this.requests.push(action);

      if (action === 'Login') {
        this.login(req, body, res);
        return;
      }

      if (!this.authorized(req, action)) {
        res.writeHead(401, {'Content-Type': 'text/xml'});
        res.end(
          '<soap:Envelope><soap:Body><soap:Fault><faultstring>401 Unauthorized</faultstring></soap:Fault>' + '</soap:Body></soap:Envelope>',
        );
        return;
      }

      this.respond(res, action, body);
    });
  }

  private login(req: IncomingMessage, body: string, res: ServerResponse): void {
    if (tag(body, 'Action') === 'request') {
      const challenge = randomBytes(8).toString('hex');
      const cookie = randomBytes(5).toString('hex');
      const publicKey = randomBytes(8).toString('hex');
      this.sessions.set(cookie, hmac(publicKey + this.pin, challenge));
      this.pending = {challenge, cookie};
      this.send(
        res,
        'Login',
        `<LoginResult>OK</LoginResult><Challenge>${challenge}</Challenge><Cookie>${cookie}</Cookie><PublicKey>${publicKey}</PublicKey>`,
      );
      return;
    }

    const cookie = /uid=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
    const privateKey = this.sessions.get(cookie);
    const expected = privateKey && this.pending ? hmac(privateKey, this.pending.challenge) : undefined;

    if (expected && tag(body, 'LoginPassword') === expected) {
      this.logins++;
      this.send(res, 'Login', '<LoginResult>success</LoginResult>');
    } else {
      this.sessions.delete(cookie);
      this.send(res, 'Login', '<LoginResult>fail</LoginResult>');
    }
  }

  private pending?: {challenge: string; cookie: string};

  private authorized(req: IncomingMessage, action: string): boolean {
    const cookie = /uid=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
    const privateKey = this.sessions.get(cookie);
    const [signature, timestamp] = ((req.headers.hnap_auth as string) || '').split(' ');

    return !this.rejectSessions && !!privateKey && signature === hmac(privateKey, `${timestamp}"${NS}${action}"`);
  }

  private respond(res: ServerResponse, action: string, body: string): void {
    const moduleId = tag(body, 'ModuleID');

    switch (action) {
      case 'GetDeviceSettings':
        this.send(
          res,
          action,
          '<Type>ConnectedHomeClient</Type><DeviceName>DSP-W215</DeviceName><VendorName>D-Link</VendorName>' +
            '<ModelName>DSP-W215</ModelName><DeviceMacId>E8:CC:18:83:22:FF</DeviceMacId>' +
            '<FirmwareVersion>1.11</FirmwareVersion><HardwareVersion>A1</HardwareVersion>',
        );
        break;
      case 'GetModuleSOAPActions':
        this.send(
          res,
          action,
          '<ModuleSOPAList>' +
            '<SOAPActions><ModuleID>1</ModuleID><Acton>GetSocketSettings</Action><Acton>SetSocketSettings</Action></SOAPActions>' +
            '<SOAPActions><ModuleID>2</ModuleID><Acton>GetCurrentTemperature</Action></SOAPActions>' +
            '<SOAPActions><ModuleID>3</ModuleID><Acton>GetCurrentPowerConsumption</Action></SOAPActions>' +
            '</ModuleSOPAList>',
        );
        break;
      case 'GetSocketSettings':
        this.send(
          res,
          action,
          `<SocketInfoList><SocketInfo><ModuleID>1</ModuleID><OPStatus>${this.isOn}</OPStatus></SocketInfo></SocketInfoList>`,
        );
        break;
      case 'SetSocketSettings':
        this.isOn = tag(body, 'OPStatus') === 'true';
        this.send(res, action, '');
        break;
      case 'GetCurrentTemperature':
        this.send(
          res,
          action,
          `<CurrentTemperature>${moduleId === '2' ? this.temperature : 0}</CurrentTemperature>`,
          moduleId === '2' ? 'OK' : 'ERROR',
        );
        break;
      case 'GetCurrentPowerConsumption':
        this.send(
          res,
          action,
          `<CurrentConsumption>${moduleId === '3' ? this.watts : 0}</CurrentConsumption>`,
          moduleId === '3' ? 'OK' : 'ERROR',
        );
        break;
      default:
        this.send(res, action, '', 'ERROR');
    }
  }

  private send(res: ServerResponse, action: string, inner: string, result = 'OK'): void {
    const resultTag = action === 'Login' ? '' : `<${action}Result>${result}</${action}Result>`;
    res.writeHead(200, {'Content-Type': 'text/xml'});
    res.end(
      '<?xml version="1.0" encoding="utf-8"?><soap:Envelope><soap:Body>' +
        `<${action}Response xmlns="${NS}">${resultTag}${inner}</${action}Response></soap:Body></soap:Envelope>`,
    );
  }
}
