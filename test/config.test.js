import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';
import { PaperExchange as RisexPaperExchange } from '../src/exchange/rs/paper.js';

const envNames = ['RS_NETWORK', 'RISEX_API_URL', 'RISEX_WS_URL'];
const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

try {
  for (const name of envNames) delete process.env[name];

  const mainnet = getConfig().rs;
  assert.equal(mainnet.apiUrl, 'https://api.rise.trade');
  assert.equal(mainnet.wsUrl, 'wss://api.rise.trade/ws/');

  const paper = new RisexPaperExchange();
  assert.equal(paper.candidates[0], 'https://api.rise.trade');
  assert.equal(paper.candidates.includes('https://api.risex.trade'), false);

  process.env.RISEX_API_URL = 'https://custom.example/api';
  process.env.RISEX_WS_URL = 'wss://custom.example/ws';
  const overridden = getConfig().rs;
  assert.equal(overridden.apiUrl, process.env.RISEX_API_URL);
  assert.equal(overridden.wsUrl, process.env.RISEX_WS_URL);
} finally {
  for (const name of envNames) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}

console.log('config tests passed');
