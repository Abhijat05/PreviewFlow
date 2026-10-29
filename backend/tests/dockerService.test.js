import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generateContainerName,
  removeContainer,
  runCommand
} from "../src/services/dockerService.js";

describe("dockerService security & execution", () => {
  test("generateContainerName sanitizes inputs to only lowercase alphanumerics and hyphens", () => {
    const maliciousProject = { id: "p12345;rm -rf /;$(calc.exe)" };
    const name = generateContainerName(maliciousProject, "1;reboot", "1&&whoami");

    assert.match(name, /^[a-z0-9-]+$/);
    assert.doesNotMatch(name, /[;$&|`"']/);
  });

  test("removeContainer rejects invalid container names containing shell injection characters", async () => {
    // Shell metacharacters must be rejected immediately without invoking shell
    const maliciousNames = [
      "preview-123; rm -rf /",
      "test && curl http://evil.com",
      "test | cat /etc/passwd",
      "`whoami`",
      "$(id)",
      "test\nrm -rf /"
    ];

    for (const name of maliciousNames) {
      const result = await removeContainer(name);
      assert.equal(result, false, `Should reject malicious container name: ${name}`);
    }
  });

  test("runCommand executes via spawn passing argument array without shell expansion", async () => {
    let captured = "";
    const onData = (chunk) => {
      captured += chunk;
    };

    // Use node to echo exact args preserving special characters
    const testArg = "hello;world&&echo 'safe'|grep safe";
    await runCommand(
      process.execPath,
      ["-e", "console.log(process.argv[1])", testArg],
      onData
    );

    assert.ok(
      captured.includes(testArg),
      `Expected output to contain literal argument without shell execution: ${captured}`
    );
  });

  test("runCommand rejects on non-zero exit code", async () => {
    await assert.rejects(
      async () => {
        await runCommand(process.execPath, ["-e", "process.exit(42)"], () => {});
      },
      (err) => {
        assert.match(err.message, /exit code 42/i);
        return true;
      }
    );
  });
});
