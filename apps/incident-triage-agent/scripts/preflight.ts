import { appMetadata, loadAppConfig } from '../src/config/app.js';

const config = loadAppConfig();

console.log(
  `${appMetadata.appId} configuration is valid (role=${config.processRole}, host=${config.host}, port=${String(config.port)})`,
);
