import type { WithUUID, Characteristic } from 'homebridge';
import { Formats, Perms } from 'homebridge';

export default function ACMode(
  DefaultCharacteristic: typeof Characteristic,
): WithUUID<new () => Characteristic> {
  return class ACMode extends DefaultCharacteristic {
    static readonly UUID = '4E9EF1BB-BC8A-4F54-A659-5C26E1845B0B';

    constructor() {
      super('AC Mode', ACMode.UUID, {
        format: Formats.UINT8,
        minValue: 0,
        maxValue: 3,
        perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY],
      });
    }
  };
}
