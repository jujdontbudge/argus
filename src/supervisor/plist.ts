export interface SupervisorPlistOptions {
  bunPath: string;
  cliPath: string;
  codexPath: string;
  ghPath: string;
  label: string;
  logPath?: string;
  path: string;
  restartDelayMilliseconds?: string;
  restartLimit?: string;
  restartMaxDelayMilliseconds?: string;
  restartWindowMilliseconds?: string;
  registryPath: string;
  statusPath: string;
  watchMaxRssMiB?: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderSupervisorPlist(
  options: SupervisorPlistOptions,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.bunPath)}</string>
    <string>${xml(options.cliPath)}</string>
    <string>supervisor</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(options.path)}</string>
    <key>ARGUS_CODEX_EXECUTABLE</key>
    <string>${xml(options.codexPath)}</string>
    <key>ARGUS_GH_EXECUTABLE</key>
    <string>${xml(options.ghPath)}</string>
    <key>ARGUS_REPOS_FILE</key>
    <string>${xml(options.registryPath)}</string>
    <key>ARGUS_SUPERVISOR_STATUS_FILE</key>
    <string>${xml(options.statusPath)}</string>
    <key>ARGUS_SUPERVISOR_RESTART_MS</key>
    <string>${xml(options.restartDelayMilliseconds ?? "1000")}</string>
    <key>ARGUS_SUPERVISOR_RESTART_LIMIT</key>
    <string>${xml(options.restartLimit ?? "5")}</string>
    <key>ARGUS_SUPERVISOR_RESTART_MAX_MS</key>
    <string>${xml(options.restartMaxDelayMilliseconds ?? "60000")}</string>
    <key>ARGUS_SUPERVISOR_RESTART_WINDOW_MS</key>
    <string>${xml(options.restartWindowMilliseconds ?? "300000")}</string>
    <key>ARGUS_WATCH_MAX_RSS_MB</key>
    <string>${xml(options.watchMaxRssMiB ?? "512")}</string>
  </dict>
  <key>StandardErrorPath</key>
  <string>${xml(options.logPath ?? `${options.statusPath}.log`)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}
