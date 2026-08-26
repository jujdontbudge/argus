import { describe, expect, test } from "bun:test";

import { renderSupervisorPlist } from "./plist.ts";

describe("supervisor launchd plist", () => {
  test("renders a byte-stable launch-at-login job with explicit sandboxable paths", () => {
    const options = {
      bunPath: "/opt/homebrew/bin/bun",
      cliPath: "/Applications/Argus & Tools/src/cli.ts",
      codexPath: "/Users/test/.local/bin/codex",
      ghPath: "/opt/homebrew/bin/gh",
      label: "dev.argus.test-supervisor",
      path: "/Users/test/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      registryPath: "/tmp/argus-test/repos",
      statusPath: "/tmp/argus-test/status.json",
    };

    const first = renderSupervisorPlist(options);
    const second = renderSupervisorPlist(options);

    expect(second).toBe(first);
    expect(first).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.argus.test-supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/bun</string>
    <string>/Applications/Argus &amp; Tools/src/cli.ts</string>
    <string>supervisor</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/test/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>ARGUS_CODEX_EXECUTABLE</key>
    <string>/Users/test/.local/bin/codex</string>
    <key>ARGUS_GH_EXECUTABLE</key>
    <string>/opt/homebrew/bin/gh</string>
    <key>ARGUS_REPOS_FILE</key>
    <string>/tmp/argus-test/repos</string>
    <key>ARGUS_SUPERVISOR_STATUS_FILE</key>
    <string>/tmp/argus-test/status.json</string>
    <key>ARGUS_SUPERVISOR_RESTART_MS</key>
    <string>1000</string>
    <key>ARGUS_SUPERVISOR_RESTART_LIMIT</key>
    <string>5</string>
    <key>ARGUS_SUPERVISOR_RESTART_MAX_MS</key>
    <string>60000</string>
    <key>ARGUS_SUPERVISOR_RESTART_WINDOW_MS</key>
    <string>300000</string>
    <key>ARGUS_WATCH_MAX_RSS_MB</key>
    <string>512</string>
  </dict>
  <key>StandardErrorPath</key>
  <string>/tmp/argus-test/status.json.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`);
  });
});
