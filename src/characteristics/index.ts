import type {
  Characteristic as CharacteristicType,
  WithUUID,
} from 'homebridge';

import TotalConsumption from './TotalConsumption';
import ACMode from './ACMode';

export default function characteristic(
  Characteristic: typeof CharacteristicType,
): Record<
  | 'TotalConsumption'
  | 'ACMode',
  WithUUID<new () => CharacteristicType>
> {

  return {
    TotalConsumption: TotalConsumption(Characteristic),
    ACMode: ACMode(Characteristic),
  };
}
