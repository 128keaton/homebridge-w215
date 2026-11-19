import type {Characteristic, HAP, WithUUID} from 'homebridge';

export type CharacteristicConstructor = WithUUID<new () => Characteristic>;

/**
 * Eve's custom "Consumption" characteristic. The Home app ignores it, but Eve (and other HomeKit
 * apps that understand Eve characteristics) show the live wattage.
 */
export function createEveCharacteristics(hap: HAP): {Watts: CharacteristicConstructor} {
  class Watts extends hap.Characteristic {
    static readonly UUID: string = 'E863F10D-079E-48FF-8F27-9C2605A29F52';

    constructor() {
      super('Consumption', Watts.UUID, {
        format: hap.Formats.FLOAT,
        unit: 'W',
        minValue: 0,
        maxValue: 65535,
        minStep: 0.1,
        perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  return {Watts};
}
