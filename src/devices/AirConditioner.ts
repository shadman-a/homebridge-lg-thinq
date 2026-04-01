import { AccessoryContext, BaseDevice } from '../baseDevice.js';
import { LGThinQHomebridgePlatform } from '../platform.js';
import { CharacteristicValue, Logger, PlatformAccessory, Service } from 'homebridge';
import { Device } from '../lib/Device.js';
import { EnumValue, RangeValue, ValueType } from '../lib/DeviceModel.js';
import { cToF, fToC, normalizeBoolean, normalizeNumber } from '../helper.js';

export enum ACModelType {
  AWHP = 'AWHP',
  RAC = 'RAC',
}

export enum FanSpeed {
  LOW = 2,
  LOW_MEDIUM = 3,
  MEDIUM = 4,
  MEDIUM_HIGH = 5,
  HIGH = 6,
}

const MAX_FAN_SPEED = 3;
const FAN_SPEED_MAP: number[] = [
  FanSpeed.LOW,
  FanSpeed.MEDIUM,
  FanSpeed.HIGH,
];
const FAN_ROTATION_SPEEDS: number[] = [15, 60, 100];

export enum ACModeOption {
  COOL = 0,
  FAN = 1,
  DRY = 2,
  ENERGY_SAVE = 3,
}

enum OpMode {
  AUTO = 6,
  COOL = 0,
  HEAT = 4,
  FAN = 2,
  DRY = 1,
  AIR_CLEAN = 5,
}

export type Config = {
  ac_swing_mode: string,
  ac_air_quality: boolean,
  ac_mode: string,
  ac_temperature_sensor: boolean,
  ac_humidity_sensor: boolean,
  ac_led_control: boolean,
  ac_fan_control: boolean,
  ac_jet_control: boolean,
  ac_temperature_unit: string,
  ac_buttons: { name: string, op_mode: string | number }[],
  ac_air_clean: boolean,
  ac_energy_save: boolean,
}

export default class AirConditioner extends BaseDevice {
  protected service: Service;
  protected serviceAirQuality: Service | undefined;
  protected serviceSensor: Service | undefined;
  protected serviceHumiditySensor: Service | undefined;
  protected serviceLight: Service | undefined;
  protected serviceFanV2: Service | undefined;
  protected serviceJetMode: Service | undefined;
  protected serviceQuietMode: Service | undefined;
  protected serviceEnergySaveMode: Service | undefined;
  protected serviceAirClean: Service | undefined;
  protected serviceLabelButtons: Service | undefined;

  protected jetModeModels = ['RAC_056905'];
  protected quietModeModels = ['WINF_056905'];
  protected airCleanModels = ['RAC_056905'];
  protected currentTargetState = 2;

  constructor(
    public readonly platform: LGThinQHomebridgePlatform,
    public readonly accessory: PlatformAccessory<AccessoryContext>,
    logger: Logger,
  ) {
    super(platform, accessory, logger);

    const device: Device = this.accessory.context.device;
    const {
      Service: {
        TemperatureSensor,
        HumiditySensor,
        Switch,
        Lightbulb,
        HeaterCooler,
      },
    } = this.platform;

    this.service = this.accessory.getService(HeaterCooler) || this.accessory.addService(HeaterCooler, device.name);
    this.service.addOptionalCharacteristic(this.platform.customCharacteristics.TotalConsumption);
    this.service.addOptionalCharacteristic(this.platform.customCharacteristics.ACMode);
    this.createHeaterCoolerService();

    if (this.config.ac_air_quality && this.Status.airQuality) {
      this.createAirQualityService();
    } else if (this.serviceAirQuality) {
      accessory.removeService(this.serviceAirQuality);
      this.serviceAirQuality = undefined;
    }

    this.serviceSensor = accessory.getService(TemperatureSensor) || undefined;
    if (this.config.ac_temperature_sensor) {
      this.serviceSensor = this.serviceSensor || accessory.addService(TemperatureSensor);
      this.serviceSensor.updateCharacteristic(platform.Characteristic.StatusActive, false);
      this.serviceSensor.addLinkedService(this.service);
    } else if (this.serviceSensor) {
      accessory.removeService(this.serviceSensor);
      this.serviceSensor = undefined;
    }

    this.serviceHumiditySensor = accessory.getService(HumiditySensor) || undefined;
    if (this.config.ac_humidity_sensor) {
      this.serviceHumiditySensor = this.serviceHumiditySensor || accessory.addService(HumiditySensor);
      this.serviceHumiditySensor.updateCharacteristic(platform.Characteristic.StatusActive, false);
      this.serviceHumiditySensor.addLinkedService(this.service);
    } else if (this.serviceHumiditySensor) {
      accessory.removeService(this.serviceHumiditySensor);
      this.serviceHumiditySensor = undefined;
    }

    this.serviceLight = accessory.getService(Lightbulb) || undefined;
    if (this.config.ac_led_control) {
      this.serviceLight = this.serviceLight || accessory.addService(Lightbulb);
      this.serviceLight.getCharacteristic(platform.Characteristic.On)
        .onSet(this.setLight.bind(this))
        .updateValue(false);
      this.serviceLight.addLinkedService(this.service);
    } else if (this.serviceLight) {
      accessory.removeService(this.serviceLight);
      this.serviceLight = undefined;
    }

    if (this.config.ac_fan_control) {
      this.createFanService();
    } else if (this.serviceFanV2) {
      accessory.removeService(this.serviceFanV2);
      this.serviceFanV2 = undefined;
    }

    if (this.config.ac_jet_control && this.supportsJetMode(device)) {
      this.serviceJetMode = accessory.getService('Jet Mode') || accessory.addService(Switch, 'Jet Mode', 'Jet Mode');
      this.serviceJetMode.addOptionalCharacteristic(platform.Characteristic.ConfiguredName);
      this.serviceJetMode.setCharacteristic(platform.Characteristic.ConfiguredName, device.name + ' Jet Mode');
      this.serviceJetMode.getCharacteristic(platform.Characteristic.On)
        .onSet(this.setJetModeActive.bind(this));
    } else if (this.serviceJetMode) {
      accessory.removeService(this.serviceJetMode);
      this.serviceJetMode = undefined;
    }

    if (this.supportsQuietMode(device)) {
      this.serviceQuietMode = accessory.getService('Quiet mode') || accessory.addService(Switch, 'Quiet mode', 'Quiet mode');
      this.serviceQuietMode.addOptionalCharacteristic(platform.Characteristic.ConfiguredName);
      this.serviceQuietMode.setCharacteristic(platform.Characteristic.ConfiguredName, device.name + ' Quiet mode');
      this.serviceQuietMode.getCharacteristic(platform.Characteristic.On)
        .onSet(this.setQuietModeActive.bind(this));
    } else if (this.serviceQuietMode) {
      accessory.removeService(this.serviceQuietMode);
      this.serviceQuietMode = undefined;
    }

    this.serviceEnergySaveMode = accessory.getService('Energy save') || undefined;
    if (this.isEnergySaveSupported(device) && this.config.ac_energy_save) {
      if (!this.serviceEnergySaveMode) {
        this.serviceEnergySaveMode = accessory.addService(Switch, 'Energy save', 'Energy save');
      }
      this.serviceEnergySaveMode.addOptionalCharacteristic(platform.Characteristic.ConfiguredName);
      this.serviceEnergySaveMode.setCharacteristic(platform.Characteristic.ConfiguredName, device.name + ' Energy save');
      this.serviceEnergySaveMode.getCharacteristic(platform.Characteristic.On)
        .onSet(this.setEnergySaveActive.bind(this));
    } else if (this.serviceEnergySaveMode) {
      accessory.removeService(this.serviceEnergySaveMode);
      this.serviceEnergySaveMode = undefined;
    }

    this.serviceAirClean = accessory.getService('Air Purify') || undefined;
    if (this.supportsAirClean(device) && this.config.ac_air_clean) {
      if (!this.serviceAirClean) {
        this.serviceAirClean = accessory.addService(Switch, 'Air Purify', 'Air Purify');
      }
      this.serviceAirClean.addOptionalCharacteristic(platform.Characteristic.ConfiguredName);
      this.serviceAirClean.setCharacteristic(platform.Characteristic.ConfiguredName, device.name + ' Air Purify');
      this.serviceAirClean.getCharacteristic(platform.Characteristic.On)
        .onSet(this.setAirCleanActive.bind(this));
    } else if (this.serviceAirClean) {
      accessory.removeService(this.serviceAirClean);
      this.serviceAirClean = undefined;
    }

    this.setupButton(device);

    setInterval(() => {
      if (device.online) {
        this.platform.ThinQ?.deviceControl(device.id, {
          dataKey: 'airState.mon.timeout',
          dataValue: '70',
        }, 'Set', 'allEventEnable', 'control').catch(() => {
          return;
        });
      }
    }, 60000);
  }

  public get config(): Config {
    return {
      ac_swing_mode: 'BOTH',
      ac_air_quality: false,
      ac_mode: 'COOLING',
      ac_temperature_sensor: false,
      ac_humidity_sensor: false,
      ac_led_control: false,
      ac_fan_control: false,
      ac_jet_control: false,
      ac_temperature_unit: 'C',
      ac_buttons: [],
      ac_air_clean: true,
      ac_energy_save: false,
      ...super.config,
    };
  }

  public get Status(): ACStatus {
    return new ACStatus(this.accessory.context.device.snapshot, this.accessory.context.device, this.config, this.logger);
  }

  protected supportsJetMode(device: Device) {
    return this.jetModeModels.includes(device.model);
  }

  protected supportsQuietMode(device: Device) {
    return this.quietModeModels.includes(device.model);
  }

  protected supportsAirClean(device: Device) {
    return this.airCleanModels.includes(device.model);
  }

  protected isEnergySaveSupported(device: Device) {
    return Object.prototype.hasOwnProperty.call(device.snapshot, 'airState.powerSave.basic');
  }

  protected createFanService() {
    const {
      Service: {
        Fanv2,
      },
      Characteristic,
    } = this.platform;
    const device: Device = this.accessory.context.device;

    this.serviceFanV2 = this.accessory.getService(Fanv2) || this.accessory.addService(Fanv2);
    this.serviceFanV2.addLinkedService(this.service);
    this.serviceFanV2.addOptionalCharacteristic(Characteristic.ConfiguredName);
    this.serviceFanV2.setCharacteristic(Characteristic.ConfiguredName, device.name + ' Fan');

    this.serviceFanV2.getCharacteristic(Characteristic.Active)
      .onGet(() => {
        return this.Status.isPowerOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
      })
      .onSet((value: CharacteristicValue) => {
        const isOn = normalizeBoolean(value);
        if ((this.Status.isPowerOn && isOn) || (!this.Status.isPowerOn && !isOn)) {
          return;
        }

        setTimeout(() => {
          this.serviceFanV2?.updateCharacteristic(
            Characteristic.Active,
            this.Status.isPowerOn ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
          );
          this.serviceFanV2?.updateCharacteristic(
            Characteristic.RotationSpeed,
            this.Status.rotationSpeed,
          );
        }, 100);
      })
      .updateValue(Characteristic.Active.INACTIVE);

    this.serviceFanV2.getCharacteristic(Characteristic.CurrentFanState)
      .onGet(() => {
        return this.Status.isPowerOn ? Characteristic.CurrentFanState.BLOWING_AIR : Characteristic.CurrentFanState.INACTIVE;
      })
      .setProps({
        validValues: [Characteristic.CurrentFanState.INACTIVE, Characteristic.CurrentFanState.BLOWING_AIR],
      })
      .updateValue(Characteristic.CurrentFanState.INACTIVE);

    this.serviceFanV2.getCharacteristic(Characteristic.TargetFanState)
      .setProps({
        validValues: [Characteristic.TargetFanState.MANUAL],
      })
      .onSet(this.setFanState.bind(this))
      .updateValue(Characteristic.TargetFanState.MANUAL);

    this.serviceFanV2.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1,
      })
      .updateValue(this.Status.rotationSpeed)
      .onSet(this.setFanSpeed.bind(this));

    this.serviceFanV2.getCharacteristic(Characteristic.SwingMode)
      .onSet(this.setSwingMode.bind(this))
      .updateValue(this.Status.isSwingOn ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED);
  }

  protected createAirQualityService() {
    const {
      Service: {
        AirQualitySensor,
      },
    } = this.platform;

    this.serviceAirQuality = this.accessory.getService(AirQualitySensor) || this.accessory.addService(AirQualitySensor);
  }

  protected createHeaterCoolerService() {
    const { Characteristic } = this.platform;
    const device: Device = this.accessory.context.device;
    const status = this.Status;

    this.service.setCharacteristic(Characteristic.Name, device.name);
    this.service.getCharacteristic(Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .updateValue(Characteristic.Active.INACTIVE);
    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .updateValue(Characteristic.CurrentHeaterCoolerState.INACTIVE);

    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          Characteristic.TargetHeaterCoolerState.HEAT,
          Characteristic.TargetHeaterCoolerState.COOL,
        ],
      })
      .updateValue(Characteristic.TargetHeaterCoolerState.COOL);

    this.service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onSet(this.setTargetState.bind(this));

    this.service.getCharacteristic(this.platform.customCharacteristics.ACMode)
      .onSet(this.setACMode.bind(this))
      .onGet(() => {
        if (this.Status.opMode === OpMode.COOL && this.Status.isEnergySaveOn) {
          return ACModeOption.ENERGY_SAVE;
        }
        switch (this.Status.opMode) {
        case OpMode.FAN:
          return ACModeOption.FAN;
        case OpMode.DRY:
          return ACModeOption.DRY;
        default:
          return ACModeOption.COOL;
        }
      })
      .updateValue(ACModeOption.COOL);

    if (status.currentTemperature) {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, status.currentTemperature);
    }

    const currentTemperatureValue = device.deviceModel.value('airState.tempState.current') as RangeValue;
    if (currentTemperatureValue) {
      this.service.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({
          minValue: status.convertTemperatureCelsiusFromLGToHomekit(currentTemperatureValue.min),
          maxValue: status.convertTemperatureCelsiusFromLGToHomekit(currentTemperatureValue.max),
          minStep: 0.01,
        });
    }

    const targetHeatTemperature = status.getTemperatureRange(status.getTemperatureRangeForHeating());
    if (targetHeatTemperature) {
      this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps({
          minValue: status.convertTemperatureCelsiusFromLGToHomekit(targetHeatTemperature.min),
          maxValue: status.convertTemperatureCelsiusFromLGToHomekit(targetHeatTemperature.max),
          minStep: targetHeatTemperature.step || 0.01,
        });
    }

    const targetCoolTemperature = status.getTemperatureRange(status.getTemperatureRangeForCooling());
    if (targetCoolTemperature) {
      this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps({
          minValue: status.convertTemperatureCelsiusFromLGToHomekit(targetCoolTemperature.min),
          maxValue: status.convertTemperatureCelsiusFromLGToHomekit(targetCoolTemperature.max),
          minStep: targetCoolTemperature.step || 0.01,
        });
    }

    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .onSet(this.setTargetTemperature.bind(this));
    this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .onSet(this.setTargetTemperature.bind(this));

    if (!this.config.ac_fan_control) {
      this.service.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 1,
        })
        .updateValue(this.Status.rotationSpeed)
        .onSet(this.setFanSpeed.bind(this));
    }

    this.service.getCharacteristic(Characteristic.SwingMode)
      .onSet(this.setSwingMode.bind(this));
  }

  async setEnergySaveActive(value: CharacteristicValue) {
    const device: Device = this.accessory.context.device;
    const enabled = normalizeBoolean(value);
    const status = this.Status;
    if (!(this.isEnergySaveSupported(device) && status.isPowerOn && status.opMode === OpMode.COOL)) {
      this.logger.debug(`Energy save mode is not supported in the current state. Power: ${status.isPowerOn}, Mode: ${status.opMode}`);
      return;
    }

    try {
      await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.powerSave.basic',
        dataValue: enabled ? 1 : 0,
      });
      this.accessory.context.device.data.snapshot['airState.powerSave.basic'] = enabled ? 1 : 0;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting energy save mode:', error);
    }
  }

  async setAirCleanActive(value: CharacteristicValue) {
    const device: Device = this.accessory.context.device;
    const status = this.Status;
    const enabled = normalizeBoolean(value);
    if (!(this.supportsAirClean(device) && status.isPowerOn && status.opMode === OpMode.COOL)) {
      this.logger.debug(`Air clean mode is not supported in the current state. Power: ${status.isPowerOn}, Mode: ${status.opMode}`);
      return;
    }

    try {
      await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.wMode.airClean',
        dataValue: enabled ? 1 : 0,
      });
      this.accessory.context.device.data.snapshot['airState.wMode.airClean'] = enabled ? 1 : 0;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting air clean mode:', error);
    }
  }

  async setQuietModeActive(value: CharacteristicValue) {
    const device: Device = this.accessory.context.device;
    const status = this.Status;
    const enabled = normalizeBoolean(value);
    if (!(this.supportsQuietMode(device) && status.isPowerOn && status.opMode === OpMode.COOL)) {
      this.logger.debug(`Quiet mode is not supported in the current state. Power: ${status.isPowerOn}, Mode: ${status.opMode}`);
      return;
    }

    try {
      await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.miscFuncState.silentAWHP',
        dataValue: enabled ? 1 : 0,
      });
      this.accessory.context.device.data.snapshot['airState.miscFuncState.silentAWHP'] = enabled ? 1 : 0;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting quiet mode:', error);
    }
  }

  async setJetModeActive(value: CharacteristicValue) {
    const device: Device = this.accessory.context.device;
    const status = this.Status;
    const enabled = normalizeBoolean(value);
    if (!(this.supportsJetMode(device) && status.isPowerOn && status.opMode === OpMode.COOL)) {
      this.logger.debug(`Jet mode is not supported in the current state. Power: ${status.isPowerOn}, Mode: ${status.opMode}`);
      return;
    }

    try {
      await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.wMode.jet',
        dataValue: enabled ? 1 : 0,
      });
      this.accessory.context.device.data.snapshot['airState.wMode.jet'] = enabled ? 1 : 0;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting jet mode:', error);
    }
  }

  async setFanState(value: CharacteristicValue) {
    void value;
    const status = this.Status;
    if (!status.isPowerOn) {
      this.logger.debug('Power is off, cannot set fan state');
      return;
    }

    const device: Device = this.accessory.context.device;
    try {
      await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.windStrength',
        dataValue: FanSpeed.HIGH,
      });
      this.accessory.context.device.data.snapshot['airState.windStrength'] = FanSpeed.HIGH;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting fan state:', error);
    }
  }

  public updateAccessoryCharacteristic(device: Device) {
    super.updateAccessoryCharacteristic(device);
    this.updateAccessoryActiveCharacteristic();
    this.updateAccessoryCurrentTemperatureCharacteristic();
    this.updateAccessoryStateCharacteristics();
    this.updateAccessoryTemperatureCharacteristics();
    this.updateAccessoryFanStateCharacteristics();
    this.updateAccessoryTotalConsumptionCharacteristic();
    this.updateAccessoryAirQualityCharacteristic();
    this.updateAccessoryTemperatureSensorCharacteristic();
    this.updateAccessoryHumiditySensorCharacteristic();
    this.updateAccessoryFanV2Characteristic();
    this.updateAccessoryLedControlCharacteristic();
    this.updateAccessoryJetModeCharacteristic();
    this.updateAccessoryQuietModeCharacteristic();
    this.updateAccessoryEnergySaveModeCharacteristic();
    this.updateAccessoryAirCleanCharacteristic();
  }

  public updateAccessoryActiveCharacteristic() {
    this.service.updateCharacteristic(
      this.platform.Characteristic.Active,
      this.Status.isPowerOn ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE,
    );
  }

  public updateAccessoryCurrentTemperatureCharacteristic() {
    const currentTemperature = this.Status.currentTemperature;
    if (typeof currentTemperature === 'number' && !isNaN(currentTemperature)) {
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, currentTemperature);
    }
  }

  public updateAccessoryStateCharacteristics() {
    const { Characteristic } = this.platform;
    const status = this.Status;

    if (!status.isPowerOn) {
      this.service.updateCharacteristic(
        Characteristic.CurrentHeaterCoolerState,
        Characteristic.CurrentHeaterCoolerState.INACTIVE,
      );
    } else if (status.opMode === OpMode.HEAT) {
      this.service.updateCharacteristic(
        Characteristic.CurrentHeaterCoolerState,
        Characteristic.CurrentHeaterCoolerState.HEATING,
      );
      this.service.updateCharacteristic(
        Characteristic.TargetHeaterCoolerState,
        Characteristic.TargetHeaterCoolerState.HEAT,
      );
    } else if (status.opMode === OpMode.COOL || status.opMode === OpMode.DRY) {
      this.service.updateCharacteristic(
        Characteristic.CurrentHeaterCoolerState,
        Characteristic.CurrentHeaterCoolerState.COOLING,
      );
      this.service.updateCharacteristic(
        Characteristic.TargetHeaterCoolerState,
        Characteristic.TargetHeaterCoolerState.COOL,
      );
    } else if (status.opMode === OpMode.FAN) {
      this.service.updateCharacteristic(
        Characteristic.CurrentHeaterCoolerState,
        Characteristic.CurrentHeaterCoolerState.IDLE,
      );
      this.service.updateCharacteristic(
        Characteristic.TargetHeaterCoolerState,
        Characteristic.TargetHeaterCoolerState.HEAT,
      );
    } else if ([OpMode.AUTO, -1].includes(status.opMode)) {
      if (status.currentTemperature < status.targetTemperature) {
        this.service.updateCharacteristic(
          Characteristic.CurrentHeaterCoolerState,
          Characteristic.CurrentHeaterCoolerState.HEATING,
        );
        this.service.updateCharacteristic(
          Characteristic.TargetHeaterCoolerState,
          Characteristic.TargetHeaterCoolerState.HEAT,
        );
      } else {
        this.service.updateCharacteristic(
          Characteristic.CurrentHeaterCoolerState,
          Characteristic.CurrentHeaterCoolerState.COOLING,
        );
        this.service.updateCharacteristic(
          Characteristic.TargetHeaterCoolerState,
          Characteristic.TargetHeaterCoolerState.COOL,
        );
      }
    } else {
      this.service.updateCharacteristic(
        Characteristic.CurrentHeaterCoolerState,
        Characteristic.CurrentHeaterCoolerState.IDLE,
      );
    }

    this.service.updateCharacteristic(
      this.platform.customCharacteristics.ACMode,
      (() => {
        if (status.opMode === OpMode.COOL && status.isEnergySaveOn) {
          return ACModeOption.ENERGY_SAVE;
        }
        switch (status.opMode) {
        case OpMode.FAN:
          return ACModeOption.FAN;
        case OpMode.DRY:
          return ACModeOption.DRY;
        default:
          return ACModeOption.COOL;
        }
      })(),
    );
  }

  public updateAccessoryTemperatureCharacteristics() {
    const temperature = this.Status.targetTemperature;
    if (typeof temperature !== 'number' || isNaN(temperature)) {
      return;
    }

    const currentState = this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState).value;
    if (currentState === this.platform.Characteristic.CurrentHeaterCoolerState.HEATING) {
      this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, temperature);
    }

    if (currentState === this.platform.Characteristic.CurrentHeaterCoolerState.COOLING) {
      this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, temperature);
    }
  }

  public updateAccessoryFanStateCharacteristics() {
    const { Characteristic } = this.platform;
    this.service.updateCharacteristic(Characteristic.RotationSpeed, this.Status.rotationSpeed);
    this.service.updateCharacteristic(
      Characteristic.SwingMode,
      this.Status.isSwingOn ? Characteristic.SwingMode.SWING_ENABLED : Characteristic.SwingMode.SWING_DISABLED,
    );
  }

  public updateAccessoryTotalConsumptionCharacteristic() {
    this.service.updateCharacteristic(this.platform.customCharacteristics.TotalConsumption, this.Status.currentConsumption);
  }

  public updateAccessoryAirQualityCharacteristic() {
    if (this.config.ac_air_quality && this.serviceAirQuality && this.Status.airQuality && this.Status.airQuality.isOn) {
      this.serviceAirQuality.updateCharacteristic(this.platform.Characteristic.AirQuality, this.Status.airQuality.overall);
      if (this.Status.airQuality.PM2) {
        this.serviceAirQuality.updateCharacteristic(this.platform.Characteristic.PM2_5Density, this.Status.airQuality.PM2);
      }
      if (this.Status.airQuality.PM10) {
        this.serviceAirQuality.updateCharacteristic(this.platform.Characteristic.PM10Density, this.Status.airQuality.PM10);
      }
    }
  }

  public updateAccessoryTemperatureSensorCharacteristic() {
    if (this.config.ac_temperature_sensor && this.serviceSensor) {
      this.serviceSensor.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.Status.currentTemperature);
      this.serviceSensor.updateCharacteristic(this.platform.Characteristic.StatusActive, this.Status.isPowerOn);
    }
  }

  public updateAccessoryHumiditySensorCharacteristic() {
    if (this.config.ac_humidity_sensor && this.serviceHumiditySensor) {
      this.serviceHumiditySensor.updateCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity, this.Status.currentRelativeHumidity);
      this.serviceHumiditySensor.updateCharacteristic(this.platform.Characteristic.StatusActive, this.Status.isPowerOn);
    }
  }

  public updateAccessoryFanV2Characteristic() {
    if (this.config.ac_fan_control && this.serviceFanV2) {
      this.serviceFanV2.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.Status.isPowerOn ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE,
      );
      this.serviceFanV2.updateCharacteristic(
        this.platform.Characteristic.CurrentFanState,
        this.Status.isPowerOn ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR : this.platform.Characteristic.CurrentFanState.INACTIVE,
      );
      this.serviceFanV2.updateCharacteristic(
        this.platform.Characteristic.TargetFanState,
        this.platform.Characteristic.TargetFanState.MANUAL,
      );
      this.serviceFanV2.updateCharacteristic(this.platform.Characteristic.RotationSpeed, this.Status.rotationSpeed);
      this.serviceFanV2.updateCharacteristic(
        this.platform.Characteristic.SwingMode,
        this.Status.isSwingOn
          ? this.platform.Characteristic.SwingMode.SWING_ENABLED
          : this.platform.Characteristic.SwingMode.SWING_DISABLED,
      );
    }
  }

  public updateAccessoryLedControlCharacteristic() {
    if (this.config.ac_led_control && this.serviceLight) {
      this.serviceLight.updateCharacteristic(this.platform.Characteristic.On, this.Status.isLightOn);
    }
  }

  public updateAccessoryJetModeCharacteristic() {
    if (this.serviceJetMode && this.supportsJetMode(this.accessory.context.device)) {
      this.serviceJetMode.updateCharacteristic(this.platform.Characteristic.On, !!this.accessory.context.device.snapshot['airState.wMode.jet']);
    }
  }

  public updateAccessoryQuietModeCharacteristic() {
    const device = this.accessory.context.device;
    if (this.serviceQuietMode && this.supportsQuietMode(device)) {
      this.serviceQuietMode.updateCharacteristic(this.platform.Characteristic.On, !!device.snapshot['airState.miscFuncState.silentAWHP']);
    }
  }

  public updateAccessoryEnergySaveModeCharacteristic() {
    const device = this.accessory.context.device;
    if (this.serviceEnergySaveMode && this.isEnergySaveSupported(device) && this.config.ac_energy_save) {
      this.serviceEnergySaveMode.updateCharacteristic(this.platform.Characteristic.On, !!device.snapshot['airState.powerSave.basic']);
    }
  }

  public updateAccessoryAirCleanCharacteristic() {
    const device = this.accessory.context.device;
    if (this.serviceAirClean && this.supportsAirClean(device) && this.config.ac_air_clean) {
      this.serviceAirClean.updateCharacteristic(this.platform.Characteristic.On, !!device.snapshot['airState.wMode.airClean']);
    }
  }

  async setLight(value: CharacteristicValue) {
    const status = this.Status;
    if (!status.isPowerOn) {
      this.logger.debug('Power is off, cannot set light state');
      return;
    }

    try {
      const device: Device = this.accessory.context.device;
      const enabled = normalizeBoolean(value);
      await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.lightingState.displayControl',
        dataValue: enabled ? 1 : 0,
      });
      this.accessory.context.device.data.snapshot['airState.lightingState.displayControl'] = enabled ? 1 : 0;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting light state:', error);
    }
  }

  async setTargetState(value: CharacteristicValue) {
    this.logger.debug('Set target AC mode = ', value);
    const {
      Characteristic: {
        TargetHeaterCoolerState,
      },
    } = this.platform;

    const targetValue = normalizeNumber(value);
    if (targetValue === null) {
      return;
    }

    this.currentTargetState = targetValue;

    try {
      switch (targetValue) {
      case TargetHeaterCoolerState.HEAT:
        await this.setACMode(ACModeOption.FAN);
        break;
      case TargetHeaterCoolerState.COOL:
        await this.setACMode(ACModeOption.COOL);
        break;
      default:
        return;
      }
    } catch (error) {
      this.logger.error('Error setting target state:', error);
    }
  }

  async setActive(value: CharacteristicValue) {
    const device: Device = this.accessory.context.device;
    const isOn = normalizeBoolean(value);
    const isOnNumeric = isOn ? 1 : 0;
    this.logger.debug('Set power on = ', isOnNumeric, ' current status = ', this.Status.isPowerOn);

    if ((this.Status.isPowerOn && isOnNumeric === 1) || (!this.Status.isPowerOn && isOnNumeric === 0)) {
      this.logger.debug('Power state already matches incoming value; skipping deviceControl.');
      return;
    }

    try {
      const success = await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.operation',
        dataValue: isOnNumeric,
      }, 'Operation');
      if (success) {
        this.accessory.context.device.data.snapshot['airState.operation'] = isOnNumeric;
        this.updateAccessoryCharacteristic(this.accessory.context.device);
      }
    } catch (error) {
      this.logger.error('Error setting active state:', error);
    }
  }

  async setTargetTemperature(value: CharacteristicValue) {
    const status = this.Status;
    if (!status.isPowerOn) {
      this.logger.error('Power is off, cannot set target temperature');
      return;
    }

    const device: Device = this.accessory.context.device;
    const vNum = normalizeNumber(value);
    if (vNum === null) {
      this.logger.error('Invalid temperature value: ', value);
      return;
    }

    const temperatureLG = status.convertTemperatureCelsiusFromHomekitToLG(vNum);
    if (typeof temperatureLG !== 'number' || isNaN(temperatureLG)) {
      this.logger.error('Converted temperature is not a valid number:', temperatureLG);
      return;
    }

    if (temperatureLG === Number(device.snapshot['airState.tempState.target'])) {
      this.logger.debug('Target temperature is identical to current setting; skipping.');
      return;
    }

    try {
      await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.tempState.target',
        dataValue: temperatureLG,
      });
      this.accessory.context.device.data.snapshot['airState.tempState.target'] = temperatureLG;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting target temperature:', error);
    }
  }

  async setFanSpeed(value: CharacteristicValue) {
    if (!this.Status.isPowerOn) {
      return;
    }

    const vNum = normalizeNumber(value);
    if (vNum === null) {
      return;
    }

    const numeric = Math.round(vNum);
    let index = 0;
    let minDiff = Number.MAX_VALUE;
    for (let i = 0; i < FAN_ROTATION_SPEEDS.length; i++) {
      const diff = Math.abs(FAN_ROTATION_SPEEDS[i] - numeric);
      if (diff < minDiff) {
        minDiff = diff;
        index = i;
      }
    }

    const speedValue = Math.min(MAX_FAN_SPEED, index + 1);
    const windStrength = FAN_SPEED_MAP[speedValue - 1] || FanSpeed.HIGH;
    const device: Device = this.accessory.context.device;

    if (windStrength === Number(device.snapshot['airState.windStrength'])) {
      return;
    }

    this.logger.debug('Set fan speed = ', speedValue);
    try {
      await this.platform.ThinQ?.deviceControl(device.id, {
        dataKey: 'airState.windStrength',
        dataValue: windStrength,
      });
      this.accessory.context.device.data.snapshot['airState.windStrength'] = windStrength;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting fan speed:', error);
    }
  }

  async setSwingMode(value: CharacteristicValue) {
    if (!this.Status.isPowerOn) {
      this.logger.debug('Power is off, cannot set swing mode');
      return;
    }

    const swingValue = normalizeBoolean(value) ? '100' : '0';
    const device: Device = this.accessory.context.device;

    try {
      if (this.config.ac_swing_mode === 'BOTH') {
        await this.platform.ThinQ?.deviceControl(device.id, {
          dataKey: null,
          dataValue: null,
          dataSetList: {
            'airState.wDir.vStep': swingValue,
            'airState.wDir.hStep': swingValue,
          },
          dataGetList: null,
        }, 'Set', 'favoriteCtrl');
        this.accessory.context.device.data.snapshot['airState.wDir.vStep'] = swingValue;
        this.accessory.context.device.data.snapshot['airState.wDir.hStep'] = swingValue;
      } else if (this.config.ac_swing_mode === 'VERTICAL') {
        await this.platform.ThinQ?.deviceControl(device.id, {
          dataKey: 'airState.wDir.vStep',
          dataValue: swingValue,
        });
        this.accessory.context.device.data.snapshot['airState.wDir.vStep'] = swingValue;
      } else if (this.config.ac_swing_mode === 'HORIZONTAL') {
        await this.platform.ThinQ?.deviceControl(device.id, {
          dataKey: 'airState.wDir.hStep',
          dataValue: swingValue,
        });
        this.accessory.context.device.data.snapshot['airState.wDir.hStep'] = swingValue;
      }

      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting swing mode:', error);
    }
  }

  async setOpMode(deviceId: string, opMode: number): Promise<boolean | undefined> {
    return await this.platform.ThinQ?.deviceControl(deviceId, {
      dataKey: 'airState.opMode',
      dataValue: opMode,
    });
  }

  async setACMode(value: CharacteristicValue) {
    if (!this.Status.isPowerOn) {
      return;
    }

    const device: Device = this.accessory.context.device;
    const modeValue = normalizeNumber(value);
    if (modeValue === null) {
      return;
    }

    let opMode = OpMode.COOL;
    let energySave = false;
    switch (modeValue) {
    case ACModeOption.FAN:
      opMode = OpMode.FAN;
      break;
    case ACModeOption.DRY:
      opMode = OpMode.DRY;
      break;
    case ACModeOption.ENERGY_SAVE:
      opMode = OpMode.COOL;
      energySave = true;
      break;
    default:
      opMode = OpMode.COOL;
      break;
    }

    try {
      if (opMode !== this.Status.opMode) {
        const success = await this.setOpMode(device.id, opMode);
        if (success === false) {
          return;
        }
        this.accessory.context.device.data.snapshot['airState.opMode'] = opMode;
      }

      if (this.isEnergySaveSupported(device)) {
        const desired = energySave ? 1 : 0;
        if (Number(device.snapshot['airState.powerSave.basic'] || 0) !== desired) {
          await this.platform.ThinQ?.deviceControl(device.id, {
            dataKey: 'airState.powerSave.basic',
            dataValue: desired,
          });
          this.accessory.context.device.data.snapshot['airState.powerSave.basic'] = desired;
        }
      }

      this.updateAccessoryCharacteristic(this.accessory.context.device);
    } catch (error) {
      this.logger.error('Error setting AC mode:', error);
    }
  }

  public setupButton(device: Device) {
    if (!this.config.ac_buttons.length) {
      return;
    }

    this.serviceLabelButtons = this.accessory.getService('Buttons')
      || this.accessory.addService(this.platform.Service.ServiceLabel, 'Buttons', 'Buttons');

    for (const linkedService of this.serviceLabelButtons.linkedServices ?? []) {
      this.accessory.removeService(linkedService);
    }

    for (const button of this.config.ac_buttons) {
      this.setupButtonOpmode(device, button.name, Number(button.op_mode));
    }
  }

  protected setupButtonOpmode(device: Device, name: string, opMode: number) {
    const {
      Service: {
        Switch,
      },
      Characteristic,
    } = this.platform;

    if (!this.serviceLabelButtons) {
      this.logger.error('ServiceLabelButtons not found cant setup button');
      return;
    }

    const serviceButton = this.accessory.getService(name) || this.accessory.addService(Switch, name, name);
    serviceButton.addOptionalCharacteristic(Characteristic.ConfiguredName);
    serviceButton.setCharacteristic(Characteristic.ConfiguredName, name);
    serviceButton.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => {
        return this.Status.opMode === opMode;
      })
      .onSet((value: CharacteristicValue) => {
        this.handleButtonOpmode(value, opMode);
      });

    this.serviceLabelButtons.addLinkedService(serviceButton);
  }

  async handleButtonOpmode(value: CharacteristicValue, opMode: number) {
    if (normalizeBoolean(value)) {
      if (this.Status.opMode !== opMode) {
        const success = await this.setOpMode(this.accessory.context.device.id, opMode);
        if (success !== false) {
          this.accessory.context.device.data.snapshot['airState.opMode'] = opMode;
          this.updateAccessoryCharacteristic(this.accessory.context.device);
        }
      }
    } else {
      const success = await this.setOpMode(this.accessory.context.device.id, OpMode.COOL);
      if (success === false) {
        return;
      }
      this.accessory.context.device.data.snapshot['airState.opMode'] = OpMode.COOL;
      this.updateAccessoryCharacteristic(this.accessory.context.device);
      await this.setTargetState(this.currentTargetState);
    }
  }
}

export class ACStatus {
  constructor(
    protected data: any,
    protected device: Device,
    protected config: Config,
    private logger: Logger,
  ) {
  }

  public get isFahrenheitUnit() {
    return (this.config.ac_temperature_unit || '').toLowerCase() === 'f';
  }

  public convertTemperatureCelsiusFromHomekitToLG(temperatureInCelsius: CharacteristicValue): number {
    const tempNum = Number(temperatureInCelsius);
    if (!this.isFahrenheitUnit) {
      return tempNum;
    }

    const temperatureInFahrenheit = Math.round(cToF(tempNum));
    try {
      const mapped = this.device.deviceModel.lookupMonitorValue
        && this.device.deviceModel.lookupMonitorValue('TempFahToCel', String(temperatureInFahrenheit));
      if (typeof mapped !== 'undefined' && mapped !== null) {
        const n = Number(mapped);
        if (!isNaN(n)) {
          return n;
        }
      }
    } catch (error) {
      this.logger.warn('Temperature mapping lookup failed, falling back to direct conversion.', error);
    }

    return temperatureInFahrenheit;
  }

  public convertTemperatureCelsiusFromLGToHomekit(temperature: number): number {
    const tempNum = Number(temperature);
    if (!this.isFahrenheitUnit) {
      return tempNum;
    }

    try {
      const mapped = this.device.deviceModel.lookupMonitorValue
        && this.device.deviceModel.lookupMonitorValue('TempCelToFah', String(tempNum));
      if (typeof mapped !== 'undefined' && mapped !== null) {
        const n = Number(mapped);
        if (!isNaN(n)) {
          return Math.round(fToC(n) * 100) / 100;
        }
      }
    } catch (error) {
      this.logger.warn('Temperature mapping lookup failed, falling back to direct conversion.', error);
    }

    return Math.round(fToC(tempNum) * 100) / 100;
  }

  public get opMode() {
    return this.data['airState.opMode'] as number;
  }

  public get isPowerOn() {
    return !!this.data['airState.operation'] as boolean;
  }

  public get currentRelativeHumidity() {
    const humidity = parseInt(this.data['airState.humidity.current']);
    if (humidity > 100) {
      return humidity / 10;
    }
    return humidity;
  }

  public get currentTemperature() {
    return this.convertTemperatureCelsiusFromLGToHomekit(this.data['airState.tempState.current'] as number);
  }

  public get targetTemperature() {
    return this.convertTemperatureCelsiusFromLGToHomekit(this.data['airState.tempState.target'] as number);
  }

  public get airQuality() {
    if (!('airState.quality.overall' in this.data) && !('airState.quality.PM2' in this.data) && !('airState.quality.PM10' in this.data)) {
      return null;
    }

    return {
      isOn: this.isPowerOn || this.data['airState.quality.sensorMon'],
      overall: parseInt(this.data['airState.quality.overall']),
      PM2: parseInt(this.data['airState.quality.PM2'] || '0'),
      PM10: parseInt(this.data['airState.quality.PM10'] || '0'),
    };
  }

  public get windStrength() {
    const value = Number(this.data['airState.windStrength']);
    if (value >= FanSpeed.HIGH) {
      return 3;
    }
    if (value >= FanSpeed.MEDIUM) {
      return 2;
    }
    return 1;
  }

  public get rotationSpeed() {
    return FAN_ROTATION_SPEEDS[this.windStrength - 1] ?? FAN_ROTATION_SPEEDS[1];
  }

  public get isSwingOn() {
    const vStep = Math.floor((this.data['airState.wDir.vStep'] || 0) / 100);
    const hStep = Math.floor((this.data['airState.wDir.hStep'] || 0) / 100);
    return !!(vStep + hStep);
  }

  public get isLightOn() {
    return !!this.data['airState.lightingState.displayControl'];
  }

  public get isEnergySaveOn() {
    return !!this.data['airState.powerSave.basic'];
  }

  public get currentConsumption() {
    const consumption = Number(this.data['airState.energy.onCurrent']);
    if (isNaN(consumption)) {
      return 0;
    }
    return consumption / 100;
  }

  public get type() {
    return this.device.deviceModel.data.Info.modelType || ACModelType.RAC;
  }

  public getTemperatureRange([minRange, maxRange]: [EnumValue, EnumValue]): RangeValue {
    let temperature: RangeValue = {
      type: ValueType.Range,
      min: 0,
      max: 0,
      step: 0.01,
    };

    if (minRange && maxRange) {
      const minRangeOptions: number[] = Object.values(minRange.options).filter((value): value is number => typeof value === 'number');
      const maxRangeOptions: number[] = Object.values(maxRange.options).filter((value): value is number => typeof value === 'number');

      if (minRangeOptions.length > 1) {
        temperature.min = Math.min(...minRangeOptions.filter(value => value !== 0));
      }
      if (maxRangeOptions.length > 1) {
        temperature.max = Math.max(...maxRangeOptions.filter(value => value !== 0));
      }
    }

    if (!temperature.min || !temperature.max) {
      temperature = this.device.deviceModel.value('airState.tempState.limitMin') as RangeValue;
    }

    if ((!temperature?.min || !temperature?.max) && this.device.deviceModel.value('airState.tempState.target')) {
      temperature = this.device.deviceModel.value('airState.tempState.target') as RangeValue;
    }

    return temperature;
  }

  public getTemperatureRangeForHeating(): [EnumValue, EnumValue] {
    let heatLowLimitKey;
    let heatHighLimitKey;

    if (this.type === ACModelType.AWHP) {
      heatLowLimitKey = 'support.airState.tempState.waterTempHeatMin';
      heatHighLimitKey = 'support.airState.tempState.waterTempHeatMax';
    } else {
      heatLowLimitKey = 'support.heatLowLimit';
      heatHighLimitKey = 'support.heatHighLimit';
    }

    return [
      this.device.deviceModel.value(heatLowLimitKey) as EnumValue,
      this.device.deviceModel.value(heatHighLimitKey) as EnumValue,
    ];
  }

  public getTemperatureRangeForCooling(): [EnumValue, EnumValue] {
    let coolLowLimitKey;
    let coolHighLimitKey;

    if (this.type === ACModelType.AWHP) {
      coolLowLimitKey = 'support.airState.tempState.waterTempCoolMin';
      coolHighLimitKey = 'support.airState.tempState.waterTempCoolMax';
    } else {
      coolLowLimitKey = 'support.coolLowLimit';
      coolHighLimitKey = 'support.coolHighLimit';
    }

    return [
      this.device.deviceModel.value(coolLowLimitKey) as EnumValue,
      this.device.deviceModel.value(coolHighLimitKey) as EnumValue,
    ];
  }
}
