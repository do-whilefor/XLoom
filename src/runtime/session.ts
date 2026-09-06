import { SessionManager } from '../vendor/pi/coding-agent/core/session-manager.js';
export { SessionManager };
export function readSession(path: string) {
  return SessionManager.open(path).buildSessionContext();
}
