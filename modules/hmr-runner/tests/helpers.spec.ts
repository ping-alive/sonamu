import { test } from "@japa/runner";
import { type ExecaError } from "execa";

import { runNode } from "../src/helpers.js";

test.group("Child process", () => {
  test("run typescript file as a child process", async ({ fs, assert }) => {
    await fs.create(
      "foo.ts",
      `
      process.send('ready')
    `,
    );

    const childProcess = runNode(fs.basePath, {
      script: "foo.ts",
      scriptArgs: [],
      nodeArgs: ["--import=../tsnode.esm.js"],
    });
    const payload = await childProcess.getOneMessage();
    const result = await childProcess;

    assert.equal(result.exitCode, 0);
    assert.equal(payload, "ready");
  });

  test("pass arguments to the script", async ({ fs, assert }) => {
    await fs.create(
      "foo.ts",
      `
      process.send({ args: process.argv.splice(2) })
    `,
    );

    const childProcess = runNode(fs.basePath, {
      script: "foo.ts",
      scriptArgs: ["--watch", "--foo=bar"],
      nodeArgs: ["--import=../tsnode.esm.js"],
    });
    const payload = await childProcess.getOneMessage();
    const result = await childProcess;

    assert.equal(result.exitCode, 0);
    assert.deepEqual(payload, { args: ["--watch", "--foo=bar"] });
  });

  test("pass arguments to node", async ({ assert, fs }) => {
    await fs.create(
      "foo.ts",
      `
      process.send({ args: process.execArgv })
    `,
    );

    const childProcess = runNode(fs.basePath, {
      script: "foo.ts",
      scriptArgs: ["--watch", "--foo=bar"],
      nodeArgs: ["--conditions=dev", "--import=tsx"],
    });

    const payload = await childProcess.getOneMessage();
    const result = await childProcess;

    assert.equal(result.exitCode, 0);
    assert.deepEqual(payload, {
      args: ["--enable-source-maps", "--conditions=dev", "--import=tsx"],
    });
  });

  test("wait for child process to finish", async ({ fs, assert }) => {
    await fs.create(
      "foo.ts",
      `
      setTimeout(() => {}, 1000)
    `,
    );

    const childProcess = runNode(fs.basePath, {
      script: "foo.ts",
      scriptArgs: [],
      nodeArgs: ["--import=../tsnode.esm.js"],
    });
    const result = await childProcess;
    assert.equal(result.exitCode, 0);
  });

  test("get child process exit code", async ({ fs, assert }) => {
    await fs.create(
      "foo.ts",
      `
      throw new Error('Something went wrong')
    `,
    );

    const childProcess = runNode(fs.basePath, {
      script: "foo.ts",
      scriptArgs: [],
      nodeArgs: ["--import=../tsnode.esm.js"],
    });

    // execa 10은 비정상 종료를 거부로 알리므로 reject: false로 결과만 받는다
    const result = await childProcess.catch((error: ExecaError) => error);
    assert.equal(result.exitCode, 1);
  });

  test("await and get child process exit code", async ({ fs, assert }) => {
    assert.plan(1);

    await fs.create(
      "foo.ts",
      `
      throw new Error('Something went wrong')
    `,
    );

    const childProcess = runNode(fs.basePath, {
      script: "foo.ts",
      scriptArgs: [],
      nodeArgs: ["--import=../tsnode.esm.js"],
    });
    try {
      await childProcess;
    } catch (error) {
      // SAFETY: execaNode의 거부 값은 exitCode를 가진 ExecaError다
      assert.equal((error as ExecaError).exitCode, 1);
    }
  });
});
