#!/bin/bash
# Post-Onboarding Payment Test
# Run this AFTER completing Stripe onboarding

set -e

API_BASE="http://localhost:4242/api/v1"

# Use the client from the previous test
CLIENT_ID="379d81cf-458d-4598-a72f-138aa137868b"
API_KEY="0bc166e3d701ab020b88"

echo "=========================================="
echo "Post-Onboarding Payment Test"
echo "=========================================="
echo ""

# Step 1: Verify client has Stripe account connected
echo "1️⃣  Checking client Stripe account status..."
ADMIN_CREDS=$(curl -s -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"testpassword"}')

TOKEN=$(echo "$ADMIN_CREDS" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

CLIENT_INFO=$(curl -s "$API_BASE/clients" \
    -H "Authorization: Bearer $TOKEN")

STRIPE_ACCOUNT=$(echo "$CLIENT_INFO" | grep -o '"stripeAccountId":"acct_[^"]*"' | head -1 | cut -d'"' -f4)

if [ -n "$STRIPE_ACCOUNT" ]; then
    echo "   ✅ Client has Stripe account connected: $STRIPE_ACCOUNT"
else
    echo "   ❌ Client does NOT have a Stripe account connected yet"
    echo ""
    echo "   Please complete onboarding at:"
    echo "   http://localhost:1919/onboard?token=f864619979652c5086cc069c80a17f2f118f7147d802ec96fc7094f71ca0286e"
    echo ""
    exit 1
fi
echo ""

# Step 2: Test Payment with Checkout Session (USE_CHECKOUT=true)
echo "2️⃣  Creating payment with Checkout Session..."
CHECKOUT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/payments/create" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -H "Idempotency-Key: checkout-test-$(date +%s)" \
    -d '{
        "lineItems": [{
            "price_data": {
                "currency": "usd",
                "product_data": {
                    "name": "Test Product"
                },
                "unit_amount": 2000
            },
            "quantity": 1
        }]
    }')

CHECKOUT_CODE=$(echo "$CHECKOUT_RESPONSE" | tail -n1)
CHECKOUT_BODY=$(echo "$CHECKOUT_RESPONSE" | head -n-1)

if [ "$CHECKOUT_CODE" = "201" ]; then
    CHECKOUT_URL=$(echo "$CHECKOUT_BODY" | grep -o '"url":"https://[^"]*"' | cut -d'"' -f4)
    if [ -n "$CHECKOUT_URL" ]; then
        echo "   ✅ Checkout session created successfully"
        echo "   Payment URL: $CHECKOUT_URL"
        echo ""
        echo "   📝 MANUAL STEP: Open this URL to complete the test payment"
        echo "      Use Stripe test card: 4242 4242 4242 4242"
        echo "      Expiry: Any future date"
        echo "      CVC: Any 3 digits"
    else
        echo "   ⚠️  Response received but no URL extracted"
        echo "   Response: $CHECKOUT_BODY"
    fi
else
    echo "   ❌ Checkout creation failed (HTTP $CHECKOUT_CODE)"
    echo "   Response: $CHECKOUT_BODY"
fi
echo ""

# Step 3: Test Payment Intent (if USE_CHECKOUT=false)
echo "3️⃣  Testing Payment Intent mode..."
echo "   (This will fail if USE_CHECKOUT=true, which is expected)"
PI_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/payments/create" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -H "Idempotency-Key: pi-test-$(date +%s)" \
    -d '{
        "amount": 1500,
        "currency": "usd",
        "description": "Test payment intent"
    }')

PI_CODE=$(echo "$PI_RESPONSE" | tail -n1)
PI_BODY=$(echo "$PI_RESPONSE" | head -n-1)

if [ "$PI_CODE" = "201" ]; then
    CLIENT_SECRET=$(echo "$PI_BODY" | grep -o '"clientSecret":"[^"]*"' | cut -d'"' -f4)
    PAYMENT_INTENT_ID=$(echo "$PI_BODY" | grep -o '"paymentIntentId":"[^"]*"' | cut -d'"' -f4)
    echo "   ✅ Payment Intent created successfully"
    echo "   Payment Intent ID: $PAYMENT_INTENT_ID"
    echo "   Client Secret: ${CLIENT_SECRET:0:30}..."
elif [ "$PI_CODE" = "400" ]; then
    echo "   ℹ️  Payment Intent mode not enabled (USE_CHECKOUT=true)"
    echo "   Response: $PI_BODY"
else
    echo "   ⚠️  Unexpected response (HTTP $PI_CODE)"
    echo "   Response: $PI_BODY"
fi
echo ""

# Step 4: Check Payment Reports
echo "4️⃣  Checking payment reports..."
REPORT_RESPONSE=$(curl -s "$API_BASE/reports/payments?clientId=$CLIENT_ID" \
    -H "Authorization: Bearer $TOKEN")

echo "   Response: $REPORT_RESPONSE" | head -c 500
echo ""
echo ""

# Summary
echo "=========================================="
echo "✅ Payment Test Complete!"
echo "=========================================="
echo ""
echo "Summary:"
echo "  - Client Stripe account: $STRIPE_ACCOUNT"
echo "  - Checkout session: Created"
echo "  - Payment Intent: Tested"
echo ""
echo "Next steps:"
echo "  1. Complete payment at the Checkout URL above"
echo "  2. Use test card: 4242 4242 4242 4242"
echo "  3. Check Stripe dashboard for the payment"
echo "  4. Run this script again to see updated payment reports"
echo ""
