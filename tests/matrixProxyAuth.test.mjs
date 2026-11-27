import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { transformSync } from 'esbuild';

const source = fs.readFileSync(new URL('../src/main/libs/matrix/kernelPool.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('kernelPool.ts', source, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(n => ts.isFunctionDeclaration(n) && ['onMessage', 'answerProxyChallenge'].includes(n.name?.text));
const code = transformSync(functions.map(fn => fn.getText(ast)).join('\n'), { loader: 'ts' }).code;

test('proxy addresses normalize IPv6/default ports and reject malformed input before any spawn', async () => {
  const address = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'proxyServerAddress');
  const launch = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'doLaunch');
  let touched = false;
  const runtime = vm.createContext({ URL, installedKernelPath: () => { touched = true; }, spawn: () => { touched = true; } });
  vm.runInContext(transformSync(address.getText(ast) + '\n' + launch.getText(ast), { loader: 'ts' }).code, runtime);
  assert.equal(runtime.proxyServerAddress({ protocol: 'http', host: '2001:db8::1', port: 8668 }), 'http://[2001:db8::1]:8668');
  assert.equal(runtime.proxyServerAddress({ protocol: 'https', host: 'PROXY.INVALID', port: 443 }), 'https://proxy.invalid');
  for (const host of ['proxy.invalid/path', 'user@proxy.invalid', 'bad host']) {
    await assert.rejects(runtime.doLaunch({ proxy: { protocol: 'http', host, port: 8668 } }));
    assert.equal(touched, false);
  }
});

test('only the configured proxy challenge receives credentials; server and unknown challenges do not', () => {
  const sent = [];
  const capture = (_s, method, params) => sent.push({ method, params });
  const runtime = vm.createContext({ URL, send: async (...args) => capture(...args), sendNoWait: capture });
  vm.runInContext(code, runtime);
  const auth = { username: 'test-user', password: 'test-pass', origin: 'http://proxy.invalid:8668' };
  for (const challenge of [
    { source: 'Server', origin: auth.origin },
    { source: 'Server', origin: 'https://www.tiktok.com' },
    { source: 'Proxy', origin: 'http://other.invalid:8668' },
    { source: 'Proxy', origin: 'http://proxy.invalid:8080' },
    { source: 'Proxy', origin: 'invalid' },
    {},
  ]) {
    const session = { pending: new Map(), proxyAuth: auth, proxyChallenge: { attempts: new Set() } };
    sent.length = 0;
    runtime.onMessage(session, JSON.stringify({ method: 'Fetch.authRequired', params: { requestId: 'test', authChallenge: challenge } }));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].params.authChallengeResponse.username, undefined);
    assert.equal(sent[0].params.authChallengeResponse.password, undefined);
    assert.equal(session.proxyChallenge.attempts.size, 0);
  }
  sent.length = 0;
  const session = { pending: new Map(), proxyAuth: auth, proxyChallenge: { attempts: new Set() } };
  runtime.onMessage(session, JSON.stringify({ method: 'Fetch.authRequired', params: { requestId: 'test', authChallenge: { source: 'Proxy', origin: auth.origin } } }));
  assert.equal(sent[0].params.authChallengeResponse.response, 'ProvideCredentials');
  assert.equal(sent[0].params.authChallengeResponse.username, auth.username);
  assert.equal(sent.length, 1, 'credentials do not end the authentication scope');
  sent.length = 0;
  runtime.onMessage({ pending: new Map(), proxyAuth: { ...auth, origin: 'null' }, proxyChallenge: { attempts: new Set() } }, JSON.stringify({ method: 'Fetch.authRequired', params: { requestId: 'test', authChallenge: { source: 'Proxy', origin: 'socks5://unrelated.invalid:1080' } } }));
  assert.equal(sent[0].params.authChallengeResponse.response, 'CancelAuth');
  assert.equal(sent[0].params.authChallengeResponse.password, undefined);
});
