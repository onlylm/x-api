import { centsToMoney, moneyToCents, signedMoneyToCents, sumMoney } from "../domain.js";

/** Variances below 1 USD are treated as FX/settlement noise, not a rebate or overcharge. */
export const COST_VARIANCE_TOLERANCE_USD_CENTS = 100;

export function isIgnorableCostVariance(standardUsd: string, actualUsd: string): boolean {
  return Math.abs(moneyToCents(standardUsd) - moneyToCents(actualUsd)) < COST_VARIANCE_TOLERANCE_USD_CENTS;
}

/** Explicit bookkeeping rate, never a market-rate default or a payment conversion. */
export function usdToCny(usd: string, rate: string): string {
  if (!/^\d{1,3}(\.\d{1,6})?$/.test(rate) || Number(rate) <= 0) {
    throw new Error("汇率须大于 0，最多六位小数");
  }
  const [whole, fraction = ""] = rate.split(".");
  const scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return centsToMoney(Number((BigInt(moneyToCents(usd)) * scaled + 500_000n) / 1_000_000n));
}

export interface CostReconciliationInput {
  supplyCny: string;
  standardCostCny: string;
  platformBaseProfitCny: string;
  standardUsd: string;
  actualUsd: string;
  feesUsd: string;
  retainedUsd: string;
  fxRate?: string | null;
}

/** Keep the original quote; savings are returned IN ADDITION to the platform's base profit. */
export function calculateCostReconciliation(input: CostReconciliationInput) {
  const supply = moneyToCents(input.supplyCny);
  const standardCost = moneyToCents(input.standardCostCny);
  const base = signedMoneyToCents(input.platformBaseProfitCny);
  const standard = moneyToCents(input.standardUsd), actual = moneyToCents(input.actualUsd);
  const rawVariance = standard - actual;
  // Keep the raw charge for evidence, but normalize sub-1U movement to zero for
  // rebates, exception routing and profit adjustment.
  const actionableVariance = Math.abs(rawVariance) < COST_VARIANCE_TOLERANCE_USD_CENTS ? 0 : rawVariance;
  const saving = Math.max(0, actionableVariance);
  const retained = Math.min(saving, moneyToCents(input.retainedUsd));
  const rebateUsd = centsToMoney(saving - retained);
  // The retained amount is the built-in fee allowance withheld from the platform rebate.
  // Any separately registered fees are additional costs and must not be hidden inside it.
  const totalCostUsd = sumMoney([input.actualUsd, centsToMoney(retained), input.feesUsd]);
  // When the verified USD charge is exactly the plan standard and there are no
  // extra fees or rebates, the real cost has not moved from the frozen CNY cost.
  // Reuse that order-time value instead of requiring an artificial FX rate.
  const unchangedFromFrozenCost = actionableVariance === 0 && moneyToCents(input.feesUsd) === 0 &&
    moneyToCents(rebateUsd) === 0;
  const actualCostCny = input.fxRate
    ? usdToCny(totalCostUsd, input.fxRate)
    : unchangedFromFrozenCost ? centsToMoney(standardCost) : null;
  // A zero USD rebate is exactly CNY 0.00 and does not need an invented FX rate.
  // This lets the frozen CNY supply quote flow straight into net settlement income.
  const rebateCny = moneyToCents(rebateUsd) === 0
    ? "0.00"
    : input.fxRate ? usdToCny(rebateUsd, input.fxRate) : null;
  const net = rebateCny === null ? null : centsToMoney(supply - moneyToCents(rebateCny));
  const baseGross = centsToMoney(supply - standardCost);
  // Cost savings and the platform rebate are synchronized. Their shared USD movement
  // cancels from gross profit; only an overcharge or an extra fee changes the baseline.
  const profitAdjustmentUsdCents = actionableVariance - retained - moneyToCents(input.feesUsd) - moneyToCents(rebateUsd);
  const grossProfit = profitAdjustmentUsdCents === 0
    ? baseGross
    : input.fxRate
      ? centsToMoney(signedMoneyToCents(baseGross) + signedMoneyToCents(usdToCny(centsToMoney(Math.abs(profitAdjustmentUsdCents)), input.fxRate)) * Math.sign(profitAdjustmentUsdCents))
      : null;
  return {
    original_supply_cny: centsToMoney(supply),
    standard_cost_cny: centsToMoney(standardCost),
    base_gross_profit_cny: baseGross,
    platform_base_profit_cny: centsToMoney(base),
    saving_usd: centsToMoney(saving),
    ignored_variance_usd: centsToMoney(actionableVariance === 0 ? Math.abs(rawVariance) : 0),
    retained_applied_usd: centsToMoney(retained),
    rebate_usd: rebateUsd,
    actual_usd: centsToMoney(actual),
    fees_usd: centsToMoney(moneyToCents(input.feesUsd)),
    total_cost_usd: totalCostUsd,
    profit_adjustment_usd: centsToMoney(profitAdjustmentUsdCents),
    fx_rate: input.fxRate || null,
    actual_cost_cny: actualCostCny,
    rebate_equivalent_cny: rebateCny,
    supplier_net_income_cny: net,
    gross_profit_cny: grossProfit,
    // Display-only equivalent. Statements and payment records remain separated by currency.
    platform_total_equivalent_cny: rebateCny === null ? null
      : centsToMoney(base + moneyToCents(rebateCny)),
  };
}
