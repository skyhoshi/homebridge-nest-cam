import { HAP, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { NestEndpoints, handleError } from './nest-endpoints';
import { CameraInfo, Properties } from './camera-info';
import querystring from 'querystring';
import { EventEmitter } from 'events';

type OnlyBooleans<T> = Pick<
  T,
  {
    [K in keyof T]: T[K] extends boolean ? K : never;
  }[keyof T]
>;

export const enum NestCamEvents {
  CAMERA_STATE_CHANGED = 'camera-change',
  CHIME_STATE_CHANGED = 'chime-change',
  AUDIO_STATE_CHANGED = 'audio-change',
  DOORBELL_RANG = 'doorbell-rang',
  MOTION_DETECTED = 'motion-detected',
}

export class NestCam extends EventEmitter {
  private readonly config: PlatformConfig;
  private readonly log: Logging;
  private endpoints: NestEndpoints;
  private readonly hap: HAP;
  public info: CameraInfo;
  private accessory: PlatformAccessory;
  private motionDetected = false;
  private motionInProgress = false;
  private doorbellRang = false;
  private alertTypes: Array<string> = [];
  private alertCooldown = 180000;
  private alertInterval: NodeJS.Timeout | undefined;

  constructor(config: PlatformConfig, info: CameraInfo, accessory: PlatformAccessory, log: Logging, hap: HAP) {
    super();
    this.hap = hap;
    this.log = log;
    this.config = config;
    this.accessory = accessory;
    this.info = info;
    this.alertTypes = config.options?.alertTypes || [];
    this.alertCooldown = (config.options?.alertCooldownRate || 180) * 1000;
    this.endpoints = new NestEndpoints(config.fieldTest || false);
  }

  private async setBooleanProperty(
    key: keyof OnlyBooleans<Properties>,
    value: boolean,
    service: Service | undefined,
    event?: NestCamEvents,
  ): Promise<void> {
    const query = querystring.stringify({
      [key]: value,
      uuid: this.info.uuid,
    });

    const response = await this.endpoints.sendRequest(
      this.config.access_token,
      this.endpoints.CAMERA_API_HOSTNAME,
      '/api/dropcams.set_properties',
      'POST',
      'json',
      query,
    );

    try {
      if (response.status !== 0) {
        this.log.error(`Unable to set property '${key}' for ${this.info.name} to ${value}`);
      } else {
        if (service) {
          service.updateCharacteristic(this.hap.Characteristic.On, value);
          this.info.properties[key] = value;
          event && this.emit(event);
        }
      }
    } catch (error) {
      handleError(this.log, error, `Error setting property for ${this.info.name}`);
    }
  }

  async toggleActive(enabled: boolean): Promise<void> {
    const service = this.accessory.getService('Streaming');
    await this.setBooleanProperty('streaming.enabled', enabled, service, NestCamEvents.CAMERA_STATE_CHANGED);
  }

  async toggleChime(enabled: boolean): Promise<void> {
    const service = this.accessory.getService('Chime');
    await this.setBooleanProperty('doorbell.indoor_chime.enabled', enabled, service, NestCamEvents.CHIME_STATE_CHANGED);
  }

  async toggleAudio(enabled: boolean): Promise<void> {
    const service = this.accessory.getService('Audio');
    await this.setBooleanProperty('audio.enabled', enabled, service, NestCamEvents.AUDIO_STATE_CHANGED);
  }

  startAlertChecks(interval: number) {
    if (!this.alertInterval) {
      const self = this;
      this.alertInterval = setInterval(async function () {
        self.checkAlerts();
      }, interval);
    }
  }

  stopAlertChecks() {
    if (this.alertInterval) {
      clearInterval(this.alertInterval);
    }
  }

  private async checkAlerts(): Promise<void> {
    this.log.debug(`Checking for alerts on ${this.accessory.displayName}`);
    try {
      const currDate = new Date();
      currDate.setMinutes(currDate.getMinutes() - 1);
      const epoch = Math.round(currDate.getTime() / 1000);
      const query = querystring.stringify({
        start_time: epoch,
      });
      if (!this.accessory.context.removed) {
        const self = this;
        const response = await this.endpoints.sendRequest(
          this.config.access_token,
          `https://${this.info.nexus_api_nest_domain_host}`,
          `/cuepoint/${this.info.uuid}/2?${query}`,
          'GET',
        );
        if (response.length > 0) {
          for (let i = 0; i < response.length; i++) {
            const trigger = response[i];
            if (trigger.is_important && trigger.types.includes('doorbell') && !this.doorbellRang) {
              this.triggerDoorbell();
              break;
            }

            // Check the intersection between user defined alert types and received alerts
            let intersection = trigger.types;
            if (this.alertTypes.length > 0) {
              intersection = this.alertTypes.filter((type) => trigger.types.includes(type));
            }
            if (trigger.is_important && intersection.length > 0 && !this.motionDetected) {
              this.triggerMotion();
              break;
            }
          }
        } else if (this.motionInProgress) {
          self.setMotion(false);
          this.motionInProgress = false;
        }
      }
    } catch (error) {
      handleError(this.log, error, 'Error checking alerts');
    }
  }

  triggerMotion(): void {
    const self = this;
    this.setMotion(true);
    this.motionDetected = true;
    this.motionInProgress = true;

    setTimeout(async function () {
      self.motionDetected = false;
    }, this.alertCooldown);
  }

  private setMotion(state: boolean): void {
    const service = this.accessory.getService(this.hap.Service.MotionSensor);
    if (service) {
      this.log.debug(`Setting ${this.accessory.displayName} Motion to ${state}`);
      service.updateCharacteristic(this.hap.Characteristic.MotionDetected, state);
      this.emit(NestCamEvents.MOTION_DETECTED, state);
    }
  }

  triggerDoorbell(): void {
    const self = this;
    this.setDoorbell();
    this.doorbellRang = true;
    setTimeout(function () {
      self.doorbellRang = false;
    }, this.alertCooldown);
  }

  private setDoorbell(): void {
    const doorbellService = this.accessory.getService(this.hap.Service.Doorbell);
    if (doorbellService) {
      this.log.debug(`Ringing ${this.accessory.displayName} Doorbell`);
      doorbellService.updateCharacteristic(
        this.hap.Characteristic.ProgrammableSwitchEvent,
        this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );
      this.emit(NestCamEvents.DOORBELL_RANG, true);
    }

    const switchService = this.accessory.getService(this.hap.Service.StatelessProgrammableSwitch);
    if (switchService) {
      switchService.updateCharacteristic(
        this.hap.Characteristic.ProgrammableSwitchEvent,
        this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );
    }
  }
}
