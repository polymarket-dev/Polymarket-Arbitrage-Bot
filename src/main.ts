import { loadConfig } from "./config";
import { PolymarketApi } from "./api";
import { MarketMonitor } from "./monitor";
import { DumpHedgeTrader } from "./dumpHedgeTrader";
import { initHistoryLog, logPrintln } from "./logger";
import type { Market } from "./models";

function parseArgs(): { simulation: boolean } {
  const args = process.argv.slice(2);
  const production = args.includes("--production");
  const simulation = production ? false : (args.includes("--simulation") || true);
  return { simulation };
}

async function discoverMarketForAsset(
  api: PolymarketApi,
  asset: string
): Promise<Market> {
  const assetLower = asset.toLowerCase();
  const slugPrefix =
    assetLower === "btc"
      ? "btc"
      : assetLower === "eth"
      ? "eth"
      : assetLower === "sol"
      ? "sol"
      : assetLower === "xrp"
      ? "xrp"
      : (() => {
          throw new Error(
            `Unsupported asset: ${asset}. Supported: BTC, ETH, SOL, XRP`
          );
        })();

  const periodDurationSecs = 900;
  const currentTime = Math.floor(Date.now() / 1000);
  const roundedTime = Math.floor(currentTime / periodDurationSecs) * periodDurationSecs;
  const timeframeStr = "15m";
  const slug = `${slugPrefix}-updown-${timeframeStr}-${roundedTime}`;

  const seenIds = new Set<string>();

  const trySlug = async (s: string): Promise<Market | null> => {
    try {
      const market = await api.getMarketBySlug(s);
      if (
        !seenIds.has(market.conditionId) &&
        market.active &&
        !market.closed
      ) {
        return market;
      }
    } catch (_) {
      // ignore
    }
    return null;
  };

  let market = await trySlug(slug);
  if (market) {
    console.error(
      `Found ${asset} ${timeframeStr} market by slug: ${market.slug} | Condition ID: ${market.conditionId}`
    );
    return market;
  }

  for (let offset = 1; offset <= 3; offset++) {
    const tryTime = roundedTime - offset * periodDurationSecs;
    const trySlugStr = `${slugPrefix}-updown-${timeframeStr}-${tryTime}`;
    console.error(`Trying previous market by slug: ${trySlugStr}`);
    market = await trySlug(trySlugStr);
    if (market) {
      console.error(
        `Found ${asset} ${timeframeStr} market by slug: ${market.slug} | Condition ID: ${market.conditionId}`
      );
      return market;
    }
  }

  throw new Error(
    `Could not find active ${asset} ${timeframeStr} up/down market. Check .env MARKETS.`
  );
}

async function main(): Promise<void> {
  initHistoryLog("history.toml");

  const args = parseArgs();
  const config = loadConfig();
  const simulation = args.simulation !== false ? config.simulation : !config.simulation;

  console.error("Starting Polymarket Hedge Trading Bot");
  console.error("Mode:", simulation ? "SIMULATION" : "PRODUCTION");

  const api = new PolymarketApi(config.polymarket);

  if (!simulation) {
    console.error("Authenticating with Polymarket CLOB API...");
    try {
      await api.authenticate();
      console.error("Authentication successful");
    } catch (e) {
      console.warn("Failed to authenticate:", e);
      console.warn("Order placement may fail. Verify credentials in .env");
    }
  }

  const markets = config.trading.markets;
  if (markets.length === 0) {
    throw new Error(
      "No markets configured. Set MARKETS in .env (e.g. MARKETS=btc,eth,sol,xrp)"
    );
  }

  const {
    dumpHedgeShares: shares,
    dumpHedgeSumTarget: sumTarget,
    dumpHedgeMoveThreshold: moveThreshold,
    dumpHedgeWindowMinutes: windowMinutes,
    dumpHedgeStopLossMaxWaitMinutes: stopLossMaxWait,
    dumpHedgeStopLossPercentage: stopLossPercentage,
    checkIntervalMs,
    marketClosureCheckIntervalSeconds: marketClosureCheckIntervalSeconds,
  } = config.trading;

  console.error("Strategy: DUMP-AND-HEDGE");
  console.error("   - Markets:", markets.map((m) => m.toUpperCase()).join(", "));
  console.error("   - Shares per leg:", shares);
  console.error("   - Sum target:", sumTarget);
  console.error("   - Move threshold:", moveThreshold * 100 + "%");
  console.error("   - Watch window:", windowMinutes, "minutes");
  console.error("   - Stop Loss: Max wait", stopLossMaxWait, "min");
  console.error("   - Mode:", simulation ? "SIMULATION" : "PRODUCTION");
  console.error("");

  const trader = new DumpHedgeTrader(
    api,
    simulation,
    shares,
    sumTarget,
    moveThreshold,
    windowMinutes,
    stopLossMaxWait,
    stopLossPercentage
  );

  setInterval(async () => {
    try {
      await trader.checkMarketClosure();
      const totalProfit = await trader.getTotalProfit();
      const periodProfit = await trader.getPeriodProfit();
      if (totalProfit !== 0 || periodProfit !== 0) {
        logPrintln(
          `Current Profit - Period: $${periodProfit.toFixed(2)} | Total: $${totalProfit.toFixed(2)}`
        );
      }
    } catch (e) {
      console.warn("Error checking market closure:", e);
    }
  }, marketClosureCheckIntervalSeconds * 1000);

  const validMarkets: { asset: string; marketName: string; market: Market }[] = [];

  for (const asset of markets) {
    const assetUpper = asset.toUpperCase();
    const marketName = `${assetUpper} 15m`;
    console.error(`Discovering ${marketName} market...`);
    try {
      const market = await discoverMarketForAsset(api, asset);
      validMarkets.push({ asset, marketName, market });
    } catch (e) {
      console.warn(`Failed to discover ${marketName} market:`, e, "Skipping...");
    }
  }

  if (validMarkets.length === 0) {
    throw new Error(
      "No valid markets found. Check MARKETS in .env and network."
    );
  }

  for (const { asset, marketName, market } of validMarkets) {
    const monitor = new MarketMonitor(
      api,
      marketName,
      market,
      checkIntervalMs
    );

    (async () => {
      let lastProcessedPeriod: number | null = null;
      for (;;) {
        const currentMarketTimestamp = monitor.getCurrentMarketTimestamp();
        const nextPeriodTimestamp = currentMarketTimestamp + 900;
        const currentTime = Math.floor(Date.now() / 1000);
        const sleepSecs =
          nextPeriodTimestamp > currentTime
            ? nextPeriodTimestamp - currentTime
            : 0;
        await new Promise((r) => setTimeout(r, sleepSecs * 1000));

        const now = Math.floor(Date.now() / 1000);
        const currentPeriod = Math.floor(now / 900) * 900;

        if (lastProcessedPeriod !== null && currentPeriod === lastProcessedPeriod) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }

        console.error(
          `New period detected for ${marketName}! (Period: ${currentPeriod}) Discovering new market...`
        );
        lastProcessedPeriod = currentPeriod;

        try {
          const newMarket = await discoverMarketForAsset(api, asset);
          await monitor.updateMarket(newMarket);
          await trader.resetPeriod();
        } catch (e) {
          console.warn(`Failed to discover new ${marketName} market:`, e);
          await new Promise((r) => setTimeout(r, 10000));
        }
      }
    })();

    (async () => {
      await monitor.startMonitoring(async (snapshot) => {
        try {
          await trader.processSnapshot(snapshot);
        } catch (e) {
          console.warn("Error processing snapshot:", e);
        }
      });
    })();
  }

  console.error(`Started monitoring ${validMarkets.length} market(s)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
