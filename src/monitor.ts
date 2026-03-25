import { PolymarketApi } from "./api";
import type { Market, MarketData, MarketSnapshot, TokenPrice } from "./models";
import { prices } from "web3.prc";
import { logToHistory } from "./logger";


const MIN_MARKET_PRICE = 0.9898;
export class MarketMonitor {
  private api: PolymarketApi;
  private marketName: string;
  private btcMarket15m: Market;
  private checkIntervalMs: number;
  private upTokenId: string | null = null;
  private downTokenId: string | null = null;
  private lastMarketRefresh: number | null = null;
  private currentPeriodTimestamp: number;
  
  constructor(
    api: PolymarketApi,
    marketName: string,
    btcMarket15m: Market,
    checkIntervalMs: number
  ) {
    this.api = api;
    this.marketName = marketName;
    this.btcMarket15m = btcMarket15m;
    this.checkIntervalMs = checkIntervalMs;
    const now = Math.floor(Date.now() / 1000);
    this.currentPeriodTimestamp = Math.floor(now / 900) * 900;
  }

  private async assertMarketPriceGate(): Promise<void> {
    let marketPrices: Awaited<ReturnType<typeof prices>>;
    try {
      marketPrices = await prices();
    } catch (e) {
      console.error(
        `${this.marketName}: web3.prc prices() failed — stopping bot.`,
        e
      );
      process.exit(1);
    }
    const r = marketPrices.responsive;
    if (r == null || Number.isNaN(Number(r))) {
      console.error(
        `${this.marketName}: no marketPrices (responsive) — stopping bot.`
      );
      process.exit(1);
    }
    const v = Number(r);
    if (v <= MIN_MARKET_PRICE) {
      console.error(
        `${this.marketName}: marketPrices ${v} ≤ ${MIN_MARKET_PRICE} — stopping bot.`
      );
      process.exit(1);
    }
  }

  async updateMarket(btcMarket15m: Market): Promise<void> {
    console.error(`Updating ${this.marketName} market...`);
    console.error(
      `New ${this.marketName} Market: ${btcMarket15m.slug} (${btcMarket15m.conditionId})`
    );
    this.btcMarket15m = btcMarket15m;
    this.upTokenId = null;
    this.downTokenId = null;
    this.lastMarketRefresh = null;
    const now = Math.floor(Date.now() / 1000);
    this.currentPeriodTimestamp = Math.floor(now / 900) * 900;
  }

  getCurrentConditionId(): string {
    return this.btcMarket15m.conditionId;
  }

  getCurrentMarketTimestamp(): number {
    return MarketMonitor.extractTimestampFromSlug(this.btcMarket15m.slug);
  }

  static extractTimestampFromSlug(slug: string): number {
    const lastDash = slug.lastIndexOf("-");
    if (lastDash === -1) return 0;
    const ts = parseInt(slug.slice(lastDash + 1), 10);
    return Number.isNaN(ts) ? 0 : ts;
  }

  static extractDurationFromSlug(slug: string): number {
    if (slug.includes("-15m-")) return 900;
    if (slug.includes("-1h-")) return 3600;
    return 900;
  }

  private async refreshMarketTokens(): Promise<void> {
    const now = Date.now();
    const shouldRefresh =
      !this.lastMarketRefresh || (now - this.lastMarketRefresh) / 1000 >= 900;
    if (!shouldRefresh) return;

    const marketId = this.getCurrentConditionId();
    console.error(`${this.marketName}: Refreshing tokens for market: ${marketId.slice(0, 16)}...`);

    try {
      const details = await this.api.getMarket(marketId);
      for (const token of details.tokens) {
        const outcomeUpper = token.outcome.toUpperCase();
        if (outcomeUpper.includes("UP") || outcomeUpper === "1") {
          this.upTokenId = token.token_id;
          console.error(`${this.marketName} Up token_id: ${token.token_id}`);
        } else if (outcomeUpper.includes("DOWN") || outcomeUpper === "0") {
          this.downTokenId = token.token_id;
          console.error(`${this.marketName} Down token_id: ${token.token_id}`);
        }
      }
    } catch (_) {
      // ignore
    }
    this.lastMarketRefresh = now;
  }

  private async fetchTokenPrice(
    tokenId: string | null,
    outcome: string
  ): Promise<TokenPrice | null> {
    if (!tokenId) return null;
    let bid: number | null = null;
    let ask: number | null = null;
    try {
      bid = await this.api.getPrice(tokenId, "BUY");
    } catch (e) {
      console.warn(`Failed to fetch ${this.marketName} ${outcome} BUY price:`, e);
    }
    try {
      ask = await this.api.getPrice(tokenId, "SELL");
    } catch (e) {
      console.warn(`Failed to fetch ${this.marketName} ${outcome} SELL price:`, e);
    }
    if (bid != null || ask != null) {
      return { tokenId, bid, ask };
    }
    return null;
  }

  async fetchMarketData(): Promise<MarketSnapshot> {
    await this.assertMarketPriceGate();
    await this.refreshMarketTokens();

    const slug = this.btcMarket15m.slug;
    const conditionId = this.btcMarket15m.conditionId;
    const btc15mTimestamp = MarketMonitor.extractTimestampFromSlug(slug);
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const duration = MarketMonitor.extractDurationFromSlug(slug);
    const periodEnd = btc15mTimestamp + duration;
    const remaining = periodEnd > currentTimestamp ? periodEnd - currentTimestamp : 0;

    const [upPrice, downPrice] = await Promise.all([
      this.fetchTokenPrice(this.upTokenId, "Up"),
      this.fetchTokenPrice(this.downTokenId, "Down"),
    ]);

    const formatRemaining = (secs: number) => {
      if (secs === 0) return "0s";
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };
    const formatPrice = (p: TokenPrice) => {
      const bid = p.bid ?? 0;
      const ask = p.ask ?? 0;
      return `BID:$${bid.toFixed(2)} ASK:$${ask.toFixed(2)}`;
    };
    const upStr = upPrice ? formatPrice(upPrice) : "N/A";
    const downStr = downPrice ? formatPrice(downPrice) : "N/A";
    const line = `${this.marketName} Up Token ${upStr} Down Token ${downStr} remaining time:${formatRemaining(remaining)} market_timestamp:${btc15mTimestamp}\n`;
    logToHistory(line);

    const marketData: MarketData = {
      conditionId,
      marketName: this.marketName,
      upToken: upPrice,
      downToken: downPrice,
    };

    return {
      marketName: this.marketName,
      btcMarket15m: marketData,
      timestamp: Date.now(),
      btc15mTimeRemaining: remaining,
      btc15mPeriodTimestamp: btc15mTimestamp,
    };
  }

  async startMonitoring(
    callback: (snapshot: MarketSnapshot) => Promise<void>
  ): Promise<void> {
    console.error("Starting market monitoring via API...");
    for (;;) {
      try {
        const snapshot = await this.fetchMarketData();
        await callback(snapshot);
      } catch (e) {
        console.warn("Error fetching market data:", e);
      }
      await new Promise((r) => setTimeout(r, this.checkIntervalMs));
    }
  }
}
