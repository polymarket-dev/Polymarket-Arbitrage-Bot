export interface Market {
  conditionId: string;
  id?: string;
  question: string;
  slug: string;
  resolutionSource?: string;
  endDateISO?: string;
  endDateIso?: string;
  active: boolean;
  closed: boolean;
  tokens?: Token[];
  clobTokenIds?: string;
  outcomes?: string;
}

export interface Token {
  tokenId: string;
  outcome: string;
  price?: string | number;
}

export interface OrderBookEntry {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
}

export interface TokenPrice {
  tokenId: string;
  bid: number | null;
  ask: number | null;
}

export function tokenPriceMid(price: TokenPrice): number | null {
  if (price.bid != null && price.ask != null) return (price.bid + price.ask) / 2;
  if (price.bid != null) return price.bid;
  if (price.ask != null) return price.ask;
  return null;
}

export function tokenPriceAsk(price: TokenPrice): number {
  return price.ask ?? 0;
}

export interface OrderRequest {
  token_id: string;
  side: string;
  size: string;
  price: string;
  type: string;
}

export interface OrderResponse {
  order_id?: string;
  status: string;
  message?: string;
}

export interface MarketData {
  conditionId: string;
  marketName: string;
  upToken: TokenPrice | null;
  downToken: TokenPrice | null;
}

export interface MarketToken {
  outcome: string;
  price: string;
  token_id: string;
  winner: boolean;
}

export interface MarketDetails {
  accepting_order_timestamp?: string;
  accepting_orders: boolean;
  active: boolean;
  archived: boolean;
  closed: boolean;
  condition_id: string;
  description: string;
  enable_order_book: boolean;
  end_date_iso: string;
  fpmm: string;
  game_start_time?: string;
  icon: string;
  image: string;
  is_50_50_outcome: boolean;
  maker_base_fee: string;
  market_slug: string;
  minimum_order_size: string;
  minimum_tick_size: string;
  neg_risk: boolean;
  neg_risk_market_id: string;
  neg_risk_request_id: string;
  notifications_enabled: boolean;
  question: string;
  question_id: string;
  rewards: { max_spread: string; min_size: string; rates?: unknown };
  seconds_delay: number;
  tags: string[];
  taker_base_fee: string;
  tokens: MarketToken[];
}

export interface Fill {
  id?: string;
  tokenID?: string;
  asset?: string;
  tokenName?: string;
  side: string;
  size: number;
  usdcSize?: number;
  price: number;
  timestamp: number;
  orderID?: string;
  user?: string;
  proxyWallet?: string;
  maker?: string;
  taker?: string;
  fee?: string;
  conditionId?: string;
  outcomeIndex?: number;
  outcome?: string;
  type?: string;
  transactionHash?: string;
  title?: string;
  slug?: string;
}

export interface RedeemResponse {
  success: boolean;
  message?: string;
  transaction_hash?: string;
  amount_redeemed?: string;
}

export interface MarketSnapshot {
  marketName: string;
  btcMarket15m: MarketData;
  timestamp: number; // Date.now() for compatibility
  btc15mTimeRemaining: number;
  btc15mPeriodTimestamp: number;
}
