import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedHostnames, hostnameOf, isAllowedRequest } from './hosts.js';

test('hostnameOf strips ports and handles URLs and IPv6', () => {
  assert.equal(hostnameOf('localhost:8080'), 'localhost');
  assert.equal(hostnameOf('http://Game.Example.com:8080/x'), 'game.example.com');
  assert.equal(hostnameOf('[::1]:8080'), '[::1]');
  assert.equal(hostnameOf(undefined), null);
  assert.equal(hostnameOf('bad host'), null);
});

test('allowed hosts: loopback, bind address, PUBLIC_URL and extras; wildcard binds add nothing', () => {
  const a = allowedHostnames({ host: '0.0.0.0', publicUrl: 'http://10.0.0.5:8080', extra: 'game.lan, other.lan:9000' });
  assert.deepEqual(a.sort(), ['10.0.0.5', '127.0.0.1', '[::1]', 'game.lan', 'localhost', 'other.lan'].sort());
  assert.ok(!a.includes('0.0.0.0'));
  assert.ok(allowedHostnames({ host: '::1', publicUrl: 'http://localhost:8080' }).includes('[::1]'));
});

test('requests: Host must be allowed, Origin too when present', () => {
  const a = allowedHostnames({ host: '127.0.0.1', publicUrl: 'http://localhost:8080' });
  assert.ok(isAllowedRequest(a, 'localhost:8080', undefined));
  assert.ok(isAllowedRequest(a, 'localhost:8080', 'http://localhost:8080'));
  assert.ok(!isAllowedRequest(a, 'evil.example:8080', undefined), 'rebound Host');
  assert.ok(!isAllowedRequest(a, 'localhost:8080', 'https://evil.example'), 'cross-site Origin');
  assert.ok(!isAllowedRequest(a, 'localhost:8080', 'null'), 'opaque Origin');
  assert.ok(!isAllowedRequest(a, undefined, undefined), 'missing Host');
});
