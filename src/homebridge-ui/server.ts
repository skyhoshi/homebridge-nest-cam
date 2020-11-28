import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { auth, getCameras } from '../nest/connection';
import { NestConfig } from '../nest/models/config';
import { CameraInfo } from '../nest/models/camera';

interface Structure {
  name: string;
  id: string;
}

class UiServer extends HomebridgePluginUiServer {
  private accessToken?: string;
  private issueToken?: string;

  constructor() {
    super();

    this.onRequest('/auth', this.handleAuthRequest.bind(this));
    this.onRequest('/structures', this.handleStructureRequest.bind(this));
    this.onRequest('/cameras', this.handleCamerasRequest.bind(this));

    this.ready();
    // setTimeout(() => {
    //   this.pushEvent('auth-error', { message: 'Something went wrong.' });
    // }, 2000);
  }

  private generateConfig(): NestConfig | undefined {
    if (this.issueToken && this.accessToken) {
      const config: NestConfig = {
        platform: 'Nest-cam',
        fieldTest: this.issueToken?.endsWith('https%3A%2F%2Fhome.ft.nest.com'),
        access_token: this.accessToken,
      };
      return config;
    }
  }

  async handleAuthRequest(payload: any): Promise<boolean> {
    this.accessToken = await auth(payload.issueToken, payload.cookies);
    if (this.accessToken) {
      this.issueToken = payload.issueToken;
      return true;
    } else {
      return false;
    }
  }

  async handleStructureRequest(): Promise<Array<Structure> | undefined> {
    const config = this.generateConfig();

    if (config) {
      const structures: Array<Structure> = [];
      const cameras = await getCameras(config);
      cameras.forEach((cameraInfo) => {
        const exists = structures.find((x) => x.id === cameraInfo.nest_structure_id.replace('structure.', ''));
        if (!exists) {
          structures.push({
            name: cameraInfo.nest_structure_name,
            id: cameraInfo.nest_structure_id.replace('structure.', ''),
          });
        }
      });
      return structures;
    }
  }

  async handleCamerasRequest(): Promise<Array<CameraInfo> | undefined> {
    const config = this.generateConfig();
    if (config) {
      const cameras = await getCameras(config);
      return cameras;
    }
  }
}

// start the instance of the class
((): UiServer => {
  return new UiServer();
})();
