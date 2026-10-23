const test = require('node:test');
const assert = require('node:assert');
const { parseClientJson } = require('../src/main/client.js');

const desktop = {
  installed: {
    client_id: '123-abc.apps.googleusercontent.com',
    project_id: 'desktop-calendar',
    client_secret: 'GOCSPX-secret',
    redirect_uris: ['http://localhost'],
  },
};

test('Google Cloud でダウンロードした「デスクトップ アプリ」の JSON を読める', () => {
  assert.deepEqual(parseClientJson(JSON.stringify(desktop)), {
    clientId: '123-abc.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-secret',
  });
});

test('BOM 付きのファイルでも読める', () => {
  assert.equal(parseClientJson(`﻿${JSON.stringify(desktop)}`).clientSecret, 'GOCSPX-secret');
});

test('「ウェブ アプリケーション」用の JSON は理由を添えて断る', () => {
  const web = { web: { client_id: '1-x.apps.googleusercontent.com', client_secret: 's' } };
  assert.throws(() => parseClientJson(JSON.stringify(web)), /デスクトップ アプリ/);
});

test('シークレットが入っていない JSON は断る', () => {
  const noSecret = { installed: { client_id: '1-x.apps.googleusercontent.com' } };
  assert.throws(() => parseClientJson(JSON.stringify(noSecret)), /シークレット/);
});

test('関係のない JSON や壊れたファイルは断る', () => {
  assert.throws(() => parseClientJson('{"name":"package"}'), /client_id/);
  assert.throws(() => parseClientJson('not json'), /JSON/);
});
