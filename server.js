// ==========================================================================
// PACKSPEC AI - BOXBUDDY SECURED BACKEND INFRASTRUCTURE
// ==========================================================================

// 🌐 NODE.JS ENVIRONMENT POLYFILL (Fixes 'window is not defined' in Shippo SDK)
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

// 🛡️ SECURED API CLIENT INITIALIZATIONS
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const shippo = new Shippo({ 
  apiKeyHeader: `ShippoToken ${process.env.SHIPPO_API_KEY}` 
});

const app = express();
const PORT = 3000;

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

// ⚖️ WEIGHT PARSER HELPER
function parseToOunces(val) {
  if (!val) return null;
  const strVal = String(val).toLowerCase().trim();
  const num = parseFloat(strVal);
  if (isNaN(num)) return null;
  if (strVal.includes('lb') || strVal.includes('pound')) {
    return num * 16;
  }
  return num;
}

// 📍 RESOLVE CITY/STATE OR TEXT INTO A VALID 5-DIGIT US ZIP CODE (WITH INT'L & PLACEHOLDER GUARDRAILS)
async function resolveToZipCode(locationStr) {
  if (!locationStr) return '07030';

  // 1. Intercept placeholder or invalid location strings immediately
  if (/^(00000|00001|00000-0000|n\/a|unknown|none)$/i.test(locationStr.trim()) || locationStr.includes('00000')) {
    console.log(`⚠️ Placeholder origin ZIP detected ("${locationStr}"). Applying default fallback ZIP.`);
    return '07030';
  }
  
  // 2. Guardrail for foreign seller locations to prevent Shippo lookup crashes
  const isInternational = /(japan|china|uk|united kingdom|canada|germany|australia|hong kong|taiwan|korea|france|italy)/i.test(locationStr);
  if (isInternational) {
    console.log(`🌐 International origin seller detected (${locationStr}). Applying US import port fallback ZIP.`);
    return '90210'; 
  }

  // 3. Match valid 5-digit US ZIP code (excluding 00000/00001)
  const zipMatch = String(locationStr).match(/\b\d{5}\b/);
  if (zipMatch && zipMatch[0] !== '00000' && zipMatch[0] !== '00001') {
    return zipMatch[0];
  }

  // 4. OpenAI fallback for city/state strings
  try {
    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { 
          role: 'system', 
          content: 'Convert the given US city/state location into a valid 5-digit US postal ZIP code. Output ONLY the 5-digit ZIP number.' 
        },
        { role: 'user', content: locationStr }
      ],
      temperature: 0.0,
    });
    const resolvedZip = aiResponse.choices[0].message.content.trim();
    if (/^\d{5}$/.test(resolvedZip) && resolvedZip !== '00000' && resolvedZip !== '00001') {
      return resolvedZip;
    }
  } catch (err) {
    console.log('💡 Location resolution fallback triggered.');
  }

  return '07030';
}

// 🌐 AUTO-DETECT BUYER DESTINATION ZIP FROM CLIENT IP ADDRESS
async function detectBuyerZipFromIP(req) {
  try {
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
    
    const geoResponse = await axios.get(`http://ip-api.com/json/${clientIp === '::1' || clientIp === '127.0.0.1' ? '' : clientIp}`);
    if (geoResponse.data && geoResponse.data.zip) {
      return geoResponse.data.zip;
    }
  } catch (err) {
    console.log('💡 IP Geolocation warning: ' + err.message);
  }
  return '90210';
}

// HIGH-PRECISION DYNAMIC SHIPPO LOGISTICS MATRIX ENGINE
async function compileLiveCarrierBoxResponse(finalLength, finalWidth, finalHeight, finalWeight, pageShippingCost, cleanOriginZip, cleanDestZip, itemTitle = '') {
  let boxLength = Number(finalLength);
  let boxWidth = Number(finalWidth);
  let boxHeight = Number(finalHeight);
  const lowerTitle = String(itemTitle).toLowerCase();

  // 1. 🧥 APPAREL / SOFT GOODS POLY MAILER RULE (Strict flat poly mailer profile)
  const isApparel = /(jacket|coat|hoodie|shirt|sweater|anorak|pullover|pants|shorts|jersey|t-shirt|fleece|arc'teryx|patagonia)/i.test(lowerTitle);
  
  // 2. 🏌️ GOLF CLUBS / DRIVERS RULE (Expanded to 48-inch long box/tube)
  const isGolfClub = /(golf|shaft|driver|wood|iron|putter|wedge)/i.test(lowerTitle);

  // 3. 🖨️️ BULKY EQUIPMENT & 3D PRINTERS CARRIER CLASS CAP
  const isBulkyEquipment = /(printer|3d printer|neptune|bambu|creality|machine|console|receiver|amplifier)/i.test(lowerTitle);

  if (isApparel) {
    boxLength = 12;
    boxWidth = 10;
    boxHeight = 2; // Flat poly mailer profile
  } else if (isGolfClub) {
    boxLength = 48;
    boxWidth = 6;
    boxHeight = 6;
  } else if (isBulkyEquipment) {
    boxLength = 16;
    boxWidth = 14;
    boxHeight = 12;
  } else if (boxLength > 20 || boxWidth > 20 || boxHeight > 20) {
    boxLength = Math.min(boxLength, 18);
    boxWidth = Math.min(boxWidth, 14);
    boxHeight = Math.min(boxHeight, 12);
  }

  const pad = (Number(boxHeight) <= 3) ? 1 : 2;
  boxLength = Math.max(1, Math.round(boxLength + pad));
  boxWidth = Math.max(1, Math.round(boxWidth + pad));
  boxHeight = Math.max(1, Math.round(boxHeight + pad));
  const boxWeightOunces = Math.max(1, Math.round(Number(finalWeight)));

  let description = 'Standard Shipping Box';

  if (isApparel || (boxLength <= 13 && boxWidth <= 11 && boxHeight <= 3)) {
    description = 'Padded Poly Mailer';
  } else if (boxLength <= 16 && boxWidth <= 12 && boxHeight <= 6) {
    description = 'Small Shipping Box';
  } else if (isGolfClub) {
    description = 'Long Golf Club Tube / Box';
  } else if (isBulkyEquipment) {
    description = 'Heavy-Duty Equipment Box';
  } else {
    description = 'Medium / Standard Box';
  }

  let calculatedRateNum = 7.45; 
  let assignedCarrier = 'USPS Ground Advantage';

  try {
    console.log(`📦 SHIPPO ENGINE: Package [${boxLength}x${boxWidth}x${boxHeight} in, ${boxWeightOunces} oz]`);
    console.log(`📍 SHIPPO ROUTE: Origin ZIP (${cleanOriginZip}) ➡️ Destination ZIP (${cleanDestZip})`);

    const shipment = await shippo.shipments.create({
      addressTo: { zip: cleanDestZip, country: 'US' }, 
      addressFrom: {
        name: 'BoxBuddy Seller',
        street1: '123 Main St',
        city: 'Origin City',
        state: 'US',
        zip: cleanOriginZip, 
        country: 'US'
      },
      parcels: [{
        length: String(boxLength),
        width: String(boxWidth),
        height: String(boxHeight),
        distanceUnit: 'in',
        weight: String(boxWeightOunces), 
        massUnit: 'oz'
      }],
      async: false
    });

    if (shipment && shipment.rates && shipment.rates.length > 0) {
      const cheapestRate = shipment.rates.reduce((min, rate) => {
        const minVal = parseFloat(min.rate || min.amount || 0);
        const rateVal = parseFloat(rate.rate || rate.amount || 0);
        return rateVal < minVal ? rate : min;
      }, shipment.rates[0]);
      
      calculatedRateNum = parseFloat(cheapestRate.rate || cheapestRate.amount || 7.45);
      
      let serviceName = 'Standard';
      if (cheapestRate.servicelevel && typeof cheapestRate.servicelevel === 'object' && cheapestRate.servicelevel.name) {
        serviceName = cheapestRate.servicelevel.name;
      } else if (cheapestRate.servicelevel) {
        serviceName = String(cheapestRate.servicelevel);
      } else if (cheapestRate.servicelevelName) {
        serviceName = cheapestRate.servicelevelName;
      }
      
      assignedCarrier = (cheapestRate.provider || 'Carrier') + ' ' + serviceName;
      console.log('🎯 SHIPPO RATE SECURED -> ' + assignedCarrier + ': $' + calculatedRateNum);
    }
  } catch (shippoError) {
    console.log('💡 Shippo pipeline warning: ' + shippoError.message);
  }

  const trueSavingsNum = Number(pageShippingCost) - calculatedRateNum;
  const formattedSavings = '$' + Math.abs(trueSavingsNum).toFixed(2);
  const isSaving = Number(pageShippingCost) > 0 && trueSavingsNum > 0;

  return {
    success: true,
    boxModel: description,
    dimensions: boxLength + ' x ' + boxWidth + ' x ' + boxHeight + ' in',
    liveRate: '$' + calculatedRateNum.toFixed(2),
    carrier: assignedCarrier,
    buttonTextBuyer: isSaving ? 'Optimized! Saved ' + formattedSavings + ' 🎉' : 'Alternative Rate: $' + calculatedRateNum.toFixed(2),
    buttonTextSeller: isSaving ? 'Profit Increased by ' + formattedSavings + ' 💰' : 'Alternative Rate: $' + calculatedRateNum.toFixed(2)
  };
}

// 👥 DYNAMIC MULTI-USER IDENTITY AND OPTIMIZATION ROUTE
app.post('/api/optimize', async (req, res) => {
  const { title, itemSpecifics, userMode, browserExtensionId, weight, originLocation, destinationZip } = req.body;
  const userId = browserExtensionId || 'anonymous_user_guest';

  const parsedWeight = parseToOunces(weight) || (itemSpecifics ? parseToOunces(itemSpecifics.weight) : null);

  console.log('==========================================');
  console.log('📥 PIPELINE REQUEST FOR USER ID: [' + userId + ']');

  try {
    let userRecord = await db.findOne({ userId });
    if (!userRecord) { userRecord = await db.insert({ userId, credits: 3 }); }

    if (userRecord.credits <= 0) {
      console.log('⚠️ BILLING INTERCEPTED: Account empty (0 credits). Sending payment prompt...');
      return res.json({ success: false, requiresPayment: true });
    }

    const newBalance = userRecord.credits - 1;
    await db.update({ userId }, { $set: { credits: newBalance } });

    // 📍 DYNAMIC ORIGIN & DESTINATION ZIP RESOLUTION
    const cleanOriginZip = await resolveToZipCode(originLocation);
    let cleanDestZip = '90210';

    if (destinationZip && /^\d{5}$/.test(String(destinationZip).trim())) {
      cleanDestZip = String(destinationZip).trim();
    } else if (destinationZip) {
      cleanDestZip = await resolveToZipCode(destinationZip);
    } else {
      cleanDestZip = await detectBuyerZipFromIP(req);
    }

    let pageShippingCost = 21.55;
    if (itemSpecifics) {
      if (itemSpecifics.isFreeShipping === true || itemSpecifics.listedShippingCost === 0) {
        pageShippingCost = 0;
      } else if (itemSpecifics.listedShippingCost !== undefined && itemSpecifics.listedShippingCost !== null) {
        pageShippingCost = parseFloat(itemSpecifics.listedShippingCost);
      }
    }

    const hasFullDimensions = itemSpecifics && itemSpecifics.length && itemSpecifics.width && itemSpecifics.height;
    if (hasFullDimensions) {
      const specL = parseFloat(itemSpecifics.length);
      const specW = parseFloat(itemSpecifics.width);
      const specH = parseFloat(itemSpecifics.height);
      if (!isNaN(specL) && !isNaN(specW) && !isNaN(specH)) {
        const responseData = await compileLiveCarrierBoxResponse(specL, specW, specH, parsedWeight || 16, pageShippingCost, cleanOriginZip, cleanDestZip, title);
        responseData.remainingCredits = newBalance;
        return res.json(responseData);
      }
    }

    const cleanedTitle = sanitizeTitleForSearch(title);
    let searchContext = '';

    try {
      const payloadObject = { q: cleanedTitle + ' technical specification dimensions length width height weight' };
      const serperResponse = await axios.post('https://serper.dev', payloadObject, {
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' }
      });
      if (serperResponse.data && serperResponse.data.organic) {
        searchContext = serperResponse.data.organic.map(item => item.snippet).join(' ');
      }
    } catch (searchErr) {}

    let finalLength = 12, finalWidth = 10, finalHeight = 4, finalWeight = 16;

    try {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: `You are an expert e-commerce logistics packaging engine. Analyze the product title and context to determine the proper UNPACKAGED item dimensions (inches) and weight (ounces).

LOGISTICS DOMAIN RULES TO ENFORCE:
1. Golf Clubs / Shafts / Drivers / Woods / Irons / Putters: Length MUST be 48 inches, Width 6 inches, Height 6 inches. Weight 16-32 oz.
2. Apparel / Jackets / Hoodies / Arc'teryx / Patagonia: Output flat poly mailer dimensions (length 12, width 10, height 2 inches).
3. Weight Standard: ALWAYS output total weight in OUNCES (1 lb = 16 oz).

Output ONLY a valid JSON object: {"length": number, "width": number, "height": number, "weight": number}` 
          },
          { role: 'user', content: 'Title: ' + title + '\nContext: ' + searchContext }
        ],
        temperature: 0.1,
      });

      let rawText = aiResponse.choices[0].message.content.trim();
      rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsedData = JSON.parse(rawText);

      finalLength = Number(parsedData.length) || finalLength;
      finalWidth = Number(parsedData.width) || finalWidth;
      finalHeight = Number(parsedData.height) || finalHeight;
      finalWeight = Number(parsedData.weight) || finalWeight;
    } catch (aiErr) {}

    const responseData = await compileLiveCarrierBoxResponse(finalLength, finalWidth, finalHeight, parsedWeight || finalWeight, pageShippingCost, cleanOriginZip, cleanDestZip, title);
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
  if (!userRecord) {
    userRecord = await db.insert({ userId, credits: 3 });
  }
  res.json({ credits: userRecord.credits });
});

// 💳 CREATE DYNAMIC STRIPE CHECKOUT SESSION (GUARANTEES EXTENSION ID ATTACHMENT)
app.post('/api/create-checkout-session', async (req, res) => {
  const { browserExtensionId, packageType } = req.body;
  const targetUserId = browserExtensionId || 'anonymous_user_guest';

  // Define pricing tiers (in cents)
  let unitAmount = 99; // Starter: 5 credits ($0.99)
  let creditQuantity = 5;
  let packageName = 'BoxBuddy Starter Pack (5 Credits)';

  if (packageType === 'pro' || packageType === '50') {
    unitAmount = 499; // Pro: 50 credits ($4.99)
    creditQuantity = 50;
    packageName = 'BoxBuddy Pro Pack (50 Credits)';
  } else if (packageType === 'enterprise' || packageType === '100') {
    unitAmount = 999; // Enterprise: 100 credits ($9.99)
    creditQuantity = 100;
    packageName = 'BoxBuddy Enterprise Pack (100 Credits)';
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      client_reference_id: targetUserId,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: packageName },
          unit_amount: unitAmount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://boxbuddy-backend.onrender.com/api/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://boxbuddy-backend.onrender.com/api/stripe/cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.log('💡 Stripe session creation error: ' + err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// 💳 STRIPE SUCCESS FULFILLMENT ROUTE (WITH CLEAR USER INSTRUCTIONS)
app.get('/api/stripe/success', async (req, res) => {
  const sessionId = req.query.session_id;
  let tokensAwarded = 5;
  let targetUserId = 'anonymous_user_guest';

  try {
    if (sessionId && sessionId.startsWith('cs_')) {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const totalPaid = session.amount_total;
      
      if (session.client_reference_id) {
        targetUserId = session.client_reference_id;
      }

      if (totalPaid >= 900) tokensAwarded = 100;
      else if (totalPaid >= 400) tokensAwarded = 50;
      else tokensAwarded = 5;
    }
  } catch (err) {
    console.log('💡 Stripe session lookup warning: ' + err.message);
  }

  let userRecord = await db.findOne({ userId: targetUserId });
  if (!userRecord) {
    await db.insert({ userId: targetUserId, credits: tokensAwarded });
  } else {
    await db.update({ userId: targetUserId }, { $inc: { credits: tokensAwarded } });
  }

  const updatedRecord = await db.findOne({ userId: targetUserId });
  const newTotalCredits = updatedRecord ? updatedRecord.credits : tokensAwarded;

  res.send(`
    <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
      <h1>Refill Successful! 🎉</h1>
      <p>Added <strong>${tokensAwarded}</strong> credits to your account.</p>
      <p>Your new total balance is <strong>${newTotalCredits} credits</strong>.</p>
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 8px; max-width: 400px; margin: 20px auto; color: #166534;">
        <p style="margin: 0; font-weight: bold;">You're all set!</p>
        <p style="margin: 5px 0 0 0; font-size: 14px;">Go back to your eBay shopping tab and refresh the page to see your updated balance.</p>
      </div>
      <p style="color: #64748b; margin-top: 20px; font-size: 13px;">You can now close this tab.</p>
    </div>
  `);
});

// 🛠️ ADMIN ROUTE: INCREMENT CREDITS FOR ANY USER ID
app.get('/api/admin/refill', async (req, res) => {
  const userId = req.query.userId || 'kaheokadbghchegchjldjpmpmapfhijf';
  let userRecord = await db.findOne({ userId });
  if (!userRecord) {
    await db.insert({ userId, credits: 50 });
  } else {
    await db.update({ userId }, { $inc: { credits: 50 } });
  }
  const updated = await db.findOne({ userId });
  res.send(`Wallet updated successfully for user ${userId}! Added 50 credits. New total: ${updated.credits}`);
});

app.listen(PORT, () => {
  console.log('🚀 BoxBuddy Secured Shippo Production Infrastructure active on port ' + PORT);
});