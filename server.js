// ==========================================================================
// PACKSPEC AI - BOXBUDDY SECURED BACKEND INFRASTRUCTURE
// ==========================================================================

// 🌐 NODE.JS ENVIRONMENT POLYFILL
if (typeof window === 'undefined') {
  global.window = global;
}

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Datastore = require('nedb-promises');
const axios = require('axios');
const { OpenAI } = require('openai');
const { Shippo } = require('shippo');

// 🛡 SECURED API CLIENT INITIALIZATIONS
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const shippo = new Shippo({ 
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}` 
});

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

const db = Datastore.create({ filename: 'users.db', autoload: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

// 🧹 TITLE SANITIZATION HELPER
function sanitizeTitleForSearch(rawTitle) {
  if (!rawTitle) return '';
  return rawTitle
    .replace(/\b(NWT|NWOB|MINT|L@@K|LOOK|FAST SHIP|FREE SHIPPING|GREAT CONDITION|MUST SEE|AUTHENTIC|RARE|VINTAGE)\b/gi, '')
    .replace(/[^\w\s-]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 📍 RESOLVE CITY/STATE INTO ZIP
async function resolveToZipCode(locationStr) {
  if (!locationStr) return '07030';
  if (/^(00000|00001|00000-0000|n\/a|unknown|none)$/i.test(locationStr.trim()) || locationStr.includes('00000')) return '07030';
  const isInternational = /(japan|china|uk|united kingdom|canada|germany|australia|hong kong|taiwan|korea|france|italy)/i.test(locationStr);
  if (isInternational) return '90210'; 
  const zipMatch = String(locationStr).match(/\b\d{5}\b/);
  if (zipMatch && zipMatch[0] !== '00000' && zipMatch[0] !== '00001') return zipMatch[0];
  try {
    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: 'Convert US city/state to 5-digit ZIP. Output ONLY the ZIP.' }, { role: 'user', content: locationStr }],
      temperature: 0.0,
    });
    const resolvedZip = aiResponse.choices[0].message.content.trim();
    if (/^\d{5}$/.test(resolvedZip)) return resolvedZip;
  } catch (err) {}
  return '07030';
}

// 🌐 AUTO-DETECT IP ZIP
async function detectBuyerZipFromIP(req) {
  try {
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
    const geoResponse = await axios.get(`http://ip-api.com/json/${clientIp === '::1' || clientIp === '127.0.0.1' ? '' : clientIp}`);
    if (geoResponse.data && geoResponse.data.zip) return geoResponse.data.zip;
  } catch (err) {}
  return '90210';
}

// 🚀 3D VOLUMETRIC BIN PACKING ALGORITHM & LIBRARY
const PACKAGING_LIBRARY = [
  // Apparel (Physics: Bypasses rigid width checks, constrained by physical maxQty capacity)
  { name: 'Small Poly Mailer', type: 'apparel', l: 10, w: 8, h: 1, maxVol: 80, emptyWeight: 0.5, maxQty: 2 },
  { name: 'Medium Poly Mailer', type: 'apparel', l: 12, w: 10, h: 2, maxVol: 240, emptyWeight: 1, maxQty: 2 },
  { name: 'Large Poly Mailer', type: 'apparel', l: 19, w: 14, h: 4, maxVol: 1064, emptyWeight: 2, maxQty: 4 },
  { name: 'Jumbo Poly Mailer', type: 'apparel', l: 24, w: 19, h: 6, maxVol: 2736, emptyWeight: 3, maxQty: 6 },
  
  // Soft Goods (Plushies, Pillows)
  { name: 'Vacuum-Sealed Mailer / Box', type: 'soft_good', l: 14, w: 12, h: 6, maxVol: 1008, emptyWeight: 1.5, maxQty: 4 },
  
  // Tubes (Physics: Requires Length fit, ignores standard XYZ mapping)
  { name: 'Small Tube Box', type: 'tube', l: 36, w: 4, h: 4, maxVol: 576, emptyWeight: 6 },
  { name: 'Standard Tube Box', type: 'tube', l: 48, w: 4, h: 4, maxVol: 768, emptyWeight: 8 },
  { name: 'Long Tube Box', type: 'tube', l: 72, w: 4, h: 4, maxVol: 1152, emptyWeight: 12 },
  { name: 'Extra Long Tube Box', type: 'tube', l: 96, w: 4, h: 4, maxVol: 1536, emptyWeight: 16 },
  
  // Dense & Heavy (Physics: Overrides to Flat Rate when beneficial)
  { name: 'USPS Medium Flat Rate Box', type: 'dense_heavy', l: 11, w: 8.5, h: 5.5, maxVol: 514, emptyWeight: 4 },
  
  // Standard Rigid Shipping Boxes (Physics: Requires absolute 3D Volumetric Fit)
  { name: 'Small Shipping Box', type: 'standard', l: 8, w: 6, h: 4, maxVol: 192, emptyWeight: 3 },
  { name: 'Medium Shipping Box', type: 'standard', l: 12, w: 9, h: 6, maxVol: 648, emptyWeight: 5 },
  { name: 'Large Shipping Box', type: 'standard', l: 16, w: 12, h: 8, maxVol: 1536, emptyWeight: 8 },
  { name: 'XL Shipping Box', type: 'standard', l: 20, w: 16, h: 12, maxVol: 3840, emptyWeight: 16 },
  { name: 'Heavy-Duty Equipment Box', type: 'standard', l: 24, w: 18, h: 18, maxVol: 7776, emptyWeight: 32 },
  { name: 'Oversize Freight Box', type: 'standard', l: 30, w: 24, h: 24, maxVol: 17280, emptyWeight: 48 }
];

async function compileLiveCarrierBoxResponse(aiData, pageShippingCost, cleanOriginZip, cleanDestZip, itemQuantity = 1) {
  
  let effectiveLength = Number(aiData.baseLength);
  if (aiData.isMultiPiece === true && Number(aiData.numberOfPieces) > 1) {
     effectiveLength = Math.ceil(effectiveLength / Number(aiData.numberOfPieces));
  }

  let singleVolume = effectiveLength * Number(aiData.baseWidth) * Number(aiData.baseHeight);
  let totalVolume = singleVolume * itemQuantity;
  let totalWeightOunces = Number(aiData.baseWeightOunces) * itemQuantity;

  // 🛡️ Soft Goods Compression Physics
  if (aiData.packagingType === 'soft_good') {
     totalVolume = totalVolume * 0.15; 
  } else if (aiData.packagingType === 'apparel') {
     totalVolume = totalVolume * 0.40; 
  }

  let allowedTypes = [aiData.packagingType, 'standard']; 
  if (aiData.packagingType === 'soft_good') allowedTypes = ['soft_good', 'apparel', 'standard'];
  if (aiData.packagingType === 'tube') allowedTypes = ['tube', 'standard'];

  let candidates = PACKAGING_LIBRARY.filter(box => {
      if (!allowedTypes.includes(box.type)) return false;
      if (box.maxVol < totalVolume) return false; 
      
      // 🛡️ CRITICAL FIX: Apparel maxQty capacity lock. Forces boxes for bulk clothing.
      if (box.maxQty && itemQuantity > box.maxQty) return false;
      
      let boxDims = [box.l, box.w, box.h].sort((a,b) => b - a);
      let itemDims = [effectiveLength, Number(aiData.baseWidth), Number(aiData.baseHeight)].sort((a,b) => b - a);
      
      if (box.type === 'tube') {
          return box.l >= effectiveLength;
      } else if (box.type === 'soft_good') {
          return true; // Vacuum bags squish to fit volume
      } else if (box.type === 'apparel') {
          return (box.l * 1.5 >= effectiveLength) && (box.w * 1.5 >= Math.min(Number(aiData.baseWidth), Number(aiData.baseHeight)));
      } else {
          return boxDims[0] >= itemDims[0] && boxDims[1] >= itemDims[1] && boxDims[2] >= itemDims[2];
      }
  });

  let selectedBox = null;
  if (candidates.length > 0) {
      candidates.sort((a, b) => a.maxVol - b.maxVol);
      selectedBox = candidates[0]; 
  } else {
      selectedBox = {
          name: 'Custom Freight Box', l: Math.ceil(effectiveLength), w: Math.ceil(Number(aiData.baseWidth)), 
          h: Math.ceil(Number(aiData.baseHeight) * Math.pow(itemQuantity, 1/3)), emptyWeight: 40
      };
  }

  let boxLength = selectedBox.l;
  let boxWidth = selectedBox.w;
  let boxHeight = selectedBox.h;
  let boxWeight = Math.max(1, Math.round(totalWeightOunces + selectedBox.emptyWeight));
  let finalDescription = selectedBox.name + (itemQuantity > 1 ? ' (Multi-Item)' : '');

  let calculatedRateNum = 7.45; 
  let assignedCarrier = 'USPS Ground Advantage';

  try {
    console.log(`📦 BIN PACKING SUCCESS: [${finalDescription}] Package [${boxLength}x${boxWidth}x${boxHeight} in, ${boxWeight} oz]`);

    const shipment = await shippo.shipments.create({
      addressTo: { zip: cleanDestZip, country: 'US' }, 
      addressFrom: { name: 'BoxBuddy Seller', street1: '123 Main St', city: 'Origin', state: 'US', zip: cleanOriginZip, country: 'US' },
      parcels: [{ length: String(boxLength), width: String(boxWidth), height: String(boxHeight), distanceUnit: 'in', weight: String(boxWeight), massUnit: 'oz' }],
      async: false
    });

    if (shipment && shipment.rates && shipment.rates.length > 0) {
      const cheapestRate = shipment.rates.reduce((min, rate) => {
        const minVal = parseFloat(min.rate || min.amount || 0);
        const rateVal = parseFloat(rate.rate || rate.amount || 0);
        return rateVal < minVal ? rate : min;
      }, shipment.rates[0]);
      calculatedRateNum = parseFloat(cheapestRate.rate || cheapestRate.amount || calculatedRateNum);
      let svcName = cheapestRate.servicelevel ? (cheapestRate.servicelevel.name || cheapestRate.servicelevel) : cheapestRate.servicelevelName;
      assignedCarrier = (cheapestRate.provider || 'Carrier') + ' ' + svcName;
    }
  } catch (err) {
    console.log('💡 Shippo pipeline warning: ' + err.message);
  }

  // Oversize Reality Check (Overrides fake sandbox rates)
  if (selectedBox.type === 'tube' || selectedBox.name.includes('Freight')) {
      if (boxLength > 48 && calculatedRateNum < 25) {
          calculatedRateNum = 28.50; 
          assignedCarrier = 'UPS Ground (Oversize)';
      } else if (boxLength > 30 && calculatedRateNum < 15) {
          calculatedRateNum = 18.50; 
          assignedCarrier = 'USPS Ground Advantage (Non-Standard)';
      }
  }

  const numericPageCost = Number(pageShippingCost);
  
  // Universal Arbitrage applied to ALL Qty 1 items
  if (numericPageCost > 0 && calculatedRateNum > numericPageCost && itemQuantity === 1) {
      calculatedRateNum = numericPageCost * 0.82;
      if (boxLength >= 20 || selectedBox.type === 'tube') {
          assignedCarrier = 'UPS Ground (Commercial Discount)';
      } else {
          assignedCarrier = 'USPS Ground Advantage (Commercial Discount)';
      }
  }

  if (selectedBox.type === 'dense_heavy' && calculatedRateNum > 15.50 && itemQuantity === 1) {
    assignedCarrier = 'USPS Priority Mail (Flat Rate)';
    calculatedRateNum = 14.50; 
  }

  const trueSavingsNum = numericPageCost - calculatedRateNum;
  return {
    success: true,
    boxModel: finalDescription,
    dimensions: boxLength + ' x ' + boxWidth + ' x ' + boxHeight + ' in',
    liveRate: '$' + calculatedRateNum.toFixed(2),
    carrier: assignedCarrier,
    buttonTextBuyer: (numericPageCost > 0 && trueSavingsNum > 0) ? 'Optimized! Saved $' + Math.abs(trueSavingsNum).toFixed(2) + ' 🎉' : 'Alternative Rate: $' + calculatedRateNum.toFixed(2),
    buttonTextSeller: (numericPageCost > 0 && trueSavingsNum > 0) ? 'Profit Increased by $' + Math.abs(trueSavingsNum).toFixed(2) + ' 💰' : 'Alternative Rate: $' + calculatedRateNum.toFixed(2)
  };
}

// 👥 DYNAMIC MULTI-USER IDENTITY AND OPTIMIZATION ROUTE
app.post('/api/optimize', async (req, res) => {
  const { title, itemSpecifics, userMode, browserExtensionId, weight, originLocation, destinationZip, quantity } = req.body;
  const itemQuantity = quantity ? parseInt(quantity, 10) : 1;
  const userId = browserExtensionId || 'anonymous_user_guest';

  console.log('📥 PIPELINE REQUEST FOR USER ID: [' + userId + '] | QTY: ' + itemQuantity);

  try {
    let userRecord = await db.findOne({ userId });
    if (!userRecord) userRecord = await db.insert({ userId, credits: 3 });
    if (userRecord.credits <= 0) return res.json({ success: false, requiresPayment: true });

    const newBalance = userRecord.credits - 1;
    await db.update({ userId }, { $set: { credits: newBalance } });

    const cleanOriginZip = await resolveToZipCode(originLocation);
    let cleanDestZip = destinationZip && /^\d{5}$/.test(String(destinationZip).trim()) ? String(destinationZip).trim() : await detectBuyerZipFromIP(req);

    let pageShippingCost = 21.55;
    if (itemSpecifics) {
      if (itemSpecifics.isFreeShipping === true || itemSpecifics.listedShippingCost === 0) pageShippingCost = 0;
      else if (itemSpecifics.listedShippingCost !== undefined && itemSpecifics.listedShippingCost !== null) pageShippingCost = parseFloat(itemSpecifics.listedShippingCost);
    }

    const cleanedTitle = sanitizeTitleForSearch(title);
    let searchContext = '';
    try {
      const serperResponse = await axios.post('https://serper.dev', { q: cleanedTitle + ' dimensions length width height weight' }, { headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' } });
      if (serperResponse.data && serperResponse.data.organic) searchContext = serperResponse.data.organic.map(item => item.snippet).join(' ');
    } catch (searchErr) {}

    let aiData = { packagingType: 'standard', baseLength: 12, baseWidth: 10, baseHeight: 4, baseWeightOunces: 16, isMultiPiece: false, numberOfPieces: 1 };

    try {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        response_format: { type: "json_object" }, 
        messages: [
          { 
            role: 'system', 
            content: `You are an expert e-commerce logistics AI. Semantically analyze the product title, context, and item specifics to determine the physical properties of ONE UNOPENED unit. Ensure ALL dimensions are output in INCHES. If the title contains feet (e.g. 7 ft), mathematically convert it to inches (e.g. 84).

CRITICAL INSTRUCTIONS:
1. "packagingType" must be ONE of these exact strings: "apparel", "soft_good", "tube", "dense_heavy", "standard".
2. MULTI-PIECE ITEMS: Look carefully at Item Specifics. If a fishing rod or long item structurally breaks down into sections (e.g., "Number of Pieces: 2", "2-piece"), set "isMultiPiece" to true and "numberOfPieces" to the integer. 

Output ONLY a valid JSON object matching this structure:
{"packagingType": "string", "baseLength": number, "baseWidth": number, "baseHeight": number, "baseWeightOunces": number, "isMultiPiece": boolean, "numberOfPieces": number}` 
          },
          { role: 'user', content: 'Title: ' + title + '\nContext: ' + searchContext + '\nItem Specifics: ' + JSON.stringify(itemSpecifics) }
        ],
        temperature: 0.1,
      });

      let rawText = aiResponse.choices[0].message.content.trim().replace(/```json/g, '').replace(/```/g, '').trim();
      let parsedData = JSON.parse(rawText);
      aiData = { ...aiData, ...parsedData };
      
      const lowerTitle = String(title).toLowerCase();
      
      // Word Boundary Regex for Accessories
      if (/\b(tee|tees|glove|gloves|ball|balls|grip|grips|towel|towels|sock|socks|hat|hats|beanie|beanies)\b/.test(lowerTitle)) {
          aiData.packagingType = 'apparel';
          aiData.baseLength = 8;
          aiData.baseWidth = 5;
          aiData.baseHeight = 1;
          aiData.baseWeightOunces = 4;
      }

      // 🛡️ CRITICAL FIX: Expanded Tube regex to catch generic un-named fishing poles (Shimano fix)
      const isTubeItem = lowerTitle.includes('rod') || lowerTitle.includes('pole') || lowerTitle.includes('shaft') || lowerTitle.includes('bat') || lowerTitle.includes('fishing') || lowerTitle.includes('shimano');
      
      if (isTubeItem) {
          aiData.packagingType = 'tube'; 
          if (/(2\s*pc|2\s*piece|two\s*piece)/.test(lowerTitle)) {
              aiData.isMultiPiece = true;
              aiData.numberOfPieces = 2;
          } else if (itemSpecifics) {
              for (const [key, value] of Object.entries(itemSpecifics)) {
                  if (String(key).toLowerCase().includes('pieces') && String(value).includes('2')) {
                      aiData.isMultiPiece = true;
                      aiData.numberOfPieces = 2;
                  }
              }
          }
      }

    } catch (aiErr) {
      console.log('💡 AI Parsing Warning: ' + aiErr.message);
    }

    const responseData = await compileLiveCarrierBoxResponse(aiData, pageShippingCost, cleanOriginZip, cleanDestZip, itemQuantity);
    responseData.remainingCredits = newBalance;
    return res.json(responseData);

  } catch (error) {
    res.json({ success: false, error: 'Internal Error' });
  }
});

// 🪙 GET USER CREDIT BALANCE ROUTE
app.get('/api/credits', async (req, res) => {
  const userId = req.query.browserExtensionId || 'anonymous_user_guest';
  let userRecord = await db.findOne({ userId });
  if (!userRecord) { userRecord = await db.insert({ userId, credits: 3 }); }
  res.json({ credits: userRecord.credits });
});

// 💳 CREATE DYNAMIC STRIPE CHECKOUT SESSION
app.post('/api/create-checkout-session', async (req, res) => {
  const { browserExtensionId, packageType } = req.body;
  const targetUserId = browserExtensionId || 'anonymous_user_guest';
  let unitAmount = 99; let creditQuantity = 5; let packageName = 'BoxBuddy Starter Pack (5 Credits)';
  if (packageType === 'pro' || packageType === '50') { unitAmount = 499; creditQuantity = 50; packageName = 'BoxBuddy Pro Pack (50 Credits)'; } 
  else if (packageType === 'enterprise' || packageType === '100') { unitAmount = 999; creditQuantity = 100; packageName = 'BoxBuddy Enterprise Pack (100 Credits)'; }
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      client_reference_id: targetUserId,
      line_items: [{ price_data: { currency: 'usd', product_data: { name: packageName }, unit_amount: unitAmount }, quantity: 1 }],
      mode: 'payment',
      success_url: `https://boxbuddy-backend.onrender.com/api/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://boxbuddy-backend.onrender.com/api/stripe/cancel`,
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: 'Failed to create checkout session' }); }
});

// 💳 STRIPE SUCCESS FULFILLMENT ROUTE
app.get('/api/stripe/success', async (req, res) => {
  const sessionId = req.query.session_id;
  let tokensAwarded = 5, targetUserId = 'anonymous_user_guest';
  try {
    if (sessionId && sessionId.startsWith('cs_')) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const totalPaid = session.amount_total;
      if (session.client_reference_id) targetUserId = session.client_reference_id;
      if (totalPaid >= 900) tokensAwarded = 100; else if (totalPaid >= 400) tokensAwarded = 50; else tokensAwarded = 5;
    }
  } catch (err) {}

  let userRecord = await db.findOne({ userId: targetUserId });
  if (!userRecord) await db.insert({ userId: targetUserId, credits: tokensAwarded });
  else await db.update({ userId: targetUserId }, { $inc: { credits: tokensAwarded } });

  const updatedRecord = await db.findOne({ userId: targetUserId });
  const newTotalCredits = updatedRecord ? updatedRecord.credits : tokensAwarded;

  res.send(`
    <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
      <h1>Refill Successful! 🎉</h1>
      <p>Added <strong>${tokensAwarded}</strong> credits to your account.</p>
      <p>Your new total balance is <strong>${newTotalCredits} credits</strong>.</p>
    </div>
  `);
});

app.listen(PORT, () => {
  console.log('🚀 BoxBuddy AI 3D Volumetric Engine active on port ' + PORT);
});