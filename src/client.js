import { signCommand } from './crypto.js';
export class AgentClient {
  constructor(url, wallet) { this.url = url.replace(/\/$/, ''); this.wallet = wallet; }
  async request(path, body) {
    const response = await fetch(`${this.url}${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error?.message ?? `HTTP ${response.status}`);
      error.code = result.error?.code; throw error;
    }
    return result;
  }
  walletInfo() { return this.request(`/v1/wallets/${encodeURIComponent(this.wallet.player)}`); }
  async send(command) {
    const { nextNonce, serverId } = await this.walletInfo();
    return this.request('/v1/commands', signCommand(this.wallet, { ...command, serverId }, nextNonce));
  }
  async matchCommand(type, matchId, extra = {}) {
    const { match } = await this.request(`/v1/matches/${encodeURIComponent(matchId)}`);
    return this.send({ ...extra, type, matchId, expectedVersion: match.version });
  }
  view(matchId) { return this.send({ type: 'view', matchId }); }
  // Use the version from the state your strategy actually observed.
  act(match, action, amount) {
    return this.send({ type: 'action', matchId: match.id, expectedVersion: match.version, action,
      ...(amount === undefined ? {} : { amount }) });
  }
}
