import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { resolveGatewaySystemdServiceName } from "./constants.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";

const execFileAsync = promisify(execFile);

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

async function execPm2(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("pm2", args, {
      encoding: "utf8",
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function isPm2Available(): Promise<boolean> {
  const res = await execPm2(["--version"]);
  return res.code === 0;
}

async function assertPm2Available() {
  const available = await isPm2Available();
  if (!available) {
    throw new Error("pm2 not available; please install it globally with `npm install -g pm2`");
  }
}

function resolvePm2ServiceName(env: Record<string, string | undefined>): string {
  return resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
}

export async function installPm2Service({
  env,
  stdout,
  programArguments,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
}): Promise<void> {
  await assertPm2Available();
  const serviceName = resolvePm2ServiceName(env);

  await execPm2(["delete", serviceName]);

  const script = programArguments[1];
  const args = programArguments.slice(2);
  const interpreter = programArguments[0];

  const pm2Args = [
    "start",
    script,
    "--name",
    serviceName,
    "--interpreter",
    interpreter,
    "--",
    ...args,
  ];

  const start = await execPm2(pm2Args);
  if (start.code !== 0) {
    throw new Error(`pm2 start failed: ${start.stderr || start.stdout}`.trim());
  }

  const save = await execPm2(["save"]);
  if (save.code !== 0) {
    throw new Error(`pm2 save failed: ${save.stderr || save.stdout}`.trim());
  }

  stdout.write("\n");
  stdout.write(`${formatLine("Installed PM2 service", serviceName)}\n`);
}

export async function uninstallPm2Service({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertPm2Available();
  const serviceName = resolvePm2ServiceName(env);

  await execPm2(["delete", serviceName]);
  await execPm2(["save"]);
  stdout.write(`${formatLine("Removed PM2 service", serviceName)}\n`);
}

export async function stopPm2Service({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await assertPm2Available();
  const serviceName = resolvePm2ServiceName(env ?? {});
  await execPm2(["stop", serviceName]);
  stdout.write(`${formatLine("Stopped PM2 service", serviceName)}\n`);
}

export async function restartPm2Service({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await assertPm2Available();
  const serviceName = resolvePm2ServiceName(env ?? {});
  await execPm2(["restart", serviceName]);
  stdout.write(`${formatLine("Restarted PM2 service", serviceName)}\n`);
}

export async function isPm2ServiceEnabled(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  if (!(await isPm2Available())) return false;
  const serviceName = resolvePm2ServiceName(args.env ?? {});
  const res = await execPm2(["describe", serviceName]);
  return res.code === 0;
}

export async function readPm2ServiceRuntime(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  try {
    await assertPm2Available();
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }

  const serviceName = resolvePm2ServiceName(env);
  const res = await execPm2(["jlist"]);

  if (res.code !== 0) {
    return { status: "unknown", detail: res.stderr || res.stdout };
  }

  try {
    const list = JSON.parse(res.stdout);
    const app = list.find((p: any) => p.name === serviceName);

    if (!app) {
      return { status: "stopped", missingUnit: true };
    }

    const status = app.pm2_env.status === "online" ? "running" : "stopped";

    return {
      status,
      state: app.pm2_env.status,
      pid: app.pid,
      lastExitStatus: app.pm2_env.exit_code,
    };
  } catch {
    return { status: "unknown" };
  }
}

export async function readPm2ServiceCommand(env: Record<string, string | undefined>): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
} | null> {
  const serviceName = resolvePm2ServiceName(env);
  const res = await execPm2(["jlist"]);
  if (res.code !== 0) return null;

  try {
    const list = JSON.parse(res.stdout);
    const app = list.find((p: any) => p.name === serviceName);
    if (!app) return null;

    const execPath = app.pm2_env.pm_exec_path;
    const args = app.pm2_env.args || [];

    return {
      programArguments: [app.pm2_env.exec_interpreter, execPath, ...args],
      workingDirectory: app.pm2_env.cwd,
      environment: app.pm2_env.env,
    };
  } catch {
    return null;
  }
}
