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

// 📍 RESOLVE CITY/STATE OR TEXT INTO A VALID 5-DIGIT US ZIP CODE
async function resolveToZipCode(locationStr) {
  if (!locationStr) return '07030';
  if (/^(00000|00001|00000-0000|n\/a|unknown|none)$/i.test(locationStr.trim()) || locationStr.includes('00000')) {
    return '07030';
  }
  const isInternational = /(japan|china|uk|united kingdom|canada|germany|australia|hong kong|taiwan|korea|france|italy)/i.test(locationStr);
  if (isInternational) return '90210'; 
  
  const zipMatch = String(locationStr).match(/\b\d{5}\b/);
  if (zipMatch && zipMatch[0] !== '00000' && zipMatch[0] !== '00001') return zipMatch[0];

  try {
    const aiResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Convert the given US city/state location into a valid 5-digit US postal ZIP code. Output ONLY the 5-digit ZIP number.' },
        { role: 'user', content: locationStr }
      ],
      temperature: 0.0,
    });
    const resolvedZip = aiResponse.choices[0].message.content.trim();
    if (/^\d{5}$/.test(resolvedZip) && resolvedZip !== '00000' && resolvedZip !== '00001') return resolvedZip;
  } catch (err) {}
  return '07030';
}

// 🌐 AUTO-DETECT BUYER DESTINATION ZIP
async function detectBuyerZipFromIP(req) {
  try {
    let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();
    const geoResponse = await axios.get(`http://ip-api.com/json/${clientIp === '::1' || clientIp === '127.0.0.1' ? '' : clientIp}`);
    if (geoResponse.data && geoResponse.data.zip) return geoResponse.data.zip;
  } catch (err) {}
  return '90210';
}

// 🚀 SHIPPO LOGISTICS ENGINE: MULTI-CARRIER ARBITRAGE & DYNAMIC COMPRESSION
async function compileLiveCarrierBoxResponse(aiProfile, finalLength, finalWidth, finalHeight, finalWeight, pageShippingCost, cleanOriginZip, cleanDestZip, itemTitle = '', itemQuantity = 1) {
  let boxLength = Number(finalLength);
  let boxWidth = Number(finalWidth);
  let boxHeight = Number(finalHeight);
  let boxWeightOunces = Math.max(1, Math.round(Number(finalWeight)));
  const lowerTitle = String(itemTitle).toLowerCase();

  let description = 'Standard Shipping Box';

  // 📐 EDGE-CASE SMART DIMENSIONING (Base 1-Unit Evaluation)
  if (aiProfile === 'poly_mailer') {
    if (boxWeightOunces <= 8 || /(glove|tee|sleeve|grip|towel)/i.test(lowerTitle)) {
      description = 'Small Poly Mailer';
      boxLength = 10; boxWidth = 8; boxHeight = 1;
      boxWeightOunces = 4;
    } else {
      description = 'Medium Poly Mailer';
      boxLength = 12; boxWidth = 10; boxHeight = 2;
      if (/(jacket|coat)/i.test(lowerTitle)) boxWeightOunces = 15; 
      else boxWeightOunces = 12; 
    }
  } else if (aiProfile === 'vacuum_bag') {
    boxLength = Math.max(10, Math.ceil(boxLength * 0.5));
    boxWidth = Math.max(8, Math.ceil(boxWidth * 0.5));
    boxHeight = Math.max(4, Math.ceil(boxHeight * 0.5));
    description = 'Vacuum-Sealed Mailer / Box';
  } else if (aiProfile === 'long_tube') {
    boxLength = Math.max(30, Math.ceil(boxLength));
    boxWidth = 4;
    boxHeight = 4;
    description = 'Long Tube / Shaft Box';
  } else if (aiProfile === 'flat_rate_box') {
    boxLength = 11;
    boxWidth = 8;
    boxHeight = 6;
    description = 'USPS Medium Flat Rate Box';
  } else if (aiProfile === 'heavy_box') {
    if (boxHeight > 20) boxHeight = Math.ceil(boxHeight * 0.5); 
    boxLength = Math.max(16, Math.ceil(boxLength));
    boxWidth = Math.max(14, Math.ceil(boxWidth));
    description = 'Heavy-Duty Equipment Box';
  } else if (aiProfile === 'small_box') {
    boxLength = Math.max(Math.ceil(boxLength + 1), 8);
    boxWidth = Math.max(Math.ceil(boxWidth + 1), 6);
    boxHeight = Math.max(Math.ceil(boxHeight + 1), 4);
    description = 'Small Shipping Box (Protective)';
    if (/(adapter|sleeve)/i.test(lowerTitle)) boxWeightOunces = 4;
  } else {
    // standard_box
    boxLength = Math.max(10, Math.ceil(boxLength + 1));
    boxWidth = Math.max(8, Math.ceil(boxWidth + 1));
    boxHeight = Math.max(4, Math.ceil(boxHeight + 1));
  }

  // 🚀 MULTI-ITEM QUANTITY SCALING ENGINE
  if (itemQuantity > 1) {
    boxWeightOunces = boxWeightOunces * itemQuantity;
    let scaleFactor = Math.pow(itemQuantity, 1/3); 
    
    if (aiProfile === 'poly_mailer') {
       description = 'Large Poly Mailer';
       boxLength = Math.max(15, Math.ceil(boxLength + (itemQuantity * 0.5))); 
       boxWidth = Math.max(12, Math.ceil(boxWidth + (itemQuantity * 0.5)));   
       boxHeight = Math.max(3, Math.ceil(boxHeight + (itemQuantity * 0.6)));  
    } else if (aiProfile === 'flat_rate_box') {
       description = 'Heavy-Duty Equipment Box (Multi-Item)';
       aiProfile = 'heavy_box'; 
       boxLength = Math.ceil(boxLength * scaleFactor);
       boxWidth = Math.ceil(boxWidth * scaleFactor);
       boxHeight = Math.ceil(boxHeight * scaleFactor);
    } else {
       description = description.includes('Box') ? description.replace('Box', 'Box (Multi-Item)') : description + ' (Multi-Item)';
       boxLength = Math.ceil(boxLength * scaleFactor);
       boxWidth = Math.ceil(boxWidth * scaleFactor);
       boxHeight = Math.ceil(boxHeight * scaleFactor);
    }
  }

  let calculatedRateNum = 7.45; 
  let assignedCarrier = 'USPS Ground Advantage';

  try {
    console.log(`📦 SHIPPO ENGINE: [Profile: ${aiProfile}] Package [${boxLength}x${boxWidth}x${boxHeight} in, ${boxWeightOunces} oz]`);
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
      console.log('🎯 LOWEST SHIPPO RATE SECURED -> ' + assignedCarrier + ': $' + calculatedRateNum);
    }
  } catch (shippoError) {
    console.log('💡 Shippo pipeline warning: ' + shippoError.message);
  }

  // 🚀 MULTI-CARRIER ARBITRAGE & FLAT RATE OVERRIDE
  const numericPageCost = Number(pageShippingCost);
  
  if (numericPageCost > 0 && calculatedRateNum >= numericPageCost) {
    // 🚀 FIX: Lock Synthetic Discounts to 1-Unit orders to prevent eBay DOM flat-rate scaling bugs
    if ((aiProfile === 'heavy_box' || aiProfile === 'long_tube') && itemQuantity === 1) {
      assignedCarrier = 'UPS Ground (Commercial)';
      calculatedRateNum = numericPageCost * 0.82; 
    }
  }

  if (aiProfile === 'flat_rate_box' && calculatedRateNum > 15.50 && itemQuantity === 1) {
    assignedCarrier = 'USPS Priority Mail (Flat Rate)';
    calculatedRateNum = 14.50; 
  }

  const trueSavingsNum = numericPageCost - calculatedRateNum;
  const formattedSavings = '$' + Math.abs(trueSavingsNum).toFixed(2);
  const isSaving = numericPageCost > 0 && trueSavingsNum > 0;

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
  const { title, itemSpecifics, userMode, browserExtensionId, weight, originLocation, destinationZip, quantity } = req.body;
  const itemQuantity = quantity ? parseInt(quantity, 10) : 1;
  const userId = browserExtensionId || 'anonymous_user_guest';

  const parsedWeight = parseToOunces(weight) || (itemSpecifics ? parseToOunces(itemSpecifics.weight) : null);

  console.log('==========================================');
  console.log('📥 PIPELINE REQUEST FOR USER ID: [' + userId + ']');
  console.log('📦 REQUESTED QUANTITY: ' + itemQuantity);

  try {
    let userRecord = await db.findOne({ userId });
    if (!userRecord) { userRecord = await db.insert({ userId, credits: 3 }); }
    if (userRecord.credits <= 0) {
      return res.json({ success: false, requiresPayment: true });
    }

    const newBalance = userRecord.credits - 1;
    await db.update({ userId }, { $set: { credits: newBalance } });

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

    let finalLength = 12, finalWidth = 10, finalHeight = 4, finalWeight = 16, aiProfile = 'standard_box';

    try {
      const aiResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { 
            role: 'system', 
            content: `You are an expert e-commerce packaging logistics AI. Your task is to semantically analyze the product title and context, determine the correct packaging profile category, and output actual dimensions (inches) and weight (ounces).

CRITICAL INSTRUCTIONS: 
1. Extract UNOPENED SHIPPING BOX dimensions, NEVER assembled dimensions.
2. If an item specifies it is "2 pieces", "2-pc", or "breaks down" (e.g., fishing rods), DIVIDE the total length by the number of pieces to find the true shipping length.
3. DO NOT route small accessories (e.g., Golf Tees, Golf Balls) to "long_tube". Use standard_box or poly_mailer.

PACKAGING PROFILES:
- "poly_mailer" : Single apparel items, soft goods. DO NOT USE for "Lots" or Multiples.
- "vacuum_bag" : Use ONLY for highly compressible soft goods like Plush Toys, Squishmallows.
- "long_tube" : Use for long, thin items like Golf Clubs, Fishing Rods, and Baseball Bats.
- "flat_rate_box" : Use for tiny but extremely dense/heavy items (e.g., Kettlebells).
- "heavy_box" : Large, bulky, or heavy items (e.g., 3D printers, receivers).
- "standard_box" : Shoe boxes, T-Shirt Lots/Bundles, or anything else.

Output ONLY a valid JSON object matching this structure:
{"packagingProfile": "poly_mailer|vacuum_bag|long_tube|flat_rate_box|small_box|heavy_box|standard_box", "length": number, "width": number, "height": number, "weight": number}` 
          },
          { role: 'user', content: 'Title: ' + title + '\nContext: ' + searchContext + '\nItem Specifics: ' + JSON.stringify(itemSpecifics) }
        ],
        temperature: 0.1,
      });

      let rawText = aiResponse.choices[0].message.content.trim();
      rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsedData = JSON.parse(rawText);

      aiProfile = parsedData.packagingProfile || 'standard_box';
      finalLength = Number(parsedData.length) || finalLength;
      finalWidth = Number(parsedData.width) || finalWidth;
      finalHeight = Number(parsedData.height) || finalHeight;
      finalWeight = Number(parsedData.weight) || finalWeight;
    } catch (aiErr) {}

    const responseData = await compileLiveCarrierBoxResponse(aiProfile, finalLength, finalWidth, finalHeight, parsedWeight || finalWeight, pageShippingCost, cleanOriginZip, cleanDestZip, title, itemQuantity);
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

  let unitAmount = 99; 
  let creditQuantity = 5;
  let packageName = 'BoxBuddy Starter Pack (5 Credits)';

  if (packageType === 'pro' || packageType === '50') {
    unitAmount = 499; creditQuantity = 50; packageName = 'BoxBuddy Pro Pack (50 Credits)';
  } else if (packageType === 'enterprise' || packageType === '100') {
    unitAmount = 999; creditQuantity = 100; packageName = 'BoxBuddy Enterprise Pack (100 Credits)';
  }

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
  } catch (err) {
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
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
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 8px; max-width: 400px; margin: 20px auto; color: #166534;">
        <p style="margin: 0; font-weight: bold;">You're all set!</p>
        <p style="margin: 5px 0 0 0; font-size: 14px;">Go back to your eBay shopping tab and refresh the page to see your updated balance.</p>
      </div>
    </div>
  `);
});

app.listen(PORT, () => {
  console.log('🚀 BoxBuddy AI Multi-Carrier Optimization Engine active on port ' + PORT);
});