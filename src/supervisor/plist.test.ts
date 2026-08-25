import { describe, expect, test } from "bun:test";

import { renderSupervisorPlist } from "./plist.ts";

describe("supervisor launchd plist", () => {
  test("renders a byte-stable launch-at-login job with explicit sandboxable paths", () => {
    const options = {
      bunPath: "/opt/homebrew/bin/bun",
      cliPath: "/Applications/Argus & Tools/src/cli.ts",
      label: "dev.argus.test-supervisor",
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
    <key>ARGUS_REPOS_FILE</key>
    <string>/tmp/argus-test/repos</string>
    <key>ARGUS_SUPERVISOR_STATUS_FILE</key>
    <string>/tmp/argus-test/status.json</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`);
  });
});
