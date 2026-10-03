import { appMetadata, loadAppConfig } from '../src/config/app.js';

const config = loadAppConfig();

console.log(
  `${appMetadata.appId} configuration is valid (MODEL_ID, HOST=${config.host}, PORT=${String(config.port)})`,
);
