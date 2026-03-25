import * as fs from "fs";

let historyStream: fs.WriteStream | null = null;

export function initHistoryLog(path: string = "history.toml"): void {
  if (historyStream) return;
  historyStream = fs.createWriteStream(path, { flags: "a" });
}

export function logToHistory(message: string): void {
  process.stderr.write(message);
  if (historyStream) {
    historyStream.write(message);
    historyStream.emit("drain");
  }
}

export function logPrintln(...args: unknown[]): void {
  const message = args.map(String).join(" ") + "\n";
  logToHistory(message);
}
