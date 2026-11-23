/** Connector settings come from environment variables only. Nothing is read from files in the repo. */
export class ConfigError extends Error {}

export interface ConfigSpec {
  /** Variables that must be set, e.g. ["ACME_API_KEY"]. */
  required: string[];
  /** Variables with defaults, e.g. { ACME_BASE_URL: "https://api.acme.example" }. */
  optional?: Record<string, string>;
}

export function loadConfig(spec: ConfigSpec, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const missing = spec.required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    // Names only: values never appear in errors or logs.
    throw new ConfigError(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
  const config: Record<string, string> = {};
  for (const name of spec.required) config[name] = env[name]!.trim();
  for (const [name, fallback] of Object.entries(spec.optional ?? {})) config[name] = env[name]?.trim() || fallback;
  return config;
}
