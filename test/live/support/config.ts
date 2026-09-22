import type { ClientTarget } from './stack.js';

export type GatewayConfigOptions = {
  target: ClientTarget;
  accounts: Record<string, string>;
  owners: string[];
  allowFrom: string[];
  redirect?: 'auto' | 'follow' | 'pin';
  room?: string;
  roster?: string[];
  channel?: Record<string, unknown>;
  chain?: Record<string, unknown>;
};

export function accountIdFor(screenName: string): string {
  return screenName.replace(/ /g, '').toLowerCase();
}

export function gatewayConfig(o: GatewayConfigOptions): Record<string, unknown> {
  const accounts = Object.fromEntries(
    Object.entries(o.accounts).map(([screenName, password]) => [accountIdFor(screenName), { screenName, password }]),
  );
  const names = Object.keys(accounts);
  return {
    channels: {
      oscar: {
        enabled: true,
        host: o.target.host,
        port: o.target.port,
        tls: o.target.tls,
        ...(o.target.caFile ? { caFile: o.target.caFile } : {}),
        redirect: o.redirect ?? 'auto',
        owners: o.owners,
        allowFrom: o.allowFrom,
        dmPolicy: 'allowlist',
        ...(o.room ? { room: { name: o.room, exchange: 4, historyFrom: 'listed', notifyOnUnlistedJoin: true } } : {}),
        chain: {
          roster: (o.roster ?? []).map((screenName) => ({ screenName, role: 'general work', aliases: [] })),
          ...(o.chain ?? {}),
        },
        accounts,
        defaultAccount: names[0],
        ...(o.channel ?? {}),
      },
    },
    agents: { list: names.map((id) => ({ id })) },
    bindings: names.map((id) => ({ agentId: id, match: { channel: 'oscar', accountId: id } })),
    commands: { config: true, ownerAllowFrom: o.owners.map((name) => `oscar:${name}`) },
    tools: { alsoAllow: ['message', 'oscar_delegate', 'oscar_status', 'oscar_room'] },
  };
}
