import { homedir } from "node:os";
import { join } from "node:path";
export const getAgentDir = () => join(homedir(), ".xloom");
export const getSessionsDir = () => join(getAgentDir(), "sessions");
export const APP_NAME = "xloom";
