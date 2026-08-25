export interface SupervisorPlistOptions {
  bunPath: string;
  cliPath: string;
  label: string;
  registryPath: string;
  statusPath: string;
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
    <key>ARGUS_REPOS_FILE</key>
    <string>${xml(options.registryPath)}</string>
    <key>ARGUS_SUPERVISOR_STATUS_FILE</key>
    <string>${xml(options.statusPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}
