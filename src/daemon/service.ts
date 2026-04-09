import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  stageLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  installPm2Service,
  isPm2Available,
  isPm2ServiceEnabled,
  readPm2ServiceCommand,
  readPm2ServiceRuntime,
  restartPm2Service,
  stopPm2Service,
  uninstallPm2Service,
} from "./pm2.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  readScheduledTaskRuntime,
  restartScheduledTask,
  stageScheduledTask,
  stopScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  isSystemdUserServiceAvailable,
  readSystemdServiceExecStart,
  readSystemdServiceRuntime,
  restartSystemdService,
  stageSystemdService,
  stopSystemdService,
  uninstallSystemdService,
} from "./systemd.js";

export { isPm2Available };
export type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceRestartResult,
  GatewayServiceStartResult,
  GatewayServiceStageArgs,
  GatewayServiceState,
} from "./service-types.js";

function ignoreServiceWriteResult<TArgs extends GatewayServiceInstallArgs>(
  write: (args: TArgs) => Promise<unknown>,
): (args: TArgs) => Promise<void> {
  return async (args: TArgs) => {
    await write(args);
  };
}

export type GatewayService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  stage: (args: GatewayServiceStageArgs) => Promise<void>;
  install: (args: GatewayServiceInstallArgs) => Promise<void>;
  uninstall: (args: GatewayServiceManageArgs) => Promise<void>;
  stop: (args: GatewayServiceControlArgs) => Promise<void>;
  restart: (args: GatewayServiceControlArgs) => Promise<GatewayServiceRestartResult>;
  isLoaded: (args: GatewayServiceEnvArgs) => Promise<boolean>;
  readCommand: (env: GatewayServiceEnv) => Promise<GatewayServiceCommandConfig | null>;
  readRuntime: (env: GatewayServiceEnv) => Promise<GatewayServiceRuntime>;
};

function mergeGatewayServiceEnv(
  baseEnv: GatewayServiceEnv,
  command: GatewayServiceCommandConfig | null,
): GatewayServiceEnv {
  if (!command?.environment) {
    return baseEnv;
  }
  return {
    ...baseEnv,
    ...command.environment,
  };
}

export async function readGatewayServiceState(
  service: GatewayService,
  args: GatewayServiceEnvArgs = {},
): Promise<GatewayServiceState> {
  const baseEnv = args.env ?? (process.env as GatewayServiceEnv);
  const command = await service.readCommand(baseEnv).catch(() => null);
  const env = mergeGatewayServiceEnv(baseEnv, command);
  const [loaded, runtime] = await Promise.all([
    service.isLoaded({ env }).catch(() => false),
    service.readRuntime(env).catch(() => undefined),
  ]);
  return {
    installed: command !== null,
    loaded,
    running: runtime?.status === "running",
    env,
    command,
    runtime,
  };
}

export async function startGatewayService(
  service: GatewayService,
  args: GatewayServiceControlArgs,
): Promise<GatewayServiceStartResult> {
  const state = await readGatewayServiceState(service, { env: args.env });
  if (!state.loaded && !state.installed) {
    return {
      outcome: "missing-install",
      state,
    };
  }

  try {
    const restartResult = await service.restart({ ...args, env: state.env });
    const nextState = await readGatewayServiceState(service, { env: state.env });
    return {
      outcome: restartResult.outcome === "scheduled" ? "scheduled" : "started",
      state: nextState,
    };
  } catch (err) {
    const nextState = await readGatewayServiceState(service, { env: state.env });
    if (!nextState.installed) {
      return {
        outcome: "missing-install",
        state: nextState,
      };
    }
    throw err;
  }
}

export function describeGatewayServiceRestart(
  serviceNoun: string,
  result: GatewayServiceRestartResult,
): {
  scheduled: boolean;
  daemonActionResult: "restarted" | "scheduled";
  message: string;
  progressMessage: string;
} {
  if (result.outcome === "scheduled") {
    return {
      scheduled: true,
      daemonActionResult: "scheduled",
      message: `restart scheduled, ${normalizeLowercaseStringOrEmpty(serviceNoun)} will restart momentarily`,
      progressMessage: `${serviceNoun} service restart scheduled.`,
    };
  }
  return {
    scheduled: false,
    daemonActionResult: "restarted",
    message: `${serviceNoun} service restarted.`,
    progressMessage: `${serviceNoun} service restarted.`,
  };
}

type SupportedGatewayServicePlatform = "darwin" | "linux" | "win32";

const GATEWAY_SERVICE_REGISTRY: Record<SupportedGatewayServicePlatform, GatewayService> = {
  darwin: {
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: ignoreServiceWriteResult(stageLaunchAgent),
    install: ignoreServiceWriteResult(installLaunchAgent),
    uninstall: uninstallLaunchAgent,
    stop: stopLaunchAgent,
    restart: restartLaunchAgent,
    isLoaded: isLaunchAgentLoaded,
    readCommand: readLaunchAgentProgramArguments,
    readRuntime: readLaunchAgentRuntime,
  },
  linux: {
    label: "Systemd/PM2",
    loadedText: "active",
    notLoadedText: "inactive",
    stage: ignoreServiceWriteResult(stageSystemdService),
    install: async (args) => {
      if (await isSystemdUserServiceAvailable()) {
        await installSystemdService(args);
      } else if (await isPm2Available()) {
        await installPm2Service(args);
      } else {
        await installSystemdService(args);
      }
    },
    uninstall: async (args) => {
      if (await isSystemdUserServiceAvailable()) {
        try {
          await uninstallSystemdService(args);
        } catch {}
      }
      if (await isPm2Available()) {
        try {
          await uninstallPm2Service(args);
        } catch {}
      }
    },
    stop: async (args) => {
      if (
        (await isSystemdUserServiceAvailable()) &&
        (await isSystemdServiceEnabled({ env: args.env }))
      ) {
        await stopSystemdService(args);
        return;
      }
      if ((await isPm2Available()) && (await isPm2ServiceEnabled({ env: args.env }))) {
        await stopPm2Service(args);
        return;
      }
      await stopSystemdService(args);
    },
    restart: async (args) => {
      if (
        (await isSystemdUserServiceAvailable()) &&
        (await isSystemdServiceEnabled({ env: args.env }))
      ) {
        return await restartSystemdService(args);
      }
      if ((await isPm2Available()) && (await isPm2ServiceEnabled({ env: args.env }))) {
        await restartPm2Service(args);
        return { outcome: "completed" } as const;
      }
      if (await isSystemdUserServiceAvailable()) {
        return await restartSystemdService(args);
      } else if (await isPm2Available()) {
        await restartPm2Service(args);
        return { outcome: "completed" } as const;
      } else {
        return await restartSystemdService(args);
      }
    },
    isLoaded: async (args) => {
      if (await isSystemdUserServiceAvailable()) {
        if (await isSystemdServiceEnabled(args)) {
          return true;
        }
      }
      if (await isPm2Available()) {
        if (await isPm2ServiceEnabled(args)) {
          return true;
        }
      }
      return false;
    },
    readCommand: async (env) => {
      if (await isSystemdUserServiceAvailable()) {
        const cmd = await readSystemdServiceExecStart(env);
        if (cmd) {
          return cmd;
        }
      }
      if (await isPm2Available()) {
        const cmd = await readPm2ServiceCommand(env);
        if (cmd) {
          return cmd;
        }
      }
      return null;
    },
    readRuntime: async (env) => {
      if (await isSystemdUserServiceAvailable()) {
        const rt = await readSystemdServiceRuntime(env);
        if (!rt.missingUnit) {
          return rt;
        }
      }
      if (await isPm2Available()) {
        return await readPm2ServiceRuntime(env);
      }
      return { status: "unknown", detail: "Systemd/PM2 unavailable" };
    },
  },
  win32: {
    label: "Scheduled Task",
    loadedText: "registered",
    notLoadedText: "missing",
    stage: ignoreServiceWriteResult(stageScheduledTask),
    install: ignoreServiceWriteResult(installScheduledTask),
    uninstall: uninstallScheduledTask,
    stop: stopScheduledTask,
    restart: restartScheduledTask,
    isLoaded: isScheduledTaskInstalled,
    readCommand: readScheduledTaskCommand,
    readRuntime: readScheduledTaskRuntime,
  },
};

function isSupportedGatewayServicePlatform(
  platform: NodeJS.Platform,
): platform is SupportedGatewayServicePlatform {
  return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}

export function resolveGatewayService(): GatewayService {
  if (isSupportedGatewayServicePlatform(process.platform)) {
    return GATEWAY_SERVICE_REGISTRY[process.platform];
  }
  throw new Error(`Gateway service install not supported on ${process.platform}`);
}
