import { readFileSync } from "node:fs";
import chalk from "chalk";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { compact, type SessionInfo } from "./model.js";

export const XLOOM_VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
// Braille cells give the diagonals a 14×12 dot grid in the same 7×3 text footprint.
const PIXEL_X = ["⠙⢷⣄ ⣠⡾⠋", "  ⣹⣿⣏  ", "⣠⡾⠋ ⠙⢷⣄"];
const coral = chalk.hex("#D98B73");

/** Model capacity is catalog/configuration metadata, never an inferred runtime budget. */
export function contextLabel(capacity?: number): string {
  if (!Number.isSafeInteger(capacity) || capacity! <= 0) return "";
  const value = capacity!;
  if (value % 1_000_000 === 0) return `[${value / 1_000_000}M]`;
  if (value % 1_048_576 === 0) return `[${value / 1_048_576}M]`;
  if (value % 1000 === 0) return `[${value / 1000}K]`;
  if (value % 1024 === 0) return `[${value / 1024}K]`;
  return `[${value.toLocaleString("en-US")}]`;
}

export class HeaderView implements Component {
  constructor(private readonly session: () => Pick<SessionInfo, "model" | "modelName" | "contextWindow" | "authLabel" | "workspace">, private readonly workspace: string) {}
  invalidate(): void {}
  render(width: number): string[] {
    const info = this.session();
    const model = `${compact(info.modelName ?? info.model, 240)}${contextLabel(info.contextWindow)}`;
    const rows = [`Xloom v${XLOOM_VERSION}`, `${model}${info.authLabel ? ` · ${compact(info.authLabel, 80)}` : ""}`, compact(info.workspace ?? this.workspace, 4096)];
    const logo = width >= 32;
    // Keep the transcript clear of the logo; layout drops this last row first when height is tight.
    return [...rows.map((row, index) => truncateToWidth(`${logo ? ` ${coral(PIXEL_X[index]!)}   ` : ""}${index === 0 ? chalk.bold(row) : chalk.gray(row)}`, Math.max(0, width), width > 3 ? "…" : "")), ""];
  }
}
