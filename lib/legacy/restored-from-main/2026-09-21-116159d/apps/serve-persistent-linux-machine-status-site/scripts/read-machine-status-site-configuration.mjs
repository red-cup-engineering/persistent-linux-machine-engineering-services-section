// Reads the machine status-site configuration document, and the Google
// OAuth client credentials file it may name, off disk. The admission rules
// themselves are pure and live in ../src/machine-status-site-configuration.mjs;
// this is the one single filesystem effect around them, reached through the
// house file-services effect owner rather than node:fs directly.
import { readFileText } from "@red-cup-engineering/file-services/read-file";
import {
  absolutePath,
  admitMachineStatusSiteConfiguration,
  object,
  text,
} from "../src/machine-status-site-configuration.mjs";

/** Reads and admits the configuration document at an absolute path. */
export async function readMachineStatusSiteConfiguration(path) {
  const configurationPath = absolutePath(path, "the machine status-site configuration path");
  let parsed;
  try {
    parsed = JSON.parse(await readFileText(configurationPath));
  } catch (error) {
    throw new TypeError(`the machine status-site configuration at ${configurationPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return admitMachineStatusSiteConfiguration(parsed);
}

/**
 * The Google OAuth client credentials for this site: the JSON file
 * `oauth.clientConfigPath` names, else GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET from the environment the machine supplies.
 */
export async function readOAuthClientEnvironment(configuration, environment = {}) {
  if (configuration.oauth.clientConfigPath === null) return environment;
  let parsed;
  try {
    parsed = JSON.parse(await readFileText(configuration.oauth.clientConfigPath));
  } catch (error) {
    throw new TypeError(`the OAuth client configuration at ${configuration.oauth.clientConfigPath} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parts = object(parsed, "the OAuth client configuration");
  return {
    ...environment,
    GOOGLE_CLIENT_ID: text(parts.googleClientId, "the OAuth client configuration googleClientId"),
    GOOGLE_CLIENT_SECRET: text(parts.googleClientSecret, "the OAuth client configuration googleClientSecret"),
  };
}
