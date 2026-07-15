import { useState, useMemo, useEffect, createContext, useContext } from "react";
import { Zap, ChevronDown } from "lucide-react";

/* =========================================================================
   BijliHisaab Pakistan — bilingual (EN / اردو) electricity bill estimator.
   Design: Swiss / International Typographic Style. RTL-aware for Urdu.
   Tariff basis: NEPRA uniform residential tariff, FY 2025–26. Estimates only.
   ========================================================================= */

const TARIFF_UPDATED = "July 2026";

const DISCOS = ["LESCO", "MEPCO", "FESCO", "GEPCO", "IESCO", "PESCO", "HESCO", "SEPCO", "QESCO", "K-Electric"];

const UNPROTECTED_SLABS = [
  { upto: 100, rate: 23.59 }, { upto: 200, rate: 25.10 }, { upto: 300, rate: 27.04 },
  { upto: 400, rate: 32.53 }, { upto: 500, rate: 36.38 }, { upto: 600, rate: 39.31 },
  { upto: 700, rate: 40.79 }, { upto: Infinity, rate: 43.95 },
];
const PROTECTED_SLABS = [{ upto: 100, rate: 13.99 }, { upto: 200, rate: 17.07 }];
const LIFELINE_SLABS = [{ upto: 50, rate: 3.95 }, { upto: 100, rate: 7.74 }];
const COMMERCIAL_RATE = 45.43;  // A-2 commercial per-unit rate (NEPRA uniform, FY 2025–26)
const DEFAULT_FPA = 3.23;       // Fuel Price/Cost Adjustment (Rs/unit) — NEPRA sets it monthly; typically Rs 2.5–3.5 in FY 2025–26
const DEFAULT_SURCHARGE = 3.23; // Financing Cost surcharge + net Quarterly Tariff Adjustment (Rs/unit); read exact figures off your bill
const GST = 0.18;               // General Sales Tax, 18%, on energy + FPA + surcharge + fixed charges
const DUTY = 0.015;             // Provincial Electricity Duty, ~1.5% on variable (energy + FPA + surcharge) charges
const TV_FEE = 35;              // PTV licence fee, residential (per bill)
const TV_FEE_COMM = 60;         // PTV licence fee, commercial (per bill)

// Advance/withholding income tax — Income Tax Ordinance 2001, Section 235.
// DOMESTIC: 0% below the threshold; above it, applies ONLY to non-filers (not on the
//   Active Taxpayers List). Domestic ATL filers are fully exempt.
// COMMERCIAL/INDUSTRIAL: collected on every bill on a slab basis, regardless of filer
//   status (filers may adjust it later against their annual return).
const IT_THRESHOLD = 25000;     // Domestic WHT applies at/above this monthly bill (Rs)
const DEFAULT_IT_RATE = 7.5;    // % WHT on domestic non-filer bills at/above threshold (adjustable)
const DEFAULT_FILER = false;    // treat consumer as non-filer by default (tax applies); filers toggle this on
const COMM_WHT_FREE = 500;      // commercial bill up to this is exempt (Rs)
const COMM_WHT_MID_CAP = 20000; // commercial bill up to this: flat 10% band (Rs)
const COMM_WHT_MID_RATE = 0.10; // 10% for the Rs 500–20,000 band
const COMM_WHT_BASE = 1950;     // fixed amount above Rs 20,000 (Rs)
const COMM_WHT_TOP_RATE = 0.12; // + 12% of the amount above Rs 20,000 (commercial; industrial is 5%)
const DEFAULT_LOAD = 1;         // sanctioned load in kW
const PRESETS = [100, 200, 300, 500, 700];
const FEEDBACK_EMAIL = "hello@wattwise.pk"; // replace with your address before launch

// Per-kW/month fixed charge (NEPRA determination, Feb 2026), by tariff + slab.
function fixedPerKw(cat, units) {
  if (cat === "lifeline") return 0;
  if (cat === "commercial") return 500;
  if (cat === "protected") return units <= 100 ? 200 : 300;
  if (units <= 100) return 275;
  if (units <= 200) return 300;
  if (units <= 300) return 350;
  if (units <= 400) return 400;
  if (units <= 500) return 500;
  return 675;
}

function progressive(units, slabs) {
  let remaining = units, prev = 0, total = 0;
  for (const s of slabs) {
    const band = Math.min(remaining, s.upto - prev);
    if (band > 0) total += band * s.rate;
    remaining -= band; prev = s.upto;
    if (remaining <= 0) break;
  }
  return total;
}
const slabRateForTotal = (u) => UNPROTECTED_SLABS.find((s) => u <= s.upto) || UNPROTECTED_SLABS.at(-1);

function calculateBill(rawUnits, category, fpaRate, surchargeRate = DEFAULT_SURCHARGE, load = DEFAULT_LOAD, itRate = DEFAULT_IT_RATE, filer = DEFAULT_FILER) {
  const units = Math.max(0, Number(rawUnits) || 0);
  let energy = 0, effectiveCategory = category, noteKey = null;
  if (category === "commercial") energy = units * COMMERCIAL_RATE;
  else if (category === "lifeline") {
    if (units > 100) { effectiveCategory = "nonprotected"; noteKey = "lifeline"; energy = units * slabRateForTotal(units).rate; }
    else energy = progressive(units, LIFELINE_SLABS);
  } else if (category === "protected") {
    if (units > 200) { effectiveCategory = "nonprotected"; noteKey = "protected"; energy = units * slabRateForTotal(units).rate; }
    else energy = progressive(units, PROTECTED_SLABS);
  } else energy = units * slabRateForTotal(units).rate;

  const fpa = units * (Number(fpaRate) || 0);
  const surcharge = units * (Number(surchargeRate) || 0);
  // Fixed charges: per-kW of sanctioned load (NEPRA Feb 2026), lifeline exempt.
  const fixed = fixedPerKw(effectiveCategory, units) * Math.max(0, Number(load) || 0);
  const variable = energy + fpa + surcharge;
  const duty = variable * DUTY;                       // Electricity Duty (variable charges)
  const gst = (variable + fixed) * GST;               // GST (not on duty / TV / income tax)
  const tv = units === 0 ? 0 : (category === "commercial" ? TV_FEE_COMM : TV_FEE);
  const beforeIT = energy + fpa + surcharge + fixed + duty + gst + tv;

  // Advance/withholding income tax — Section 235, Income Tax Ordinance 2001.
  let incomeTax = 0;
  if (effectiveCategory === "commercial") {
    // Commercial slab, collected on every bill (filers adjust it later):
    //   ≤ Rs 500 → nil · Rs 500–20,000 → 10% · > Rs 20,000 → Rs 1,950 + 12%.
    if (beforeIT > COMM_WHT_MID_CAP) incomeTax = COMM_WHT_BASE + (beforeIT - COMM_WHT_MID_CAP) * COMM_WHT_TOP_RATE;
    else if (beforeIT > COMM_WHT_FREE) incomeTax = beforeIT * COMM_WHT_MID_RATE;
  } else if (!filer && beforeIT >= IT_THRESHOLD) {
    // Domestic: only non-filers pay, and only at/above the threshold. Filers are exempt.
    incomeTax = beforeIT * ((Number(itRate) || 0) / 100);
  }

  const total = beforeIT + incomeTax;
  const afterDue = total * 1.10;                       // Late Payment Surcharge (10%)
  const perUnit = units > 0 ? total / units : 0;

  return {
    units, energy, fpa, surcharge, fixed, duty, gst, tv, incomeTax, total, afterDue, perUnit,
    effectiveCategory, noteKey,
    taxesAndDuties: duty + gst + tv + incomeTax,
  };
}

const fmt = (n) => "Rs " + Math.round(Number(n) || 0).toLocaleString("en-US");

const APPLIANCES = [
  { id: "ac", watts: 1500, hours: 8, name: { en: "Air Conditioner (1.5 ton)", ur: "ایئر کنڈیشنر (1.5 ٹن)" }, tip: { en: "Set to 26°C and switch to an inverter unit — roughly 40% less.", ur: "26° پر رکھیں اور انورٹر یونٹ استعمال کریں — تقریباً 40% کمی۔" } },
  { id: "fan", watts: 75, hours: 12, name: { en: "Ceiling Fan", ur: "چھت کا پنکھا" }, tip: { en: "DC inverter fans (~30W) roughly halve fan running cost.", ur: "ڈی سی انورٹر پنکھے (~30 واٹ) خرچ تقریباً آدھا کر دیتے ہیں۔" } },
  { id: "fridge", watts: 200, hours: 9, name: { en: "Refrigerator", ur: "فریج" }, tip: { en: "Keep coils clean and the door shut; inverter fridges save most.", ur: "کوائل صاف اور دروازہ بند رکھیں؛ انورٹر فریج سب سے زیادہ بچاتا ہے۔" } },
  { id: "washer", watts: 500, hours: 1, name: { en: "Washing Machine", ur: "واشنگ مشین" }, tip: { en: "Run full loads only to cut the number of cycles.", ur: "صرف بھرے لوڈ پر چلائیں تاکہ سائیکل کم ہوں۔" } },
  { id: "micro", watts: 1200, hours: 0.5, name: { en: "Microwave", ur: "مائیکرو ویو" }, tip: { en: "Fine for short use — it is the standby draw that adds up.", ur: "مختصر استعمال ٹھیک ہے — اصل خرچ اسٹینڈ بائی میں ہے۔" } },
  { id: "iron", watts: 1000, hours: 0.5, name: { en: "Electric Iron", ur: "بجلی کی استری" }, tip: { en: "Iron in one batch so the plate reheats fewer times.", ur: "ایک ساتھ استری کریں تاکہ پلیٹ کم بار گرم ہو۔" } },
  { id: "pump", watts: 750, hours: 1, name: { en: "Water Pump", ur: "واٹر پمپ" }, tip: { en: "Use a timer or float switch to stop needless running.", ur: "ٹائمر یا فلوٹ سوئچ سے بےجا چلنا روکیں۔" } },
  { id: "geyser", watts: 2000, hours: 1.5, name: { en: "Geyser / Water Heater", ur: "گیزر / واٹر ہیٹر" }, tip: { en: "A gas geyser or lower thermostat saves heavily in winter.", ur: "گیس گیزر یا کم تھرموسٹیٹ سردیوں میں بہت بچاتا ہے۔" } },
  { id: "led", watts: 12, hours: 6, name: { en: "LED Lights (each)", ur: "ایل ای ڈی لائٹ (فی عدد)" }, tip: { en: "Already efficient — replace any remaining CFL/incandescent.", ur: "پہلے ہی کارآمد — بقیہ سی ایف ایل/بلب بدل دیں۔" } },
  { id: "tv", watts: 100, hours: 5, name: { en: "Television", ur: "ٹیلی وژن" }, tip: { en: "Turn fully off rather than standby to trim phantom load.", ur: "اسٹینڈ بائی کے بجائے مکمل بند کریں تاکہ فینٹم لوڈ کم ہو۔" } },
  { id: "pc", watts: 150, hours: 5, name: { en: "Computer / Laptop", ur: "کمپیوٹر / لیپ ٹاپ" }, tip: { en: "Laptops draw far less than desktops; enable sleep mode.", ur: "لیپ ٹاپ ڈیسک ٹاپ سے کم خرچ کرتا ہے؛ سلیپ موڈ آن کریں۔" } },
];

/* ----------------------------- i18n ---------------------------------- */

const T = {
  en: {
    dir: "ltr",
    nav: { calculator: "Bill calculator", appliances: "Appliances", compare: "Compare", faq: "About & FAQ", feedback: "Feedback" },
    meta: ["Free", "No sign-in", "NEPRA FY 2025–26", `Updated ${TARIFF_UPDATED}`],
    hero: { eyebrow: "Electricity bill estimator — Pakistan", title: "Know your bill before it arrives.", standfirst: "Check and estimate your electricity bill online for LESCO, FESCO, MEPCO, IESCO, K-Electric and every Pakistani DISCO — from a 100-unit to a 300-unit bill and beyond. See exactly why it is that high, and the fastest ways to bring it down." },
    calc: { s1: "Section 01", title: "Your electricity details", subtitle: "Fill in what you know — the rest is optional.", helpTitle: "Where do I find this?", helpBody: "Your printed bill shows Units Consumed and Tariff Type (A-1 = non-protected, A-1P = protected). No bill nearby? Open your DISCO's online duplicate bill, or subtract last month's meter reading from today's.", disco: "Distribution company", ctype: "Consumer type", units: "Units consumed this month", unitsHint: "From your meter: current reading − previous reading.", common: "Common usage — tap to fill", prev: "Last month's units (optional)", prevHint: "Enables month-on-month comparison.", load: "Sanctioned load (kW)", loadHint: "Printed on your bill as sanctioned load — usually 1–5 kW for homes. Sets the fixed charge.", advanced: "Advanced — fuel adjustment & surcharge", advancedHint: "Tap to open — fine-tune FPA, surcharge & tax to match your bill", unit: "unit", fromBill: "From your bill (Rs total)", fpaLabel: "Fuel adjustment (FPA)", surchargeLabel: "Surcharge + QTA", itLabel: "Non-filer income tax rate", filerLabel: "Tax status (ATL)", nonFiler: "Non-filer", filerYes: "Filer", commTaxNote: "Commercial bills carry advance income tax automatically (Section 235): nil up to Rs 500, 10% up to Rs 20,000, then Rs 1,950 + 12% above — applied whether or not you file.", filerNote: "Domestic advance income tax (Section 235) is charged only to non-filers, and only when the bill reaches Rs 25,000. If you are on the FBR Active Taxpayers List, switch to Filer and it drops to zero.", fpaNote: "FPA and surcharge change over time and appear as separate lines on your bill. For an exact match, copy the per-unit FPA and the surcharge/quarterly-adjustment figures from your latest bill." },
    cat: { protected: { label: "Protected", sub: "≤200 units, no AC" }, nonprotected: { label: "Non-protected", sub: ">200 units / has AC" }, lifeline: { label: "Lifeline", sub: "≤100, minimal use" }, commercial: { label: "Commercial", sub: "shops, offices" } },
    result: { total: "Estimated total payable", avg: "Avg / unit", why: "Why this amount", energy: "Energy charges", fpa: "Fuel adj. & surcharges", taxes: "Taxes & duties", taxDetail: "Taxes & duties — breakdown", gst: "General Sales Tax (18%)", duty: "Electricity Duty", tvFee: "PTV licence fee", itLine: "Income tax (Section 235)", fixed: "Fixed charges", warn: "Slab warning", afterDue: "After due date (+10% LPS)", disclaimer: `Estimate on the NEPRA uniform tariff (FY 2025–26). Actual bills vary with the monthly Fuel Price Adjustment, quarterly adjustments, surcharges and your DISCO. Tariff data reviewed ${TARIFF_UPDATED}.` },
    notes: { lifeline: "Above 100 units, lifeline status is lost — billed as non-protected.", protected: "Crossing 200 units drops protected status for the month — every unit is billed at non-protected rates." },
    cmp: { vsLast: "Compared with last month", units: "Units", bill: "Bill", change: "Change" },
    save: { s2: "Section 02 — Ways to spend less", print: "Print / save as PDF", highTitle: "Your estimated bill is high", highBody: "Here are the biggest ways to bring it down, most impactful first." },
    tips: { slabTag: "Slab cliff", slabTitle: "You are only {gap} units into a higher rate band", slabBody: "Non-protected bills charge every unit at your top band's rate. Getting below {floor} units re-rates the whole bill lower — about {x} saved.", acTag: "Cooling", acTitle: "Cooling is likely your biggest cost", acBody: "Set the AC to 26°C, service it, and prefer an inverter unit — together this can save up to about {x} a month. Try fans first; each fan costs a fraction of an AC.", standbyTag: "Standby power", standbyTitle: "Cut always-on and standby loads", standbyBody: "Switch off the geyser when it is not needed and unplug idle TVs, chargers and set-top boxes — often around {x} a month.", lightTag: "Lighting", lightTitle: "Switch remaining bulbs to LED", lightBody: "Replacing ~5 old bulbs with LEDs saves roughly {x} a month at your current rate.", peakTag: "Peak hours", peakTitle: "Shift heavy loads off-peak", peakBody: "Run laundry, the water pump and ironing outside peak hours to avoid higher time-of-use rates." },
    app: { s1: "Section 01", title: "What is running at home?", subtitle: "Set the count, wattage and how often you use each appliance.", watt: "W", hrs: "Hrs/day", days: "Days/week", monthly: "Estimated monthly usage", units: "units", cost: "≈ cost", biggest: "Biggest energy users", uShort: "u", use: "Use {n} units in calculator →", empty: "Add an appliance to see where your electricity goes.", draw: "Biggest draw", addTitle: "Add your own device", namePh: "Device name", wattsPh: "Watts", addBtn: "Add", remove: "Remove" },
    compare: { thisMonth: "This month", cutBack: "If I cut back", units: "Units", ctype: "Consumer type", diff: "Difference between scenarios", save: "Save", extra: "Extra", sentence: "“{b}” is {word} than “{a}” by {pct}% per month.", cheaper: "cheaper", pricier: "pricier" },
    faq: { heading: "About & FAQ", about: "BijliHisaab is a free electricity bill calculator for Pakistan. Estimate your monthly bill, check what a 300-unit bill costs, understand protected vs non-protected slabs, and see how to reduce it — for LESCO (Lahore), FESCO (Faisalabad), MEPCO, GEPCO, IESCO, PESCO, HESCO, SEPCO, QESCO and K-Electric.", items: [
      { q: "How do I check or download my duplicate electricity bill online?", a: "BijliHisaab shows an estimate, not your official bill. To view or print your actual (duplicate) bill, use your DISCO's own online bill service — search your company name with 'online bill' (for example 'LESCO online bill' or 'FESCO bill') and enter your 14-digit reference number from any past bill." },
      { q: "What does a 300-unit electricity bill cost in Pakistan?", a: "For a non-protected household, 300 units is charged at that slab's rate on every unit, plus fuel adjustment, GST, electricity duty and fixed charges — often roughly Rs 11,000–14,000 depending on the month's fuel adjustment. Enter 300 in the calculator above for your own estimate." },
      { q: "How accurate is this estimate?", a: "It uses the published NEPRA uniform tariff for FY 2025–26. The main unknown is the monthly Fuel Price Adjustment — set it in the Advanced box for a closer figure. Treat every result as a well-informed estimate, not the official bill." },
      { q: "What is the 200-unit trap?", a: "Protected consumers pay heavily subsidised rates. The moment monthly use crosses 200 units, you are billed at non-protected rates on every single unit — not just the extra ones. BijliHisaab flags this whenever it happens." },
      { q: "Protected vs non-protected — which am I?", a: "You are protected if you have stayed at or under 200 units, have no AC registered on your meter, and your sanctioned load is under 5 kW. Check the tariff field (A-1 vs A-1P) on your bill." },
      { q: "Do you store my data?", a: "No. There are no accounts, no server and no database. Every calculation happens in your browser and nothing is saved or sent anywhere." },
      { q: "Which companies are supported?", a: "All government DISCOs share the NEPRA uniform tariff. K-Electric differs slightly, so treat its figures as a rougher estimate." },
      { q: "Filer vs non-filer — does it change my bill?", a: "For homes, yes, but only on big bills. Advance income tax under Section 235 is charged to domestic consumers only if they are non-filers (not on the FBR Active Taxpayers List) and the bill reaches Rs 25,000 or more — then 7.5% of the bill. Domestic filers pay nothing. Update your CNIC/filer status with your DISCO to have it removed. Set your status in the Advanced box." },
      { q: "What taxes and charges make up my bill?", a: "Energy charge (units × slab rate); Fuel Price Adjustment (FPA, set monthly); Financing Cost surcharge and any Quarterly Tariff Adjustment (per unit); fixed charges per kW of sanctioned load; Electricity Duty (about 1.5% of variable charges); 18% General Sales Tax; the PTV licence fee (Rs 35 at home, Rs 60 commercial); and, where it applies, Section 235 income tax. Pay after the due date and a 10% Late Payment Surcharge is added." },
      { q: "How is tax different for a shop or commercial meter?", a: "Commercial bills carry Section 235 advance income tax automatically, on a slab: nil up to Rs 500, 10% up to Rs 20,000, then Rs 1,950 plus 12% of the amount above Rs 20,000 — filer or not. Unregistered (non-sales-tax-registered) commercial and industrial users can also face Further Tax and Extra Tax; those are not modelled here, so treat commercial figures as a floor." },
      { q: "Why is my real bill higher than the estimate?", a: "Usually a higher monthly Fuel Price Adjustment than the default, arrears carried from a previous month, a late-payment surcharge, or a billing cycle longer than 30 days. Set the FPA from your latest bill and compare only the current-month charges." },
      { q: "What exactly is the fuel adjustment (FPA)?", a: "A per-unit charge NEPRA sets each month to reflect the real cost of the fuel used to generate electricity. It changes every month and moves your bill up or down, which is why BijliHisaab lets you set it yourself." },
      { q: "How do I read my meter?", a: "Note the number shown on the meter today and subtract the reading printed on last month's bill. The difference is the units used so far this cycle." },
      { q: "Does having an AC always make me non-protected?", a: "If an AC is registered on your meter's sanctioned load, yes — you pay non-protected rates however little you use it. Crossing 200 units in a month also drops protected status." },
      { q: "Can solar lower my bill?", a: "Rooftop solar with net metering can cut grid units sharply, especially for high-slab users. Savings depend on your usage and system size — treat online solar calculators as estimates too." },
      { q: "How do I check my electricity bill online?", a: "To view or download your actual monthly bill, use your DISCO's official online bill service and enter your 14-digit reference number — for example the FESCO, LESCO, MEPCO or IESCO bill portals. BijliHisaab is different: it estimates the bill in advance and explains every charge, so you know the amount before it arrives." },
      { q: "How can I get a duplicate electricity bill?", a: "A duplicate electricity bill is issued by your distribution company, not by us. Search your DISCO's name with \"online bill\" (for example \"FESCO online bill\" or \"LESCO duplicate bill\"), enter your reference number, then print or save the PDF. Use BijliHisaab alongside it to check whether the amount looks right." },
      { q: "How do I check my FESCO electricity bill online?", a: "For your actual FESCO bill, use FESCO's official online bill service and enter your 14-digit reference number to view or download the duplicate PDF. BijliHisaab is an estimator: enter your units above and it works out the FESCO bill in advance — energy, fuel adjustment, taxes and fixed charges — on the same NEPRA tariff FESCO uses, so you know the amount before it arrives." },
      { q: "How do I check my Lahore (LESCO) electricity bill?", a: "In Lahore your distribution company is LESCO. To see or download your actual (duplicate) LESCO bill, open LESCO's online bill service and enter your reference number. To estimate it first — or check whether the amount looks right — enter your units in the calculator above; LESCO uses the same NEPRA uniform tariff this tool is built on." },
      { q: "What is the electricity bill for 300 units in Pakistan?", a: "A 300-unit bill sits in the 201–300 slab. For a non-protected household it usually comes to roughly Rs 10,000–11,000 once energy charges, 18% GST and the monthly fuel adjustment are added. Enter 300 units in the calculator to see the exact figure for your company and tariff type." },
    ], disclaimerLabel: "Disclaimer", disclaimerText: "BijliHisaab is an independent estimator, not affiliated with NEPRA or any DISCO. Always confirm against your official bill before paying." },
    fb: { title: "Tell us what to improve", subtitle: "BijliHisaab is free and always evolving. Your feedback decides what we build next.", ratingLabel: "How useful was it? (optional)", nameLabel: "Name (optional)", namePh: "Your name", msgLabel: "Your feedback", msgPh: "What worked, what was confusing, what's missing…", send: "Send feedback", note: "This opens your email app with the message ready to send. Nothing is stored on this site." },
    footer: { reviewed: `Tariff reviewed ${TARIFF_UPDATED} · Estimates only`, privacy: "Privacy policy", disclaimer: "BijliHisaab provides estimates based on publicly available NEPRA tariff information and is not affiliated with NEPRA or any distribution company. Actual bills may differ due to fuel adjustments, surcharges, taxes and tariff updates. No personal data is collected or stored." },
    privacy: { title: "Privacy policy", updated: `Last updated: ${TARIFF_UPDATED}`, contact: "Questions about privacy? Email {email}.", sections: [
      { h: "No account, no tracking", p: "BijliHisaab needs no sign-up and sets no advertising or analytics cookies. You can use every feature without identifying yourself." },
      { h: "Your data stays in your browser", p: "Every calculation — bills, appliances and comparisons — runs entirely on your device. The values you enter are never sent to a server or stored by us, and they clear when you close the tab." },
      { h: "No bills are collected", p: "BijliHisaab does not collect meter readings, reference numbers or copies of your bill. Anything you type is used only to show your estimate on screen." },
      { h: "Feedback you choose to send", p: "The Feedback tab opens your own email app with a message you write. You decide whether to send it; it reaches us by email and nothing is captured on the site itself." },
      { h: "Web fonts", p: "For Urdu text the interface may load a font from Google Fonts, which your browser fetches directly. We receive none of that data." },
      { h: "Changes to this policy", p: "If this policy changes, the date above will be updated." },
    ] },
  },
  ur: {
    dir: "rtl",
    nav: { calculator: "بل کیلکولیٹر", appliances: "آلات", compare: "موازنہ", faq: "تعارف و سوالات", feedback: "رائے" },
    meta: ["مفت", "بغیر سائن اِن", "نیپرا مالی سال 26–2025", "اپ ڈیٹ جولائی 2026"],
    hero: { eyebrow: "بجلی بل کا تخمینہ — پاکستان", title: "بل آنے سے پہلے اندازہ لگائیں۔", standfirst: "LESCO، FESCO، MEPCO، IESCO، K-Electric اور ہر پاکستانی کمپنی کا بجلی بل آن لائن دیکھیں اور تخمینہ لگائیں — 100 یونٹ سے 300 یونٹ اور اُس سے آگے تک۔ دیکھیں یہ اِتنا زیادہ کیوں ہے، اور اِسے کم کرنے کے تیز ترین طریقے۔" },
    calc: { s1: "حصہ 01", title: "آپ کی بجلی کی تفصیلات", subtitle: "جو معلوم ہے وہ بھریں — باقی اختیاری ہے۔", helpTitle: "یہ معلومات کہاں سے ملے گی؟", helpBody: "آپ کے چھپے بل پر «Units Consumed» اور «Tariff Type» (A-1 = غیر محفوظ، A-1P = محفوظ) درج ہوتا ہے۔ بل موجود نہیں؟ اپنی کمپنی کا آن لائن ڈپلیکیٹ بل کھولیں، یا پچھلی میٹر ریڈنگ آج کی ریڈنگ سے منہا کریں۔", disco: "تقسیم کار کمپنی", ctype: "صارف کی قسم", units: "اِس ماہ استعمال شدہ یونٹ", unitsHint: "میٹر سے: موجودہ ریڈنگ − پچھلی ریڈنگ۔", common: "عام استعمال — بھرنے کے لیے دبائیں", prev: "پچھلے ماہ کے یونٹ (اختیاری)", prevHint: "ماہ بہ ماہ موازنے کے لیے۔", load: "منظور شدہ لوڈ (کلوواٹ)", loadHint: "بل پر «Sanctioned Load» کے طور پر درج ہوتا ہے — گھروں کے لیے عموماً 1–5 کلوواٹ۔ یہ فکسڈ چارج طے کرتا ہے۔", advanced: "ایڈوانسڈ — فیول ایڈجسٹمنٹ و سرچارج", advancedHint: "کھولنے کے لیے دبائیں — بل سے ملانے کے لیے FPA، سرچارج و ٹیکس ایڈجسٹ کریں", unit: "یونٹ", fromBill: "آپ کے بل سے (کل روپے)", fpaLabel: "فیول ایڈجسٹمنٹ (FPA)", surchargeLabel: "سرچارج + QTA", itLabel: "نان فائلر انکم ٹیکس شرح", filerLabel: "ٹیکس اسٹیٹس (ATL)", nonFiler: "نان فائلر", filerYes: "فائلر", commTaxNote: "کمرشل بلوں پر ایڈوانس انکم ٹیکس خودکار لگتا ہے (سیکشن 235): Rs 500 تک صفر، Rs 20,000 تک 10%، اُس سے زائد پر Rs 1,950 + 12% — چاہے آپ فائلر ہوں یا نہ ہوں۔", filerNote: "گھریلو ایڈوانس انکم ٹیکس (سیکشن 235) صرف نان فائلرز پر، اور صرف تب لگتا ہے جب بل Rs 25,000 تک پہنچ جائے۔ اگر آپ ایف بی آر کی ایکٹو ٹیکس پیئرز لسٹ پر ہیں تو «فائلر» منتخب کریں، یہ صفر ہو جائے گا۔", fpaNote: "ایف پی اے اور سرچارج وقت کے ساتھ بدلتے ہیں اور بل پر الگ لائنوں میں آتے ہیں۔ بالکل درست ملان کے لیے اپنے تازہ بل سے فی یونٹ FPA اور سرچارج/سہ ماہی ایڈجسٹمنٹ کے اعداد یہاں درج کریں۔" },
    cat: { protected: { label: "محفوظ", sub: "200 یونٹ تک، بغیر اے سی" }, nonprotected: { label: "غیر محفوظ", sub: "200 سے زائد / اے سی" }, lifeline: { label: "لائف لائن", sub: "100 تک، کم استعمال" }, commercial: { label: "کمرشل", sub: "دکانیں، دفاتر" } },
    result: { total: "قابلِ ادائیگی کل تخمینہ", avg: "اوسط / یونٹ", why: "یہ رقم کیوں؟", energy: "توانائی چارجز", fpa: "فیول ایڈجسٹمنٹ و سرچارج", taxes: "ٹیکس و ڈیوٹی", taxDetail: "ٹیکس و ڈیوٹی — تفصیل", gst: "جنرل سیلز ٹیکس (18%)", duty: "الیکٹرسٹی ڈیوٹی", tvFee: "پی ٹی وی فیس", itLine: "انکم ٹیکس (سیکشن 235)", fixed: "فکسڈ چارجز", warn: "سلیب انتباہ", afterDue: "مقررہ تاریخ کے بعد (+10% ایل پی ایس)", disclaimer: "تخمینہ نیپرا یکساں ٹیرف (مالی سال 26–2025) پر مبنی ہے۔ اصل بل ماہانہ فیول ایڈجسٹمنٹ، سہ ماہی ایڈجسٹمنٹ، سرچارجز اور آپ کی کمپنی کے مطابق مختلف ہو سکتا ہے۔ ٹیرف ڈیٹا جولائی 2026 میں نظرثانی شدہ۔" },
    notes: { lifeline: "100 یونٹ سے زائد پر لائف لائن رعایت ختم — غیر محفوظ نرخ لاگو۔", protected: "200 یونٹ عبور کرنے پر اُس ماہ محفوظ حیثیت ختم — ہر یونٹ غیر محفوظ نرخ پر۔" },
    cmp: { vsLast: "پچھلے ماہ سے موازنہ", units: "یونٹ", bill: "بل", change: "تبدیلی" },
    save: { s2: "حصہ 02 — کم خرچ کے طریقے", print: "پرنٹ / پی ڈی ایف محفوظ کریں", highTitle: "آپ کا متوقع بل زیادہ ہے", highBody: "اِسے کم کرنے کے سب سے مؤثر طریقے، ترتیب سے۔" },
    tips: { slabTag: "سلیب کلف", slabTitle: "آپ اگلے نرخ بینڈ میں صرف {gap} یونٹ اندر ہیں", slabBody: "غیر محفوظ بل میں ہر یونٹ آپ کے سب سے اوپر والے بینڈ کے نرخ پر لگتا ہے۔ {floor} یونٹ سے نیچے آنے پر پورا بل کم نرخ پر آ جاتا ہے — تقریباً {x} کی بچت۔", acTag: "ٹھنڈک", acTitle: "ٹھنڈک ممکنہ طور پر سب سے بڑا خرچ ہے", acBody: "اے سی 26° پر رکھیں، سروس کروائیں، اور انورٹر یونٹ کو ترجیح دیں — یہ سب مل کر ماہانہ تقریباً {x} تک بچا سکتے ہیں۔ پہلے پنکھے چلائیں؛ ہر پنکھا اے سی سے بہت کم خرچ کرتا ہے۔", standbyTag: "اسٹینڈ بائی پاور", standbyTitle: "ہمہ وقت آن اور اسٹینڈ بائی بوجھ کم کریں", standbyBody: "ضرورت نہ ہو تو گیزر بند رکھیں اور فارغ ٹی وی، چارجر اور سیٹ ٹاپ باکس نکال دیں — اکثر ماہانہ تقریباً {x}۔", lightTag: "روشنی", lightTitle: "بقیہ بلب ایل ای ڈی میں بدلیں", lightBody: "تقریباً 5 پرانے بلب ایل ای ڈی سے بدلنے پر موجودہ نرخ پر ماہانہ تقریباً {x} کی بچت۔", peakTag: "پیک اوقات", peakTitle: "بھاری استعمال پیک سے ہٹائیں", peakBody: "کپڑے دھونا، واٹر پمپ اور استری پیک اوقات سے باہر چلائیں تاکہ زیادہ نرخ سے بچا جا سکے۔" },
    app: { s1: "حصہ 01", title: "گھر میں کیا چل رہا ہے؟", subtitle: "ہر آلے کی تعداد، واٹ اور استعمال کی تعدد مقرر کریں۔", watt: "واٹ", hrs: "گھنٹے/دن", days: "دن/ہفتہ", monthly: "ماہانہ متوقع استعمال", units: "یونٹ", cost: "≈ لاگت", biggest: "سب سے زیادہ بجلی خرچ", uShort: "یو", use: "کیلکولیٹر میں {n} یونٹ استعمال کریں ←", empty: "استعمال دیکھنے کے لیے کوئی آلہ شامل کریں۔", draw: "سب سے زیادہ کھپت", addTitle: "اپنا آلہ شامل کریں", namePh: "آلے کا نام", wattsPh: "واٹ", addBtn: "شامل کریں", remove: "ہٹائیں" },
    compare: { thisMonth: "اِس ماہ", cutBack: "اگر کمی کروں", units: "یونٹ", ctype: "صارف کی قسم", diff: "منظرناموں کا فرق", save: "بچت", extra: "اضافی", sentence: "«{b}» ماہانہ «{a}» سے {pct}% {word} ہے۔", cheaper: "سستا", pricier: "مہنگا" },
    faq: { heading: "تعارف و سوالات", about: "بجلی حساب پاکستان کے لیے ایک مفت بجلی بل کیلکولیٹر ہے۔ اپنے ماہانہ بل کا تخمینہ لگائیں، دیکھیں 300 یونٹ کا بل کتنا بنتا ہے، محفوظ اور غیر محفوظ سلیب سمجھیں، اور کم کرنے کے طریقے جانیں — LESCO (لاہور)، FESCO (فیصل آباد)، MEPCO، GEPCO، IESCO، PESCO، HESCO، SEPCO، QESCO اور کے-الیکٹرک کے لیے۔", items: [
      { q: "ڈپلیکیٹ بجلی بل آن لائن کیسے چیک یا ڈاؤن لوڈ کروں؟", a: "بجلی حساب تخمینہ دکھاتا ہے، آپ کا اصل بل نہیں۔ اصل (ڈپلیکیٹ) بل دیکھنے یا پرنٹ کرنے کے لیے اپنی کمپنی کی آن لائن بل سروس استعمال کریں — کمپنی کا نام «online bill» کے ساتھ تلاش کریں (مثلاً 'LESCO online bill' یا 'FESCO bill') اور کسی پرانے بل سے اپنا 14 ہندسوں کا ریفرنس نمبر درج کریں۔" },
      { q: "پاکستان میں 300 یونٹ کا بجلی بل کتنا بنتا ہے؟", a: "غیر محفوظ گھرانے کے لیے 300 یونٹ اُسی سلیب کے نرخ پر ہر یونٹ پر لگتے ہیں، اور اوپر سے فیول ایڈجسٹمنٹ، جی ایس ٹی، الیکٹرسٹی ڈیوٹی اور فکسڈ چارجز — ماہانہ فیول ایڈجسٹمنٹ کے مطابق اکثر تقریباً Rs 11,000–14,000۔ اپنے تخمینے کے لیے اوپر کیلکولیٹر میں 300 درج کریں۔" },
      { q: "یہ تخمینہ کتنا درست ہے؟", a: "یہ نیپرا کے شائع شدہ یکساں ٹیرف (مالی سال 26–2025) پر مبنی ہے۔ سب سے بڑا نامعلوم عنصر ماہانہ فیول ایڈجسٹمنٹ ہے — درست نتیجے کے لیے اِسے ایڈوانسڈ خانے میں مقرر کریں۔ ہر نتیجہ باخبر تخمینہ سمجھیں، سرکاری بل نہیں۔" },
      { q: "200 یونٹ کا جال کیا ہے؟", a: "محفوظ صارفین کو بہت رعایتی نرخ ملتا ہے۔ جیسے ہی ماہانہ استعمال 200 یونٹ عبور کرتا ہے، ہر یونٹ غیر محفوظ نرخ پر لگتا ہے — صرف اضافی یونٹ نہیں۔ BijliHisaab ایسا ہوتے ہی خبردار کرتا ہے۔" },
      { q: "محفوظ یا غیر محفوظ — میں کون ہوں؟", a: "اگر آپ 200 یونٹ یا اُس سے کم رہے ہیں، میٹر پر اے سی رجسٹرڈ نہیں، اور منظور شدہ لوڈ 5 کلوواٹ سے کم ہے تو آپ محفوظ ہیں۔ اپنے بل پر ٹیرف فیلڈ (A-1 یا A-1P) دیکھیں۔" },
      { q: "کیا آپ میرا ڈیٹا محفوظ کرتے ہیں؟", a: "نہیں۔ کوئی اکاؤنٹ، سرور یا ڈیٹابیس نہیں۔ ہر حساب آپ کے براؤزر میں ہوتا ہے اور کچھ محفوظ یا بھیجا نہیں جاتا۔" },
      { q: "کون سی کمپنیاں شامل ہیں؟", a: "تمام سرکاری کمپنیاں نیپرا کا یکساں ٹیرف استعمال کرتی ہیں۔ کے-الیکٹرک قدرے مختلف ہے، اِس لیے اُس کے اعداد کو موٹا تخمینہ سمجھیں۔" },
      { q: "فائلر اور نان فائلر — کیا اِس سے بل بدلتا ہے؟", a: "گھروں کے لیے ہاں، مگر صرف بڑے بلوں پر۔ سیکشن 235 کا ایڈوانس انکم ٹیکس گھریلو صارف پر تب لگتا ہے جب وہ نان فائلر ہو (ایف بی آر کی ایکٹو ٹیکس پیئرز لسٹ پر نہ ہو) اور بل Rs 25,000 تک پہنچ جائے — پھر بل کا 7.5%۔ گھریلو فائلر کچھ نہیں دیتے۔ اپنی کمپنی کے پاس شناختی کارڈ/فائلر اسٹیٹس اپ ڈیٹ کروا کر یہ ہٹوایا جا سکتا ہے۔ اپنی حیثیت ایڈوانسڈ خانے میں مقرر کریں۔" },
      { q: "میرے بل میں کون کون سے ٹیکس اور چارجز ہوتے ہیں؟", a: "توانائی چارج (یونٹ × سلیب نرخ)؛ فیول ایڈجسٹمنٹ (ایف پی اے، ماہانہ)؛ فنانسنگ کاسٹ سرچارج اور سہ ماہی ایڈجسٹمنٹ (فی یونٹ)؛ منظور شدہ لوڈ کے فی کلوواٹ فکسڈ چارجز؛ الیکٹرسٹی ڈیوٹی (متغیر چارجز کا تقریباً 1.5%)؛ 18% جنرل سیلز ٹیکس؛ پی ٹی وی فیس (گھر Rs 35، کمرشل Rs 60)؛ اور جہاں لاگو ہو، سیکشن 235 انکم ٹیکس۔ مقررہ تاریخ کے بعد ادائیگی پر 10% لیٹ پیمنٹ سرچارج شامل ہو جاتا ہے۔" },
      { q: "دکان یا کمرشل میٹر پر ٹیکس کیسے مختلف ہے؟", a: "کمرشل بلوں پر سیکشن 235 کا ایڈوانس انکم ٹیکس خودکار لگتا ہے، سلیب کے حساب سے: Rs 500 تک صفر، Rs 20,000 تک 10%، اُس سے زائد پر Rs 1,950 جمع Rs 20,000 سے اوپر کی رقم کا 12% — فائلر ہو یا نہ ہو۔ غیر رجسٹرڈ (سیلز ٹیکس میں غیر رجسٹرڈ) کمرشل و صنعتی صارفین پر فرتھر ٹیکس اور ایکسٹرا ٹیکس بھی لگ سکتا ہے؛ یہ یہاں شامل نہیں، اِس لیے کمرشل اعداد کو کم سے کم حد سمجھیں۔" },
      { q: "میرا اصل بل تخمینے سے زیادہ کیوں ہے؟", a: "عام وجوہات: ڈیفالٹ سے زیادہ ماہانہ فیول ایڈجسٹمنٹ، پچھلے مہینے کے بقایا جات، لیٹ پیمنٹ سرچارج، یا 30 دن سے زیادہ کا بلنگ سائیکل۔ اپنے تازہ بل سے ایف پی اے مقرر کریں اور صرف رواں ماہ کے چارجز کا موازنہ کریں۔" },
      { q: "فیول ایڈجسٹمنٹ (ایف پی اے) اصل میں کیا ہے؟", a: "یہ فی یونٹ چارج ہے جو نیپرا ہر ماہ بجلی بنانے میں استعمال ہونے والے ایندھن کی اصل لاگت کے مطابق مقرر کرتا ہے۔ یہ ہر ماہ بدلتا ہے، اِسی لیے BijliHisaab میں اِسے خود مقرر کیا جا سکتا ہے۔" },
      { q: "میٹر کیسے پڑھیں؟", a: "آج میٹر پر موجود نمبر نوٹ کریں اور پچھلے بل پر چھپی ریڈنگ منہا کریں۔ فرق اِس سائیکل میں اب تک استعمال شدہ یونٹ ہے۔" },
      { q: "کیا اے سی ہمیشہ غیر محفوظ بنا دیتا ہے؟", a: "اگر میٹر کے منظور شدہ لوڈ پر اے سی رجسٹرڈ ہے تو ہاں — چاہے کم استعمال ہو، غیر محفوظ نرخ لاگو ہوتا ہے۔ کسی ماہ 200 یونٹ عبور کرنا بھی محفوظ حیثیت ختم کر دیتا ہے۔" },
      { q: "کیا سولر سے بل کم ہو سکتا ہے؟", a: "چھت پر سولر اور نیٹ میٹرنگ گرڈ یونٹ نمایاں کم کر سکتے ہیں، خاص طور پر زیادہ سلیب والوں کے لیے۔ بچت استعمال اور سسٹم سائز پر منحصر ہے؛ آن لائن سولر کیلکولیٹرز کو بھی تخمینہ سمجھیں۔" },
      { q: "بجلی بل آن لائن کیسے چیک کریں؟", a: "اپنا اصل ماہانہ بل دیکھنے یا ڈاؤن لوڈ کرنے کے لیے اپنی کمپنی کی سرکاری آن لائن بل سروس پر 14 ہندسوں کا ریفرنس نمبر درج کریں — مثلاً FESCO، LESCO، MEPCO یا IESCO کے بل پورٹل۔ بجلی حساب اِس سے مختلف ہے: یہ بل کا پہلے سے تخمینہ لگاتا ہے اور ہر چارج سمجھاتا ہے، تاکہ رقم آنے سے پہلے معلوم ہو جائے۔" },
      { q: "ڈپلیکیٹ بجلی بل کیسے حاصل کریں؟", a: "ڈپلیکیٹ بل آپ کی تقسیم کار کمپنی جاری کرتی ہے، ہم نہیں۔ اپنی کمپنی کا نام «online bill» کے ساتھ تلاش کریں (مثلاً «FESCO online bill» یا «LESCO duplicate bill»)، ریفرنس نمبر درج کریں، پھر پی ڈی ایف پرنٹ یا محفوظ کریں۔ ساتھ ہی بجلی حساب سے دیکھ لیں کہ رقم درست لگتی ہے۔" },
      { q: "FESCO بجلی بل آن لائن کیسے چیک کریں؟", a: "اپنا اصل FESCO بل دیکھنے یا ڈاؤن لوڈ کرنے کے لیے FESCO کی سرکاری آن لائن بل سروس پر 14 ہندسوں کا ریفرنس نمبر درج کریں۔ بجلی حساب ایک تخمینہ کار ہے: اوپر اپنے یونٹ درج کریں اور یہ FESCO بل کا پہلے سے حساب لگا دیتا ہے — توانائی، فیول ایڈجسٹمنٹ، ٹیکس اور فکسڈ چارجز — اُسی نیپرا ٹیرف پر جو FESCO استعمال کرتا ہے، تاکہ رقم آنے سے پہلے معلوم ہو۔" },
      { q: "لاہور (LESCO) کا بجلی بل کیسے چیک کریں؟", a: "لاہور میں آپ کی کمپنی LESCO ہے۔ اپنا اصل (ڈپلیکیٹ) LESCO بل دیکھنے یا ڈاؤن لوڈ کرنے کے لیے LESCO کی آن لائن بل سروس کھولیں اور ریفرنس نمبر درج کریں۔ پہلے سے تخمینہ لگانے — یا رقم درست ہے یا نہیں دیکھنے — کے لیے اوپر کیلکولیٹر میں یونٹ درج کریں؛ LESCO وہی نیپرا یکساں ٹیرف استعمال کرتا ہے جس پر یہ ٹول بنا ہے۔" },
      { q: "پاکستان میں 300 یونٹ کا بل کتنا ہوتا ہے؟", a: "300 یونٹ 201–300 سلیب میں آتا ہے۔ غیر محفوظ گھرانے کے لیے توانائی چارجز، 18% جی ایس ٹی اور ماہانہ فیول ایڈجسٹمنٹ ملا کر یہ عموماً تقریباً Rs 10,000–11,000 بنتا ہے۔ اپنی کمپنی اور ٹیرف کے مطابق درست رقم کے لیے کیلکولیٹر میں 300 یونٹ درج کریں۔" },
    ], disclaimerLabel: "ڈسکلیمر", disclaimerText: "BijliHisaab ایک آزاد تخمینہ کار ہے، نیپرا یا کسی کمپنی سے وابستہ نہیں۔ ادائیگی سے پہلے ہمیشہ اپنے سرکاری بل سے تصدیق کریں۔" },
    fb: { title: "بتائیں کیا بہتر کریں", subtitle: "BijliHisaab مفت اور مسلسل بہتر ہو رہا ہے۔ آپ کی رائے طے کرتی ہے کہ آگے کیا بنائیں۔", ratingLabel: "کتنا مفید رہا؟ (اختیاری)", nameLabel: "نام (اختیاری)", namePh: "آپ کا نام", msgLabel: "آپ کی رائے", msgPh: "کیا اچھا لگا، کیا اُلجھن ہوئی، کیا کمی ہے…", send: "رائے بھیجیں", note: "یہ آپ کی ای میل ایپ کھولتا ہے جہاں پیغام تیار ہوگا۔ اِس سائٹ پر کچھ محفوظ نہیں ہوتا۔" },
    footer: { reviewed: "ٹیرف جولائی 2026 میں نظرثانی شدہ · صرف تخمینہ", privacy: "پرائیویسی پالیسی", disclaimer: "BijliHisaab عوامی طور پر دستیاب نیپرا ٹیرف معلومات پر مبنی تخمینے فراہم کرتا ہے اور نیپرا یا کسی تقسیم کار کمپنی سے وابستہ نہیں۔ اصل بل فیول ایڈجسٹمنٹ، سرچارجز، ٹیکس اور ٹیرف تبدیلیوں کے باعث مختلف ہو سکتے ہیں۔ کوئی ذاتی ڈیٹا جمع یا محفوظ نہیں کیا جاتا۔" },
    privacy: { title: "پرائیویسی پالیسی", updated: "آخری اپ ڈیٹ: جولائی 2026", contact: "پرائیویسی سے متعلق سوال؟ ای میل کریں {email}۔", sections: [
      { h: "کوئی اکاؤنٹ نہیں، کوئی ٹریکنگ نہیں", p: "BijliHisaab کے لیے سائن اَپ کی ضرورت نہیں اور یہ کوئی اشتہاری یا اینالٹکس کوکی سیٹ نہیں کرتا۔ آپ اپنی شناخت بتائے بغیر ہر فیچر استعمال کر سکتے ہیں۔" },
      { h: "آپ کا ڈیٹا آپ کے براؤزر میں رہتا ہے", p: "ہر حساب — بل، آلات اور موازنہ — مکمل طور پر آپ کے آلے پر ہوتا ہے۔ درج کی گئی اقدار کسی سرور کو نہیں بھیجی جاتیں اور نہ ہم محفوظ کرتے ہیں؛ ٹیب بند کرتے ہی یہ ختم ہو جاتی ہیں۔" },
      { h: "کوئی بل جمع نہیں کیا جاتا", p: "BijliHisaab میٹر ریڈنگ، ریفرنس نمبر یا آپ کے بل کی نقل جمع نہیں کرتا۔ جو کچھ آپ لکھتے ہیں وہ صرف اسکرین پر تخمینہ دکھانے کے لیے استعمال ہوتا ہے۔" },
      { h: "رائے جو آپ خود بھیجتے ہیں", p: "رائے والا ٹیب آپ کی اپنی ای میل ایپ کھولتا ہے جہاں پیغام آپ لکھتے ہیں۔ بھیجنا نہ بھیجنا آپ کا فیصلہ ہے؛ یہ ای میل کے ذریعے ہم تک پہنچتا ہے اور سائٹ پر کچھ محفوظ نہیں ہوتا۔" },
      { h: "ویب فونٹس", p: "اردو متن کے لیے انٹرفیس گوگل فونٹس سے فونٹ لوڈ کر سکتا ہے، جسے آپ کا براؤزر براہِ راست حاصل کرتا ہے۔ وہ ڈیٹا ہمیں نہیں ملتا۔" },
      { h: "پالیسی میں تبدیلی", p: "اگر یہ پالیسی بدلی تو اوپر کی تاریخ اپ ڈیٹ کر دی جائے گی۔" },
    ] },
  },
};

const L = createContext({ lang: "en", dir: "ltr", t: T.en });
const useL = () => useContext(L);
const endAlign = (dir) => (dir === "rtl" ? "left" : "right");

const SEO_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      "@id": "https://bijlihisab.online/#app",
      url: "https://bijlihisab.online/",
      name: "BijliHisaab",
      alternateName: "بجلی حساب",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web browser",
      inLanguage: ["en", "ur"],
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "PKR" },
      description: "Free online electricity bill calculator and estimator for Pakistan. Check and estimate your LESCO, FESCO, MEPCO, IESCO, GEPCO, PESCO, HESCO, SEPCO, QESCO and K-Electric bill, understand every charge, and find ways to save.",
      keywords: "check electricity bill, electricity bill check, electricity bill online, online electricity bill, online bill check, electricity bill check online, duplicate electricity bill, lahore electricity bill, 300 unit electricity bill in pakistan, fesco electricity bill, fesco bill, lesco bill, iesco bill",
    },
    {
      "@type": "FAQPage",
      mainEntity: T.en.faq.items.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
};

function savingsForBill(bill, category, fpa, surcharge, load, itRate, filer, t) {
  const tips = [];
  const u = bill.units;
  const pu = bill.perUnit || 0;
  const nonProt = bill.effectiveCategory === "nonprotected";

  // 1. Slab cliff — the single biggest lever on a non-protected bill.
  //    The whole bill is charged at the top band's rate, so dropping below the
  //    band boundary re-rates every unit lower. Compute the real saving.
  if (nonProt && u > 100) {
    const floors = [700, 600, 500, 400, 300, 200, 100];
    const floor = floors.find((f) => u > f);
    const gap = floor ? u - floor : 0;
    if (floor && gap > 0 && gap <= 70) {
      const target = calculateBill(floor, floor <= 200 ? "protected" : "nonprotected", fpa, surcharge, load, itRate, filer);
      const save = bill.total - target.total;
      if (save > 0) tips.push({
        tag: t.tips.slabTag, tone: "cost",
        title: t.tips.slabTitle.replace("{gap}", gap),
        body: t.tips.slabBody.replace("{floor}", floor).replace("{x}", fmt(save)),
      });
    }
  }

  // 2. Cooling — the dominant load once usage is high.
  if (u >= 300) tips.push({ tag: t.tips.acTag, tone: "neutral", title: t.tips.acTitle, body: t.tips.acBody.replace("{x}", fmt(180 * pu)) });

  // 3. Standby / always-on loads.
  if (u >= 200) tips.push({ tag: t.tips.standbyTag, tone: "neutral", title: t.tips.standbyTitle, body: t.tips.standbyBody.replace("{x}", fmt(30 * pu)) });

  // 4. Lighting — small but universal.
  if (u > 0) {
    const led = (5 * 40 * 6 * 30) / 1000 * pu;
    tips.push({ tag: t.tips.lightTag, tone: "neutral", title: t.tips.lightTitle, body: t.tips.lightBody.replace("{x}", fmt(led)) });
  }

  // 5. Peak hours.
  tips.push({ tag: t.tips.peakTag, tone: "neutral", title: t.tips.peakTitle, body: t.tips.peakBody });

  return tips;
}

/* --------------------------- design tokens --------------------------- */

const CSS = `
.ww-root{--ink:#141414;--paper:#ffffff;--canvas:#f5f4f1;--g1:#5f5f5c;--g2:#9a988f;--rule:#e3e1da;--accent:#e1251b;
 font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:var(--ink);background:var(--canvas);
 -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}
.ww-root[dir="rtl"]{font-family:"Noto Naskh Arabic","Noto Nastaliq Urdu","Jameel Noori Nastaleeq",Tahoma,"Segoe UI",sans-serif;}
.ww-root[dir="rtl"] .ww-eyebrow,.ww-root[dir="rtl"] .ww-label{letter-spacing:0;text-transform:none;font-weight:700;}
.ww-root[dir="rtl"] h1{letter-spacing:0 !important;line-height:1.45 !important;}
.ww-root *{box-sizing:border-box;}
/* Layout utilities — these are relied on throughout the markup and MUST ship in
   this stylesheet (the standalone build has no Tailwind). */
.ww-root .flex{display:flex;}
.ww-root .flex-col{flex-direction:column;}
.ww-root .flex-1{flex:1 1 0%;min-width:0;}
.ww-root .flex-wrap{flex-wrap:wrap;}
.ww-root .items-center{align-items:center;}
.ww-root .items-start{align-items:flex-start;}
.ww-root .items-end{align-items:flex-end;}
.ww-root .justify-between{justify-content:space-between;}
.ww-root .justify-center{justify-content:center;}
.ww-root .justify-end{justify-content:flex-end;}
.ww-wrap{max-width:1180px;margin:0 auto;padding:0 28px;}
@media(max-width:600px){.ww-wrap{padding:0 20px;}}
.ww-eyebrow{text-transform:uppercase;font-size:11px;letter-spacing:.18em;font-weight:600;color:var(--g2);}
.ww-label{text-transform:uppercase;font-size:11px;letter-spacing:.13em;font-weight:600;color:var(--g1);}
.ww-rule{height:1px;background:var(--rule);width:100%;}
.ww-rule-ink{height:1px;background:var(--ink);width:100%;}
.ww-panel{background:var(--paper);border:1px solid var(--rule);}
.ww-num{font-variant-numeric:tabular-nums;}
.ww-input{width:100%;background:#fff;border:1px solid var(--ink);padding:11px 12px;font-family:inherit;font-size:15px;
 color:var(--ink);border-radius:0;outline:none;appearance:none;}
.ww-input:focus{box-shadow:inset 0 0 0 2px var(--ink);}
.ww-range{width:100%;accent-color:var(--ink);}
.ww-btn{display:inline-flex;align-items:center;gap:8px;background:var(--ink);color:#fff;border:1px solid var(--ink);
 padding:12px 18px;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
 cursor:pointer;border-radius:0;transition:background .15s,border-color .15s;}
.ww-btn:hover{background:var(--accent);border-color:var(--accent);}
.ww-root[dir="rtl"] .ww-btn,.ww-root[dir="rtl"] .ww-btn-ghost{letter-spacing:0;text-transform:none;font-size:13px;}
.ww-btn-ghost{display:inline-flex;align-items:center;gap:8px;background:transparent;color:var(--ink);border:1px solid var(--ink);
 padding:12px 18px;font-family:inherit;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
 cursor:pointer;border-radius:0;transition:background .15s,color .15s;}
.ww-btn-ghost:hover{background:var(--ink);color:#fff;}
.ww-navlink{background:none;border:none;font-family:inherit;font-size:14px;font-weight:500;color:var(--g1);cursor:pointer;
 padding:4px 0;white-space:nowrap;border-bottom:2px solid transparent;}
.ww-navlink:hover{color:var(--ink);}
.ww-navlink.is-active{color:var(--ink);border-bottom-color:var(--accent);font-weight:600;}
.ww-cat{border:1px solid var(--rule);background:#fff;padding:12px;cursor:pointer;transition:border-color .15s,background .15s;width:100%;text-align:inherit;}
.ww-cat:hover{border-color:var(--ink);}
.ww-adv{border:1px solid var(--rule);background:#fff;transition:border-color .15s;}
.ww-adv:hover{border-color:var(--ink);}
.ww-adv[open]{border-color:var(--ink);}
.ww-adv-sum{transition:background .15s;}
.ww-adv-sum:hover{background:var(--canvas);}
.ww-adv-sum::-webkit-details-marker{display:none;}
.ww-adv-chev{display:inline-flex;color:var(--accent);transition:transform .2s ease;flex:0 0 auto;}
.ww-adv[open] .ww-adv-chev{transform:rotate(180deg);}
.ww-cat.is-active{border-color:var(--ink);background:var(--ink);}
.ww-cat.is-active .ww-cat-t{color:#fff;}
.ww-cat.is-active .ww-cat-s{color:#b9b9b9;}
.ww-cat-t{display:block;font-size:14px;font-weight:600;color:var(--ink);}
.ww-cat-s{display:block;font-size:11px;color:var(--g2);margin-top:2px;}
.ww-step{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--ink);background:#fff;color:var(--ink);
 cursor:pointer;font-size:16px;line-height:1;font-family:inherit;}
.ww-step:hover{background:var(--ink);color:#fff;}
.ww-step-fill{background:var(--ink);color:#fff;}
.ww-step-fill:hover{background:var(--accent);border-color:var(--accent);}
.ww-vline{width:1px;height:12px;background:var(--rule);}
.ww-chip{border:1px solid var(--rule);background:#fff;font-family:inherit;font-size:13px;font-weight:600;padding:7px 14px;cursor:pointer;color:var(--ink);}
.ww-chip:hover{border-color:var(--ink);}
.ww-chip.is-active{background:var(--ink);color:#fff;border-color:var(--ink);}
.ww-lang{display:inline-flex;border:1px solid var(--ink);}
.ww-lang button{background:#fff;border:none;font-family:inherit;font-size:12px;font-weight:700;letter-spacing:.03em;padding:6px 11px;cursor:pointer;color:var(--ink);line-height:1;}
.ww-lang button.is-active{background:var(--ink);color:#fff;}
.ww-lang button+button{border-inline-start:1px solid var(--ink);}

/* Hero — single column on small screens, balanced two-column editorial split on desktop */
.ww-hero-title{font-size:clamp(34px,9vw,72px);}
.ww-hero-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:26px;}
.ww-hero-aside{display:flex;flex-direction:column;gap:22px;max-width:560px;}
.ww-hero-meta{display:flex;align-items:center;flex-wrap:wrap;gap:12px;}
@media(min-width:900px){
  .ww-hero-title{font-size:clamp(52px,6.4vw,80px);}
  .ww-hero-grid{grid-template-columns:minmax(0,1.32fr) minmax(0,1fr);gap:clamp(40px,5vw,72px);align-items:end;}
  .ww-hero-aside{padding-bottom:8px;}
}
.ww-root[dir="rtl"] .ww-hero-title{font-size:clamp(30px,7vw,60px);}

/* Result card header: stacks on small screens (total never crowded), splits on larger */
.ww-result-head{display:flex;flex-direction:column;gap:18px;padding:24px;border-bottom:1px solid var(--rule);}
.ww-result-aside{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex:0 0 auto;}
.ww-result-avg{text-align:right;}
.ww-root[dir="rtl"] .ww-result-avg{text-align:left;}
@media(min-width:560px){
  .ww-result-head{flex-direction:row;align-items:flex-start;justify-content:space-between;gap:16px;padding:28px;}
  .ww-result-aside{flex-direction:column;align-items:flex-end;}
  .ww-root[dir="rtl"] .ww-result-aside{align-items:flex-start;}
}

/* Keep the input panel in view beside the longer results column on wide screens */
@media(min-width:960px){.ww-sticky-panel{position:sticky;top:88px;}}
`;

/* ----------------------------- UI atoms ------------------------------ */

const SEG = { energy: "var(--accent)", fpa: "var(--ink)", taxes: "#7d7d7d", fixed: "#cfcdc6" };

function StackBar({ parts }) {
  return (
    <div className="flex" style={{ height: 12, width: "100%", border: "1px solid var(--ink)" }}>
      {parts.map((p, i) => (
        <div key={i} title={`${p.label}: ${fmt(p.value)}`}
          style={{ width: `${p.pct}%`, background: p.color, borderInlineEnd: i < parts.length - 1 ? "1px solid #fff" : "none", transition: "width .6s ease" }} />
      ))}
    </div>
  );
}

function Segment({ label, value, pct, color }) {
  const { dir } = useL();
  return (
    <div className="flex items-center" style={{ gap: 12 }}>
      <span style={{ width: 11, height: 11, background: color, flex: "0 0 auto" }} />
      <span className="flex-1" style={{ fontSize: 14, color: "var(--g1)" }}>{label}</span>
      <span className="ww-num" style={{ fontSize: 13, color: "var(--g2)", width: 40, textAlign: endAlign(dir) }}>{pct}%</span>
      <span className="ww-num" style={{ fontSize: 14, fontWeight: 600, width: 100, textAlign: endAlign(dir) }}>{fmt(value)}</span>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: "block" }}>
      <span className="ww-label" style={{ display: "block", marginBottom: 8 }}>{label}</span>
      {children}
      {hint && <span style={{ display: "block", marginTop: 6, fontSize: 12, color: "var(--g2)" }}>{hint}</span>}
    </label>
  );
}

/* A per-unit rate (FPA / surcharge) that the user can drive EITHER by dragging the
   slider OR by typing the total rupee amount printed on their bill. The total is
   converted to a per-unit rate using the current units, and the live total is shown
   back so the user can confirm it matches the bill. */
function RateField({ label, perUnit, units, max = 10, onChange, t }) {
  const total = Math.round((Number(perUnit) || 0) * (Number(units) || 0));
  const [totalStr, setTotalStr] = useState(String(total));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setTotalStr(String(total)); }, [total, editing]);

  const applyTotal = (v) => {
    setTotalStr(v);
    const num = Number(v);
    if (units > 0 && v.trim() !== "" && !Number.isNaN(num) && num >= 0) onChange(num / units);
  };

  return (
    <div>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span className="ww-label">{label}</span>
        <span className="ww-num ww-label" style={{ color: "var(--ink)" }}>Rs {(Number(perUnit) || 0).toFixed(2)} / {t.calc.unit}</span>
      </div>
      <input className="ww-range" type="range" min="0" max={max} step="0.01" value={perUnit}
        onChange={(e) => onChange(Number(e.target.value))} />
      <div className="flex items-center justify-between" style={{ gap: 10, marginTop: 6 }}>
        <span style={{ fontSize: 12, color: "var(--g2)" }}>{t.calc.fromBill}</span>
        <div className="flex items-center" style={{ gap: 8 }}>
          <span className="ww-num" style={{ fontSize: 12, color: "var(--g2)" }}>Rs</span>
          <input type="number" min="0" inputMode="numeric"
            className="ww-input ww-num" style={{ width: 88, padding: "6px 10px", fontSize: 13 }}
            value={totalStr} placeholder="0"
            onFocus={() => setEditing(true)} onBlur={() => setEditing(false)}
            onChange={(e) => applyTotal(e.target.value)} />
        </div>
      </div>
    </div>
  );
}

function WSelect({ value, onChange, children }) {
  const { dir } = useL();
  return (
    <div style={{ position: "relative" }}>
      <select className="ww-input" value={value} onChange={onChange} style={{ paddingInlineEnd: 36, cursor: "pointer" }}>
        {children}
      </select>
      <span style={{ position: "absolute", top: "50%", [dir === "rtl" ? "left" : "right"]: 12, transform: "translateY(-50%)", pointerEvents: "none", color: "var(--ink)", display: "flex" }}>
        <ChevronDown size={16} />
      </span>
    </div>
  );
}

/* --------------------------- Result panel ---------------------------- */

function ResultCard({ bill, onPrint }) {
  const { t, dir } = useL();
  const { total, energy, fpa, surcharge, fixed, taxesAndDuties } = bill;
  const parts = [
    { label: t.result.energy, value: energy, color: SEG.energy },
    { label: t.result.fpa, value: fpa + surcharge, color: SEG.fpa },
    { label: t.result.taxes, value: taxesAndDuties, color: SEG.taxes },
    { label: t.result.fixed, value: fixed, color: SEG.fixed },
  ].map((p) => ({ ...p, pct: total > 0 ? Math.round((p.value / total) * 100) : 0 }));

  return (
    <div className="ww-panel">
      <div className="ww-result-head">
        <div style={{ minWidth: 0 }}>
          <span className="ww-label">{t.result.total}</span>
          <p className="ww-num" style={{ marginTop: 10, fontWeight: 700, letterSpacing: "-0.035em", lineHeight: .95, color: "var(--accent)", fontSize: "clamp(40px,7vw,60px)", whiteSpace: "nowrap" }}>{fmt(total)}</p>
          <p className="ww-num" style={{ marginTop: 8, fontSize: 12, color: "var(--g2)" }}>{t.result.afterDue}: {fmt(bill.afterDue)}</p>
        </div>
        <div className="ww-result-aside">
          {onPrint && <button className="ww-btn-ghost ww-print-btn" onClick={onPrint} style={{ padding: "8px 12px" }}>{t.save.print}</button>}
          <div className="ww-result-avg">
            <span className="ww-label">{t.result.avg}</span>
            <p className="ww-num" style={{ marginTop: 8, fontSize: 22, fontWeight: 600 }}>Rs {bill.perUnit.toFixed(2)}</p>
          </div>
        </div>
      </div>

      <div style={{ padding: "24px 28px" }}>
        <span className="ww-label">{t.result.why}</span>
        <div style={{ marginTop: 14 }}><StackBar parts={parts} /></div>
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          {parts.map((p, i) => <Segment key={i} {...p} />)}
        </div>

        {taxesAndDuties > 0 && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--rule)" }}>
            <span className="ww-label" style={{ color: "var(--g2)" }}>{t.result.taxDetail}</span>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
              {[
                { label: t.result.gst, value: bill.gst },
                { label: t.result.duty, value: bill.duty },
                { label: t.result.tvFee, value: bill.tv },
                { label: t.result.itLine, value: bill.incomeTax },
              ].filter((r) => r.value > 0).map((r, i) => (
                <div key={i} className="flex items-center justify-between" style={{ gap: 12 }}>
                  <span style={{ fontSize: 13, color: "var(--g1)" }}>{r.label}</span>
                  <span className="ww-num" style={{ fontSize: 13, fontWeight: 600 }}>{fmt(r.value)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {bill.noteKey && (
        <div style={{ margin: "0 28px 20px", borderInlineStart: "2px solid var(--accent)", padding: "10px 16px", background: "#fbf1f0" }}>
          <span className="ww-label" style={{ color: "var(--accent)" }}>{t.result.warn}</span>
          <p style={{ marginTop: 5, fontSize: 13, color: "var(--ink)", lineHeight: 1.5 }}>{t.notes[bill.noteKey]}</p>
        </div>
      )}

      <div style={{ padding: "0 28px 24px" }}>
        <div className="ww-rule" style={{ marginBottom: 16 }} />
        <p style={{ fontSize: 12, lineHeight: 1.6, color: "var(--g2)" }}>{t.result.disclaimer}</p>
      </div>
    </div>
  );
}

function SavingsList({ tips }) {
  return (
    <div className="ww-panel">
      {tips.map((tip, i) => (
        <div key={i} style={{ padding: "16px 20px", borderTop: i ? "1px solid var(--rule)" : "none" }}>
          <span className="ww-label" style={{ color: tip.tone === "cost" ? "var(--accent)" : "var(--g1)" }}>{tip.tag}</span>
          <p style={{ marginTop: 6, fontSize: 15, fontWeight: 600 }}>{tip.title}</p>
          <p style={{ marginTop: 4, fontSize: 14, color: "var(--g1)", lineHeight: 1.5 }}>{tip.body}</p>
        </div>
      ))}
    </div>
  );
}

/* -------------------------- Bill calculator -------------------------- */

const CAT_IDS = ["protected", "nonprotected", "lifeline", "commercial"];

function BillCalculator({ state, set }) {
  const { t, dir } = useL();
  const { disco, category, units, prevUnits, fpa, surcharge, load, itRate, filer } = state;
  const bill = useMemo(() => calculateBill(units, category, fpa, surcharge, load, itRate, filer), [units, category, fpa, surcharge, load, itRate, filer]);
  const prevBill = useMemo(() => (prevUnits ? calculateBill(prevUnits, category, fpa, surcharge, load, itRate, filer) : null), [prevUnits, category, fpa, surcharge, load, itRate, filer]);
  const tips = useMemo(() => savingsForBill(bill, category, fpa, surcharge, load, itRate, filer, t), [bill, category, fpa, surcharge, load, itRate, filer, t]);
  const diff = prevBill ? bill.total - prevBill.total : null;
  const unitDiff = prevBill ? bill.units - prevBill.units : null;

  return (
    <div className="ww-grid-main" style={{ display: "grid", gap: 28, gridTemplateColumns: "minmax(0,1fr)" }}>
      <style>{`@media(min-width:960px){.ww-grid-main{grid-template-columns:minmax(0,1fr) minmax(0,1.12fr) !important;}}`}</style>

      <div className="ww-panel ww-sticky-panel" style={{ padding: 28, alignSelf: "start" }}>
        <span className="ww-eyebrow">{t.calc.s1}</span>
        <h2 style={{ marginTop: 8, fontSize: 22, fontWeight: 700, letterSpacing: dir === "rtl" ? "0" : "-0.02em" }}>{t.calc.title}</h2>
        <p style={{ marginTop: 6, fontSize: 14, color: "var(--g1)" }}>{t.calc.subtitle}</p>

        <div style={{ marginTop: 16, borderInlineStart: "2px solid var(--ink)", padding: "10px 14px", background: "#faf9f6" }}>
          <span className="ww-label">{t.calc.helpTitle}</span>
          <p style={{ marginTop: 5, fontSize: 13, color: "var(--g1)", lineHeight: 1.55 }}>{t.calc.helpBody}</p>
        </div>

        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 22 }}>
          <Field label={t.calc.disco}>
            <WSelect value={disco} onChange={(e) => set({ disco: e.target.value })}>
              {DISCOS.map((d) => <option key={d}>{d}</option>)}
            </WSelect>
          </Field>

          <div>
            <span className="ww-label" style={{ display: "block", marginBottom: 8 }}>{t.calc.ctype}</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr" }}>
              {CAT_IDS.map((id, i) => (
                <button key={id} onClick={() => set({ category: id })}
                  className={`ww-cat${category === id ? " is-active" : ""}`}
                  style={{ marginInlineStart: i % 2 ? -1 : 0, marginTop: i > 1 ? -1 : 0 }}>
                  <span className="ww-cat-t">{t.cat[id].label}</span>
                  <span className="ww-cat-s">{t.cat[id].sub}</span>
                </button>
              ))}
            </div>
          </div>

          <Field label={t.calc.units} hint={t.calc.unitsHint}>
            <input type="number" min="0" className="ww-input" value={units} placeholder="350" onChange={(e) => set({ units: e.target.value })} />
            <span style={{ display: "block", marginTop: 10, marginBottom: 8 }} className="ww-label">{t.calc.common}</span>
            <div className="flex" style={{ gap: 8, flexWrap: "wrap" }}>
              {PRESETS.map((p) => (
                <button key={p} className={`ww-chip${String(p) === String(units) ? " is-active" : ""}`} onClick={() => set({ units: String(p) })}>{p}</button>
              ))}
            </div>
          </Field>

          <Field label={t.calc.prev} hint={t.calc.prevHint}>
            <input type="number" min="0" className="ww-input" value={prevUnits} placeholder="310" onChange={(e) => set({ prevUnits: e.target.value })} />
          </Field>

          <Field label={t.calc.load} hint={t.calc.loadHint}>
            <input type="number" min="0" step="0.5" className="ww-input" value={load} placeholder="1" onChange={(e) => set({ load: e.target.value })} />
          </Field>

          <details className="ww-adv">
            <summary className="ww-adv-sum" style={{ cursor: "pointer", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: 16 }}>
              <span className="flex items-center" style={{ gap: 10 }}>
                <span className="ww-adv-chev"><ChevronDown size={18} /></span>
                <span>
                  <span className="ww-label" style={{ display: "block" }}>{t.calc.advanced}</span>
                  <span style={{ display: "block", fontSize: 11, color: "var(--g2)", marginTop: 3, textTransform: "none", letterSpacing: 0, fontWeight: 500 }}>{t.calc.advancedHint}</span>
                </span>
              </span>
              <span className="ww-num ww-label" style={{ color: "var(--ink)", whiteSpace: "nowrap" }}>Rs {(Number(fpa) + Number(surcharge)).toFixed(2)} / {t.calc.unit}</span>
            </summary>
            <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
              <RateField label={t.calc.fpaLabel} perUnit={fpa} units={Number(units) || 0} max={12} onChange={(v) => set({ fpa: v })} t={t} />
              <RateField label={t.calc.surchargeLabel} perUnit={surcharge} units={Number(units) || 0} max={12} onChange={(v) => set({ surcharge: v })} t={t} />
              <div className="flex items-center justify-between" style={{ gap: 8, marginTop: 0 }}>
                <span className="ww-label">{t.calc.filerLabel}</span>
                <div className="ww-lang" style={{ margin: 0 }}>
                  <button type="button" className={!filer ? "is-active" : ""} onClick={() => set({ filer: false })}>{t.calc.nonFiler}</button>
                  <button type="button" className={filer ? "is-active" : ""} onClick={() => set({ filer: true })}>{t.calc.filerYes}</button>
                </div>
              </div>
              {category === "commercial" ? (
                <p style={{ marginTop: 10, fontSize: 12, color: "var(--g2)", lineHeight: 1.55 }}>{t.calc.commTaxNote}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between" style={{ gap: 8, marginTop: 12, opacity: filer ? 0.4 : 1 }}>
                    <span className="ww-label">{t.calc.itLabel}</span>
                    <span className="ww-num ww-label" style={{ color: "var(--ink)" }}>{filer ? "0.0" : Number(itRate).toFixed(1)}%</span>
                  </div>
                  <input className="ww-range" type="range" min="0" max="15" step="0.25" value={itRate} disabled={filer} onChange={(e) => set({ itRate: Number(e.target.value) })} style={{ opacity: filer ? 0.4 : 1 }} />
                  <p style={{ marginTop: 8, fontSize: 12, color: "var(--g2)", lineHeight: 1.55 }}>{t.calc.filerNote}</p>
                </>
              )}
              <p style={{ marginTop: 10, fontSize: 12, color: "var(--g2)", lineHeight: 1.55 }}>{t.calc.fpaNote}</p>
            </div>
          </details>
        </div>
      </div>

      <div className="flex flex-col" style={{ gap: 28 }}>
        <ResultCard bill={bill} onPrint={() => window.print()} />

        {prevBill && (
          <div className="ww-panel" style={{ padding: 24 }}>
            <span className="ww-label">{t.cmp.vsLast}</span>
            <div className="flex" style={{ marginTop: 14, gap: 40, flexWrap: "wrap" }}>
              <div>
                <span style={{ fontSize: 12, color: "var(--g2)" }}>{t.cmp.units}</span>
                <p className="ww-num" style={{ fontSize: 20, fontWeight: 700, color: unitDiff > 0 ? "var(--accent)" : "var(--ink)" }}>{unitDiff > 0 ? "+" : ""}{unitDiff}</p>
              </div>
              <div>
                <span style={{ fontSize: 12, color: "var(--g2)" }}>{t.cmp.bill}</span>
                <p className="ww-num" style={{ fontSize: 20, fontWeight: 700, color: diff > 0 ? "var(--accent)" : "var(--ink)" }}>{diff > 0 ? "+" : "−"}{fmt(Math.abs(diff))}</p>
              </div>
              <div>
                <span style={{ fontSize: 12, color: "var(--g2)" }}>{t.cmp.change}</span>
                <p className="ww-num" style={{ fontSize: 20, fontWeight: 700 }}>{prevBill.total > 0 ? ((diff / prevBill.total) * 100).toFixed(1) : 0}%</p>
              </div>
            </div>
          </div>
        )}

        <div>
          <span className="ww-eyebrow">{t.save.s2}</span>
          {bill.effectiveCategory === "nonprotected" && bill.units >= 300 && (
            <div style={{ marginTop: 12, borderInlineStart: "2px solid var(--accent)", padding: "12px 16px", background: "#fbf1f0" }}>
              <span className="ww-label" style={{ color: "var(--accent)" }}>{t.save.highTitle}</span>
              <p style={{ marginTop: 5, fontSize: 13, color: "var(--ink)", lineHeight: 1.5 }}>{t.save.highBody}</p>
            </div>
          )}
          <div style={{ marginTop: 12 }}><SavingsList tips={tips} /></div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------- Appliance calculator ------------------------ */

function ApplianceCalculator({ perUnitHint, onApply }) {
  const { t, lang, dir } = useL();
  const [rows, setRows] = useState(APPLIANCES.map((a) => ({ ...a, qty: 0, days: 7 })));
  const [newName, setNewName] = useState("");
  const [newWatts, setNewWatts] = useState("");
  const rate = perUnitHint || 28;

  const computed = rows.map((r) => {
    const daysPerMonth = (Number(r.days) || 0) / 7 * 30;
    const monthlyUnits = (Number(r.watts) * r.qty * Number(r.hours) * daysPerMonth) / 1000;
    return { ...r, monthlyUnits, cost: monthlyUnits * rate };
  }).filter((r) => r.qty > 0 && r.monthlyUnits > 0);
  const totalUnits = computed.reduce((s, r) => s + r.monthlyUnits, 0);
  const totalCost = computed.reduce((s, r) => s + r.cost, 0);
  const ranked = [...computed].sort((a, b) => b.monthlyUnits - a.monthlyUnits);
  const maxUnits = ranked[0]?.monthlyUnits || 1;

  const upd = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id) => setRows((rs) => rs.filter((r) => r.id !== id));
  const addDevice = () => {
    const w = Number(newWatts);
    if (!newName.trim() || !w || w <= 0) return;
    setRows((rs) => [...rs, {
      id: "custom-" + Date.now(), watts: w, hours: 2, days: 7, qty: 1, custom: true,
      name: { en: newName.trim(), ur: newName.trim() }, tip: null,
    }]);
    setNewName(""); setNewWatts("");
  };

  const smallInput = { width: 74, padding: "5px 8px", fontSize: 13 };

  return (
    <div className="ww-grid-app" style={{ display: "grid", gap: 28, gridTemplateColumns: "minmax(0,1fr)" }}>
      <style>{`@media(min-width:960px){.ww-grid-app{grid-template-columns:minmax(0,1.05fr) minmax(0,1fr) !important;}}`}</style>

      <div className="ww-panel" style={{ padding: 28 }}>
        <span className="ww-eyebrow">{t.app.s1}</span>
        <h2 style={{ marginTop: 8, fontSize: 22, fontWeight: 700, letterSpacing: dir === "rtl" ? "0" : "-0.02em" }}>{t.app.title}</h2>
        <p style={{ marginTop: 6, fontSize: 14, color: "var(--g1)" }}>{t.app.subtitle}</p>

        {/* Add custom device — at the top */}
        <div style={{ marginTop: 20, border: "1px solid var(--ink)", padding: 16 }}>
          <span className="ww-label">{t.app.addTitle}</span>
          <div className="flex" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
            <input className="ww-input" placeholder={t.app.namePh} value={newName}
              onChange={(e) => setNewName(e.target.value)} style={{ flex: "1 1 140px", minWidth: 0 }}
              onKeyDown={(e) => { if (e.key === "Enter") addDevice(); }} />
            <input className="ww-input ww-num" type="number" min="0" placeholder={t.app.wattsPh} value={newWatts}
              onChange={(e) => setNewWatts(e.target.value)} style={{ width: 96, flex: "0 0 auto" }}
              onKeyDown={(e) => { if (e.key === "Enter") addDevice(); }} />
            <button className="ww-btn" onClick={addDevice} style={{ flex: "0 0 auto" }}>{t.app.addBtn}</button>
          </div>
        </div>

        <div style={{ marginTop: 22, borderTop: "1px solid var(--rule)" }}>
          {rows.map((r) => (
            <div key={r.id} style={{ borderBottom: "1px solid var(--rule)", padding: "14px 0" }}>
              <div className="flex items-center justify-between" style={{ gap: 12 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="flex items-center" style={{ gap: 8 }}>
                    <p style={{ fontSize: 14, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name[lang]}</p>
                    {r.custom && (
                      <button onClick={() => remove(r.id)} title={t.app.remove}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--g2)", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
                    )}
                  </div>
                  <div className="flex items-center" style={{ gap: 6, marginTop: 6 }}>
                    <input type="number" min="0" className="ww-input ww-num" style={smallInput}
                      value={r.watts} onChange={(e) => upd(r.id, { watts: e.target.value })} />
                    <span className="ww-label">{t.app.watt}</span>
                  </div>
                </div>
                <div className="flex items-center" style={{ gap: 8, flex: "0 0 auto" }}>
                  <button className="ww-step" onClick={() => upd(r.id, { qty: Math.max(0, r.qty - 1) })}>−</button>
                  <span className="ww-num" style={{ width: 22, textAlign: "center", fontSize: 14, fontWeight: 700 }}>{r.qty}</span>
                  <button className="ww-step ww-step-fill" onClick={() => upd(r.id, { qty: r.qty + 1 })}>+</button>
                </div>
              </div>

              {r.qty > 0 && (
                <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="flex items-center" style={{ gap: 12 }}>
                    <span className="ww-label" style={{ width: 78, flex: "0 0 auto" }}>{t.app.hrs}</span>
                    <input className="ww-range" type="range" min="0" max="24" step="0.5" value={r.hours}
                      onChange={(e) => upd(r.id, { hours: Number(e.target.value) })} style={{ flex: 1 }} />
                    <span className="ww-num" style={{ width: 40, textAlign: endAlign(dir), fontSize: 13, fontWeight: 600, flex: "0 0 auto" }}>{r.hours}h</span>
                  </div>
                  <div className="flex items-center" style={{ gap: 12 }}>
                    <span className="ww-label" style={{ width: 78, flex: "0 0 auto" }}>{t.app.days}</span>
                    <div className="flex items-center" style={{ gap: 8 }}>
                      <button className="ww-step" onClick={() => upd(r.id, { days: Math.max(1, r.days - 1) })}>−</button>
                      <span className="ww-num" style={{ width: 22, textAlign: "center", fontSize: 14, fontWeight: 700 }}>{r.days}</span>
                      <button className="ww-step ww-step-fill" onClick={() => upd(r.id, { days: Math.min(7, r.days + 1) })}>+</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div className="ww-panel" style={{ padding: 28 }}>
          <div className="flex items-end justify-between" style={{ gap: 16 }}>
            <div>
              <span className="ww-label">{t.app.monthly}</span>
              <p className="ww-num" style={{ marginTop: 10, fontSize: 52, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: .95 }}>
                {Math.round(totalUnits)}<span style={{ fontSize: 18, fontWeight: 500, color: "var(--g2)", marginInlineStart: 8 }}>{t.app.units}</span>
              </p>
            </div>
            <div style={{ textAlign: endAlign(dir) }}>
              <span className="ww-label">{t.app.cost}</span>
              <p className="ww-num" style={{ marginTop: 10, fontSize: 22, fontWeight: 600, color: "var(--accent)" }}>{fmt(totalCost)}</p>
            </div>
          </div>

          {ranked.length > 0 ? (
            <>
              <div className="ww-rule" style={{ margin: "22px 0 18px" }} />
              <span className="ww-label">{t.app.biggest}</span>
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
                {ranked.map((r, idx) => (
                  <div key={r.id}>
                    <div className="flex justify-between" style={{ fontSize: 12, gap: 12 }}>
                      <span style={{ color: "var(--g1)" }}>{r.name[lang]}{r.qty > 1 ? ` ×${r.qty}` : ""}</span>
                      <span className="ww-num" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{Math.round(r.monthlyUnits)}{t.app.uShort} · {fmt(r.cost)}</span>
                    </div>
                    <div style={{ marginTop: 5, height: 8, width: "100%", background: "#efeee9" }}>
                      <div style={{ height: "100%", width: `${(r.monthlyUnits / maxUnits) * 100}%`, background: idx === 0 ? "var(--accent)" : "var(--ink)", transition: "width .5s ease" }} />
                    </div>
                  </div>
                ))}
              </div>
              <button className="ww-btn" style={{ marginTop: 24 }} onClick={() => onApply(Math.round(totalUnits))}>
                {t.app.use.replace("{n}", Math.round(totalUnits))}
              </button>
            </>
          ) : (
            <p style={{ marginTop: 22, padding: 20, border: "1px solid var(--rule)", textAlign: "center", fontSize: 14, color: "var(--g2)" }}>{t.app.empty}</p>
          )}
        </div>

        {ranked[0] && ranked[0].tip && (
          <div style={{ borderInlineStart: "2px solid var(--accent)", padding: "12px 16px", background: "#fff" }}>
            <span className="ww-label" style={{ color: "var(--accent)" }}>{t.app.draw}</span>
            <p style={{ marginTop: 5, fontSize: 14, color: "var(--ink)", lineHeight: 1.5 }}>
              <strong>{ranked[0].name[lang]}</strong> — {ranked[0].tip[lang]}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Compare ------------------------------ */

function CompareEditor({ s, setS, accent }) {
  const { t } = useL();
  return (
    <div className="ww-panel" style={{ padding: 24 }}>
      <input value={s.label} onChange={(e) => setS({ ...s, label: e.target.value })}
        className="ww-label" style={{ border: "none", background: "none", outline: "none", width: "100%", color: "var(--g1)" }} />
      <p className="ww-num" style={{ marginTop: 8, fontSize: 36, fontWeight: 700, letterSpacing: "-0.03em", color: accent }}>{fmt(s.bill.total)}</p>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        <Field label={t.compare.units}>
          <input type="number" min="0" className="ww-input" value={s.units} onChange={(e) => setS({ ...s, units: e.target.value })} />
        </Field>
        <Field label={t.compare.ctype}>
          <WSelect value={s.cat} onChange={(e) => setS({ ...s, cat: e.target.value })}>
            {CAT_IDS.map((id) => <option key={id} value={id}>{t.cat[id].label}</option>)}
          </WSelect>
        </Field>
      </div>
    </div>
  );
}

function Compare({ fpa, surcharge, load, itRate, filer }) {
  const { t } = useL();
  const [a, setA] = useState({ label: t.compare.thisMonth, units: 380, cat: "nonprotected" });
  const [b, setB] = useState({ label: t.compare.cutBack, units: 199, cat: "protected" });
  const s1 = { ...a, bill: calculateBill(a.units, a.cat, fpa, surcharge, load, itRate, filer) };
  const s2 = { ...b, bill: calculateBill(b.units, b.cat, fpa, surcharge, load, itRate, filer) };
  const save = s1.bill.total - s2.bill.total;
  const pct = s1.bill.total > 0 ? Math.abs((save / s1.bill.total) * 100).toFixed(0) : 0;
  const sentence = t.compare.sentence
    .replace("{b}", b.label).replace("{a}", a.label).replace("{pct}", pct)
    .replace("{word}", save >= 0 ? t.compare.cheaper : t.compare.pricier);

  return (
    <div>
      <div style={{ display: "grid", gap: 28, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
        <CompareEditor s={s1} setS={setA} accent="var(--ink)" />
        <CompareEditor s={s2} setS={setB} accent="var(--accent)" />
      </div>
      <div style={{ marginTop: 28, background: "var(--ink)", color: "#fff", padding: 32 }}>
        <span className="ww-label" style={{ color: "#b9b9b9" }}>{t.compare.diff}</span>
        <p className="ww-num" style={{ marginTop: 10, fontSize: "clamp(40px,6vw,56px)", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: "var(--accent)" }}>
          {save >= 0 ? t.compare.save : t.compare.extra} {fmt(Math.abs(save))}
        </p>
        <p style={{ marginTop: 12, fontSize: 14, color: "#cfcfcf", lineHeight: 1.6 }}>{sentence}</p>
      </div>
    </div>
  );
}

/* ------------------------------ FAQ ---------------------------------- */

function FaqView() {
  const { t } = useL();
  const [open, setOpen] = useState(0);
  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div className="ww-panel">
        {t.faq.items.map((f, i) => (
          <div key={i} style={{ borderTop: i ? "1px solid var(--rule)" : "none" }}>
            <button onClick={() => setOpen(open === i ? -1 : i)}
              style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", gap: 16, padding: "18px 22px", background: "none", border: "none", cursor: "pointer", textAlign: "inherit", fontFamily: "inherit" }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)" }}>{f.q}</span>
              <span style={{ fontSize: 20, color: "var(--accent)", transform: open === i ? "rotate(45deg)" : "none", transition: "transform .15s", lineHeight: 1 }}>+</span>
            </button>
            {open === i && <p style={{ padding: "0 22px 20px", fontSize: 14, lineHeight: 1.7, color: "var(--g1)" }}>{f.a}</p>}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, borderInlineStart: "2px solid var(--ink)", padding: "14px 18px" }}>
        <span className="ww-label">{t.faq.disclaimerLabel}</span>
        <p style={{ marginTop: 5, fontSize: 14, color: "var(--g1)", lineHeight: 1.7 }}>{t.faq.disclaimerText}</p>
      </div>
    </div>
  );
}

/* ---------------------------- Feedback ------------------------------- */

function FeedbackView() {
  const { t, dir } = useL();
  const [rating, setRating] = useState(0);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const send = () => {
    if (!msg.trim()) return;
    const subject = encodeURIComponent("BijliHisaab feedback" + (rating ? ` (${rating}/5)` : ""));
    const body = encodeURIComponent((name ? `Name: ${name}\n` : "") + (rating ? `Rating: ${rating}/5\n` : "") + `\n${msg}`);
    window.location.href = `mailto:${FEEDBACK_EMAIL}?subject=${subject}&body=${body}`;
  };
  const canSend = msg.trim().length > 0;
  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div className="ww-panel" style={{ padding: 28 }}>
        <span className="ww-eyebrow">{t.nav.feedback}</span>
        <h2 style={{ marginTop: 8, fontSize: 22, fontWeight: 700, letterSpacing: dir === "rtl" ? "0" : "-0.02em" }}>{t.fb.title}</h2>
        <p style={{ marginTop: 6, fontSize: 14, color: "var(--g1)", lineHeight: 1.6 }}>{t.fb.subtitle}</p>

        <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 18 }}>
          <div>
            <span className="ww-label" style={{ display: "block", marginBottom: 10 }}>{t.fb.ratingLabel}</span>
            <div className="flex" style={{ gap: 8 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className={`ww-chip${rating === n ? " is-active" : ""}`} onClick={() => setRating(n)} style={{ minWidth: 42, textAlign: "center" }}>{n}</button>
              ))}
            </div>
          </div>
          <Field label={t.fb.nameLabel}>
            <input className="ww-input" value={name} placeholder={t.fb.namePh} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t.fb.msgLabel}>
            <textarea className="ww-input" value={msg} placeholder={t.fb.msgPh} onChange={(e) => setMsg(e.target.value)}
              rows={5} style={{ resize: "vertical", minHeight: 120, lineHeight: 1.5 }} />
          </Field>
          <div>
            <button className="ww-btn" onClick={send} style={{ opacity: canSend ? 1 : 0.4, pointerEvents: canSend ? "auto" : "none" }}>{t.fb.send}</button>
            <p style={{ marginTop: 12, fontSize: 12, color: "var(--g2)", lineHeight: 1.6 }}>{t.fb.note}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Privacy -------------------------------- */

function PrivacyView() {
  const { t, dir } = useL();
  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <span className="ww-eyebrow">{t.privacy.updated}</span>
      <h1 style={{ marginTop: 12, fontSize: "clamp(30px,5vw,44px)", fontWeight: 700, letterSpacing: dir === "rtl" ? "0" : "-0.03em", lineHeight: 1 }}>{t.privacy.title}</h1>
      <div className="ww-panel" style={{ marginTop: 24 }}>
        {t.privacy.sections.map((s, i) => (
          <div key={i} style={{ padding: "20px 24px", borderTop: i ? "1px solid var(--rule)" : "none" }}>
            <h2 style={{ fontSize: 15, fontWeight: 700 }}>{s.h}</h2>
            <p style={{ marginTop: 6, fontSize: 14, color: "var(--g1)", lineHeight: 1.7 }}>{s.p}</p>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 24, borderInlineStart: "2px solid var(--ink)", padding: "14px 18px" }}>
        <p style={{ fontSize: 14, color: "var(--g1)", lineHeight: 1.6 }}>{t.privacy.contact.replace("{email}", FEEDBACK_EMAIL)}</p>
      </div>
    </div>
  );
}

/* ------------------------------ Shell -------------------------------- */

export default function BijliHisaab() {
  const [lang, setLang] = useState("en");
  const [view, setView] = useState("calculator");
  const [state, setState] = useState({ disco: "LESCO", category: "nonprotected", units: "350", prevUnits: "", fpa: DEFAULT_FPA, surcharge: DEFAULT_SURCHARGE, load: DEFAULT_LOAD, itRate: DEFAULT_IT_RATE, filer: DEFAULT_FILER });
  const set = (patch) => setState((s) => ({ ...s, ...patch }));
  const t = T[lang], dir = t.dir;
  const liveBill = calculateBill(state.units, state.category, state.fpa, state.surcharge, state.load, state.itRate, state.filer);
  const NAV = ["calculator", "compare", "faq", "feedback"];

  return (
    <L.Provider value={{ lang, dir, t }}>
      <div className="ww-root" dir={dir} style={{ minHeight: "100vh" }}>
        <style>{CSS}</style>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;500;600;700&display=swap" />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(SEO_LD) }} />

        {/* Masthead */}
        <header style={{ position: "sticky", top: 0, zIndex: 20, background: "#fff", borderBottom: "1px solid var(--ink)" }}>
          <div className="ww-wrap flex items-center justify-between" style={{ height: 64, gap: 16 }}>
            <button onClick={() => setView("calculator")} style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
              <span style={{ width: 26, height: 26, background: "var(--accent)", display: "inline-grid", placeItems: "center" }}>
                <Zap size={15} color="#fff" fill="#fff" />
              </span>
              <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--ink)" }}>BijliHisaab</span>
            </button>
            <div className="flex items-center" style={{ gap: 20 }}>
              <nav className="ww-nav-desk" style={{ display: "none", gap: 22 }}>
                {NAV.map((id) => <button key={id} className={`ww-navlink${view === id ? " is-active" : ""}`} onClick={() => setView(id)}>{t.nav[id]}</button>)}
              </nav>
              <div className="ww-lang">
                <button className={lang === "en" ? "is-active" : ""} onClick={() => setLang("en")}>EN</button>
                <button className={lang === "ur" ? "is-active" : ""} onClick={() => setLang("ur")} style={{ fontFamily: "'Noto Naskh Arabic',Tahoma,sans-serif" }}>اردو</button>
              </div>
            </div>
            <style>{`@media(min-width:760px){.ww-nav-desk{display:flex !important;}}`}</style>
          </div>
        </header>

        {/* Title block */}
        <section className="ww-wrap ww-hero" style={{ paddingTop: 52, paddingBottom: 40 }}>
          <div className="ww-hero-grid">
            <div className="ww-hero-lead">
              <span className="ww-eyebrow">{t.hero.eyebrow}</span>
              <h1 className="ww-hero-title" style={{ marginTop: 16, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: .96 }}>{t.hero.title}</h1>
            </div>
            <div className="ww-hero-aside">
              <p style={{ fontSize: 16, lineHeight: 1.65, color: "var(--g1)" }}>{t.hero.standfirst}</p>
              <div className="ww-hero-meta">
                {t.meta.map((m, i) => (
                  <div key={i} className="flex items-center" style={{ gap: 12 }}>
                    {i > 0 && <span className="ww-vline" />}
                    <span className="ww-eyebrow">{m}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="ww-wrap"><div className="ww-rule-ink" /></div>

        {/* Mobile nav */}
        <div style={{ position: "sticky", top: 64, zIndex: 10, background: "var(--canvas)", borderBottom: "1px solid var(--rule)" }} className="ww-nav-mob">
          <div className="ww-wrap flex" style={{ gap: 22, overflowX: "auto", padding: "12px 28px" }}>
            {NAV.map((id) => <button key={id} className={`ww-navlink${view === id ? " is-active" : ""}`} onClick={() => setView(id)}>{t.nav[id]}</button>)}
          </div>
        </div>
        <style>{`@media(min-width:760px){.ww-nav-mob{display:none !important;}}`}</style>

        {/* Main */}
        <main className="ww-wrap" style={{ paddingTop: 40, paddingBottom: 56 }}>
          {view === "calculator" && <BillCalculator state={state} set={set} />}
          {view === "compare" && <Compare fpa={state.fpa} surcharge={state.surcharge} load={state.load} itRate={state.itRate} filer={state.filer} />}
          {view === "faq" && <FaqView />}
          {view === "feedback" && <FeedbackView />}
          {view === "privacy" && <PrivacyView />}
        </main>

        {/* Footer */}
        <footer style={{ borderTop: "1px solid var(--ink)", background: "#fff" }}>
          <div className="ww-wrap" style={{ paddingTop: 28, paddingBottom: 28 }}>
            <div className="flex items-center justify-between" style={{ gap: 16, flexWrap: "wrap" }}>
              <div className="flex items-center" style={{ gap: 10 }}>
                <span style={{ width: 20, height: 20, background: "var(--accent)", display: "inline-grid", placeItems: "center" }}>
                  <Zap size={12} color="#fff" fill="#fff" />
                </span>
                <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.01em" }}>BijliHisaab</span>
              </div>
              <div className="flex items-center" style={{ gap: 18, flexWrap: "wrap" }}>
                <button className="ww-navlink" onClick={() => { setView("privacy"); if (typeof window !== "undefined") window.scrollTo(0, 0); }}>{t.footer.privacy}</button>
                <span className="ww-eyebrow">{t.footer.reviewed}</span>
              </div>
            </div>
            <p style={{ marginTop: 18, fontSize: 12, lineHeight: 1.7, color: "var(--g2)", maxWidth: 720 }}>{t.footer.disclaimer}</p>
          </div>
        </footer>
      </div>
    </L.Provider>
  );
}
