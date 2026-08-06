export const DEFAULT_APP_NAME = "OpenOutposts";

export interface AppNameEnv {
  APP_NAME?: string;
}

export function resolveAppName(env?: AppNameEnv | null): string {
  const value = env?.APP_NAME?.trim();
  return value && value.length > 0 ? value : DEFAULT_APP_NAME;
}
