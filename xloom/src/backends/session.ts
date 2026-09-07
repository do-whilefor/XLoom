import { configSecrets, type ActiveConfig } from '../config.js';
import { ChromeBackend, stdioChromeConnector } from './chrome.js';
import { KaliBackend } from './kali.js';

/** One adapter pair per root Session, shared across roles; no mutable role/Run. */
export class SessionBackends {
  readonly chrome: ChromeBackend;
  readonly kali: KaliBackend;
  readonly secrets: string[];
  constructor(config: ActiveConfig, home: string, sessionId: string, adapters?: { chrome?: ChromeBackend; kali?: KaliBackend }) {
    this.secrets = configSecrets(config);
    this.chrome = adapters?.chrome ?? new ChromeBackend(stdioChromeConnector(home, sessionId, this.secrets));
    this.kali = adapters?.kali ?? new KaliBackend(config.kali, this.secrets);
  }
  async close() { const results = await Promise.allSettled([this.chrome.close(), this.kali.close()]); for (const r of results) if (r.status === 'rejected') throw r.reason; }
}
