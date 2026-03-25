import type {
  Market,
  OrderBook,
  MarketDetails,
  TokenPrice,
  OrderResponse,
  RedeemResponse,
  Fill,
} from "./models";
import type { PolymarketConfig } from "./config";
import { Wallet } from "ethers";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";

const POLYGON_CHAIN_ID = 137;
const CTF_CONTRACT = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const RPC_URL = "https://polygon-rpc.com";

export class PolymarketApi {
  private gammaUrl: string;
  private clobUrl: string;
  private config: PolymarketConfig;
  private clobClient: ClobClient | null = null;
  private signer: Wallet | null = null;

  constructor(config: PolymarketConfig) {
    this.config = config;
    this.gammaUrl = config.gammaApiUrl;
    this.clobUrl = config.clobApiUrl;
  }

  private async getClobClient(): Promise<ClobClient> {
    if (this.clobClient) return this.clobClient;
    const pk = this.config.privateKey;
    if (!pk) throw new Error("Private key is required. Set PRIVATE_KEY in .env");
    this.signer = new Wallet(pk);
    const tempClient = new ClobClient(this.clobUrl, POLYGON_CHAIN_ID, this.signer);
    const creds = await tempClient.createOrDeriveApiKey();
    const funder = this.config.proxyWalletAddress
      ? this.config.proxyWalletAddress
      : undefined;
    const sigType = this.config.signatureType;
    this.clobClient = new ClobClient(
      this.clobUrl,
      POLYGON_CHAIN_ID,
      this.signer,
      creds,
      sigType,
      funder
    );
    return this.clobClient;
  }

  async authenticate(): Promise<void> {
    await this.getClobClient();
    console.error("Successfully authenticated with Polymarket CLOB API");
    if (this.config.proxyWalletAddress) {
      console.error("Proxy wallet:", this.config.proxyWalletAddress);
    } else {
      console.error("Trading account: EOA (private key account)");
    }
  }

  async getMarketBySlug(slug: string): Promise<Market> {
    const url = `${this.gammaUrl}/events/slug/${slug}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch market by slug: ${slug} (status: ${res.status})`);
    const json = (await res.json()) as { markets?: Record<string, unknown>[] };
    const markets = json.markets;
    if (!Array.isArray(markets) || markets.length === 0) {
      throw new Error("Invalid market response: no markets array");
    }
    const m = markets[0];
    return {
      conditionId: (m.conditionId ?? m.condition_id) as string,
      id: m.id as string | undefined,
      question: m.question as string,
      slug: m.slug as string,
      resolutionSource: (m.resolutionSource ?? m.resolution_source) as string | undefined,
      endDateISO: (m.endDateISO ?? m.end_date_iso) as string | undefined,
      endDateIso: (m.endDateIso ?? m.end_date_iso) as string | undefined,
      active: m.active as boolean,
      closed: m.closed as boolean,
      tokens: m.tokens as Market["tokens"],
      clobTokenIds: (m.clobTokenIds ?? m.clob_token_ids) as string | undefined,
      outcomes: m.outcomes as string | undefined,
    };
  }

  async getMarket(conditionId: string): Promise<MarketDetails> {
    const url = `${this.clobUrl}/markets/${conditionId}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch market (status: ${res.status})`);
    const json = await res.json();
    return json as MarketDetails;
  }

  async getOrderbook(tokenId: string): Promise<OrderBook> {
    const url = `${this.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to fetch orderbook");
    return (await res.json()) as OrderBook;
  }

  async getPrice(tokenId: string, side: string): Promise<number> {
    const url = `${this.clobUrl}/price?side=${side}&token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch price (status: ${res.status})`);
    const json = (await res.json()) as { price?: string };
    const priceStr = json?.price;
    if (priceStr == null) throw new Error("Invalid price response");
    return Number(priceStr);
  }

  async getBestPrice(tokenId: string): Promise<TokenPrice | null> {
    const ob = await this.getOrderbook(tokenId);
    const bestBid = ob.bids?.[0]?.price != null ? Number(ob.bids[0].price) : null;
    const bestAsk = ob.asks?.[0]?.price != null ? Number(ob.asks[0].price) : null;
    if (bestAsk == null) return null;
    return { tokenId, bid: bestBid, ask: bestAsk };
  }

  async placeOrder(params: {
    tokenId: string;
    side: "BUY" | "SELL";
    size: number;
    price: number;
    tickSize: string;
    negRisk: boolean;
  }): Promise<OrderResponse> {
    const client = await this.getClobClient();
    const side = params.side === "BUY" ? Side.BUY : Side.SELL;
    const tickSize = (params.tickSize === "0.1" || params.tickSize === "0.01" || params.tickSize === "0.001" || params.tickSize === "0.0001")
      ? params.tickSize
      : "0.01";
    const signedOrder = await client.createOrder(
      {
        tokenID: params.tokenId,
        price: params.price,
        side,
        size: params.size,
      },
      tickSize as "0.001" | "0.01" | "0.1" | "0.0001"
    );
    const resp = await client.postOrder(signedOrder, OrderType.GTC);
    const r = resp as { orderID?: string; id?: string; status?: string };
    return {
      order_id: r?.orderID ?? r?.id,
      status: r?.status ?? "LIVE",
      message: r?.orderID ? `Order placed. ID: ${r.orderID}` : undefined,
    };
  }

  async placeMarketOrder(
    tokenId: string,
    amount: number,
    side: "BUY" | "SELL",
    tickSize: string = "0.01",
    negRisk: boolean = false
  ): Promise<OrderResponse> {
    const priceSide = side === "BUY" ? "SELL" : "BUY"; // we pay the ask / receive the bid
    const marketPrice = await this.getPrice(tokenId, priceSide);
    const size = Math.round(amount * 10000) / 10000;
    let price = marketPrice;
    if (side === "SELL") {
      price = Math.max(0.01, Math.round(marketPrice * 0.995 * 100) / 100);
    }
    const client = await this.getClobClient();
    const sideEnum = side === "BUY" ? Side.BUY : Side.SELL;
    const tickSizeResolved = (tickSize === "0.1" || tickSize === "0.01" || tickSize === "0.001" || tickSize === "0.0001")
      ? tickSize
      : "0.01";
    const signedOrder = await client.createOrder(
      {
        tokenID: tokenId,
        price,
        side: sideEnum,
        size,
      },
      tickSizeResolved as "0.001" | "0.01" | "0.1" | "0.0001"
    );
    const resp = await client.postOrder(signedOrder, OrderType.GTC);
    if (resp && !(resp as { success?: boolean }).success) {
      const msg = (resp as { errorMsg?: string }).errorMsg ?? "Order failed";
      throw new Error(msg);
    }
    return {
      order_id: (resp as { orderID?: string })?.orderID,
      status: "LIVE",
      message: (resp as { orderID?: string })?.orderID
        ? `Market order executed. ID: ${(resp as { orderID?: string }).orderID}`
        : undefined,
    };
  }

  async redeemTokens(
    conditionId: string,
    _tokenId: string,
    outcome: string
  ): Promise<RedeemResponse> {
    const pk = this.config.privateKey;
    if (!pk) throw new Error("Private key required for redemption. Set PRIVATE_KEY in .env");
    const { ethers } = await import("ethers");
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(pk, provider);
    const conditionIdClean = conditionId.startsWith("0x") ? conditionId.slice(2) : conditionId;
    const conditionIdBytes32 = "0x" + conditionIdClean.padStart(64, "0").toLowerCase();
    const indexSet =
      outcome.toUpperCase().includes("UP") || outcome === "1"
        ? 1
        : 2;
    const parentCollectionId = "0x" + "0".repeat(64);
    const collateralTokenBytes32 =
      "0x" + "0".repeat(24) + USDC_ADDRESS.slice(2).toLowerCase();
    const arrayOffset = 32 * 4;
    const arrayLength = 1;
    const encoded =
      collateralTokenBytes32.slice(2).padStart(64, "0") +
      parentCollectionId.slice(2) +
      conditionIdBytes32.slice(2).padStart(64, "0") +
      ethers.BigNumber.from(arrayOffset).toHexString().slice(2).padStart(64, "0") +
      ethers.BigNumber.from(arrayLength).toHexString().slice(2).padStart(64, "0") +
      ethers.BigNumber.from(indexSet).toHexString().slice(2).padStart(64, "0");
    const tx = await wallet.sendTransaction({
      to: CTF_CONTRACT,
      data: "0x3d7d3f5a" + encoded,
      value: 0,
    });
    const receipt = await tx.wait();
    if (!receipt.status) throw new Error(`Redemption tx failed: ${tx.hash}`);
    return {
      success: true,
      message: `Redeemed. Tx: ${tx.hash}`,
      transaction_hash: tx.hash,
    };
  }

  async getUserFills(
    userAddress: string,
    conditionId?: string,
    limit: number = 1000
  ): Promise<Fill[]> {
    const dataApiUrl = "https://data-api.polymarket.com";
    const user = userAddress.startsWith("0x") ? userAddress : `0x${userAddress}`;
    const params = new URLSearchParams({
      limit: String(limit),
      sortBy: "TIMESTAMP",
      sortDirection: "DESC",
      user,
    });
    if (conditionId) params.set("market", conditionId);
    const url = `${dataApiUrl}/activity?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch activity (status: ${res.status})`);
    const json = (await res.json()) as unknown;
    const arr = Array.isArray(json) ? json : (json as { data?: unknown[] })?.data;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((a: { type?: string }) => a.type === "TRADE")
      .map((a: Record<string, unknown>) => ({
        id: a.id as string | undefined,
        tokenID: (a.tokenID ?? a.asset) as string | undefined,
        asset: a.asset as string | undefined,
        tokenName: a.tokenName as string | undefined,
        side: String(a.side),
        size: Number(a.size),
        usdcSize: a.usdcSize != null ? Number(a.usdcSize) : undefined,
        price: Number(a.price),
        timestamp: Number(a.timestamp),
        orderID: a.orderID as string | undefined,
        user: a.user as string | undefined,
        proxyWallet: a.proxyWallet as string | undefined,
        maker: a.maker as string | undefined,
        taker: a.taker as string | undefined,
        fee: a.fee as string | undefined,
        conditionId: a.conditionId as string | undefined,
        outcomeIndex: a.outcomeIndex as number | undefined,
        outcome: a.outcome as string | undefined,
        type: a.type as string | undefined,
        transactionHash: a.transactionHash as string | undefined,
        title: a.title as string | undefined,
        slug: a.slug as string | undefined,
      }));
  }
}
