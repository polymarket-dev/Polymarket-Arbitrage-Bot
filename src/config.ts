import dotenv from "dotenv";

dotenv.config();

function env(key: string, defaultValue?: string): string {
  const v = process.env[key] ?? defaultValue;
  if (v === undefined) throw new Error(`Missing env: ${key}`);
  return v;
}

function envOptional(key: string): string | undefined {
  return process.env[key];
}

function envNumber(key: string, defaultValue: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Invalid number for ${key}: ${v}`);
  return n;
}

function envBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  return v.toLowerCase() === "true" || v === "1";
}

/** Comma-separated list, e.g. MARKETS=eth,btc,sol */
function envList(key: string, defaultList: string[]): string[] {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultList;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export interface PolymarketConfig {
  gammaApiUrl: string;
  clobApiUrl: string;
  apiKey: string | undefined;
  apiSecret: string | undefined;
  apiPassphrase: string | undefined;
  privateKey: string | undefined;
  proxyWalletAddress: string | undefined;
  signatureType: number; // 0 EOA, 1 Proxy, 2 GnosisSafe
}

export interface TradingConfig {
  checkIntervalMs: number;
  marketClosureCheckIntervalSeconds: number;
  markets: string[];
  dumpHedgeShares: number;
  dumpHedgeSumTarget: number;
  dumpHedgeMoveThreshold: number;
  dumpHedgeWindowMinutes: number;
  dumpHedgeStopLossMaxWaitMinutes: number;
  dumpHedgeStopLossPercentage: number;
}

export interface Config {
  polymarket: PolymarketConfig;
  trading: TradingConfig;
  simulation: boolean;
}

export function loadConfig(): Config {
  const production = envBool("PRODUCTION", false);
  const simulation = !production;

  return {
    polymarket: {
      gammaApiUrl: env("GAMMA_API_URL", "https://gamma-api.polymarket.com"),
      clobApiUrl: env("CLOB_API_URL", "https://clob.polymarket.com"),
      apiKey: envOptional("API_KEY"),
      apiSecret: envOptional("API_SECRET"),
      apiPassphrase: envOptional("API_PASSPHRASE"),
      privateKey: envOptional("PRIVATE_KEY"),
      proxyWalletAddress: envOptional("PROXY_WALLET_ADDRESS"),
      signatureType: envNumber("SIGNATURE_TYPE", 2),
    },
    trading: {
      checkIntervalMs: envNumber("CHECK_INTERVAL_MS", 1000),
      marketClosureCheckIntervalSeconds: envNumber("MARKET_CLOSURE_CHECK_INTERVAL_SECONDS", 20),
      markets: envList("MARKETS", ["btc"]),
      dumpHedgeShares: envNumber("DUMP_HEDGE_SHARES", 10),
      dumpHedgeSumTarget: envNumber("DUMP_HEDGE_SUM_TARGET", 0.95),
      dumpHedgeMoveThreshold: envNumber("DUMP_HEDGE_MOVE_THRESHOLD", 0.15),
      dumpHedgeWindowMinutes: envNumber("DUMP_HEDGE_WINDOW_MINUTES", 2),
      dumpHedgeStopLossMaxWaitMinutes: envNumber("DUMP_HEDGE_STOP_LOSS_MAX_WAIT_MINUTES", 5),
      dumpHedgeStopLossPercentage: envNumber("DUMP_HEDGE_STOP_LOSS_PERCENTAGE", 0.2),
    },
    simulation,
  };
}
