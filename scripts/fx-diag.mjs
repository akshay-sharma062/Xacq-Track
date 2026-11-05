// D-09 pre-backfill diagnostic (read-only). Writes .fx-diag.json (gitignored scratch).
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

const d = new DatabaseSync("prisma/dev.db", { readOnly: true });
const q = (sql) => d.prepare(sql).get();
const qa = (sql) => d.prepare(sql).all();

const out = {
  zeroRows_inrSpend0: q("SELECT COUNT(*) c FROM Spend WHERE inrSpend=0").c,
  totalRows: q("SELECT COUNT(*) c FROM Spend").c,
  oldInrTotal: q("SELECT COALESCE(SUM(inrSpend),0) s FROM Spend").s,
  // the money-gap subset: inrSpend=0 while native spend > 0 (real under-statement)
  moneyGap: q("SELECT COUNT(*) c FROM Spend WHERE inrSpend=0 AND spend>0").c,
  moneyGapInrLost: q("SELECT COALESCE(SUM(spend),0) s FROM Spend WHERE inrSpend=0 AND spend>0 AND currency='INR'").s,
  moneyGapAedNativeLost: q("SELECT COALESCE(SUM(spend),0) s FROM Spend WHERE inrSpend=0 AND spend>0 AND currency!='INR'").s,
  // the stamp-consistency subset: inrSpend=0 AND spend=0 AND inrRate=0 (un-stamped zero rows)
  unstampedZeroRows: q("SELECT COUNT(*) c FROM Spend WHERE inrSpend=0 AND spend=0 AND inrRate=0").c,
  unstampedByCurrency: qa("SELECT currency, COUNT(*) c FROM Spend WHERE inrSpend=0 AND inrRate=0 GROUP BY currency"),
  zeroRowsAedDays: qa("SELECT day, COUNT(*) c FROM Spend WHERE inrSpend=0 AND inrRate=0 AND currency!='INR' GROUP BY day ORDER BY day"),
  zeroRowsInrDays: qa("SELECT MIN(day) mn, MAX(day) mx, COUNT(*) c FROM Spend WHERE inrSpend=0 AND inrRate=0 AND currency='INR'"),
  fxRates: qa("SELECT currency, date, rateToInr, source FROM FxRate ORDER BY currency, date"),
  // D-09 money-integrity core: is the INR total actually under-stated?
  //   under-statement exists ONLY where native spend>0 but inrSpend=0 (moneyGap above).
  //   Zero-spend rows with inrSpend=0 are CORRECT (0*rate=0), not a gap.
  // cross-check: recompute the "correct" INR total from native + per-currency rate
  // and diff against SUM(inrSpend). A non-zero diff = real under-statement to fix.
  correctTotalInr: (() => {
    const AED_FALLBACK = 25.849976; // the single stored AED rate (open.er-api.com)
    const rows = qa("SELECT currency, day, spend, inrSpend, inrRate FROM Spend");
    const byDayRate = new Map(qa("SELECT date, rateToInr FROM FxRate WHERE currency='AED'").map((r) => [r.date, r.rateToInr]));
    let correct = 0;
    for (const r of rows) {
      if (r.currency === "INR") correct += Number(r.spend ?? 0);
      else {
        // per-day stored rate where present; else the stored FX row's day; else the fallback.
        const rate = r.inrRate && r.inrRate > 0 ? r.inrRate : (byDayRate.get(r.day) ?? AED_FALLBACK);
        correct += (Number(r.spend ?? 0)) * rate;
      }
    }
    return Math.round(correct * 100) / 100;
  })(),
  // how many rows would the "stamp every inrSpend=0 row" backfill actually
  // change in value? (inrSpend=0 rows where spend>0 are the only real fixes)
  rowsNeedingValueFix: qa("SELECT currency, COUNT(*) c FROM Spend WHERE inrSpend=0 AND spend>0 GROUP BY currency"),
  // is AED money actually normalised today? positive-spend rows by currency.
  positiveSpendByCurrency: qa("SELECT currency, COUNT(*) c, COALESCE(SUM(spend),0) native, COALESCE(SUM(inrSpend),0) inr FROM Spend WHERE spend>0 GROUP BY currency"),
  // the Job Workshop AED account's normalised total (the D-05 ₹384,113.82 figure).
  jobWorkshop: (() => {
    const r = q("SELECT COALESCE(SUM(spend),0) native, COALESCE(SUM(inrSpend),0) inr, COUNT(*) c FROM Spend WHERE adAccountId=(SELECT id FROM AdAccount WHERE metaId='act_935714081758825')");
    return r;
  })(),
  // what fraction of inrSpend=0 rows are zero-spend (i.e. legitimately 0)?
  zeroSpendOfInrSpend0: q("SELECT COUNT(*) c FROM Spend WHERE inrSpend=0 AND spend=0").c,
  // MONEY-INTEGRITY core: is every row's inrSpend == round(spend * rate, 2)?
  // INR uses rate 1 (identity); other currencies use the row's inrRate (the
  // stored rate it was converted with). A row that violates this = a real gap.
  moneyIntegrity: (() => {
    const rows = qa("SELECT currency, spend, inrSpend, inrRate, adMetaId, day FROM Spend");
    let viol = 0; let sample = [];
    for (const r of rows) {
      const rate = r.currency === "INR" ? 1 : Number(r.inrRate ?? 0);
      const expected = Math.round((Number(r.spend ?? 0) * rate) * 100) / 100;
      if (Math.abs((Number(r.inrSpend ?? 0)) - expected) > 0.005) {
        viol++;
        if (sample.length < 5) sample.push({ ad: r.adMetaId, day: r.day, currency: r.currency, spend: r.spend, inrRate: r.inrRate, inrSpend: r.inrSpend, expected });
      }
    }
    return { violations: viol, sample };
  })(),
  fixedPoint: {
    ad: q("SELECT COUNT(*) c FROM Ad").c,
    adSet: q("SELECT COUNT(*) c FROM AdSet").c,
    spend: q("SELECT COUNT(*) c FROM Spend").c,
  },
  balanceNow: qa("SELECT metaId, clientId, name, balance, balanceAsOf FROM AdAccount ORDER BY name"),
};
writeFileSync(".fx-diag.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
