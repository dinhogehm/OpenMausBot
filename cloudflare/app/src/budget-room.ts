import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./http";
import { requireMembership } from "./organizations";
import { addMoney, brlMicros, budgetDay, count, safeInteger } from "./budget-math";
import { BUDGET_DEFAULT_LIMIT_BRL_MICROS, BUDGET_TIMEZONE, type BudgetConfiguration, type BudgetReservation, type BudgetReserveInput, type BudgetRpc, type BudgetScope, type BudgetView, type FxSnapshot, type PriceSnapshot } from "./budget-types";
import { fetchOpenRouterPrice, openRouterControls, priceMaximum } from "./price-book";
import { fetchPtax } from "./fx";
import { observeOpenRouterUsage } from "./budget-usage";

interface BudgetEnv { DB: D1Database }
type Key = { organizationId: string; reservationId: string };
interface Ledger { organizationId: string; configuration: BudgetConfiguration; outstandingBrlMicros: number; overrunBlocked: boolean }
interface Day { settledBrlMicros: number; reservedBrlMicros: number }
const emptyDay = (): Day => ({ settledBrlMicros: 0, reservedBrlMicros: 0 });
const fail = (code: string, status = 409): never => { throw new HttpError(status, code); };
function identifier(value: string): void { if (typeof value !== "string" || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value)) fail("budget_input_invalid", 400); }
function validateScope(scope: BudgetScope): void { identifier(scope.organizationId); identifier(scope.userId); }
function validateInput(input: BudgetReserveInput): void {
  validateScope(input); identifier(input.reservationId); identifier(input.operationId);
  if (input.provider !== "openrouter" || typeof input.model !== "string" || !/^[a-f0-9]{64}$/.test(input.requestHash)) fail("budget_input_invalid", 400);
  if (!count(input.maxOutputTokens, 1_000_000)) fail("budget_input_invalid", 400);
}
function matches(reservation: BudgetReservation, input: BudgetReserveInput): boolean {
  return (Object.keys(input) as (keyof BudgetReserveInput)[]).every(key => reservation[key] === input[key]);
}
function subtract(left: number, right: number): number { return safeInteger(BigInt(left) - BigInt(right)); }

/** One object per organization, invoked only through trusted Worker RPC.
 * A dispatch permission is durable and single-use; crashes never make it reusable.
 * PTAX and rates estimate inference, not an invoice or a guarantee of external BYOK charges.
 */
export class BudgetRoom extends DurableObject<BudgetEnv> implements BudgetRpc {
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    // Expected denials must not break the input gate and reset the whole object.
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try { return { ok: true as const, value: await work() }; }
      catch (error) { return { ok: false as const, error }; }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
  private async ledger(organizationId: string): Promise<Ledger> {
    identifier(organizationId);
    const existing = await this.ctx.storage.get<Ledger>("ledger");
    if (existing) { if (existing.organizationId !== organizationId) fail("budget_tenant_mismatch", 404); return existing; }
    const ledger: Ledger = { organizationId, outstandingBrlMicros: 0, overrunBlocked: false,
      configuration: { version: 0, limitBrlMicros: BUDGET_DEFAULT_LIMIT_BRL_MICROS, updatedAt: Date.now(), updatedBy: null } };
    await this.ctx.storage.put("ledger", ledger); return ledger;
  }
  private async view(ledger: Ledger, canEdit: boolean): Promise<BudgetView> {
    const day = budgetDay(Date.now()), current = await this.ctx.storage.get<Day>(`day:${day}`) ?? emptyDay();
    const exposed = addMoney(current.settledBrlMicros, ledger.outstandingBrlMicros);
    return { organizationId: ledger.organizationId, day, timezone: BUDGET_TIMEZONE, currency: "BRL", unit: "micros", scope: "estimated_api_inference",
      exclusions: ["subscriptions", "infrastructure", "taxes", "payment_fees"], configuration: ledger.configuration,
      settledBrlMicros: current.settledBrlMicros, reservedBrlMicros: current.reservedBrlMicros,
      carryoverBrlMicros: subtract(ledger.outstandingBrlMicros, current.reservedBrlMicros),
      availableBrlMicros: ledger.overrunBlocked ? 0 : Math.max(0, ledger.configuration.limitBrlMicros - exposed), overrunBlocked: ledger.overrunBlocked, canEdit };
  }
  private async entry(key: Key): Promise<{ ledger: Ledger; reservation: BudgetReservation }> {
    identifier(key.reservationId); const ledger = await this.ledger(key.organizationId);
    const reservation = await this.ctx.storage.get<BudgetReservation>(`reservation:${key.reservationId}`);
    if (!reservation || reservation.organizationId !== key.organizationId) return fail("budget_reservation_missing", 404);
    return { ledger, reservation };
  }
  async get(scope: BudgetScope): Promise<BudgetView> {
    return this.exclusive(async () => {
      validateScope(scope); const role = await requireMembership(this.env.DB, scope.organizationId, scope.userId);
      return this.view(await this.ledger(scope.organizationId), role !== "member");
    });
  }
  async configure(input: BudgetScope & { expectedVersion: number; limitBrlMicros: number }): Promise<BudgetView> {
    return this.exclusive(async () => {
      validateScope(input); await requireMembership(this.env.DB, input.organizationId, input.userId, true);
      count(input.limitBrlMicros, Number.MAX_SAFE_INTEGER); count(input.expectedVersion, Number.MAX_SAFE_INTEGER);
      const ledger = await this.ledger(input.organizationId);
      if (ledger.configuration.version !== input.expectedVersion) fail("budget_state_changed");
      ledger.configuration = { version: ledger.configuration.version + 1, limitBrlMicros: input.limitBrlMicros, updatedAt: Date.now(), updatedBy: input.userId };
      // Editing the ceiling never erases recorded usage, uncertainty or a pricing breach.
      await this.ctx.storage.put("ledger", ledger); return this.view(ledger, true);
    });
  }
  async reserve(input: BudgetReserveInput): Promise<BudgetReservation> {
    return this.exclusive(async () => {
      validateInput(input); await requireMembership(this.env.DB, input.organizationId, input.userId);
      const ledger = await this.ledger(input.organizationId);
      const replay = await this.ctx.storage.get<BudgetReservation>(`reservation:${input.reservationId}`);
      if (replay) { if (!matches(replay, input)) fail("budget_request_reused"); return replay; }
      if (await this.ctx.storage.get(`operation:${input.operationId}`)) fail("budget_operation_reused");
      if (ledger.overrunBlocked) fail("budget_overrun_blocked");
      const now = Date.now();
      const cachedPrice = await this.ctx.storage.get<PriceSnapshot>(`price:${input.model}:${input.maxOutputTokens}`);
      const cachedFx = await this.ctx.storage.get<FxSnapshot>("fx");
      const [price, fx] = await Promise.all([
        cachedPrice && cachedPrice.expiresAt > now ? cachedPrice : fetchOpenRouterPrice(input.model, input.maxOutputTokens, now),
        cachedFx && cachedFx.expiresAt > now ? cachedFx : fetchPtax(now),
      ]);
      // Source reads must not authorize a user whose membership changed meanwhile.
      await requireMembership(this.env.DB, input.organizationId, input.userId);
      const createdAt = Date.now(); if (price.expiresAt <= createdAt || fx.expiresAt <= createdAt) fail("budget_quote_expired");
      const day = budgetDay(createdAt), current = await this.ctx.storage.get<Day>(`day:${day}`) ?? emptyDay();
      const maxUsdNanos = priceMaximum(price, input.maxOutputTokens), maxBrlMicros = brlMicros(maxUsdNanos, fx.brlPerUsdMicros);
      if (addMoney(current.settledBrlMicros, ledger.outstandingBrlMicros, maxBrlMicros) > ledger.configuration.limitBrlMicros) fail("budget_exhausted", 429);
      const reservation: BudgetReservation = { ...input, status: "reserved", day, createdAt, updatedAt: createdAt, maxUsdNanos, maxBrlMicros, price, fx, controls: openRouterControls(price, input.maxOutputTokens) };
      ledger.outstandingBrlMicros = addMoney(ledger.outstandingBrlMicros, maxBrlMicros); current.reservedBrlMicros = addMoney(current.reservedBrlMicros, maxBrlMicros);
      await this.ctx.storage.transaction(async tx => { await tx.put({ ledger, [`day:${day}`]: current, [`reservation:${input.reservationId}`]: reservation,
        [`operation:${input.operationId}`]: input.reservationId, [`price:${input.model}:${input.maxOutputTokens}`]: price, fx }); });
      return reservation;
    });
  }
  async dispatch(key: Key): Promise<{ dispatchAllowed: boolean; reservation: BudgetReservation }> {
    return this.exclusive(async () => {
      const { ledger, reservation } = await this.entry(key);
      if (reservation.status !== "reserved") return { dispatchAllowed: false, reservation };
      await requireMembership(this.env.DB, reservation.organizationId, reservation.userId);
      const now = Date.now(); if (reservation.price.expiresAt <= now || reservation.fx.expiresAt <= now) fail("budget_quote_expired");
      if (ledger.overrunBlocked) fail("budget_overrun_blocked");
      const day = budgetDay(now), current = await this.ctx.storage.get<Day>(`day:${day}`) ?? emptyDay();
      if (addMoney(current.settledBrlMicros, ledger.outstandingBrlMicros) > ledger.configuration.limitBrlMicros) fail("budget_exhausted", 429);
      await this.ctx.storage.transaction(async tx => {
        if (reservation.day !== day) {
          const old = await tx.get<Day>(`day:${reservation.day}`) ?? emptyDay(); old.reservedBrlMicros = subtract(old.reservedBrlMicros, reservation.maxBrlMicros);
          current.reservedBrlMicros = addMoney(current.reservedBrlMicros, reservation.maxBrlMicros);
          await tx.put({ [`day:${reservation.day}`]: old, [`day:${day}`]: current }); reservation.day = day;
        }
        reservation.status = "dispatched"; reservation.dispatchedAt = now; reservation.updatedAt = now;
        await tx.put(`reservation:${key.reservationId}`, reservation);
      });
      return { dispatchAllowed: true, reservation };
    });
  }
  async releaseUndispatched(key: Key): Promise<BudgetReservation> {
    return this.exclusive(async () => {
      const { ledger, reservation } = await this.entry(key);
      if (reservation.status === "released") return reservation;
      if (reservation.status !== "reserved") fail("budget_already_dispatched");
      const day = await this.ctx.storage.get<Day>(`day:${reservation.day}`) ?? emptyDay();
      ledger.outstandingBrlMicros = subtract(ledger.outstandingBrlMicros, reservation.maxBrlMicros); day.reservedBrlMicros = subtract(day.reservedBrlMicros, reservation.maxBrlMicros);
      reservation.status = "released"; reservation.updatedAt = Date.now();
      await this.ctx.storage.transaction(async tx => { await tx.put({ ledger, [`day:${reservation.day}`]: day, [`reservation:${key.reservationId}`]: reservation }); });
      return reservation;
    });
  }
  async uncertain(key: Key): Promise<BudgetReservation> {
    return this.exclusive(async () => {
      const { reservation } = await this.entry(key);
      if (reservation.status === "settled" || reservation.status === "uncertain") return reservation;
      if (reservation.status !== "dispatched") fail("budget_not_dispatched");
      reservation.status = "uncertain"; reservation.updatedAt = Date.now(); await this.ctx.storage.put(`reservation:${key.reservationId}`, reservation); return reservation;
    });
  }
  async observe(input: Key & { response: unknown }): Promise<BudgetReservation> {
    return this.exclusive(async () => {
      const { ledger, reservation } = await this.entry(input);
      if (!["dispatched", "uncertain", "settled"].includes(reservation.status)) fail("budget_not_dispatched");
      const usage = await observeOpenRouterUsage(input.response);
      if (reservation.status === "settled") {
        if (reservation.usage?.payloadHash !== usage.payloadHash) fail("budget_receipt_changed"); return reservation;
      }
      if (reservation.usage?.providerRequestId && usage.providerRequestId && reservation.usage.providerRequestId !== usage.providerRequestId) fail("budget_receipt_changed");
      if (usage.providerRequestId) {
        const prior = await this.ctx.storage.get<string>(`provider:${usage.providerRequestId}`);
        if (prior && prior !== reservation.reservationId) fail("budget_receipt_reused");
      }
      // Nested OpenRouter BYOK can bill the upstream account separately. A credits
      // receipt alone does not qualify that total; preserve its ID and keep the hold.
      const priced = usage.priced && usage.model === reservation.model && !usage.upstreamCostUsdNanos;
      // Later incomplete replies must not erase a previously observed provider ID.
      if (!usage.providerRequestId && reservation.usage?.providerRequestId) usage.providerRequestId = reservation.usage.providerRequestId;
      reservation.usage = usage; reservation.updatedAt = Date.now(); reservation.status = "uncertain";
      await this.ctx.storage.transaction(async tx => {
        if (usage.providerRequestId) await tx.put(`provider:${usage.providerRequestId}`, reservation.reservationId);
        if (priced) {
          const day = await tx.get<Day>(`day:${reservation.day}`) ?? emptyDay();
          const actual = brlMicros(usage.costUsdNanos!, reservation.fx.brlPerUsdMicros);
          day.reservedBrlMicros = subtract(day.reservedBrlMicros, reservation.maxBrlMicros); day.settledBrlMicros = addMoney(day.settledBrlMicros, actual);
          ledger.outstandingBrlMicros = subtract(ledger.outstandingBrlMicros, reservation.maxBrlMicros);
          ledger.overrunBlocked ||= actual > reservation.maxBrlMicros;
          reservation.status = "settled"; reservation.actualBrlMicros = actual; reservation.settledAt = Date.now();
          await tx.put({ ledger, [`day:${reservation.day}`]: day });
        }
        await tx.put(`reservation:${input.reservationId}`, reservation);
      });
      return reservation;
    });
  }
}
