#!/bin/bash
# Quick Payment Test - Uses existing connected client
# Assumes you have at least one client with Stripe connected

set -e

API_BASE="http://localhost:4242/api/v1"
CLIENT_ID="379d81cf-458d-4598-a72f-138aa137868b"

echo "=========================================="
echo "Quick Payment Test"
echo "=========================================="
echo ""

# Step 1: Admin login
echo "1️⃣  Admin login..."
ADMIN_CREDS=$(curl -s -X POST "$API_BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"testpassword"}')

TOKEN=$(echo "$ADMIN_CREDS" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "   ✅ Logged in"
echo ""

# Step 2: Verify client has Stripe connected
echo "2️⃣  Checking client Stripe status..."
CLIENTS_RESPONSE=$(curl -s "$API_BASE/clients" \
    -H "Authorization: Bearer $TOKEN")

STRIPE_ACCOUNT=$(echo "$CLIENTS_RESPONSE" | grep -o '"stripeAccountId":"acct_[^"]*"' | head -1 | cut -d'"' -f4)
FOUND_CLIENT_ID=$(echo "$CLIENTS_RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
CLIENT_NAME=$(echo "$CLIENTS_RESPONSE" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$STRIPE_ACCOUNT" ]; then
    echo "   ❌ No clients with Stripe account found"
    echo "   Run: ./test-payment-flow.sh first"
    exit 1
fi

echo "   Client: $CLIENT_NAME"
echo "   Stripe Account: $STRIPE_ACCOUNT"
echo "   ✅ Ready for payments"
echo ""

# Step 3: Create a new test client to get API key
echo "3️⃣  Creating payment test client..."
NEW_CLIENT=$(curl -s -X POST "$API_BASE/accounts" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{
        "name": "Quick Payment Test",
        "email": "payment-test-'$(date +%s)'@example.com"
    }')

NEW_ID=$(echo "$NEW_CLIENT" | grep -o '"clientId":"[^"]*"' | cut -d'"' -f4)
API_KEY=$(echo "$NEW_CLIENT" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
ONBOARD_TOKEN=$(echo "$NEW_CLIENT" | grep -o '"onboardingToken":"[^"]*"' | cut -d'"' -f4)

echo "   New Client ID: $NEW_ID"
echo "   API Key: ${API_KEY:0:25}..."
echo ""

# Step 4: Auto-onboard via Stripe API
echo "4️⃣  Getting onboarding URL..."
ONBOARD_RESPONSE=$(curl -s "$API_BASE/onboard-client?token=$ONBOARD_TOKEN")
ONBOARD_URL=$(echo "$ONBOARD_RESPONSE" | grep -o '"url":"https://[^"]*"' | cut -d'"' -f4)

if [ -n "$ONBOARD_URL" ]; then
    echo "   Onboarding URL: $ONBOARD_URL"
    echo ""
    echo "   ⚡ AUTO-TEST: Attempting to create payment (will fail until onboarded)"
else
    echo "   ❌ Failed to get onboarding URL"
    exit 1
fi
echo ""

# Step 5: Try creating payment (will show what's needed)
echo "5️⃣  Testing payment creation..."
PAYMENT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE/payments/create" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -H "Idempotency-Key: test-$(date +%s)" \
    -d '{
        "lineItems": [{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": "Test Payment"},
                "unit_amount": 2000
            },
            "quantity": 1
        }]
    }')

PAYMENT_CODE=$(echo "$PAYMENT_RESPONSE" | tail -n1)
PAYMENT_BODY=$(echo "$PAYMENT_RESPONSE" | head -n-1)

echo "   HTTP Status: $PAYMENT_CODE"
echo "   Response: $PAYMENT_BODY"
echo ""

if [ "$PAYMENT_CODE" = "201" ]; then
    CHECKOUT_URL=$(echo "$PAYMENT_BODY" | grep -o '"url":"https://[^"]*"' | cut -d'"' -f4)
    echo "   ✅ PAYMENT SESSION CREATED!"
    echo ""
    echo "   📝 Open this URL to complete payment:"
    echo "   $CHECKOUT_URL"
    echo ""
    echo "   Test card: 4242 4242 4242 4242"
    echo "   Expiry: 12/30, CVC: 123"
elif [ "$PAYMENT_CODE" = "400" ]; then
    echo "   ℹ️  Payment rejected - client needs Stripe onboarding"
    echo ""
    echo "   📝 Complete onboarding at:"
    echo "   http://localhost:1919/onboard?token=$ONBOARD_TOKEN"
    echo ""
    echo "   Then re-run this script"
fi
echo ""

# Summary
echo "=========================================="
echo "Test Complete"
echo "=========================================="
echo ""
echo "To test full flow:"
echo "  1. Complete onboarding with the URL above"
echo "  2. Re-run: ./test-payment-quick.sh"
echo "  3. Complete payment at Checkout URL"
echo "  4. Check: https://dashboard.stripe.com/test/payments"
echo ""
