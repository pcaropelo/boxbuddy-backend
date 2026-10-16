# BoxSpin V6.4 -> V7 changes

Root causes found in Buyer_test_9.csv (reproduced by replaying V6.4):
- Weight was multiplied by quantity in the client AND again on the server, and unknown weight became a fake 16 oz -> oversized boxes.
- Quantity was a straight volume multiple. Now one arrangement search (tiling + layering + folding for soft goods; linear stacking for rigid) handles qty 1, 3, 7, 20 with the same rule.
- Rackets/clubs: long-item boxes are data (`minItemLength`, flat/tube boxes), and a snug custom box is quoted too and only chosen when the carrier's real price beats stock by a margin.
- Listing dims are cross-checked against the category prior; widget text is excluded from scraping.
- Pack counts ("4 Pack") become units; listing weight is divided by them.

Not executed here (npm registry blocked): Express/nedb/Shippo/Stripe/OpenAI wiring. Run `npm install && npm test && node server.js` locally.
Note: the Shippo flat-rate token is USPS_MediumFlatRateBox1 (my earlier message said USPS_FlatRateMediumBox1 - that was wrong).
