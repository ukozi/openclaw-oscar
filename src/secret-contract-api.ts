import {
  collectConditionalChannelFieldAssignments,
  getChannelSurface,
  hasConfiguredSecretInputValue,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';
import type {
  ChannelAccountEntry,
  ResolverContext,
  SecretDefaults,
  SecretTargetRegistryEntry,
} from 'openclaw/plugin-sdk/channel-secret-basic-runtime';

function target(pathPattern: string): SecretTargetRegistryEntry {
  return {
    id: pathPattern,
    targetType: pathPattern,
    configFile: 'openclaw.json',
    pathPattern,
    secretShape: 'secret_input',
    expectedResolvedValue: 'string',
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  };
}

export const secretTargetRegistryEntries: SecretTargetRegistryEntry[] = [
  target('channels.oscar.accounts.*.password'),
  target('channels.oscar.password'),
];

function fileOf(record: Record<string, unknown>): string {
  const value = record['passwordFile'];
  return typeof value === 'string' ? value.trim() : '';
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const resolved = getChannelSurface(params.config, 'oscar');
  if (!resolved) return;
  const { channel, surface } = resolved;
  const baseFile = fileOf(channel);
  collectConditionalChannelFieldAssignments({
    channelKey: 'oscar',
    field: 'password',
    channel,
    surface,
    defaults: params.defaults,
    context: params.context,
    topLevelActiveWithoutAccounts: baseFile.length === 0,
    topLevelInheritedAccountActive: ({ account, enabled }: ChannelAccountEntry) =>
      enabled &&
      baseFile.length === 0 &&
      fileOf(account).length === 0 &&
      !hasConfiguredSecretInputValue(account['password'], params.defaults),
    accountActive: ({ account, enabled }: ChannelAccountEntry) => enabled && fileOf(account).length === 0,
    topInactiveReason: 'no enabled account inherits the top-level secret because passwordFile is set.',
    accountInactiveReason: 'the account is disabled or passwordFile is set.',
  });
}

export const channelSecrets = { secretTargetRegistryEntries, collectRuntimeConfigAssignments };
