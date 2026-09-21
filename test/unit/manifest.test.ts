import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const readJson = (name: string): Record<string, any> => JSON.parse(readFileSync(root + name, 'utf8'));
const pkg = readJson('package.json');
const manifest = readJson('openclaw.plugin.json');
const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

describe('package.json', () => {
  it('names the package, licence and author', () => {
    expect(pkg.name).toBe('@ukozi/openclaw-oscar');
    expect(pkg.version).toMatch(exact);
    expect(pkg.license).toBe('MIT');
    expect(pkg.author).toBe('Lucas Chumley');
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBeUndefined();
    expect(pkg.repository.url).toBe('git+https://github.com/ukozi/openclaw-oscar.git');
    expect(pkg.description.length).toBeGreaterThan(12);
  });

  it('copies the host engines range', () => {
    expect(pkg.engines.node).toBe('>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0');
  });

  it('ships by allowlist only', () => {
    expect(pkg.files).toEqual(['dist', 'openclaw.plugin.json', 'assets/icon.png']);
    expect(existsSync(root + '.npmignore')).toBe(false);
    expect(pkg.main).toBeUndefined();
    expect(pkg.bin).toBeUndefined();
  });

  it('has the contract scripts', () => {
    expect(pkg.scripts).toMatchObject({
      build: 'tsc -p tsconfig.build.json',
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      'test:live': 'vitest run --config vitest.live.config.ts',
      'pack:check': 'vitest run test/pack.test.ts',
    });
    for (const name of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack']) {
      expect(pkg.scripts[name]).toBeUndefined();
    }
  });

  it('pins every dependency to an exact version', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['zod']);
    expect(Object.keys(pkg.devDependencies).sort()).toEqual([
      '@openclaw/plugin-inspector',
      '@types/node',
      'openclaw',
      'typescript',
      'vitest',
    ]);
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(version, name).toMatch(exact);
      expect(version, name).not.toBe('0.0.0');
    }
    expect(pkg.devDependencies.openclaw).toBe('2026.7.1-2');
  });

  it('declares the host as an optional peer with no upper bound', () => {
    expect(pkg.peerDependencies).toEqual({ openclaw: '>=2026.7.1' });
    expect(pkg.peerDependenciesMeta).toEqual({ openclaw: { optional: true } });
  });

  it('pairs every source entry with a built entry', () => {
    const oc = pkg.openclaw;
    expect(oc.extensions).toEqual(['./src/index.ts']);
    expect(oc.runtimeExtensions).toEqual(['./dist/index.js']);
    expect(oc.runtimeExtensions).toHaveLength(oc.extensions.length);
    expect(oc.setupEntry).toBe('./src/setup-entry.ts');
    expect(oc.runtimeSetupEntry).toBe('./dist/setup-entry.js');
  });

  it('carries the fields a registry publish requires', () => {
    const oc = pkg.openclaw;
    expect(oc.compat).toEqual({ pluginApi: '>=2026.7.1', minGatewayVersion: '2026.7.1' });
    expect(oc.compat.pluginApi).not.toMatch(/\|\||</);
    expect(oc.build).toEqual({ openclawVersion: '2026.7.1-2', pluginSdkVersion: '2026.7.1-2' });
    expect(oc.build.openclawVersion).toBe(pkg.devDependencies.openclaw);
    expect(oc.install).toEqual({
      clawhubSpec: 'clawhub:@ukozi/openclaw-oscar',
      npmSpec: '@ukozi/openclaw-oscar',
      defaultChoice: 'clawhub',
      minHostVersion: '>=2026.7.1',
    });
    expect(Object.keys(oc).sort()).toEqual([
      'build',
      'channel',
      'compat',
      'extensions',
      'install',
      'runtimeExtensions',
      'runtimeSetupEntry',
      'setupEntry',
    ]);
  });

  it('describes the channel the same way the manifest does', () => {
    expect(pkg.openclaw.channel.id).toBe('oscar');
    expect(pkg.openclaw.channel.label).toBe(manifest.channelConfigs.oscar.label);
    for (const key of ['label', 'selectionLabel', 'docsPath', 'blurb']) {
      expect(typeof pkg.openclaw.channel[key], key).toBe('string');
    }
  });
});

describe('openclaw.plugin.json', () => {
  it('uses only documented top-level keys', () => {
    const allowed = ['id', 'name', 'description', 'channels', 'activation', 'configSchema', 'channelConfigs', 'contracts'];
    expect(Object.keys(manifest).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(manifest.version).toBeUndefined();
    expect(manifest.channelEnvVars).toBeUndefined();
  });

  it('owns the oscar channel', () => {
    expect(manifest.id).toBe('oscar');
    expect(manifest.channels).toEqual(['oscar']);
    expect(manifest.activation).toEqual({ onChannels: ['oscar'] });
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  it('has a strict, empty plugin config schema', () => {
    expect(manifest.configSchema).toEqual({ type: 'object', additionalProperties: false, properties: {} });
  });

  it('has a channel config schema for every declared channel', () => {
    expect(Object.keys(manifest.channelConfigs)).toEqual(manifest.channels);
    expect(manifest.channelConfigs.oscar.schema.type).toBe('object');
    expect(typeof manifest.channelConfigs.oscar.schema.properties).toBe('object');
  });

  it('marks the password as sensitive', () => {
    expect(manifest.channelConfigs.oscar.uiHints.password.sensitive).toBe(true);
  });

  it('declares only tools that are registered', () => {
    expect([...(manifest.contracts?.tools ?? [])].sort()).toEqual(['oscar_delegate', 'oscar_room', 'oscar_status']);
  });
});
