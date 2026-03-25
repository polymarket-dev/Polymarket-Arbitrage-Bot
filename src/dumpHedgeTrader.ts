import { PolymarketApi } from "./api";
import type { MarketSnapshot, MarketData } from "./models";
import { tokenPriceAsk } from "./models";
import { logPrintln } from "./logger";

type TradingPhase =
  | {
      kind: "WatchingForDump";
      roundStartTime: number;
      windowEndTime: number;
    }
  | {
      kind: "WaitingForHedge";
      leg1Side: string;
      leg1TokenId: string;
      leg1EntryPrice: number;
      leg1Shares: number;
      leg1Timestamp: number;
    }
  | {
      kind: "CycleComplete";
      leg1Side: string;
      leg1EntryPrice: number;
      leg1Shares: number;
      leg2Side: string;
      leg2EntryPrice: number;
      leg2Shares: number;
      totalCost: number;
    };

interface MarketState {
  conditionId: string;
  periodTimestamp: number;
  upTokenId: string | null;
  downTokenId: string | null;
  upPriceHistory: Array<[number, number]>;
  downPriceHistory: Array<[number, number]>;
  phase: TradingPhase;
  closureChecked: boolean;
}

interface CycleTrade {
  conditionId: string;
  periodTimestamp: number;
  upTokenId: string | null;
  downTokenId: string | null;
  upShares: number;
  downShares: number;
  upAvgPrice: number;
  downAvgPrice: number;
  expectedProfit: number;
}

export class DumpHedgeTrader {
  private api: PolymarketApi;
  private simulationMode: boolean;
  private shares: number;
  private sumTarget: number;
  private moveThreshold: number;
  private windowMinutes: number;
  private stopLossMaxWaitMinutes: number;
  private stopLossPercentage: number;
  private marketStates = new Map<string, MarketState>();
  private trades = new Map<string, CycleTrade>();
  private totalProfit = 0;
  private periodProfit = 0;

  constructor(
    api: PolymarketApi,
    simulationMode: boolean,
    shares: number,
    sumTarget: number,
    moveThreshold: number,
    windowMinutes: number,
    stopLossMaxWaitMinutes: number,
    stopLossPercentage: number
  ) {
    this.api = api;
    this.simulationMode = simulationMode;
    this.shares = shares;
    this.sumTarget = sumTarget;
    this.moveThreshold = moveThreshold;
    this.windowMinutes = windowMinutes;
    this.stopLossMaxWaitMinutes = stopLossMaxWaitMinutes;
    this.stopLossPercentage = stopLossPercentage;
  }

  async processSnapshot(snapshot: MarketSnapshot): Promise<void> {
    const marketName = snapshot.marketName;
    const marketData: MarketData = snapshot.btcMarket15m;
    const periodTimestamp = snapshot.btc15mPeriodTimestamp;
    const conditionId = marketData.conditionId;
    const currentTime = Math.floor(Date.now() / 1000);

    let state = this.marketStates.get(conditionId);
    const shouldReset =
      !state || state.periodTimestamp !== periodTimestamp;

    if (shouldReset) {
      const roundStartTime = periodTimestamp;
      const windowEndTime = roundStartTime + this.windowMinutes * 60;
      let phase: TradingPhase;
      if (currentTime <= windowEndTime) {
        logPrintln(
          `${marketName}: New round started (period: ${periodTimestamp}) | Watch window: ${this.windowMinutes} minutes (active)`
        );
        phase = { kind: "WatchingForDump", roundStartTime, windowEndTime };
      } else {
        logPrintln(
          `${marketName}: New round detected (period: ${periodTimestamp}) | Watch window already passed`
        );
        phase = {
          kind: "CycleComplete",
          leg1Side: "",
          leg1EntryPrice: 0,
          leg1Shares: 0,
          leg2Side: "",
          leg2EntryPrice: 0,
          leg2Shares: 0,
          totalCost: 0,
        };
      }

      state = {
        conditionId: marketData.conditionId,
        periodTimestamp,
        upTokenId: marketData.upToken?.tokenId ?? null,
        downTokenId: marketData.downToken?.tokenId ?? null,
        upPriceHistory: [],
        downPriceHistory: [],
        phase,
        closureChecked: false,
      };
      this.marketStates.set(conditionId, state);
    }

    const s = this.marketStates.get(conditionId)!;
    if (marketData.upToken) s.upTokenId = marketData.upToken.tokenId;
    if (marketData.downToken) s.downTokenId = marketData.downToken.tokenId;

    const upAsk = marketData.upToken
      ? tokenPriceAsk(marketData.upToken)
      : 0;
    const downAsk = marketData.downToken
      ? tokenPriceAsk(marketData.downToken)
      : 0;

    const upBid = marketData.upToken?.bid ?? 0;
    const downBid = marketData.downToken?.bid ?? 0;

    if (upAsk <= 0 || downAsk <= 0) return;

    s.upPriceHistory.push([currentTime, upAsk]);
    s.downPriceHistory.push([currentTime, downAsk]);
    if (s.upPriceHistory.length > 10) s.upPriceHistory.shift();
    if (s.downPriceHistory.length > 10) s.downPriceHistory.shift();

    const phase = s.phase;

    if (phase.kind === "WatchingForDump") {
      if (currentTime > phase.windowEndTime) return;

      if (this.checkDump(s.upPriceHistory, currentTime)) {
        logPrintln(
          `${marketName}: UP dump detected! Buying ${this.shares} shares @ $${upAsk.toFixed(4)}`
        );
        if (s.upTokenId) {
          await this.executeBuy(
            marketName,
            "Up",
            s.upTokenId,
            this.shares,
            upAsk
          );
          await this.recordTrade(
            s.conditionId,
            periodTimestamp,
            "Up",
            s.upTokenId,
            this.shares,
            upAsk
          );
          s.phase = {
            kind: "WaitingForHedge",
            leg1Side: "Up",
            leg1TokenId: s.upTokenId,
            leg1EntryPrice: upAsk,
            leg1Shares: this.shares,
            leg1Timestamp: currentTime,
          };
        }
        return;
      }

      if (this.checkDump(s.downPriceHistory, currentTime)) {
        logPrintln(
          `${marketName}: DOWN dump detected! Buying ${this.shares} shares @ $${downAsk.toFixed(4)}`
        );
        if (s.downTokenId) {
          await this.executeBuy(
            marketName,
            "Down",
            s.downTokenId,
            this.shares,
            downAsk
          );
          await this.recordTrade(
            s.conditionId,
            periodTimestamp,
            "Down",
            s.downTokenId,
            this.shares,
            downAsk
          );
          s.phase = {
            kind: "WaitingForHedge",
            leg1Side: "Down",
            leg1TokenId: s.downTokenId,
            leg1EntryPrice: downAsk,
            leg1Shares: this.shares,
            leg1Timestamp: currentTime,
          };
        }
        return;
      }
    }

    if (phase.kind === "WaitingForHedge") {
      const timeElapsedMinutes = Math.floor(
        (currentTime - phase.leg1Timestamp) / 60
      );
      const oppositeAsk = phase.leg1Side === "Up" ? downAsk : upAsk;
      const oppositeSide = phase.leg1Side === "Up" ? "Down" : "Up";
      const oppositeTokenId =
        phase.leg1Side === "Up" ? s.downTokenId : s.upTokenId;
      const totalPrice = phase.leg1EntryPrice + oppositeAsk;

      if (timeElapsedMinutes >= this.stopLossMaxWaitMinutes) {
        if (oppositeTokenId) {
          logPrintln(
            `${marketName}: STOP LOSS TRIGGERED (Hedge not met after ${this.stopLossMaxWaitMinutes} minutes) | Buying opposite to hedge`
          );
          await this.executeStopLossHedge(
            marketName,
            s,
            phase.leg1Side,
            phase.leg1EntryPrice,
            phase.leg1Shares,
            oppositeSide,
            oppositeTokenId,
            oppositeAsk,
            periodTimestamp
          );
        }
        return;
      }

      if (totalPrice <= this.sumTarget && oppositeTokenId) {
        logPrintln(
          `${marketName}: Hedge condition met! Leg1: $${phase.leg1EntryPrice.toFixed(4)} + Opposite: $${oppositeAsk.toFixed(4)} = $${totalPrice.toFixed(4)} <= ${this.sumTarget}`
        );
        logPrintln(
          `${marketName}: Buying ${this.shares} ${oppositeSide} shares @ $${oppositeAsk.toFixed(4)} (Leg 2)`
        );

        await this.executeBuy(
          marketName,
          oppositeSide,
          oppositeTokenId,
          this.shares,
          oppositeAsk
        );
        await this.recordTrade(
          s.conditionId,
          periodTimestamp,
          oppositeSide,
          oppositeTokenId,
          this.shares,
          oppositeAsk
        );

        const totalCost =
          phase.leg1EntryPrice * phase.leg1Shares + oppositeAsk * this.shares;
        const expectedProfit = this.shares * 1 - totalCost;
        const profitPercent = ((1 - totalPrice) / totalPrice) * 100;

        logPrintln(
          `${marketName}: Cycle complete! Locked in ~${profitPercent.toFixed(2)}% profit | Expected profit: $${expectedProfit.toFixed(2)}`
        );

        this.periodProfit += expectedProfit;
        this.totalProfit += expectedProfit;

        const marketKey = `${s.conditionId}:${periodTimestamp}`;
        const trade = this.trades.get(marketKey);
        if (trade) trade.expectedProfit = expectedProfit;

        s.phase = {
          kind: "CycleComplete",
          leg1Side: phase.leg1Side,
          leg1EntryPrice: phase.leg1EntryPrice,
          leg1Shares: phase.leg1Shares,
          leg2Side: oppositeSide,
          leg2EntryPrice: oppositeAsk,
          leg2Shares: this.shares,
          totalCost,
        };
      } else if (currentTime % 10 === 0) {
        logPrintln(
          `${marketName}: Waiting for hedge... Leg1: $${phase.leg1EntryPrice.toFixed(4)} + ${oppositeSide}: $${oppositeAsk.toFixed(4)} = $${totalPrice.toFixed(4)} (need <= ${this.sumTarget}) | Wait: ${timeElapsedMinutes}m`
        );
      }
    }
  }

  private checkDump(
    priceHistory: Array<[number, number]>,
    currentTime: number
  ): boolean {
    if (priceHistory.length < 2) return false;
    const threeSecondsAgo = currentTime - 3;
    let oldPrice: number | null = null;
    let oldTs: number | null = null;
    let newPrice: number | null = null;
    let newTs: number | null = null;

    for (const [ts, price] of priceHistory) {
      if (ts <= threeSecondsAgo) {
        if (oldTs == null || ts > oldTs) {
          oldPrice = price;
          oldTs = ts;
        }
      }
      if (newTs == null || ts > newTs) {
        newPrice = price;
        newTs = ts;
      }
    }

    if (oldPrice == null && priceHistory.length > 0) {
      const [ts, price] = priceHistory[0];
      oldPrice = price;
      oldTs = ts;
    }
    if (newPrice == null && priceHistory.length > 0) {
      const [ts, price] = priceHistory[priceHistory.length - 1];
      newPrice = price;
      newTs = ts;
    }

    if (
      oldPrice == null ||
      newPrice == null ||
      oldTs == null ||
      newTs == null ||
      oldPrice <= 0
    )
      return false;

    const timeDiff = newTs - oldTs;
    if (timeDiff < 1 || timeDiff > 5) return false;
    const priceDrop = oldPrice - newPrice;
    const dropPercent = priceDrop / oldPrice;
    return dropPercent >= this.moveThreshold && priceDrop > 0;
  }

  private async executeBuy(
    marketName: string,
    side: string,
    tokenId: string,
    shares: number,
    price: number
  ): Promise<void> {
    logPrintln(`${marketName} BUY ${side} ${shares} shares @ $${price.toFixed(4)}`);
    if (this.simulationMode) {
      logPrintln("SIMULATION: Order executed");
    } else {
      const size = Math.round(shares * 10000) / 10000;
      try {
        await this.api.placeMarketOrder(tokenId, size, "BUY");
        logPrintln("REAL: Order placed");
      } catch (e) {
        console.warn("Failed to place order:", e);
        throw e;
      }
    }
  }

  private async executeStopLossHedge(
    marketName: string,
    state: MarketState,
    leg1Side: string,
    leg1EntryPrice: number,
    leg1Shares: number,
    oppositeSide: string,
    oppositeTokenId: string,
    oppositeAsk: number,
    periodTimestamp: number
  ): Promise<void> {
    logPrintln(
      `${marketName}: STOP LOSS HEDGE - Buying ${leg1Shares} ${oppositeSide} shares @ $${oppositeAsk.toFixed(4)}`
    );

    await this.executeBuy(
      marketName,
      oppositeSide,
      oppositeTokenId,
      leg1Shares,
      oppositeAsk
    );
    await this.recordTrade(
      state.conditionId,
      periodTimestamp,
      oppositeSide,
      oppositeTokenId,
      leg1Shares,
      oppositeAsk
    );

    const totalCost = leg1EntryPrice * leg1Shares + oppositeAsk * leg1Shares;
    const totalPricePerShare = leg1EntryPrice + oppositeAsk;
    const expectedProfit = leg1Shares * 1 - totalCost;
    const profitPercent =
      totalPricePerShare > 0
        ? ((1 - totalPricePerShare) / totalPricePerShare) * 100
        : 0;

    logPrintln(
      `${marketName}: Stop loss hedge complete! Expected profit: $${expectedProfit.toFixed(2)} (${profitPercent.toFixed(2)}%)`
    );

    this.periodProfit += expectedProfit;
    this.totalProfit += expectedProfit;

    const marketKey = `${state.conditionId}:${periodTimestamp}`;
    const trade = this.trades.get(marketKey);
    if (trade) trade.expectedProfit = expectedProfit;

    state.phase = {
      kind: "CycleComplete",
      leg1Side,
      leg1EntryPrice,
      leg1Shares,
      leg2Side: oppositeSide,
      leg2EntryPrice: oppositeAsk,
      leg2Shares: leg1Shares,
      totalCost,
    };
  }

  private async recordTrade(
    conditionId: string,
    periodTimestamp: number,
    side: string,
    tokenId: string,
    shares: number,
    price: number
  ): Promise<void> {
    const key = `${conditionId}:${periodTimestamp}`;
    let trade = this.trades.get(key);
    if (!trade) {
      trade = {
        conditionId,
        periodTimestamp,
        upTokenId: null,
        downTokenId: null,
        upShares: 0,
        downShares: 0,
        upAvgPrice: 0,
        downAvgPrice: 0,
        expectedProfit: 0,
      };
      this.trades.set(key, trade);
    }

    if (side === "Up") {
      const oldTotal = trade.upShares * trade.upAvgPrice;
      trade.upShares += shares;
      trade.upAvgPrice =
        trade.upShares > 0 ? (oldTotal + shares * price) / trade.upShares : price;
      trade.upTokenId = tokenId;
    } else if (side === "Down") {
      const oldTotal = trade.downShares * trade.downAvgPrice;
      trade.downShares += shares;
      trade.downAvgPrice =
        trade.downShares > 0
          ? (oldTotal + shares * price) / trade.downShares
          : price;
      trade.downTokenId = tokenId;
    }
  }

  async checkMarketClosure(): Promise<void> {
    const tradesList = Array.from(this.trades.entries()).map(([k, v]) => [
      k,
      { ...v },
    ]) as Array<[string, CycleTrade]>;
    if (tradesList.length === 0) return;

    const currentTimestamp = Math.floor(Date.now() / 1000);

    for (const [marketKey, trade] of tradesList) {
      const marketEndTimestamp = trade.periodTimestamp + 900;
      if (currentTimestamp < marketEndTimestamp) continue;

      const state = this.marketStates.get(trade.conditionId);
      if (state?.closureChecked) continue;

      const timeSinceClose = currentTimestamp - marketEndTimestamp;
      const minutes = Math.floor(timeSinceClose / 60);
      const seconds = timeSinceClose % 60;
      logPrintln(
        `Market ${trade.conditionId.slice(0, 8)} closed ${minutes}m ${seconds}s ago | Checking resolution...`
      );

      let market;
      try {
        market = await this.api.getMarket(trade.conditionId);
      } catch (e) {
        console.warn("Failed to fetch market:", e);
        continue;
      }

      if (!market.closed) {
        logPrintln(`Market ${trade.conditionId.slice(0, 8)} not yet closed, will retry`);
        continue;
      }

      logPrintln(`Market ${trade.conditionId.slice(0, 8)} is closed and resolved`);

      const upIsWinner = trade.upTokenId
        ? market.tokens.some(
            (t) => t.token_id === trade.upTokenId && t.winner
          )
        : false;
      const downIsWinner = trade.downTokenId
        ? market.tokens.some(
            (t) => t.token_id === trade.downTokenId && t.winner
          )
        : false;

      let actualProfit = 0;

      if (trade.upShares > 0.001) {
        if (upIsWinner) {
          if (!this.simulationMode && trade.upTokenId) {
            try {
              await this.api.redeemTokens(
                trade.conditionId,
                trade.upTokenId,
                "Up"
              );
            } catch (e) {
              console.warn("Failed to redeem Up token:", e);
            }
          }
          const value = trade.upShares * 1;
          const cost = trade.upAvgPrice * trade.upShares;
          actualProfit += value - cost;
          logPrintln(
            `Market Closed - Up Winner: ${trade.upShares.toFixed(2)} @ $${trade.upAvgPrice.toFixed(4)} | Profit: $${(value - cost).toFixed(2)}`
          );
        } else {
          actualProfit -= trade.upAvgPrice * trade.upShares;
          logPrintln(
            `Market Closed - Up Lost: ${trade.upShares.toFixed(2)} @ $${trade.upAvgPrice.toFixed(4)}`
          );
        }
      }

      if (trade.downShares > 0.001) {
        if (downIsWinner) {
          if (!this.simulationMode && trade.downTokenId) {
            try {
              await this.api.redeemTokens(
                trade.conditionId,
                trade.downTokenId,
                "Down"
              );
            } catch (e) {
              console.warn("Failed to redeem Down token:", e);
            }
          }
          const value = trade.downShares * 1;
          const cost = trade.downAvgPrice * trade.downShares;
          actualProfit += value - cost;
          logPrintln(
            `Market Closed - Down Winner: ${trade.downShares.toFixed(2)} @ $${trade.downAvgPrice.toFixed(4)} | Profit: $${(value - cost).toFixed(2)}`
          );
        } else {
          actualProfit -= trade.downAvgPrice * trade.downShares;
          logPrintln(
            `Market Closed - Down Lost: ${trade.downShares.toFixed(2)} @ $${trade.downAvgPrice.toFixed(4)}`
          );
        }
      }

      if (trade.expectedProfit !== 0) {
        this.totalProfit = this.totalProfit - trade.expectedProfit + actualProfit;
        this.periodProfit =
          this.periodProfit - trade.expectedProfit + actualProfit;
      } else {
        this.totalProfit += actualProfit;
        this.periodProfit += actualProfit;
      }

      logPrintln(
        `Period Profit: $${this.periodProfit.toFixed(2)} | Total Profit: $${this.totalProfit.toFixed(2)}`
      );

      const s = this.marketStates.get(trade.conditionId);
      if (s) s.closureChecked = true;
      this.trades.delete(marketKey);
      logPrintln("Trade removed from tracking");
    }
  }

  async resetPeriod(): Promise<void> {
    this.marketStates.clear();
    logPrintln("Dump-Hedge Trader: Period reset");
  }

  async getTotalProfit(): Promise<number> {
    return this.totalProfit;
  }

  async getPeriodProfit(): Promise<number> {
    return this.periodProfit;
  }
}
